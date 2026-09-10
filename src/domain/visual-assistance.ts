/** Durable visual collaboration facts inside publicChat, with no second delivery queue. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { publicVisualAssistanceOutcomeSchema } from '../shared/public-image-content.js'
import type { StoredPublicImageSegment } from './public-image-message.js'
import type { TeamPublicChat } from './public-message.js'
import { TeamDomainError } from './error.js'

const id = z.string().min(1).max(256)
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const visualAssistanceSchema = z.object({
  assistanceId: id, requestMessageId: id, resultId: id, sourceMessageId: id,
  requesterSessionId: id, helperSessionId: id, imageIds: z.array(id).min(1), question: z.string().min(1).max(8192),
  createdAt: timestamp, expiresAt: timestamp, visited: z.tuple([id, id]),
  requests: z.array(z.object({ requestId, digest }).strict()).min(1),
  result: z.object({ origin: z.enum(['helper', 'host']), completedAt: timestamp, outcome: publicVisualAssistanceOutcomeSchema,
    requestId: requestId.optional(), digest: digest.optional() }).strict().optional(),
}).strict()
export type VisualAssistance = z.infer<typeof visualAssistanceSchema>
export interface RequestVisualAssistanceInput {
  requestId: string; sourceMessageId: string; imageIds: string[]; helperSessionId: string; question: string
}
export interface CompleteVisualAssistanceInput {
  requestId: string; assistanceId: string; outcome: z.infer<typeof publicVisualAssistanceOutcomeSchema>
}
export interface VisualAssistanceResult { assistance: VisualAssistance; replayed: boolean }
export const VISUAL_ASSISTANCE_TTL_MS = 15 * 60 * 1000

const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
export function visualRequestDigest(input: RequestVisualAssistanceInput): string {
  return hash([input.requestId, input.sourceMessageId, input.imageIds.toSorted(), input.helperSessionId, input.question.trim()])
}
export function visualCompletionDigest(input: CompleteVisualAssistanceInput): string {
  return hash([input.requestId, input.assistanceId, publicVisualAssistanceOutcomeSchema.parse(input.outcome)])
}

function fail(): never { throw new TeamDomainError('Invalid visual collaboration graph', 'TEAM_STATE_CORRUPT') }

/** Validate the immutable graph, not only the shape of separately stored rows. */
export function assertVisualAssistanceGraph(chat: TeamPublicChat): void {
  if (chat.schemaVersion !== 3) return
  const rows = chat.assistances ?? [], ids = new Set<string>(), receipts = new Set<string>(), completions = new Set<string>()
  for (const row of rows) {
    const source = chat.messages.find(message => message.id === row.sourceMessageId)
    const request = chat.messages.find(message => message.id === row.requestMessageId)
    const result = chat.messages.find(message => message.id === row.resultId)
    if (ids.has(row.assistanceId) || row.requestMessageId === row.resultId || row.requesterSessionId === row.helperSessionId
      || row.expiresAt !== row.createdAt + VISUAL_ASSISTANCE_TTL_MS || !isDeepStrictEqual(row.visited, [row.requesterSessionId, row.helperSessionId])
      || !isDeepStrictEqual(row.imageIds, [...new Set(row.imageIds)].toSorted())
      || source === undefined || !('formatVersion' in source) || source.formatVersion !== 3 || source.assistance !== undefined
      || source.delivery.kind !== 'requested' || !source.delivery.recipients.some(recipient => recipient.recipientSessionId === row.requesterSessionId)
      || request === undefined || !('formatVersion' in request) || request.formatVersion !== 3) fail()
    ids.add(row.assistanceId)
    if (source === undefined || !('formatVersion' in source) || source.formatVersion !== 3
      || request === undefined || !('formatVersion' in request) || request.formatVersion !== 3) return fail()
    const images = source.content.filter((part): part is StoredPublicImageSegment => part.type === 'image' && row.imageIds.includes(part.imageId))
    const link = { kind: 'request', assistanceId: row.assistanceId, sourceMessageId: row.sourceMessageId, imageIds: images.map(image => image.imageId),
      requesterSessionId: row.requesterSessionId, helperSessionId: row.helperSessionId, expiresAt: row.expiresAt }
    if (!isDeepStrictEqual(request.assistance, link) || request.text !== row.question || request.createdAt !== row.createdAt
      || images.length !== row.imageIds.length || !isDeepStrictEqual(request.content, [{ type: 'text', text: row.question },
        ...images.map((image, index) => ({ ...image, imageId: `image-${index + 1}` }))])) fail()
    for (const receipt of row.requests) {
      const key = `${row.requesterSessionId}:${receipt.requestId}`
      if (receipts.has(key)) fail()
      receipts.add(key)
    }
    if (row.requests[0]!.digest !== visualRequestDigest({ requestId: row.requests[0]!.requestId, sourceMessageId: row.sourceMessageId,
      imageIds: row.imageIds, helperSessionId: row.helperSessionId, question: row.question })) fail()
    if (row.result === undefined) {
      if (result !== undefined || (request.delivery.kind === 'requested'
        && request.delivery.recipients.some(recipient => recipient.state === 'not-delivered' && recipient.reason === 'assistance-closed'))) fail()
      continue
    }
    const completion = row.result
    if (completion.completedAt < row.createdAt || result === undefined || !('formatVersion' in result) || result.formatVersion !== 3
      || result.createdAt !== completion.completedAt || !isDeepStrictEqual(result.assistance,
        { ...link, kind: 'result', resultId: row.resultId, outcome: completion.outcome })
      || result.text !== (completion.outcome.state === 'completed' ? completion.outcome.summary.trim() : `Visual assistance failed: ${completion.outcome.reason}.`)
      || (completion.origin === 'host' ? result.author.kind !== 'system' || completion.requestId !== undefined || completion.digest !== undefined
        : result.author.kind !== 'agent' || result.author.sessionId !== row.helperSessionId || completion.requestId === undefined
          || completion.digest !== visualCompletionDigest({ requestId: completion.requestId, assistanceId: row.assistanceId, outcome: completion.outcome }))) fail()
    if (completion.requestId !== undefined) {
      const key = `${row.helperSessionId}:${completion.requestId}`
      if (completions.has(key)) fail()
      completions.add(key)
    }
  }
  for (const message of chat.messages) if ('formatVersion' in message && message.formatVersion === 3 && message.assistance !== undefined) {
    const row = rows.find(candidate => candidate.assistanceId === message.assistance!.assistanceId)
    if (row === undefined || message.id !== (message.assistance.kind === 'request' ? row.requestMessageId : row.resultId)) fail()
  }
}
