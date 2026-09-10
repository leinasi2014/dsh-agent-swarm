/** Explicit public projections, with no raw credentials, durable attachment IDs or execution frames. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { TeamDomainError } from '../domain/error.js'
import { isPublicMessageV2, isPublicMessageV3, publicDeliveries, type TeamPublicMessage } from '../domain/public-message.js'

export function publicImageMetadata(ref: ImageAttachmentRef) {
  return { mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }) }
}

/** Pagination operates on the caller's authorized aggregate cut for every wire version. */
export function projectPublicHistory(messages: readonly TeamPublicMessage[], input: {
  limit: number; beforeSequence?: number | undefined; afterSequence?: number | undefined;
}, version: 1 | 2 | 3) {
  const eligible = messages.filter(row => (input.beforeSequence === undefined || row.sequence < input.beforeSequence)
    && (input.afterSequence === undefined || row.sequence > input.afterSequence))
  const entries = (input.afterSequence === undefined ? eligible.slice(-input.limit) : eligible.slice(0, input.limit)).map(row => projectPublicMessage(row, version))
  const first = entries[0]?.sequence, last = entries.at(-1)?.sequence
  return { entries, totalCount: messages.length, returnedCount: entries.length, limit: input.limit,
    hasEarlier: first === undefined ? messages.some(row => row.sequence < (input.beforeSequence ?? 0)) : messages.some(row => row.sequence < first),
    hasMore: last === undefined ? messages.some(row => row.sequence > (input.afterSequence ?? Number.MAX_SAFE_INTEGER)) : messages.some(row => row.sequence > last),
    ...(first === undefined ? {} : { firstSequence: first, lastSequence: last }) }
}

export function projectPublicMessage(message: TeamPublicMessage, version: 1 | 2 | 3) {
  if (version !== 3 && isPublicMessageV3(message)) throw new TeamDomainError('Use public chat version 3 to read this record', 'SWARM_PUBLIC_VERSION_REQUIRED')
  const base = { id: message.id, sequence: message.sequence, createdAt: message.createdAt, author: message.author, text: message.text,
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) }
  if (version >= 2) {
    const recipients = publicDeliveries(message).map(delivery => ({ recipientSessionId: delivery.recipientSessionId, state: delivery.state,
      ...(delivery.state === 'claimed' ? { claimedAt: delivery.claimedAt } : {}),
      ...(delivery.state === 'not-delivered' ? { settledAt: delivery.settledAt, reason: delivery.reason } : {}),
      ...(version === 3 && delivery.state === 'queued' && 'deferredReason' in delivery && delivery.deferredReason !== undefined
        ? { deferredReason: delivery.deferredReason } : {}) }))
    return { ...base, formatVersion: isPublicMessageV3(message) ? 3 : isPublicMessageV2(message) ? 2 : 1,
      ...(isPublicMessageV3(message) && message.assistance !== undefined ? { assistance: structuredClone(message.assistance) } : {}),
      content: isPublicMessageV3(message) ? message.content.map(part => part.type === 'image'
        ? { type: 'image' as const, imageId: part.imageId, ...publicImageMetadata(part.attachment) } : { ...part })
        : isPublicMessageV2(message) ? message.content : [{ type: 'text' as const, text: message.text }],
      mentionLabels: 'formatVersion' in message ? message.mentionLabels : [],
      delivery: recipients.length === 0 ? { kind: 'not-requested' as const } : { kind: 'requested' as const, recipients } }
  }
  if ('formatVersion' in message) throw new TeamDomainError('Use public chat version 2 to read this record', 'SWARM_PUBLIC_VERSION_REQUIRED')
  const delivery = message.delivery
  return { ...base, delivery: delivery.state === 'not-requested' ? { state: 'not-requested' as const }
    : { state: delivery.state, recipientSessionId: delivery.recipientSessionId,
      ...(delivery.state === 'claimed' ? { claimedAt: delivery.claimedAt } : {}) } }
}
