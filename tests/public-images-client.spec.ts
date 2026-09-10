import { expect, it, vi } from 'vitest'
import { PublicChatClient } from '../src/client/public-rpc-client.js'
import { publicV3MessageSchema } from '../src/client/public-v3-schema.js'
import { publicV2MessageSchema, mergePublicMessages } from '../src/client/public-v2-schema.js'
import { decodePublicDraft, encodePublicDraft, publicDraftImageIssue, publicDraftRequest } from '../src/client/public-image-draft.js'

const metadata = { mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1, name: '图.png' }
const message = { id: 'message', sequence: 1, createdAt: 1, text: '', formatVersion: 3 as const,
  content: [{ type: 'image' as const, imageId: 'image-1', ...metadata }], mentionLabels: [], author: { kind: 'local-operator' as const },
  delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'captain', state: 'queued' as const, deferredReason: 'image-capability-unknown' as const }] } }
const common = { schemaVersion: 3 as const, binding: { rootSessionId: 'captain', teamId: 'team' }, teamRevision: 2, observedAt: 3 }

it('decodes a pure-image v3 append and its public deferred reason through the official carrier', async () => {
  const response = { ...common, message, replayed: false }
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value: response })) }
  const client = new PublicChatClient(rpc)
  const request = { schemaVersion: 3 as const, target: { rootSessionId: 'viewer', teamId: 'team' }, requestId: 'one', content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'YWJj', name: '图.png' }] }
  await expect(client.appendV3(request)).resolves.toEqual(response)
  expect(rpc.call).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'v3/append', request, undefined)
})

it.each(['image-capability-unknown', 'image-model-unsupported', 'image-unavailable', 'projection-mismatch', 'recipient-unavailable'])('retains the bounded queued reason %s and rejects an invented reason', reason => {
  const input = { ...message, delivery: { kind: 'requested', recipients: [{ recipientSessionId: 'captain', state: 'queued', deferredReason: reason }] } }
  expect(publicV3MessageSchema.parse(input).delivery).toEqual(input.delivery)
  expect(() => publicV3MessageSchema.parse({ ...input, delivery: { kind: 'requested', recipients: [{ recipientSessionId: 'captain', state: 'queued', deferredReason: 'private-provider-exception' }] } })).toThrow()
})

it('decodes system-authored assistance without changing the v2 author contract or dropping source links', () => {
  const assistance = { kind: 'result', assistanceId: 'assistance', sourceMessageId: 'source', imageIds: ['image-1'], requesterSessionId: 'requester', helperSessionId: 'helper', expiresAt: 10, resultId: 'result', outcome: { state: 'failed', reason: 'expired' } }
  expect(publicV3MessageSchema.parse({ ...message, author: { kind: 'system' }, assistance })).toMatchObject({ author: { kind: 'system' }, assistance })
  expect(() => publicV2MessageSchema.parse({ ...message, formatVersion: 2, content: [{ type: 'text', text: 'legacy' }], author: { kind: 'system' } })).toThrow()
  expect(() => publicV3MessageSchema.parse({ ...message, assistance: { ...assistance, helperSessionId: 'requester' } })).toThrow()
})

it('checks image response identity, canonical bytes and metadata before returning data', async () => {
  const value = { ...common, messageId: 'message', imageId: 'image-1', image: { ...metadata, data: 'YWJj' } }
  const rpc = { call: vi.fn(async (): Promise<{ ok: true; value: unknown }> => ({ ok: true, value })) }, client = new PublicChatClient(rpc)
  const request = { schemaVersion: 3 as const, target: { rootSessionId: 'viewer', teamId: 'team' }, messageId: 'message', imageId: 'image-1' }
  await expect(client.image(request)).resolves.toEqual(value)
  expect(rpc.call).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'v3/image', request, undefined)
  for (const invalid of [{ ...value, imageId: 'other' }, { ...value, messageId: 'other' }, { ...value, image: { ...value.image, bytes: 4 } }, { ...value, image: { ...value.image, data: 'bad_' } }, { ...value, image: { ...value.image, attachmentId: 'private' } }]) {
    rpc.call.mockResolvedValueOnce({ ok: true, value: invalid }); await expect(client.image(request)).rejects.toThrow()
  }
})

it('rejects duplicate images and out-of-order history while accepting old format projections in v3 history', async () => {
  expect(() => publicV3MessageSchema.parse({ ...message, content: [...message.content, ...message.content] })).toThrow()
  const legacy = { ...message, formatVersion: 1, content: [{ type: 'text', text: 'old' }], text: 'old' }
  const value = { ...common, entries: [legacy], appendEligibility: { state: 'available' }, imageAvailability: { state: 'unavailable', reason: 'attachment-service-unavailable' }, totalCount: 1, returnedCount: 1, limit: 50, hasEarlier: false, hasMore: false, firstSequence: 1, lastSequence: 1, limits: { maxSegments: 256, maxTextBytes: 4096, maxMessages: 1000, maxBytes: 10000 } }
  const rpc = { call: vi.fn(async (): Promise<{ ok: true; value: unknown }> => ({ ok: true, value })) }, client = new PublicChatClient(rpc)
  await expect(client.historyV3({ schemaVersion: 3, target: common.binding })).resolves.toEqual(value)
  rpc.call.mockResolvedValueOnce({ ok: true, value: { ...value, entries: [{ ...legacy, id: 'second', sequence: 2 }, legacy], returnedCount: 2, firstSequence: 2 } })
  await expect(client.historyV3({ schemaVersion: 3, target: common.binding })).rejects.toThrow('Invalid public history page')
})

it('updates queued visual reasons but never downgrades a claimed recipient', () => {
  const queued = { ...message, delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'captain', state: 'queued' as const, deferredReason: 'image-model-unsupported' as const }] } }
  const claimed = { ...message, delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'captain', state: 'claimed' as const, claimedAt: 5 }] } }
  expect(mergePublicMessages([message], [queued])[0]?.delivery).toEqual(queued.delivery)
  expect(mergePublicMessages([claimed], [queued])[0]?.delivery).toEqual(claimed.delivery)
})

it('encodes the same saved Blob descriptor deterministically and checks current image limits', async () => {
  const draft = { text: '', tokens: [], version: 4, images: [{ blobId: 'blob', mediaType: 'image/png', name: '图.png', status: 'ready' as const, width: 3, height: 2 }] }
  const request = publicDraftRequest(draft, common.binding, 'fixed'), blobs = { blob: new Blob(['original'], { type: 'image/png' }) }
  const wire = await encodePublicDraft(request, blobs)
  expect(wire.content).toEqual([{ type: 'image', mediaType: 'image/png', name: '图.png', data: btoa('original') }])
  expect(await encodePublicDraft(structuredClone(request), structuredClone(blobs))).toEqual(wire)
  expect(() => decodePublicDraft({ draft, pending: { request, version: 4, captain: 'captain', blobIds: [] } }, blobs)).toThrow('Invalid saved image identities')
  const available = { state: 'available' as const, imageLimits: { maxImageBytes: 100, maxImagesPerMessage: 1, maxMessageImageBytes: 100, maxImagePixels: 6, maxImageDimension: 3, mediaTypes: ['image/png' as const] } }
  expect(publicDraftImageIssue(draft, blobs, available)).toBeUndefined()
  expect(publicDraftImageIssue(draft, blobs, { ...available, imageLimits: { ...available.imageLimits, maxImagePixels: 5 } })).toBe('pixels')
  expect(publicDraftImageIssue(draft, blobs, { ...available, imageLimits: { ...available.imageLimits, maxImageDimension: 2 } })).toBe('dimension')
  expect(publicDraftImageIssue(draft, blobs, { ...available, imageLimits: { ...available.imageLimits, maxImageBytes: 2 } })).toBe('size')
})
