import { directoryEntry, directoryPage } from './helpers/public-directory.js'
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

it('decodes v2 append through the official endpoint with frozen labels and per-recipient states', async () => {
  const value = { ...response, schemaVersion: 2, message: { ...message, formatVersion: 2, content: [{ type: 'mention', memberId: 'a' }, { type: 'mention', memberId: 'b' }], mentionLabels: [{ memberId: 'a', label: '同舟' }, { memberId: 'b', label: '同舟' }], delivery: { kind: 'requested', recipients: [{ recipientSessionId: 'a', state: 'claimed', claimedAt: 10 }, { recipientSessionId: 'b', state: 'not-delivered', settledAt: 11, reason: 'recipient-removed' }] } } }
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value })) }, client = new PublicChatClient(rpc)
  const request = { schemaVersion: 2 as const, target: { rootSessionId: 'viewer', teamId: 'a' }, requestId: 'r', content: [{ type: 'mention' as const, memberId: 'a' }, { type: 'mention' as const, memberId: 'b' }] }
  await expect(client.appendV2(request)).resolves.toEqual(value)
  expect(rpc.call).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'v2/append', request, undefined)
})
it('retains directory source distinctions, avatar status, and description truncation', async () => {
  const entry = directoryEntry(), value = directoryPage('a', [{ ...entry, skills: { ...entry.skills, assigned: { ...entry.skills.assigned, entries: [{ name: 'review', description: 'bounded', descriptionTruncated: true }] } } }])
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value })) }, client = new PublicChatClient(rpc)
  await expect(client.directory({ schemaVersion: 2, target: value.binding })).resolves.toEqual(value)
  expect(rpc.call).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'v2/directory', { schemaVersion: 2, target: value.binding }, undefined)
})
it('rejects an incomplete directory page and duplicate recipient IDs', async () => {
  const value = directoryPage(), rpc = { call: vi.fn(async (): Promise<{ ok: true; value: unknown }> => ({ ok: true, value: { ...value, page: { ...value.page, returnedCount: 50 } } })) }, client = new PublicChatClient(rpc)
  await expect(client.directory({ schemaVersion: 2, target: value.binding })).rejects.toThrow('Invalid directory page')
  rpc.call.mockResolvedValueOnce({ ok: true, value: { ...response, schemaVersion: 2, message: { ...message, formatVersion: 2, content: [{ type: 'text', text: 'hello' }], mentionLabels: [], delivery: { kind: 'requested', recipients: [{ state: 'queued', recipientSessionId: 'same' }, { state: 'queued', recipientSessionId: 'same' }] } } } })
  await expect(client.appendV2({ schemaVersion: 2, target: value.binding, requestId: 'r', content: [{ type: 'text', text: 'hello' }] })).rejects.toThrow('Duplicate public recipients')
})
