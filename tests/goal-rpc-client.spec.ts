import { expect, it, vi } from 'vitest'
import { GoalClient, GoalRpcError } from '../src/client/goal-rpc-client.js'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

const target = { rootSessionId: 'captain', teamId: 'team' }
const snapshot = { text: '', budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 }, remainingActiveTasks: 0, remainingActiveAttempts: 0, eligibility: { state: 'available' } }
const common = { schemaVersion: 1, binding: target, teamRevision: 1, observedAt: 10, snapshot }
function fixture(value: unknown) {
  const call = vi.fn(async () => ({ ok: true, value }))
  return { call, client: new GoalClient({ call } as unknown as Pick<ClientConnectionRpc, 'call'>) }
}
it('reads through the authenticated channel and rejects mismatched Captain or Team results', async () => {
  const f = fixture(common)
  expect(await f.client.read({ schemaVersion: 1, target })).toEqual(common)
  expect(f.call).toHaveBeenCalledWith('/swarm-public', 'goal/v1/read', { schemaVersion: 1, target }, undefined)
  for (const binding of [{ ...target, teamId: 'other' }, { ...target, rootSessionId: 'other' }]) {
    await expect(fixture({ ...common, binding }).client.read({ schemaVersion: 1, target })).rejects.toThrow('binding')
  }
})
it('keeps committed, absent and expired operation results distinct without accepting invented actors', async () => {
  const request = { schemaVersion: 1 as const, target, requestId: 'same', expectedLifecycleRevision: 3 }
  expect(await fixture({ ...common, state: 'expired' }).client.requestResult(request)).toMatchObject({ state: 'expired' })
  expect(await fixture({ ...common, state: 'not-found' }).client.requestResult(request)).toMatchObject({ state: 'not-found' })
  await expect(fixture({ ...common, state: 'committed', operationRevision: 3 }).client.requestResult(request)).rejects.toThrow('revision')
  const f = fixture(common)
  await expect(f.client.control({ ...request, action: 'pause', actor: 'captain' } as never)).rejects.toThrow()
  expect(f.call).not.toHaveBeenCalled()
})
it('does not turn transport or schema failures into definite Host rejections', async () => {
  const call = vi.fn(async () => ({ ok: false, error: { code: 'TEAM_GOAL_REVISION_CONFLICT', message: 'Changed' } }))
  const client = new GoalClient({ call } as unknown as Pick<ClientConnectionRpc, 'call'>)
  await expect(client.read({ schemaVersion: 1, target })).rejects.toBeInstanceOf(GoalRpcError)
  call.mockRejectedValueOnce(new Error('Disconnected'))
  await expect(client.read({ schemaVersion: 1, target })).rejects.not.toBeInstanceOf(GoalRpcError)
})
