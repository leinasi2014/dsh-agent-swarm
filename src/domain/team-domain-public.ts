/** Atomic public append, replay and consumption checkpoint. */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { actorMembership, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId, TeamState } from './types.js'
import {
  PUBLIC_REQUEST_ID_PATTERN, publicAuthorKey, publicBindingDigest, publicChatReservedBytes, publicChatReservedMessageCount, publicManagedParent, publicMessageFrame,
  isPublicMessageV2, isPublicMessageV3, publicMessageFrameV2,
  type AppendPublicMessageInput, type AppendPublicMessageResult, type PublicMessageAuthorInput, type TeamPublicAuthor, type TeamPublicMessage,
  type TeamPublicChat, type TeamPublicMessageV2,
} from './public-message.js'
import { hasUnconfirmedPublicMention, normalizePublicContent, publicMentionIds, renderPublicContent } from '../shared/public-content.js'
import { appendPublicImageMessage, updatePublicImageRecipient } from './team-domain-public-images.js'

function requestId(value: string): string {
  expectDomain(PUBLIC_REQUEST_ID_PATTERN.test(value), 'public requestId must contain 1..128 ASCII identity characters', 'TEAM_INPUT_INVALID')
  return value
}

export function freezeAuthor(team: TeamState, author: PublicMessageAuthorInput): Exclude<TeamPublicAuthor, { kind: 'system' }> {
  if (author.kind === 'local-operator') return { kind: 'local-operator' }
  const membership = actorMembership(team, author.sessionId)
  const displayName = membership.role === 'captain' ? team.captainProfile?.displayName
    : team.members.find(member => member.sessionId === author.sessionId)?.displayName
  return { kind: 'agent', sessionId: author.sessionId, role: membership.role, name: membership.name,
    ...(displayName === undefined ? {} : { displayName }) }
}

export async function appendPublicMessage(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, input: AppendPublicMessageInput): Promise<AppendPublicMessageResult> {
  if (input.formatVersion === 3) return await appendPublicImageMessage(deps, scope, teamId, input)
  const normalized = input.formatVersion === 2
    ? { ...input, requestId: requestId(input.requestId), content: normalizePublicContent(input.content) }
    : { ...input, requestId: requestId(input.requestId), text: input.text.trim() }
  const digest = publicBindingDigest(teamId, normalized)
  return await deps.store.transact(scope, teamId, team => {
    if (input.author.kind === 'agent') actorMembership(team, input.author.sessionId)
    const existing = team.publicChat?.messages.find(message => message.requestId === normalized.requestId
      && publicAuthorKey(message.author) === publicAuthorKey(input.author))
    if (existing !== undefined) {
      expectDomain(existing.bindingDigest === digest, 'public requestId already binds another payload', 'TEAM_PUBLIC_REQUEST_CONFLICT')
      return { message: structuredClone(existing), replayed: true, teamRevision: team.revision }
    }
    expectDomain(team.phase === 'active', 'public append requires an active Team', 'TEAM_PUBLIC_UNSUPPORTED')
    const parent = publicManagedParent(team.managedOrigin)
    expectDomain(parent !== undefined, 'public append requires a managed Team', 'TEAM_PUBLIC_UNSUPPORTED')
    expectDomain(input.expectedCaptainSessionId === undefined || input.expectedCaptainSessionId === team.captainSessionId,
      'public target Captain changed', 'SWARM_HOST_BINDING_MISMATCH')
    expectDomain(input.expectedTeamRevision === undefined || input.expectedTeamRevision === team.revision,
      'public target Team revision changed; retry the same request identity', 'TEAM_REVISION_CONFLICT')
    const author = freezeAuthor(team, input.author)
    const messages = team.publicChat?.messages ?? []
    expectDomain((input.author.kind !== 'agent' || input.replyTo !== undefined)
      && (input.replyTo === undefined || messages.some(message => message.id === input.replyTo)),
    'public replyTo must identify an existing message in this Team', 'TEAM_PUBLIC_REPLY_INVALID')
    expectDomain(publicChatReservedMessageCount(team.publicChat) < deps.limits.maxPublicMessages, 'public message/request capacity reached', 'TEAM_PUBLIC_CAPACITY')
    expectDomain(input.formatVersion !== 2 || input.content.length <= deps.limits.maxPublicSegments,
      'public content segment limit reached', 'TEAM_PUBLIC_CAPACITY')
    const labels = normalized.formatVersion === 2 ? publicMentionIds(normalized.content).map(memberId => {
      const member = team.members.find(row => row.sessionId === memberId && row.phase === 'active')
      expectDomain(memberId === team.captainSessionId || member !== undefined,
        'public recipient is not a current Team participant', 'TEAM_PUBLIC_RECIPIENT_INVALID')
      return { memberId, label: memberId === team.captainSessionId
        ? team.captainProfile?.displayName ?? 'captain' : member!.displayName ?? member!.name }
    }) : []
    if (normalized.formatVersion === 2) {
      expectDomain(author.kind !== 'agent' || labels.length === 0, 'Agent replies do not request delivery', 'TEAM_PUBLIC_RECIPIENT_INVALID')
      expectDomain(author.kind !== 'local-operator' || !hasUnconfirmedPublicMention(normalized.content),
        'Confirm the mention or escape the literal @', 'TEAM_PUBLIC_MENTION_UNCONFIRMED')
    }
    const text = nonEmpty(normalized.formatVersion === 2
      ? renderPublicContent(normalized.content, labels, author.kind === 'agent') : normalized.text, 'public text', deps.limits.maxPublicTextBytes)
    const base = { id: `public-${randomUUID()}`, sequence: messages.length + 1, createdAt: deps.now(), author,
      text, requestId: normalized.requestId, bindingDigest: digest,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
    let message: TeamPublicMessage
    if (normalized.formatVersion === 2) {
      const body = { ...base, formatVersion: 2 as const, content: normalized.content, mentionLabels: labels }
      const recipients = labels.length === 0 ? [team.captainSessionId] : labels.map(row => row.memberId)
      message = { ...body, delivery: author.kind === 'agent' ? { kind: 'not-requested' } : { kind: 'requested', recipients: recipients.map(recipientSessionId => ({
        state: 'queued', recipientSessionId, parentSessionId: recipientSessionId === team.captainSessionId ? parent : team.captainSessionId,
        frameVersion: 2, frame: publicMessageFrameV2(team.id, body, recipientSessionId),
      })) } }
    } else message = { ...base, delivery: author.kind === 'local-operator'
      ? { state: 'queued', recipientSessionId: team.captainSessionId, parentSessionId: parent,
          frameVersion: 1, frame: publicMessageFrame(team.id, base, team.captainSessionId) }
      : { state: 'not-requested' } }
    const chat: TeamPublicChat = team.publicChat?.schemaVersion === 3 ? { ...team.publicChat, messages: [...messages, message] }
      : !isPublicMessageV2(message) && (team.publicChat === undefined || team.publicChat.schemaVersion === 1)
      ? { schemaVersion: 1, messages: [...(team.publicChat?.messages ?? []), message] }
      : { schemaVersion: 2, messages: [...(team.publicChat?.messages ?? []), message] }
    expectDomain(publicChatReservedBytes(chat) <= deps.limits.maxPublicBytes,
      'public byte capacity reached (including request evidence and delivery frames)', 'TEAM_PUBLIC_CAPACITY')
    Object.assign(team, { publicChat: chat })
    return { message: structuredClone(message), replayed: false, teamRevision: team.revision + 1 }
  })
}

export async function publicRequestResult(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, author: PublicMessageAuthorInput, id: string): Promise<TeamPublicMessage | undefined> {
  requestId(id)
  const team = await deps.store.read(scope, teamId)
  if (team === undefined) throw new TeamDomainError('Team not found', 'TEAM_NOT_FOUND')
  const message = team.publicChat?.messages.find(row => row.requestId === id && publicAuthorKey(row.author) === publicAuthorKey(author))
  return message === undefined ? undefined : structuredClone(message)
}

export async function acknowledgePublicMessage(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, messageId: string, recipientSessionId: string): Promise<TeamPublicMessage> {
  return await deps.store.transact(scope, teamId, team => {
    const index = team.publicChat?.messages.findIndex(message => message.id === messageId) ?? -1
    expectDomain(index >= 0, 'public message not found', 'TEAM_PUBLIC_MESSAGE_NOT_FOUND')
    const message = team.publicChat!.messages[index]!
    if (isPublicMessageV3(message)) {
      const next = updatePublicImageRecipient(message, recipientSessionId, recipient => {
        if (recipient.state !== 'queued') return recipient
        expectDomain(recipient.projection !== undefined, 'Public image input has not been frozen', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
        const { deferredReason: _reason, ...fields } = recipient
        return { ...fields, state: 'claimed', claimedAt: Math.max(deps.now(), message.createdAt) }
      })
      Object.assign(team, { publicChat: { ...team.publicChat!, messages: team.publicChat!.messages.map((row, at) => at === index ? next : row) } })
      return structuredClone(next)
    }
    if (isPublicMessageV2(message)) {
      const next = updateRecipient(message, recipientSessionId, recipient => recipient.state !== 'queued' ? recipient
        : { ...recipient, state: 'claimed', claimedAt: Math.max(deps.now(), message.createdAt) })
      Object.assign(team, { publicChat: { ...team.publicChat!, messages: team.publicChat!.messages.map((row, at) => at === index ? next : row) } })
      return structuredClone(next)
    }
    const delivery = message.delivery
    expectDomain(delivery.state !== 'not-requested' && delivery.recipientSessionId === recipientSessionId,
      'public receipt recipient does not match the frozen intent', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
    if (delivery.state === 'claimed') return structuredClone(message)
    const next: TeamPublicMessage = { ...message, delivery: { ...delivery, state: 'claimed', claimedAt: Math.max(deps.now(), message.createdAt) } }
    team.publicChat!.messages[index] = next
    return structuredClone(next)
  })
}

type V2Recipient = Extract<TeamPublicMessageV2['delivery'], { kind: 'requested' }>['recipients'][number]
function updateRecipient(message: TeamPublicMessageV2, id: string, update: (recipient: V2Recipient) => V2Recipient): TeamPublicMessageV2 {
  expectDomain(message.delivery.kind === 'requested' && message.delivery.recipients.some(row => row.recipientSessionId === id),
    'public receipt recipient does not match the frozen intent', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
  if (message.delivery.kind !== 'requested') return message
  return { ...message, delivery: { ...message.delivery, recipients: message.delivery.recipients.map(row => row.recipientSessionId === id ? update(row) : row) } }
}

/** Only the delivery owner calls this after proving durable absence, never merely an empty process map. */
export async function settlePublicMessage(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, messageId: string,
  recipientSessionId: string, reason: import('../shared/public-image-content.js').PublicImageNotDeliveredReason): Promise<TeamPublicMessage> {
  return await deps.store.transact(scope, teamId, team => {
    const message = team.publicChat?.messages.find(row => row.id === messageId)
    expectDomain(message !== undefined && 'formatVersion' in message, 'Structured public message not found', 'TEAM_PUBLIC_MESSAGE_NOT_FOUND')
    if (message === undefined || !('formatVersion' in message)) throw new TeamDomainError('Structured public message not found', 'TEAM_PUBLIC_MESSAGE_NOT_FOUND')
    expectDomain(reason === 'assistance-closed' ? isPublicMessageV3(message) && message.assistance?.kind === 'request'
      && team.publicChat?.schemaVersion === 3 && team.publicChat.assistances?.some(row => row.assistanceId === message.assistance!.assistanceId && row.result !== undefined)
      : reason === 'team-archived' ? team.phase === 'archived'
      : recipientSessionId !== team.captainSessionId && !team.members.some(row => row.sessionId === recipientSessionId && row.phase === 'active'),
    'public recipient is still eligible', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
    const next = isPublicMessageV3(message) ? updatePublicImageRecipient(message, recipientSessionId, recipient => {
      if (recipient.state !== 'queued') return recipient
      const { deferredReason: _reason, ...fields } = recipient
      return { ...fields, state: 'not-delivered', reason, settledAt: Math.max(deps.now(), message.createdAt) }
    }) : updateRecipient(message, recipientSessionId, recipient => {
      if (reason === 'assistance-closed') throw new TeamDomainError('Only v3 assistance can close a helper intent', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
      return recipient.state !== 'queued' ? recipient : { ...recipient, state: 'not-delivered',
        reason, settledAt: Math.max(deps.now(), message.createdAt) }
    })
    Object.assign(team, { publicChat: { ...team.publicChat!, messages: team.publicChat!.messages.map(row => row.id === messageId ? next : row) } })
    return structuredClone(next)
  })
}
