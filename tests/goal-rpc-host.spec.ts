/** Goal control uses the real authenticated Connection and one durable Team aggregate. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { goalOperationResponseSchema, goalReadResponseSchema, goalRequestResultResponseSchema } from '../src/rpc/goal-rpc-contract.js'
import { Recording, ROOT, createTeam, setup } from './helpers/public-chat-real-composition.js'

it('authenticates goal writes, rejects forged actors, and recovers the original receipt without exposing private state', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-http-')), adapter = new Recording()
  const f = await setup(sandbox, adapter, true)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    await vi.waitFor(() => expect(f.routes.some(route => route.path === '/swarm-public')).toBe(true))
    const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const call = async (endpoint: string, fields: object = {}, headers: Record<string, string> = { cookie }) => {
      const response = await fetch(f.base + '/swarm-public/goal/v1/' + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId: 'goal-host-proof', method: 'goal/v1/' + endpoint,
          payload: { schemaVersion: 1, target: { rootSessionId: ROOT, teamId }, ...fields } }),
      })
      return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
    }
    expect((await call('read', {}, {})).status).toBe(401)
    expect((await call('read', {}, { cookie, origin: 'https://untrusted.invalid' })).status).toBe(403)
    const initial = (await call('read')).body.result
    expect(initial).toMatchObject({ ok: true })
    expect(goalReadResponseSchema.parse(initial.value)).toMatchObject({ snapshot: { text: '', remainingActiveTasks: 0 } })
    const input = { requestId: 'goal-draft-once', expectedLifecycleRevision: 0, start: false,
      goal: { text: 'Check the smallest deliverable', acceptanceCriteria: 'Evidence is accepted', constraints: 'Preserve earlier outputs', mode: 'finite' } }
    for (const extra of [{ actorSessionId: captain.id }, { origin: { kind: 'captain', sessionId: captain.id } }]) {
      expect((await call('save', { ...input, ...extra })).body.result).toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    }
    const saved = (await call('save', input)).body.result
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true })
    expect(goalOperationResponseSchema.parse(saved.value)).toMatchObject({ operationRevision: 1, replayed: false,
      snapshot: { text: input.goal.text, lifecycle: { revision: 1, phase: 'draft' } } })
    expect(saved.value.snapshot.lifecycle).not.toHaveProperty('operations')
    expect(saved.value.snapshot.lifecycle).not.toHaveProperty('operationFloorRevision')
    const paused = (await call('control', { requestId: 'pause-once', expectedLifecycleRevision: 1, action: 'pause' })).body.result
    expect(paused, JSON.stringify(paused)).toMatchObject({ ok: true, value: { operationRevision: 2, snapshot: { lifecycle: { phase: 'paused' } } } })
    const replay = (await call('save', input)).body.result
    expect(goalOperationResponseSchema.parse(replay.value)).toMatchObject({ operationRevision: 1, replayed: true,
      snapshot: { lifecycle: { revision: 2, phase: 'paused' } } })
    const restored = (await call('requestResult', { requestId: input.requestId, expectedLifecycleRevision: 0 })).body.result
    expect(goalRequestResultResponseSchema.parse(restored.value)).toMatchObject({ state: 'committed', operationRevision: 1 })
    expect((await call('save', { ...input, goal: { ...input.goal, text: 'Changed retry' } })).body.result)
      .toMatchObject({ ok: false, error: { code: 'TEAM_GOAL_CONFLICT' } })
    const actual = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(actual.tasks).toHaveLength(0)
    expect(actual.messages).toHaveLength(0)
    expect(actual.goalLifecycle?.operations).toHaveLength(2)
    expect(actual.goalLifecycle?.operations.every(receipt => receipt.origin.kind === 'local-operator')).toBe(true)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
