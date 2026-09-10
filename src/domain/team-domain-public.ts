/** Atomic public append, replay and consumption checkpoint. */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { actorMembership, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId, TeamState } from './types.js'
import {
  PUBLIC_REQUEST_ID_PATTERN, publicAuthorKey, publicBindingDigest, publicChatReservedBytes, publicManagedParent, publicMessageFrame,
  type AppendPublicMessageInput, type AppendPublicMessageResult, type PublicMessageAuthorInput, type TeamPublicAuthor, type TeamPublicMessage,
} from './public-message.js'

function requestId(value: string): string {
  expectDomain(PUBLIC_REQUEST_ID_PATTERN.test(value), 'public requestId must contain 1..128 ASCII identity characters', 'TEAM_INPUT_INVALID')
  return value
}

function freezeAuthor(team: TeamState, author: PublicMessageAuthorInput): TeamPublicAuthor {
  if (author.kind === 'local-operator') return { kind: 'local-operator' }
  const membership = actorMembership(team, author.sessionId)
  const displayName = membership.role === 'captain' ? team.captainProfile?.displayName
    : team.members.find(member => member.sessionId === author.sessionId)?.displayName
  return { kind: 'agent', sessionId: author.sessionId, role: membership.role, name: membership.name,
    ...(displayName === undefined ? {} : { displayName }) }
}

export async function appendPublicMessage(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, input: AppendPublicMessageInput): Promise<AppendPublicMessageResult> {
  const normalized = { ...input, requestId: requestId(input.requestId), text: nonEmpty(input.text, 'public text', deps.limits.maxPublicTextBytes) }
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
    expectDomain(messages.length < deps.limits.maxPublicMessages, 'public message/request capacity reached', 'TEAM_PUBLIC_CAPACITY')
    const base = { id: `public-${randomUUID()}`, sequence: messages.length + 1, createdAt: deps.now(), author,
      text: normalized.text, requestId: normalized.requestId, bindingDigest: digest,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
    const message: TeamPublicMessage = { ...base, delivery: author.kind === 'local-operator'
      ? { state: 'queued', recipientSessionId: team.captainSessionId, parentSessionId: parent,
          frameVersion: 1, frame: publicMessageFrame(team.id, base, team.captainSessionId) }
      : { state: 'not-requested' } }
    const chat = { schemaVersion: 1 as const, messages: [...messages, message] }
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
    const delivery = message.delivery
    expectDomain(delivery.state !== 'not-requested' && delivery.recipientSessionId === recipientSessionId,
      'public receipt recipient does not match the frozen intent', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
    if (delivery.state === 'claimed') return structuredClone(message)
    const next: TeamPublicMessage = { ...message, delivery: { ...delivery, state: 'claimed', claimedAt: Math.max(deps.now(), message.createdAt) } }
    team.publicChat!.messages[index] = next
    return structuredClone(next)
  })
}
