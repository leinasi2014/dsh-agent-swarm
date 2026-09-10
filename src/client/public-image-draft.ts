import { z } from 'zod'
import type { PublicChatAppendRequest, PublicChatV2AppendRequest, PublicChatV3AppendRequest } from '../rpc/public-rpc-contract.js'
import { MAX_PUBLIC_CONTENT_SEGMENTS, normalizePublicContent, publicSegmentSchema, type PublicSegment } from '../shared/public-content.js'
import { publicImageMediaTypeSchema, type PublicImageAvailability } from '../shared/public-image-content.js'
import { draftContent, type PublicDraft, type PublicDraftImage } from './public-draft.js'
import type { PublicDraftSnapshot } from './public-draft-store.js'

type LocalImage = z.infer<typeof localImage>
export interface PublicDraftV3Request extends Omit<PublicChatV3AppendRequest, 'content'> { readonly content: readonly (PublicSegment | LocalImage)[] }
export type StoredPublicRequest = PublicChatAppendRequest | PublicChatV2AppendRequest | PublicDraftV3Request
export type StoredPublicSnapshot = PublicDraftSnapshot<StoredPublicRequest>
const id = z.string().min(1), version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const requestFields = { requestId: id, replyTo: z.string().optional(), target: z.object({ rootSessionId: id, teamId: id }) }
const legacyRequest = z.object({ ...requestFields, schemaVersion: z.literal(1), text: z.string() })
const localImage = z.object({ type: z.literal('image'), blobId: id, mediaType: publicImageMediaTypeSchema, name: z.string().optional() }).strict()
const savedSchema = z.object({
  draft: z.object({ text: z.string(), version, replyTo: z.string().optional(), tokens: z.array(z.object({ start: version, end: version, memberId: id, label: z.string() })).default([]),
    images: z.array(z.object({ blobId: id, mediaType: z.string(), name: z.string().optional(), status: z.enum(['checking', 'ready', 'invalid']).optional(), width: version.optional(), height: version.optional(), error: z.enum(['format', 'empty', 'decode']).optional() })).optional(),
  }), legacyUpgrade: z.boolean().optional(),
  pending: z.object({ version, captain: id, blobIds: z.array(id).optional(), upgradedLegacy: z.boolean().optional(), legacyVersion: version.optional(), legacyRequest: legacyRequest.optional(),
    request: z.discriminatedUnion('schemaVersion', [legacyRequest,
      z.object({ ...requestFields, schemaVersion: z.literal(2), content: z.array(publicSegmentSchema).min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS) }),
      z.object({ ...requestFields, schemaVersion: z.literal(3), content: z.array(z.union([publicSegmentSchema, localImage])).min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS) }),
    ]),
  }).optional(),
})
export function decodePublicDraft(value: unknown, blobs: Readonly<Record<string, Blob>> = {}): StoredPublicSnapshot {
  const saved = savedSchema.parse(value)
  if (saved.draft.tokens.some((token, index) => token.end > saved.draft.text.length || token.start >= token.end || token.start < (saved.draft.tokens[index - 1]?.end ?? 0) || saved.draft.text.slice(token.start, token.end) !== `@${token.label}`)) saved.draft.tokens = []
  const images = saved.draft.images ?? []
  const frozenIds = saved.pending?.request.schemaVersion === 3 ? saved.pending.request.content.flatMap(segment => segment.type === 'image' ? [segment.blobId] : []) : []
  if (new Set(images.map(image => image.blobId)).size !== images.length
    || JSON.stringify(frozenIds) !== JSON.stringify(saved.pending?.blobIds ?? [])) throw new Error('Invalid saved image identities')
  for (const blobId of [...images.map(image => image.blobId), ...frozenIds]) if (!(blobs[blobId] instanceof Blob)) throw new Error('Saved image bytes unavailable')
  return { ...saved, blobs } as StoredPublicSnapshot
}
export function publicDraftRequest(draft: PublicDraft, target: PublicChatV3AppendRequest['target'], requestId: string): PublicDraftV3Request {
  const text = draftContent(draft)
  return { schemaVersion: 3, target, requestId, ...(draft.replyTo === undefined ? {} : { replyTo: draft.replyTo }),
    content: [...(text.length === 0 ? [] : normalizePublicContent(text)), ...(draft.images ?? []).map(image => localImage.parse({ type: 'image', blobId: image.blobId, mediaType: image.mediaType, ...(image.name === undefined ? {} : { name: image.name }) }))],
  }
}
export async function encodePublicDraft(request: PublicDraftV3Request, blobs: Readonly<Record<string, Blob>>): Promise<PublicChatV3AppendRequest> {
  const content: PublicChatV3AppendRequest['content'][number][] = []
  for (const segment of request.content) {
    if (segment.type !== 'image') { content.push(segment); continue }
    const blob = blobs[segment.blobId]
    if (blob === undefined) throw new Error('Saved image bytes unavailable')
    const bytes = new Uint8Array(await blob.arrayBuffer()), chunks: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
    content.push({ type: 'image', mediaType: segment.mediaType, data: btoa(chunks.join('')), ...(segment.name === undefined ? {} : { name: segment.name }) })
  }
  return { ...request, content }
}
export function publicImageBlob(data: string, mediaType: string): Blob {
  const binary = atob(data), chunks: BlobPart[] = []
  for (let offset = 0; offset < binary.length; offset += 0x8000) chunks.push(Uint8Array.from(binary.slice(offset, offset + 0x8000), character => character.charCodeAt(0)))
  return new Blob(chunks, { type: mediaType })
}
export type PublicDraftImageIssue = 'checking' | 'unavailable' | 'format' | 'empty' | 'decode' | 'count' | 'size' | 'totalSize' | 'pixels' | 'dimension'
export function publicDraftImageIssue(draft: PublicDraft, blobs: Readonly<Record<string, Blob>>, availability: PublicImageAvailability | undefined): PublicDraftImageIssue | undefined {
  const images = draft.images ?? []
  if (images.length === 0) return undefined
  if (availability?.state !== 'available') return 'unavailable'
  const limits = availability.imageLimits
  if (images.length > limits.maxImagesPerMessage) return 'count'
  let total = 0
  for (const image of images) {
    const blob = blobs[image.blobId]
    if (blob === undefined) return 'decode'
    if (image.status === 'invalid') return image.error ?? 'decode'
    if (!limits.mediaTypes.includes(image.mediaType as typeof limits.mediaTypes[number])) return 'format'
    if (blob.size === 0) return 'empty'
    if (blob.size > limits.maxImageBytes) return 'size'
    if (image.status !== 'ready' || image.width === undefined || image.height === undefined) return 'checking'
    if (image.width > limits.maxImageDimension || image.height > limits.maxImageDimension) return 'dimension'
    if (image.width * image.height > limits.maxImagePixels) return 'pixels'
    total += blob.size
  }
  return total > limits.maxMessageImageBytes ? 'totalSize' : undefined
}
export async function inspectDraftImage(blob: Blob, image: PublicDraftImage): Promise<PublicDraftImage> {
  if (!publicImageMediaTypeSchema.safeParse(image.mediaType).success) return { ...image, status: 'invalid', error: 'format' }
  if (blob.size === 0) return { ...image, status: 'invalid', error: 'empty' }
  try {
    const bitmap = await createImageBitmap(blob)
    try { return { ...image, width: bitmap.width, height: bitmap.height, status: 'ready' } } finally { bitmap.close() }
  } catch { return { ...image, status: 'invalid', error: 'decode' } }
}
