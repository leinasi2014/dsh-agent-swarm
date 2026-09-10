/** Exact execution must survive the real aggregate transaction wait, including terminal reads. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import type { TeamScope, TeamTransaction } from '../src/domain/team-domain-port.js'
import type { TeamId } from '../src/domain/types.js'
import type { ResolveWorkRequestInput } from '../src/domain/work-request.js'
import { StorageDomainTeamStore } from '../src/storage/storage-domain-team-store.js'
import { Recording, setup } from './helpers/public-chat-real-composition.js'

const cases = (['accept', 'reject', 'replay'] as const).flatMap(decision =>
  (['abort', 'session-replaced'] as const).map(fault => ({ decision, fault })))

it.each(cases)('fences $decision after transaction wait when $fault', async ({ decision, fault }) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'work-authority-wait-'))
  const f = await setup(sandbox, new Recording()), execution = new AbortController()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { entered = resolve })
  let pending: Promise<unknown> | undefined
  let transactionSpy: { mockRestore(): void } | undefined, sessionSpy: { mockRestore(): void } | undefined
  try {
    const { agent: captain } = await f.ctx.agents.create({ sessionId: SessionId('authority-captain'),
      agentOptions: { provider: 'public-fixture', model: 'public-model' }, meta: { cwd: sandbox } })
    const runtime = f.ctx.agentSwarm, domain = runtime.domain, scope = runtime.scopeOf(captain)
    const team = await runtime.create({ agent: captain, signal: execution.signal }, 'Authority', 'Transaction admission proof.')
    const proposal = await domain.submitWorkRequest(scope, team.id, { kind: 'local-operator' },
      { requestId: 'queued-decision', description: 'Decide this request only while the caller remains current.' })
    const input: ResolveWorkRequestInput = { workRequestId: proposal.request.id, expectedRequestRevision: 1,
      decision: decision === 'reject' ? { kind: 'reject', publicReason: 'No work is needed.' }
        : { kind: 'accept', items: [{ itemKey: 'only', subject: 'Only task', description: 'No duplicate or stale execution.' }] } }
    if (decision === 'replay') await domain.resolveWorkRequest(scope, team.id, captain.id, input)
    const before = (await domain.snapshot(scope, team.id, captain.id)).team
    const transact = StorageDomainTeamStore.prototype.transact
    let armed = true
    transactionSpy = vi.spyOn(StorageDomainTeamStore.prototype, 'transact').mockImplementation(function<T>(
      this: StorageDomainTeamStore, transactionScope: TeamScope, teamId: TeamId, operation: TeamTransaction<T>,
    ): Promise<T> {
      if (!armed || transactionScope !== scope || teamId !== team.id) return transact.call(this, transactionScope, teamId, operation) as Promise<T>
      armed = false
      // Both calls enter the actual store's per-Team queue. The first owns its
      // real lock without changing the draft; the decision is queued behind it.
      const held = transact.call(this, transactionScope, teamId, async () => { entered(); await gate })
      const queued = transact.call(this, transactionScope, teamId, operation) as Promise<T>
      return Promise.all([held, queued]).then(([, result]) => result)
    })
    pending = runtime.work.resolve({ agent: captain, signal: execution.signal }, input)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await waiting
    if (fault === 'abort') execution.abort(new Error('Execution cancelled while waiting for the aggregate lock'))
    else {
      // Inject an actual distinct Session at the official read seam, keeping
      // the Agent unchanged so the separate Session-instance guard is tested.
      const replacement = Session.create(captain.id, [], captain.session.header)
      expect(replacement).not.toBe(captain.session)
      const getSession = f.ctx.sessions.get.bind(f.ctx.sessions)
      sessionSpy = vi.spyOn(f.ctx.sessions, 'get').mockImplementation(id => id === captain.id ? replacement : getSession(id))
    }
    release()
    const result = await outcome
    expect(result).toHaveProperty('error')
    if ('error' in result) {
      if (fault === 'abort') expect(result.error).toBe(execution.signal.reason)
      else expect(result.error).toMatchObject({ code: 'TEAM_AGENT_REQUIRED' })
    }
    sessionSpy?.mockRestore(); sessionSpy = undefined
    const after = (await domain.snapshot(scope, team.id, captain.id)).team
    expect(after).toEqual(before)
  } finally {
    release()
    await pending?.catch(() => undefined)
    sessionSpy?.mockRestore(); transactionSpy?.mockRestore()
    await f.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
