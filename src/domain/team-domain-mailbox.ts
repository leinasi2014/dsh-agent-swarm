/**
 * Team mailbox transitions of the Team protocol core.
 *
 * Queues peer messages durably before any delivery attempt (a queued
 * frame survives a crash and is never auto-resent) and acknowledges
 * delivery idempotently. The complete serialized message frame is
 * size-limited, not only its content. The M1B mailbox-retention
 * restructuring (F6) lands in this module.
 */
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { expectDomain } from './error.js'
import { actorMembership, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
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
    const sender = actorMembership(team, senderSessionId)
    expectDomain(team.messages.length < deps.limits.maxMessages, 'team message limit reached', 'TEAM_MESSAGE_LIMIT')
    const normalizedTarget = targetName.trim().toLowerCase()
    const targetSessionId = normalizedTarget === 'captain'
      ? team.captainSessionId
      : team.members.find(member => member.name === normalizedTarget && member.phase === 'active')?.sessionId
    expectDomain(targetSessionId !== undefined, `target "${targetName}" is not active`, 'TEAM_MESSAGE_TARGET_INVALID')
    const normalizedContent = nonEmpty(content, 'message', deps.limits.maxMessageBytes)
    const timestamp = deps.now()
    committed = {
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
  })
  return structuredClone(committed)
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
  })
  return structuredClone(committed)
}
