import { z } from 'zod'
import { isCanonicalPublicImageBase64, publicImageAvailabilitySchema, publicImageDeferredReasonSchema, publicImageNotDeliveredReasonSchema, publicImageHistoryContentSchema, publicImageMetadataSchema, publicVisualAssistanceSchema } from '../shared/public-image-content.js'
import { publicV2Common, publicV2HistorySchema, publicV2MessageSchema, validatePublicMessageLabels } from './public-v2-schema.js'

const requested = publicV2MessageSchema.shape.delivery.options[1]
const recipients = requested.shape.recipients.element.options
export const publicV3Common = { ...publicV2Common, schemaVersion: z.literal(3) }
export const publicV3MessageSchema = z.object({ ...publicV2MessageSchema.shape,
  author: z.discriminatedUnion('kind', [...publicV2MessageSchema.shape.author.options, z.object({ kind: z.literal('system') }).strict()]),
  assistance: publicVisualAssistanceSchema.optional(),
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]), content: publicImageHistoryContentSchema,
  delivery: z.discriminatedUnion('kind', [publicV2MessageSchema.shape.delivery.options[0], requested.extend({
    recipients: z.array(z.discriminatedUnion('state', [recipients[0].extend({ deferredReason: publicImageDeferredReasonSchema.optional() }), recipients[1], recipients[2].extend({ reason: publicImageNotDeliveredReasonSchema })])).min(1),
  })]),
}).superRefine(validatePublicMessageLabels).superRefine((row, context) => {
  const images = row.content.filter(segment => segment.type === 'image')
  if (new Set(images.map(image => image.imageId)).size !== images.length || ((images.length > 0 || row.assistance !== undefined || row.author.kind === 'system') && row.formatVersion !== 3)) context.addIssue({ code: 'custom', message: 'Invalid public image identities or format' })
})
export const publicV3HistorySchema = publicV2HistorySchema.extend({ ...publicV3Common, entries: z.array(publicV3MessageSchema), imageAvailability: publicImageAvailabilitySchema })
export const publicV3ImageSchema = z.object({ ...publicV3Common, messageId: z.string().min(1), imageId: z.string().min(1),
  image: publicImageMetadataSchema.extend({ data: z.string().refine(isCanonicalPublicImageBase64) }).strict(),
}).superRefine((row, context) => {
  const padding = row.image.data.endsWith('==') ? 2 : row.image.data.endsWith('=') ? 1 : 0
  if (row.image.data.length / 4 * 3 - padding !== row.image.bytes) context.addIssue({ code: 'custom', message: 'Invalid public image byte count' })
})
