/** Client-safe v3 image vocabulary. Durable attachment identifiers never cross this wire. */
import { z } from 'zod'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { MAX_PUBLIC_CONTENT_SEGMENTS, publicSegmentSchema } from './public-content.js'

export const publicImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Canonical padded base64, including zero pad bits, without Node imports or allocating decoded images.
 * Actual raster/MIME validation and deployment limits belong to official attachment admission.
 */
export function isCanonicalPublicImageBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return false
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const last = alphabet.indexOf(data[data.length - padding - 1]!)
  return last >= 0 && (padding === 2 ? last % 16 === 0 : padding === 1 ? last % 4 === 0 : true)
}

export const publicImageUploadSegmentSchema = z.object({
  type: z.literal('image'), mediaType: publicImageMediaTypeSchema,
  data: z.string().refine(isCanonicalPublicImageBase64, 'Image data must be nonempty canonical base64'),
  name: z.string().optional(),
}).strict()
export const publicImageInputSegmentSchema = z.union([publicSegmentSchema, publicImageUploadSegmentSchema])
export const publicImageContentSchema = z.array(publicImageInputSegmentSchema).min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS)
  .refine(content => content.some(segment => segment.type !== 'text' || segment.text.trim() !== ''), 'Public content is empty')
export type PublicImageUploadSegment = z.infer<typeof publicImageUploadSegmentSchema>
export type PublicImageInputSegment = z.infer<typeof publicImageInputSegmentSchema>

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const publicImageMetadataSchema = z.object({
  mediaType: publicImageMediaTypeSchema, bytes: positiveInteger, width: positiveInteger, height: positiveInteger,
  name: z.string().min(1).max(255).optional(),
  originalDimensions: z.object({ width: positiveInteger, height: positiveInteger }).strict().optional(),
}).strict()
export const publicImageHistorySegmentSchema = publicImageMetadataSchema.extend({
  type: z.literal('image'), imageId: z.string().min(1).max(256),
}).strict()
export const publicImageHistoryContentSchema = z.array(z.union([publicSegmentSchema, publicImageHistorySegmentSchema]))
  .min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS)
export type PublicImageMetadata = z.infer<typeof publicImageMetadataSchema>
export type PublicImageHistorySegment = z.infer<typeof publicImageHistorySegmentSchema>
export type PublicImageHistoryContentSegment = z.infer<typeof publicImageHistoryContentSchema>[number]

/** Exact current ctx.attachments.imageLimits fields; these are admission limits, not normalization targets. */
export const publicImageLimitsSchema = z.object({
  maxImageBytes: positiveInteger, maxImagesPerMessage: positiveInteger, maxMessageImageBytes: positiveInteger,
  maxImagePixels: positiveInteger, maxImageDimension: positiveInteger, mediaTypes: z.array(publicImageMediaTypeSchema),
}).strict()
export type PublicImageLimits = Readonly<ImageAttachmentLimits>
export const publicImageAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), imageLimits: publicImageLimitsSchema }).strict(),
  z.object({ state: z.literal('unavailable'), reason: z.literal('attachment-service-unavailable') }).strict(),
])
export type PublicImageAvailability = z.infer<typeof publicImageAvailabilitySchema>

/** Public, bounded explanations for an unsettled v3 recipient; raw storage/provider errors stay Host-side. */
export const publicImageDeferredReasonSchema = z.enum([
  'image-capability-unknown', 'image-model-unsupported', 'image-unavailable',
  'projection-mismatch', 'recipient-unavailable',
])
export type PublicImageDeferredReason = z.infer<typeof publicImageDeferredReasonSchema>

/** Normalize adjacent text and outside whitespace only; preserve image/mention order and uploaded bytes/name.
 * Host retry identity hashes each image's decoded original bytes plus MIME/name in this ordered form,
 * along with replyTo. Normalized attachment IDs and temporary upload receipts are not input identity.
 */
export function normalizePublicImageContent(input: readonly PublicImageInputSegment[]): PublicImageInputSegment[] {
  const parsed = publicImageContentSchema.parse(input)
  const content: PublicImageInputSegment[] = []
  for (const segment of parsed) {
    if (segment.type !== 'text') { content.push({ ...segment }); continue }
    const last = content.at(-1)
    if (last?.type === 'text') last.text += segment.text
    else if (segment.text !== '') content.push({ ...segment })
  }
  const first = content[0], last = content.at(-1)
  if (first?.type === 'text') first.text = first.text.trimStart()
  if (last?.type === 'text') last.text = last.text.trimEnd()
  return content.filter(segment => segment.type !== 'text' || segment.text !== '')
}
