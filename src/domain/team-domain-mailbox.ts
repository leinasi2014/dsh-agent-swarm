/**
 * Team mailbox transitions of the Team protocol core.
 *
 * Queues peer messages durably before any delivery attempt (a queued
 * frame survives a crash and is never auto-resent) and acknowledges
 * delivery idempotently. The complete serialized message frame is
 * size-limited, not only its content. Admission follows the official
 * per-target pending semantics (M1B/F6): only queued-minus-delivered
 * mail counts toward `maxPendingMessagesPerMember`, and terminal
 * (delivered/cancelled) receipts are separately bounded retained
 * receipts, pruned oldest-first without touching queued mail.
 */
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { expectDomain } from './error.js'
import { actorMembership, foldMemberName, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import { TeamMessageId, type TeamId, type TeamMessageDelivery, type TeamState } from './types.js'
import type { TeamScope } from './team-domain-port.js'

export async function queueMessage(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  senderSessionId: string,
  targetName: string,
  content: string,
  delivery: TeamMessageDelivery,
): Promise<TeamState['messages'][number]> {
  let committed!: TeamState['messages'][number]
  await deps.store.transact(scope, teamId, team => {
    committed = queueMessageInDraft(deps, team, senderSessionId, targetName, content, delivery)
  })
  return structuredClone(committed)
}

/** Shared mailbox mutation used by ordinary and atomically-correlated sends. */
export function queueMessageInDraft(
  deps: TeamDomainDeps,
  team: TeamState,
  senderSessionId: string,
  targetName: string,
  content: string,
  delivery: TeamMessageDelivery,
): TeamState['messages'][number] {
    const sender = actorMembership(team, senderSessionId)
    // Issue #19 Unicode alignment: targets fold through the same NFC +
    // `\p{L}\p{N}` policy as provisioning, so 'BOB SMITH' resolves the member
    // provisioned as 'Bob Smith' and non-Latin names address exactly their
    // own rows. The `captain` pseudo-name addresses the captain identity.
    const normalizedTarget = foldMemberName(targetName)
    const targetSessionId = normalizedTarget === 'captain'
      ? team.captainSessionId
      : team.members.find(member => member.name === normalizedTarget && member.phase === 'active')?.sessionId
    expectDomain(targetSessionId !== undefined, `target "${targetName}" is not active`, 'TEAM_MESSAGE_TARGET_INVALID')
    // Official admission order (agent-team `sendAdmitted`): a self-addressed
    // target is rejected outright, before quota admission. Both self-send
    // forms fold to this one comparison — the captain addressing the
    // `captain` pseudo-name (any fold variant of it) and a member addressing
    // its own name — because resolution has already collapsed the target to
    // a session id (issue #61 / M1D regression review P2-2).
    expectDomain(
      targetSessionId !== senderSessionId,
      'a Team member cannot message itself',
      'TEAM_SELF_MESSAGE',
    )
    // Official per-target admission: only queued-minus-delivered mail
    // occupies the quota; terminal receipts never block new sends.
    const pendingForTarget = team.messages.filter(message =>
      message.phase === 'queued' && message.targetSessionId === targetSessionId).length
    expectDomain(
      pendingForTarget < deps.limits.maxPendingMessagesPerMember,
      `teammate "${normalizedTarget}" has ${pendingForTarget} pending messages`,
      'TEAM_MAILBOX_FULL',
    )
    const normalizedContent = nonEmpty(content, 'message', deps.limits.maxMessageBytes)
    const timestamp = deps.now()
    const committed: TeamState['messages'][number] = {
      id: TeamMessageId(`message-${randomUUID()}`),
      senderSessionId,
      senderName: sender.name,
      targetSessionId,
      targetName: normalizedTarget,
      content: normalizedContent,
      delivery,
      phase: 'queued',
      createdAt: timestamp,
    }
    expectDomain(
      Buffer.byteLength(JSON.stringify(committed), 'utf8') <= deps.limits.maxMessageBytes,
      'complete message frame is too large',
      'TEAM_INPUT_LIMIT',
    )
    team.messages.push(committed)
    return committed
}

export async function acknowledgeMessage(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  messageId: TeamMessageId,
): Promise<TeamState['messages'][number]> {
  let committed!: TeamState['messages'][number]
  await deps.store.transact(scope, teamId, team => {
    const index = team.messages.findIndex(message => message.id === messageId)
    expectDomain(index >= 0, `message "${messageId}" not found`, 'TEAM_MESSAGE_NOT_FOUND')
    const current = team.messages[index]!
    if (current.phase === 'delivered') {
      committed = current
      return
    }
    expectDomain(current.phase === 'queued', 'only queued mail can be acknowledged', 'TEAM_MESSAGE_PHASE_INVALID')
    committed = { ...current, phase: 'delivered', deliveredAt: deps.now() }
    team.messages[index] = committed
    pruneRetainedMessages(team, deps.limits.maxRetainedMessages)
  })
  return structuredClone(committed)
}

/**
 * Bound the retained delivered/cancelled receipts, pruning the oldest
 * first. Queued mail is never pruned (it is still owed a delivery), and
 * pruning removes whole entries from the front of the creation-ordered
 * array, so the retained replay order, message identities and the store
 * revision sequence stay continuous. Records persisted before this
 * policy existed load unchanged; their receipts are pruned lazily by the
 * next terminal transition that runs through here.
 */
export function pruneRetainedMessages(team: TeamState, maxRetainedMessages: number): void {
  let excess = team.messages.filter(message => message.phase !== 'queued').length - maxRetainedMessages
  for (let index = 0; index < team.messages.length && excess > 0;) {
    if (team.messages[index]!.phase === 'queued') {
      index += 1
      continue
    }
    team.messages.splice(index, 1)
    excess -= 1
  }
}
