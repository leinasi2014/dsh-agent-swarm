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
import { expectDomain, TeamDomainError } from './error.js'
import { actorMembership, foldMemberName, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import { TeamMessageId, type TeamId, type TeamMessage, type TeamMessageCausal, type TeamMessageDelivery, type TeamState } from './types.js'
import type { TeamScope } from './team-domain-port.js'

export async function queueMessage(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  senderSessionId: string,
  targetName: string,
  content: string,
  delivery: TeamMessageDelivery,
  causal?: TeamMessageCausal,
  supersedes?: TeamMessage['supersedes'],
): Promise<TeamState['messages'][number]> {
  let committed!: TeamState['messages'][number]
  await deps.store.transact(scope, teamId, team => {
    committed = queueMessageInDraft(deps, team, senderSessionId, targetName, content, delivery, causal, supersedes)
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
  causal?: TeamMessageCausal,
  supersedes?: TeamMessage['supersedes'],
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
    // Mail-obsolescence: the optional causal identity is validated before it
    // is ever persisted. A headline revision, if present, must be a positive
    // safe integer; when both a task and an attempt are bound they must agree
    // on the task. These are the sender-declared facts the delivery admission
    // funnel re-derives against the authoritative aggregate.
    const normalizedCausal = causal === undefined ? undefined : normalizeCausal(causal, team)
    if (supersedes !== undefined) {
      const prior = team.messages.find(candidate => candidate.id === supersedes)
      expectDomain(prior !== undefined, `superseded message "${supersedes}" not found`, 'TEAM_MESSAGE_NOT_FOUND')
      expectDomain(prior.phase === 'queued', 'only a still-pending message can be superseded', 'TEAM_MESSAGE_PHASE_INVALID')
    }
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
      ...(normalizedCausal === undefined ? {} : { causal: normalizedCausal }),
      ...(supersedes === undefined ? {} : { supersedes }),
    }
    expectDomain(
      Buffer.byteLength(JSON.stringify(committed), 'utf8') <= deps.limits.maxMessageBytes,
      'complete message frame is too large',
      'TEAM_INPUT_LIMIT',
    )
    team.messages.push(committed)
    // Explicit supersede (mail-obsolescence): a later message of the same
    // causal chain settles the still-pending predecessor terminal as obsolete
    // in the same aggregate transaction, so its result is immediately
    // auditable and it is never delivered or wakes anyone.
    if (supersedes !== undefined) {
      const index = team.messages.findIndex(candidate => candidate.id === supersedes)
      const prior = team.messages[index]!
      team.messages[index] = {
        ...prior,
        phase: 'obsolete',
        supersededBy: committed.id,
        obsoletedAt: timestamp,
        obsoletedReason: `superseded by ${committed.id}`,
      }
    }
    pruneRetainedMessages(team, deps.limits.maxRetainedMessages)
    return committed
}

/** Normalize and validate one sender-declared causal identity block. */
export function normalizeCausal(causal: TeamMessageCausal, team: TeamState): TeamMessageCausal {
  const { taskId, attemptId, revision } = causal
  if (taskId !== undefined && !team.tasks.some(task => task.id === taskId)) {
    throw new TeamDomainError(`causal task "${taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
  }
  if (taskId !== undefined && attemptId !== undefined) {
    const attempt = team.attempts.find(candidate => candidate.id === attemptId)
    if (attempt === undefined) {
      throw new TeamDomainError(`causal attempt "${attemptId}" not found`, 'TEAM_ATTEMPT_NOT_FOUND')
    }
    if (attempt.taskId !== taskId) {
      throw new TeamDomainError(`causal attempt "${attemptId}" does not belong to task "${taskId}"`, 'TEAM_ATTEMPT_TASK_MISMATCH')
    }
  }
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new TeamDomainError('causal revision must be a positive safe integer', 'TEAM_INPUT_INVALID')
  }
  return { ...(taskId === undefined ? {} : { taskId }), ...(attemptId === undefined ? {} : { attemptId }), ...(revision === undefined ? {} : { revision }) }
}

/**
 * Mail-obsolescence admission predicate: the single obsolete funnel every
 * queued message passes through immediately before any delivery attempt.
 *
 * Returns a human-readable reason when the message must be settled obsolete —
 * and therefore must NOT be delivered, injected, followed-up or used to wake
 * its target — or `undefined` when it may be delivered. The decision is
 * derived from the authoritative aggregate at delivery time, so every prior
 * terminal transition (task completed/cancelled, attempt fenced stale / its
 * task's `currentAttemptId` moved on, target removed) is reflected without any
 * second state machine or second queue.
 */
export function messageObsoleteReason(team: TeamState, message: TeamMessage): string | undefined {
  if (message.phase !== 'queued') return undefined
  const target = team.members.find(member => member.sessionId === message.targetSessionId)
  if (target !== undefined && target.phase === 'removed' && message.targetSessionId !== team.captainSessionId) {
    return `target ${target.name} is removed`
  }
  const causal = message.causal
  if (causal === undefined) return undefined
  if (causal.taskId !== undefined) {
    const task = team.tasks.find(candidate => candidate.id === causal.taskId)
    if (task !== undefined && (task.status === 'completed' || task.status === 'cancelled')) {
      return `task ${task.id} is ${task.status}`
    }
    // Attempt replacement fencing is against the task's CURRENT attempt, not
    // the (possibly already-pruned) bound attempt: any current attempt other
    // than the bound one means the bound generation lost its handoff, so the
    // fence survives retention pruning of the old attempt.
    if (task !== undefined && causal.attemptId !== undefined && task.currentAttemptId !== causal.attemptId) {
      return `attempt ${causal.attemptId} is no longer current`
    }
  }
  if (causal.attemptId !== undefined) {
    const attempt = team.attempts.find(candidate => candidate.id === causal.attemptId)
    const attemptTask = attempt === undefined ? undefined : team.tasks.find(candidate => candidate.id === attempt.taskId)
    if (attempt !== undefined && attemptTask !== undefined && attemptTask.currentAttemptId !== causal.attemptId) {
      return `attempt ${attempt.id} is no longer current`
    }
  }
  return undefined
}

/** Settle one queued message terminal as obsolete with its admission reason. */
export async function markMessageObsolete(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  messageId: TeamMessageId,
  reason: string,
): Promise<TeamState['messages'][number]> {
  let committed!: TeamState['messages'][number]
  await deps.store.transact(scope, teamId, team => {
    const index = team.messages.findIndex(message => message.id === messageId)
    expectDomain(index >= 0, `message "${messageId}" not found`, 'TEAM_MESSAGE_NOT_FOUND')
    const current = team.messages[index]!
    if (current.phase === 'obsolete' || current.phase === 'delivered') {
      committed = current
      return
    }
    expectDomain(current.phase === 'queued', 'only queued mail can be settled obsolete', 'TEAM_MESSAGE_PHASE_INVALID')
    committed = {
      ...current,
      phase: 'obsolete',
      obsoletedAt: deps.now(),
      obsoletedReason: nonEmpty(reason, 'obsolete reason', 2_048),
    }
    team.messages[index] = committed
    pruneRetainedMessages(team, deps.limits.maxRetainedMessages)
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
