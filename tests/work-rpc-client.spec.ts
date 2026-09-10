import { expect, it, vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { WorkRequestClient, WorkRpcError } from '../src/client/work-rpc-client.js'
import { workSubmitRequestSchema, type WorkActivityResponse } from '../src/rpc/work-rpc-contract.js'

const target = { rootSessionId: 'captain-a', teamId: 'a' }
const request = { schemaVersion: 1 as const, target, requestId: 'same-id', description: 'Do this', acceptanceCriteria: 'Pass it' }
const recorded = { id: 'work-1', requestId: 'same-id', origin: { kind: 'local-operator' as const }, description: 'Do this', acceptanceCriteria: 'Pass it', revision: 1, createdAt: 10 }
const common = { schemaVersion: 1 as const, binding: target, teamRevision: 2, observedAt: 20 }
function page(): WorkActivityResponse {
  return { ...common, teamId: 'a', afterSequence: 0, retainedFromSequence: 1, throughSequence: 1, hasMore: false,
    entries: [{ id: 'event-1', sequence: 1, kind: 'request-proposed', occurredAt: 10, actor: { kind: 'local-operator' }, workRequestId: 'work-1' }], referencedRequests: [recorded],
    limits: { maxDescriptionChars: 8192, maxAcceptanceCriteriaChars: 4096, maxRequests: 256, maxActivityEntries: 1024 }, submitEligibility: { state: 'available' } }
}
function fixture(value: unknown) {
  const call = vi.fn(async () => ({ ok: true, value }))
  return { call, client: new WorkRequestClient({ call } as unknown as Pick<ClientConnectionRpc, 'call'>) }
}
it('uses the official authenticated channel and rejects writable author/source fields before dispatch', async () => {
  const f = fixture({ ...common, request: recorded, replayed: false })
  expect(await f.client.submit(request)).toMatchObject({ request: { id: 'work-1' } })
  expect(f.call).toHaveBeenCalledWith('/swarm-public', 'work/v1/submit', request, undefined)
  for (const extra of [{ origin: { kind: 'main', sessionId: 'invented' } }, { actorSessionId: 'member' }, { sourceMessageId: 'invented' }]) {
    expect(workSubmitRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false)
  }
})
it('rejects a different Captain or Team result and a receipt for another request without treating it as committed', async () => {
  for (const value of [{ ...common, binding: { ...target, rootSessionId: 'other' }, request: recorded, replayed: false },
    { ...common, request: { ...recorded, requestId: 'other' }, replayed: false }]) {
    await expect(fixture(value).client.submit(request)).rejects.toThrow()
  }
  await expect(fixture({ ...common, binding: { ...target, teamId: 'b' }, state: 'not-found' }).client.requestResult({ schemaVersion: 1, target, requestId: request.requestId })).rejects.toThrow()
})
it('rejects unordered, duplicated, wrong-cursor or cross-Team activity pages', async () => {
  const original = page()
  for (const value of [{ ...original, teamId: 'b' }, { ...original, afterSequence: 5 },
    { ...original, entries: [original.entries[0], original.entries[0]] },
    { ...original, entries: [{ ...original.entries[0], sequence: 2 }] },
    { ...original, referencedRequests: [recorded, recorded] }, { ...original, referencedRequests: [{ ...recorded, id: 'unrelated' }] }]) {
    await expect(fixture(value).client.activity({ schemaVersion: 1, target })).rejects.toThrow()
  }
})
it('keeps decoded Host rejection distinct from a lost response', async () => {
  const rpc = { call: vi.fn(async () => ({ ok: false, error: { code: 'WORK_MAILBOX_FULL', message: 'Full' } })) }
  await expect(new WorkRequestClient(rpc as unknown as Pick<ClientConnectionRpc, 'call'>).submit(request)).rejects.toBeInstanceOf(WorkRpcError)
  rpc.call.mockRejectedValueOnce(new Error('Connection lost'))
  await expect(new WorkRequestClient(rpc as unknown as Pick<ClientConnectionRpc, 'call'>).submit(request)).rejects.not.toBeInstanceOf(WorkRpcError)
})
