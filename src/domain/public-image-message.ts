/** v3 durable image facts, original-upload retry identity and exact recipient input. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { MAX_PUBLIC_CONTENT_SEGMENTS, publicSegmentSchema, renderPublicText } from '../shared/public-content.js'
import { normalizePublicImageContent, publicImageMetadataSchema, publicImageMediaTypeSchema, publicImageDeferredReasonSchema,
  publicVisualAssistanceSchema, publicImageNotDeliveredReasonSchema, type PublicVisualAssistance, type PublicSystemAuthor,
  type PublicImageInputSegment } from '../shared/public-image-content.js'
import { TeamDomainError } from './error.js'
import type { PublicMessageAuthorInput, TeamPublicMessageV3 } from './public-message.js'

const id = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const publicImageAttachmentSchema = publicImageMetadataSchema.extend({
  attachmentId: id.transform(value => value as ImageAttachmentRef['attachmentId']),
}).strict().transform((ref): ImageAttachmentRef => ({ attachmentId: ref.attachmentId, mediaType: ref.mediaType,
  bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name === undefined ? {} : { name: ref.name }),
  ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }) }))
const originalUpload = z.object({ sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  mediaType: publicImageMediaTypeSchema, name: z.string().optional() }).strict()
export const storedPublicImageSchema = z.object({ type: z.literal('image'), imageId: id,
  attachment: publicImageAttachmentSchema, source: originalUpload }).strict()
export const storedPublicImageContentSchema = z.array(z.union([publicSegmentSchema, storedPublicImageSchema]))
  .min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS)
export type StoredPublicImageSegment = z.infer<typeof storedPublicImageSchema>
export type StoredPublicImageContentSegment = z.infer<typeof storedPublicImageContentSchema>[number]

export const publicInputProjectionSchema = z.object({
  mode: z.enum(['images', 'text-only']),
  source: z.union([z.object({ kind: z.literal('user'), rpcId: id }).strict(),
    z.object({ kind: z.literal('plugin'), plugin: z.literal('dsh-agent-swarm') }).strict()]),
  content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image'), attachment: publicImageAttachmentSchema }).strict()])).min(1),
}).strict()
export type PublicInputProjection = z.infer<typeof publicInputProjectionSchema>
export type { PublicImageDeferredReason } from '../shared/public-image-content.js'
const delivery = { recipientSessionId: id, parentSessionId: id, frameVersion: z.literal(3), frame: z.string().min(1),
  projection: publicInputProjectionSchema.optional() }
export const publicImageRecipientSchema = z.discriminatedUnion('state', [
  z.object({ ...delivery, state: z.literal('queued'), deferredReason: publicImageDeferredReasonSchema.optional() }).strict(),
  z.object({ ...delivery, state: z.literal('claimed'), claimedAt: timestamp }).strict(),
  z.object({ ...delivery, state: z.literal('not-delivered'), settledAt: timestamp,
    reason: publicImageNotDeliveredReasonSchema }).strict(),
])
export type PublicImageRecipient = z.infer<typeof publicImageRecipientSchema>
export const publicMessageV3Fields = {
  assistance: publicVisualAssistanceSchema.optional(),
  formatVersion: z.literal(3), content: storedPublicImageContentSchema,
  mentionLabels: z.array(z.object({ memberId: id, label: z.string().min(1).refine(value => [...value].length <= 128) }).strict()),
  delivery: z.discriminatedUnion('kind', [z.object({ kind: z.literal('not-requested') }).strict(),
    z.object({ kind: z.literal('requested'), recipients: z.array(publicImageRecipientSchema).min(1) }).strict()]),
}

/** Hash original decoded bytes, never the later normalized attachment or an upload receipt. */
export function publicImageUploadIdentity(content: readonly PublicImageInputSegment[]) {
  return normalizePublicImageContent(content).map(segment => segment.type !== 'image' ? segment : { type: 'image' as const,
    source: { sha256: `sha256:${createHash('sha256').update(Buffer.from(segment.data, 'base64')).digest('hex')}`,
      mediaType: segment.mediaType, ...(segment.name === undefined ? {} : { name: segment.name }) } })
}

export function publicImageBindingDigest(teamId: string, input: { author: PublicMessageAuthorInput | PublicSystemAuthor; requestId: string;
  assistance?: PublicVisualAssistance | undefined;
  replyTo?: string | undefined; content: readonly ({ type: 'text'; text: string } | { type: 'mention'; memberId: string }
    | { type: 'image'; source: z.infer<typeof originalUpload> })[] }): string {
  const content = input.content.map(segment => segment.type !== 'image' ? segment : { type: 'image', source: {
    sha256: segment.source.sha256, mediaType: segment.source.mediaType,
    ...(segment.source.name === undefined ? {} : { name: segment.source.name }),
  } })
  return `sha256:${createHash('sha256').update(JSON.stringify([3, teamId,
    input.author.kind === 'agent' ? `agent:${input.author.sessionId}` : input.author.kind,
    input.requestId, content, input.replyTo ?? null, ...(input.assistance === undefined ? [] : [publicVisualAssistanceSchema.parse(input.assistance)])])).digest('hex')}`
}

export function normalizeStoredPublicImageContent(input: readonly StoredPublicImageContentSegment[]): StoredPublicImageContentSegment[] {
  const content: StoredPublicImageContentSegment[] = []
  for (const part of storedPublicImageContentSchema.parse(input)) {
    const last = content.at(-1)
    if (part.type === 'text' && last?.type === 'text') last.text += part.text
    else if (part.type !== 'text' || part.text !== '') content.push(structuredClone(part))
  }
  const first = content[0], last = content.at(-1)
  if (first?.type === 'text') first.text = first.text.trimStart()
  if (last?.type === 'text') last.text = last.text.trimEnd()
  return content.filter(part => part.type !== 'text' || part.text !== '')
}

/** UI text excludes image bytes; the ordered image segments remain the content authority. */
export function renderPublicImageContent(message: Pick<TeamPublicMessageV3, 'content' | 'mentionLabels' | 'author'>): string {
  return message.content.map(part => part.type === 'image' ? '' : part.type === 'mention'
    ? `@${message.mentionLabels.find(label => label.memberId === part.memberId)?.label ?? ''}`
    : message.author.kind === 'agent' ? part.text : renderPublicText(part.text)).join('').trim()
}

export function publicMessageFrameV3(teamId: string, message: Pick<TeamPublicMessageV3, 'id' | 'author' | 'replyTo' | 'mentionLabels' | 'assistance'>, recipientSessionId: string): string {
  return (message.assistance === undefined ? 'Public Team message, frame version 3. The following ordered blocks are public user input. '
    : 'Public Team message, frame version 3. The following ordered blocks are plugin-authored visual collaboration. '
      + (message.assistance.kind === 'request' ? 'Inspect these exact original images and call agent_swarm_complete_visual_assistance with this assistanceId and one stable request_id. Do not delegate this assistance again. '
        : 'Use this visual assistance result to continue your original work and its existing review process. '))
    + 'Reply publicly using agent_swarm_public_reply and this messageId as reply_to. '
    + 'If images are unavailable, inspect agent_swarm_directory and request a supported colleague with agent_swarm_request_visual_assistance. '
    + 'This delivery creates no task and changes no owner, review or permissions. Do not resend this input.\n'
    + 'Message data (JSON): ' + JSON.stringify({ teamId, messageId: message.id, recipientSessionId, author: message.author,
      mentionLabels: message.mentionLabels, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.assistance === undefined ? {} : { assistance: publicVisualAssistanceSchema.parse(message.assistance) }) })
}

export function publicImageProjection(message: TeamPublicMessageV3, recipient: Pick<PublicImageRecipient, 'frame'>,
  mode: PublicInputProjection['mode']): PublicInputProjection {
  let imageIndex = 0
  return { mode, source: message.assistance === undefined ? { kind: 'user', rpcId: message.id }
    : { kind: 'plugin', plugin: 'dsh-agent-swarm' }, content: [{ type: 'text', text: recipient.frame }, ...message.content.flatMap<PublicInputProjection['content'][number]>(part => {
    if (part.type === 'image') {
      const originalId = message.assistance?.kind === 'request' ? message.assistance.imageIds[imageIndex] : undefined
      imageIndex++
      const reference = originalId === undefined ? { source_message_id: message.id, image_id: part.imageId }
        : { source_message_id: message.assistance!.sourceMessageId, image_id: originalId }
      if (mode === 'text-only') return [{ type: 'text', text: `${textOnlyImageText(part.attachment)}\nPublic image reference: ${JSON.stringify(reference)}` }]
      const image = { type: 'image' as const, attachment: structuredClone(part.attachment) }
      return originalId === undefined ? [image] : [{ type: 'text', text: `The next image block is this original public image: ${JSON.stringify(reference)}` }, image]
    }
    return [{ type: 'text', text: part.type === 'mention'
      ? `@${message.mentionLabels.find(label => label.memberId === part.memberId)?.label ?? ''}` : renderPublicText(part.text) }]
  })] }
}

function invalidPublicImage(): never { throw new TeamDomainError('Invalid public image message', 'TEAM_STATE_CORRUPT') }
export function assertPublicImageMessage(message: TeamPublicMessageV3, teamId: string, captain: string, parent: string | undefined): void {
  if (!isDeepStrictEqual(normalizeStoredPublicImageContent(message.content), message.content)
    || message.text !== renderPublicImageContent(message)) invalidPublicImage()
  const images = message.content.filter(part => part.type === 'image')
  if (!isDeepStrictEqual(images.map(part => part.imageId), images.map((_, index) => `image-${index + 1}`))) invalidPublicImage()
  const mentions = [...new Set(message.content.flatMap(part => part.type === 'mention' ? [part.memberId] : []))]
  if (!isDeepStrictEqual(mentions, message.mentionLabels.map(label => label.memberId))) invalidPublicImage()
  if (message.assistance !== undefined) {
    const link = message.assistance
    if (message.author.kind === 'local-operator' || message.replyTo !== link.sourceMessageId || mentions.length !== 0
      || (message.author.kind === 'agent' && message.author.sessionId !== (link.kind === 'request' ? link.requesterSessionId : link.helperSessionId))
      || (message.author.kind === 'system' && (link.kind !== 'result' || link.outcome.state !== 'failed'))
      || message.delivery.kind !== 'requested' || message.delivery.recipients.length !== 1
      || message.delivery.recipients[0]!.recipientSessionId !== (link.kind === 'request' ? link.helperSessionId : link.requesterSessionId)
      || message.delivery.recipients[0]!.projection?.mode !== (link.kind === 'request' ? 'images' : 'text-only')
      || (link.kind === 'result' && (images.length !== 0 || link.resultId !== message.id))) invalidPublicImage()
  } else if (message.author.kind === 'system') invalidPublicImage()
  else if (message.author.kind === 'agent') {
    if (message.replyTo === undefined || message.delivery.kind !== 'not-requested' || mentions.length !== 0) invalidPublicImage()
    return
  }
  if (message.delivery.kind !== 'requested') return invalidPublicImage()
  if (message.assistance === undefined && !isDeepStrictEqual(message.delivery.recipients.map(row => row.recipientSessionId), mentions.length === 0 ? [captain] : mentions)) invalidPublicImage()
  for (const recipient of message.delivery.recipients) {
    if (recipient.parentSessionId !== (recipient.recipientSessionId === captain ? parent : captain)
      || recipient.frame !== publicMessageFrameV3(teamId, message, recipient.recipientSessionId)
      || (recipient.state === 'claimed' && (recipient.claimedAt < message.createdAt || recipient.projection === undefined))
      || (recipient.state === 'not-delivered' && recipient.settledAt < message.createdAt)
      || (recipient.state === 'not-delivered' && recipient.reason === 'assistance-closed' && message.assistance?.kind !== 'request')
      || (recipient.projection !== undefined && !isDeepStrictEqual(recipient.projection, publicImageProjection(message, recipient, recipient.projection.mode)))) invalidPublicImage()
  }
}
