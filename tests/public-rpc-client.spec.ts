import { describe, expect, it, vi } from 'vitest'
import { PublicChatClient } from '../src/client/public-rpc-client.js'

const message = { id: 'm', sequence: 1, createdAt: 1, text: 'hello', author: { kind: 'local-operator' }, delivery: { state: 'queued', recipientSessionId: 'captain' } }
const response = { schemaVersion: 1, binding: { rootSessionId: 'captain', teamId: 'a' }, teamRevision: 2, observedAt: 3, message, replayed: false }
describe('public RPC decoder', () => {
  it('uses the official logical channel, endpoint, payload, and abort signal', async () => {
    const rpc = { call: vi.fn(async () => ({ ok: true as const, value: response })) }
    const client = new PublicChatClient(rpc)
    const request = { schemaVersion: 1 as const, target: { rootSessionId: 'viewer', teamId: 'a' }, requestId: 'r', text: 'hello' }
    const signal = new AbortController().signal
    await expect(client.append(request, signal)).resolves.toMatchObject(response)
    expect(rpc.call).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'v1/append', request, signal)
  })
  it('rejects malformed author/delivery rather than fabricating messages', async () => {
    const client = new PublicChatClient({ call: async () => ({ ok: true, value: { ...response, message: { ...message, delivery: { state: 'done' } } } }) })
    await expect(client.append({ schemaVersion: 1, target: { rootSessionId: 'viewer', teamId: 'a' }, requestId: 'r', text: 'hello' })).rejects.toThrow()
  })
  it('retains an explicit endpoint rejection and does not mistake it for a committed result', async () => {
    const client = new PublicChatClient({ call: async () => ({ ok: false, error: { code: 'denied', message: 'Unavailable', details: {} } }) })
    await expect(client.requestResult({ schemaVersion: 1, target: { rootSessionId: 'viewer', teamId: 'a' }, requestId: 'r' })).rejects.toMatchObject({ code: 'denied' })
  })
})
