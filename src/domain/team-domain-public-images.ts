/** v3 public admission and frozen input updates within the existing Team transaction. */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import { actorMembership } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId } from './types.js'
import { PUBLIC_REQUEST_ID_PATTERN, isPublicMessageV3, publicAuthorKey, publicChatReservedBytes, publicManagedParent,
  type AppendPublicMessageInput, type AppendPublicMessageResult, type TeamPublicMessageV3 } from './public-message.js'
import { normalizeStoredPublicImageContent, publicImageBindingDigest, publicImageProjection, publicMessageFrameV3,
  renderPublicImageContent, type PublicImageDeferredReason, type PublicImageRecipient, type PublicInputProjection } from './public-image-message.js'
import { freezeAuthor } from './team-domain-public.js'
import { hasUnconfirmedPublicMention, publicMentionIds } from '../shared/public-content.js'

export async function appendPublicImageMessage(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId,
  input: Extract<AppendPublicMessageInput, { formatVersion: 3 }>): Promise<AppendPublicMessageResult> {
  expectDomain(PUBLIC_REQUEST_ID_PATTERN.test(input.requestId), 'Invalid public request identity', 'TEAM_INPUT_INVALID')
  const content = normalizeStoredPublicImageContent(input.content)
  expectDomain(content.length > 0, 'Public content is empty', 'TEAM_INPUT_INVALID')
  const digest = publicImageBindingDigest(teamId, { ...input, content })
  return await deps.store.transact(scope, teamId, team => {
    if (input.author.kind === 'agent') actorMembership(team, input.author.sessionId)
    const existing = team.publicChat?.messages.find(row => row.requestId === input.requestId
      && publicAuthorKey(row.author) === publicAuthorKey(input.author))
    if (existing !== undefined) {
      expectDomain(existing.bindingDigest === digest, 'Public requestId already binds another payload', 'TEAM_PUBLIC_REQUEST_CONFLICT')
      return { message: structuredClone(existing), replayed: true, teamRevision: team.revision }
    }
    const parent = publicManagedParent(team.managedOrigin)
    expectDomain(team.phase === 'active' && parent !== undefined, 'Public append requires an active managed Team', 'TEAM_PUBLIC_UNSUPPORTED')
    expectDomain(input.expectedCaptainSessionId === undefined || input.expectedCaptainSessionId === team.captainSessionId,
      'Public target Captain changed', 'SWARM_HOST_BINDING_MISMATCH')
    expectDomain(input.expectedTeamRevision === undefined || input.expectedTeamRevision === team.revision,
      'Public target Team revision changed; retry the same request identity', 'TEAM_REVISION_CONFLICT')
    const messages = team.publicChat?.messages ?? []
    expectDomain((input.author.kind !== 'agent' || input.replyTo !== undefined)
      && (input.replyTo === undefined || messages.some(row => row.id === input.replyTo)), 'Invalid public reply target', 'TEAM_PUBLIC_REPLY_INVALID')
    expectDomain(messages.length < deps.limits.maxPublicMessages && input.content.length <= deps.limits.maxPublicSegments,
      'Public message capacity reached', 'TEAM_PUBLIC_CAPACITY')
    const textParts = content.filter(part => part.type !== 'image')
    const labels = publicMentionIds(textParts).map(memberId => {
      const member = team.members.find(row => row.sessionId === memberId && row.phase === 'active')
      expectDomain(memberId === team.captainSessionId || member !== undefined, 'Public recipient is not current', 'TEAM_PUBLIC_RECIPIENT_INVALID')
      return { memberId, label: memberId === team.captainSessionId ? team.captainProfile?.displayName ?? 'captain' : member!.displayName ?? member!.name }
    })
    const author = freezeAuthor(team, input.author)
    expectDomain(author.kind !== 'agent' || labels.length === 0, 'Agent replies do not request delivery', 'TEAM_PUBLIC_RECIPIENT_INVALID')
    expectDomain(author.kind !== 'local-operator' || !hasUnconfirmedPublicMention(textParts), 'Confirm the mention or escape literal @', 'TEAM_PUBLIC_MENTION_UNCONFIRMED')
    const text = renderPublicImageContent({ content, mentionLabels: labels, author })
    expectDomain(Buffer.byteLength(text, 'utf8') <= deps.limits.maxPublicTextBytes, 'Public text capacity reached', 'TEAM_PUBLIC_CAPACITY')
    const body = { id: `public-${randomUUID()}`, sequence: messages.length + 1, createdAt: deps.now(), author, text,
      requestId: input.requestId, bindingDigest: digest, formatVersion: 3 as const, content, mentionLabels: labels,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
    const message: TeamPublicMessageV3 = { ...body, delivery: author.kind === 'agent' ? { kind: 'not-requested' }
      : { kind: 'requested', recipients: (labels.length === 0 ? [team.captainSessionId] : labels.map(row => row.memberId)).map(recipientSessionId => ({
        state: 'queued', recipientSessionId, parentSessionId: recipientSessionId === team.captainSessionId ? parent! : team.captainSessionId,
        frameVersion: 3, frame: publicMessageFrameV3(teamId, body, recipientSessionId),
      })) } }
    const chat = { ...team.publicChat, schemaVersion: 3 as const, messages: [...messages, message] }
    expectDomain(publicChatReservedBytes(chat) <= deps.limits.maxPublicBytes, 'Public byte capacity reached', 'TEAM_PUBLIC_CAPACITY')
    Object.assign(team, { publicChat: chat })
    return { message: structuredClone(message), replayed: false, teamRevision: team.revision + 1 }
  })
}

export function updatePublicImageRecipient(message: TeamPublicMessageV3, recipientId: string,
  update: (recipient: PublicImageRecipient) => PublicImageRecipient): TeamPublicMessageV3 {
  expectDomain(message.delivery.kind === 'requested' && message.delivery.recipients.some(row => row.recipientSessionId === recipientId),
    'Public recipient does not match intent', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
  if (message.delivery.kind !== 'requested') return message
  return { ...message, delivery: { ...message.delivery,
    recipients: message.delivery.recipients.map(row => row.recipientSessionId === recipientId ? update(row) : row) } }
}

/** First confirmed mode is immutable. Repeated identical preparation is a read, not a fresh input. */
export async function preparePublicImageDelivery(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId,
  messageId: string, recipientId: string, mode: PublicInputProjection['mode']): Promise<PublicImageRecipient> {
  return await deps.store.transact(scope, teamId, team => {
    const message = team.publicChat?.messages.find(row => row.id === messageId)
    if (message === undefined || !isPublicMessageV3(message)) throw new TeamDomainError('Public image message not found', 'TEAM_PUBLIC_MESSAGE_NOT_FOUND')
    expectDomain(team.phase === 'active' && (recipientId === team.captainSessionId
      || team.members.some(row => row.sessionId === recipientId && row.phase === 'active')), 'Public recipient retired', 'TEAM_PUBLIC_RECIPIENT_INVALID')
    let prepared!: PublicImageRecipient
    const next = updatePublicImageRecipient(message, recipientId, row => {
      if (row.state !== 'queued' || row.projection !== undefined) { prepared = row; return row }
      const { deferredReason: _reason, ...fields } = row
      prepared = { ...fields, projection: publicImageProjection(message, row, mode) }
      return prepared
    })
    const chat = { ...team.publicChat!, schemaVersion: 3 as const, messages: team.publicChat!.messages.map(row => row.id === messageId ? next : row) }
    expectDomain(publicChatReservedBytes(chat) <= deps.limits.maxPublicBytes, 'Public projection capacity reached', 'TEAM_PUBLIC_CAPACITY')
    Object.assign(team, { publicChat: chat })
    return structuredClone(prepared)
  })
}

export async function deferPublicImageDelivery(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId,
  messageId: string, recipientId: string, reason: PublicImageDeferredReason): Promise<void> {
  await deps.store.transact(scope, teamId, team => {
    const message = team.publicChat?.messages.find(row => row.id === messageId)
    if (message === undefined || !isPublicMessageV3(message)) return
    const next = updatePublicImageRecipient(message, recipientId, row => row.state !== 'queued' || row.deferredReason === reason ? row : { ...row, deferredReason: reason })
    Object.assign(team, { publicChat: { ...team.publicChat!, messages: team.publicChat!.messages.map(row => row.id === messageId ? next : row) } })
  })
}
