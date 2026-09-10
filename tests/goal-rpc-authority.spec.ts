import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { Recording, ROOT, addPublicMembers, createTeam, setup } from './helpers/public-chat-real-composition.js'
import { HostTargetReadService } from '../src/host/target-read-service.js'
import { handleGoalRpc } from '../src/rpc/goal-rpc-service.js'
import { goalReadResponseSchema, goalRequestResultResponseSchema } from '../src/rpc/goal-rpc-contract.js'
import { StorageDomainTeamStore } from '../src/storage/storage-domain-team-store.js'
import type { TeamScope, TeamTransaction, TeamTransactionOptions } from '../src/domain/team-domain-port.js'
import type { TeamId } from '../src/domain/types.js'

const draft = { requestId: 'operator-save', expectedLifecycleRevision: 0, start: false,
  goal: { text: 'Recover the original accepted operation', acceptanceCriteria: 'The receipt stays readable', constraints: 'No duplicate write', mode: 'finite' as const } }

it('recovers an authorized human receipt after archive while preserving the rejection of new writes', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'goal-archived-receipt-')), f = await setup(sandbox, new Recording(), true)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    await vi.waitFor(() => expect(f.routes.some(route => route.path === '/swarm-public')).toBe(true))
    const authorized = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
    const cookie = authorized.headers.get('set-cookie')!.split(';')[0]!
    const call = async (endpoint: string, fields: object = {}) => {
      const response = await fetch(f.base + '/swarm-public/goal/v1/' + endpoint, { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
          rpcId: 'archive-recovery', method: 'goal/v1/' + endpoint,
          payload: { schemaVersion: 1, target: { rootSessionId: ROOT, teamId }, ...fields } }) })
      expect(response.status).toBe(200)
      return (await response.json()).result
    }
    expect(await call('save', draft)).toMatchObject({ ok: true, value: { operationRevision: 1 } })
    await f.ctx.agentSwarm.domain.archiveTeam(scope, teamId, captain.id, 'Keep the audit record after this Team finishes')
    const archived = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const read = await call('read')
    expect(read).toMatchObject({ ok: true })
    expect(goalReadResponseSchema.parse(read.value)).toMatchObject({ teamRevision: archived.revision, snapshot: { text: draft.goal.text, eligibility: { state: 'unavailable' } } })
    const result = await call('requestResult', { requestId: draft.requestId, expectedLifecycleRevision: 0 })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(goalRequestResultResponseSchema.parse(result.value)).toMatchObject({ state: 'committed', operationRevision: 1, teamRevision: archived.revision })
    expect(await call('save', { ...draft, requestId: 'new-after-archive', expectedLifecycleRevision: 1 })).toMatchObject({ ok: false })
    expect(await call('control', { requestId: 'resume-after-archive', expectedLifecycleRevision: 1, action: 'resume' })).toMatchObject({ ok: false })
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team).toEqual(archived)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('keeps human result recovery in its own origin namespace even when a Main or Captain used the same request ID', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'goal-result-origin-')), f = await setup(sandbox, new Recording())
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox), runtime = f.ctx.agentSwarm
    await runtime.domain.saveGoal(scope, teamId, { kind: 'main', sessionId: root.id }, draft)
    await runtime.domain.saveGoal(scope, teamId, { kind: 'captain', sessionId: captain.id }, { ...draft, expectedLifecycleRevision: 1 })
    const targets = new HostTargetReadService(f.ctx, runtime, f.ctx.agentSwarmHostRead)
    const value = await handleGoalRpc(f.ctx, runtime, targets, 'goal/v1/requestResult', { schemaVersion: 1,
      target: { rootSessionId: root.id, teamId }, requestId: draft.requestId, expectedLifecycleRevision: 0 }, new AbortController().signal)
    expect(goalRequestResultResponseSchema.parse(value)).toMatchObject({ state: 'not-found', snapshot: { lifecycle: { revision: 2 } } })
    expect(JSON.stringify(value)).not.toContain('contentDigest')
    expect(JSON.stringify(value)).not.toContain('operations')
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

const waitingCases = (['save', 'control'] as const).flatMap(operation => (['abort', 'session-replaced', 'membership-revoked'] as const).map(fault => ({ operation, fault })))
it.each(waitingCases)('goal Host $operation admits no write after $fault during the actual Team transaction wait', async ({ operation, fault }) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'goal-host-authority-wait-')), f = await setup(sandbox, new Recording())
  const abort = new AbortController()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
  let pending: Promise<unknown> | undefined, transactionSpy: { mockRestore(): void } | undefined, sessionSpy: { mockRestore(): void } | undefined
  let releaseViewer: (() => void) | undefined, viewerLease: Promise<unknown> | undefined
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox), runtime = f.ctx.agentSwarm
    const viewer = fault === 'membership-revoked' ? (await addPublicMembers(f, root, captain.id))[0]! : root.id
    if (fault === 'membership-revoked') {
      let available!: () => void
      const ready = new Promise<void>(resolve => { available = resolve }), keep = new Promise<void>(resolve => { releaseViewer = resolve })
      const lifetime = new AbortController().signal
      // Official leases keep the already legitimate Captain/member view stable
      // while this case changes only the authoritative roster membership.
      viewerLease = f.ctx.subagents.withContinuableChild(root, captain.id, lifetime, async liveCaptain => {
        await f.ctx.subagents.withContinuableChild(liveCaptain, viewer, lifetime, async () => { available(); await keep })
      })
      await Promise.race([ready, viewerLease.then(() => { throw new Error('Viewer lease ended before the authority check') })])
    }
    if (operation === 'control') await runtime.domain.saveGoal(scope, teamId, { kind: 'local-operator' }, draft)
    const before = (await runtime.domain.snapshot(scope, teamId, captain.id)).team
    const targets = new HostTargetReadService(f.ctx, runtime, f.ctx.agentSwarmHostRead)
    const transact = StorageDomainTeamStore.prototype.transact
    let armed = true
    transactionSpy = vi.spyOn(StorageDomainTeamStore.prototype, 'transact').mockImplementation(function<T>(this: StorageDomainTeamStore,
      transactionScope: TeamScope, id: TeamId, body: TeamTransaction<T>, options?: TeamTransactionOptions): Promise<T> {
      if (!armed || transactionScope !== scope || id !== teamId) return transact.call(this, transactionScope, id, body, options) as Promise<T>
      armed = false
      const blocker = transact.call(this, transactionScope, id, async current => {
        entered(); await held
        if (fault === 'membership-revoked') Object.assign(current.members.find(member => member.sessionId === viewer)!, { phase: 'removed', error: 'Viewer membership revoked' })
      })
      const queued = transact.call(this, transactionScope, id, body, options) as Promise<T>
      return Promise.all([blocker, queued]).then(([, value]) => value)
    })
    const input = operation === 'save' ? draft : { requestId: 'paused-after-read', expectedLifecycleRevision: 1, action: 'pause' }
    pending = handleGoalRpc(f.ctx, runtime, targets, 'goal/v1/' + operation,
      { schemaVersion: 1, target: { rootSessionId: viewer, teamId }, ...input }, abort.signal)
    const result = pending.then(value => ({ value }), error => ({ error }))
    await Promise.race([waiting, result.then(outcome => { throw new Error(`Goal operation ended before reaching the transaction gate: ${JSON.stringify(outcome)}`) })])
    if (fault === 'abort') abort.abort(new Error('Operator cancelled while the goal write was queued'))
    else if (fault === 'session-replaced') {
      const replacement = Session.create(root.id, [], root.session.header), get = f.ctx.sessions.get.bind(f.ctx.sessions)
      expect(replacement).not.toBe(root.session)
      sessionSpy = vi.spyOn(f.ctx.sessions, 'get').mockImplementation(id => id === root.id ? replacement : get(id))
    }
    release()
    expect(await result).toHaveProperty('error')
    sessionSpy?.mockRestore(); sessionSpy = undefined
    const after = (await runtime.domain.snapshot(scope, teamId, captain.id)).team
    expect(after).toEqual(fault === 'membership-revoked' ? { ...before, revision: before.revision + 1, updatedAt: after.updatedAt,
      members: before.members.map(member => member.sessionId === viewer ? { ...member, phase: 'removed', error: 'Viewer membership revoked' } : member) } : before)
  } finally {
    release(); await pending?.catch(() => undefined)
    sessionSpy?.mockRestore(); transactionSpy?.mockRestore()
    releaseViewer?.(); await viewerLease
    await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
