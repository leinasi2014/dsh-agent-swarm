/** Durable protocol owned by the local Team-domain compatibility backend. */

declare const teamIdBrand: unique symbol
declare const taskIdBrand: unique symbol
declare const attemptIdBrand: unique symbol
declare const messageIdBrand: unique symbol

export type TeamId = string & { readonly [teamIdBrand]: true }
export type TaskId = string & { readonly [taskIdBrand]: true }
export type AttemptId = string & { readonly [attemptIdBrand]: true }
export type TeamMessageId = string & { readonly [messageIdBrand]: true }

export const TeamId = (value: string): TeamId => value as TeamId
export const TaskId = (value: string): TaskId => value as TaskId
export const AttemptId = (value: string): AttemptId => value as AttemptId
export const TeamMessageId = (value: string): TeamMessageId => value as TeamMessageId

type TeamMemberPhase = 'provisioning' | 'active' | 'failed' | 'removed'

export interface TeamMember {
  readonly name: string
  readonly role: string
  readonly sessionId: string
  readonly provider: string
  readonly phase: TeamMemberPhase
  readonly createdAt: number
  readonly error?: string
}

type TeamTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'submitted'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * One captain-declared deterministic verification command (M3-2, issue
 * #101). The list is frozen task metadata: it is authored at task creation,
 * survives every rework attempt of the same task unchanged, and is executed
 * only inside a review execution root by the configured review Provider —
 * never in a worker's workspace. `timeoutMs` bounds one execution and is
 * itself bounded by {@link TeamLimits.maxVerificationCommandMs}.
 */
export interface ReviewVerificationCommand {
  readonly command: string
  readonly timeoutMs?: number
}

export interface TeamTask {
  readonly id: TaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly acceptanceCriteria: string[]
  readonly status: TeamTaskStatus
  readonly blockedBy: TaskId[]
  readonly writeScopes: string[]
  readonly priority: number
  /**
   * Captain-declared verification command list (absent when the task
   * declares none — pre-#101 stored records and verification-free tasks keep
   * a byte-identical stored shape). Consumed by executable review Providers.
   */
  readonly verification?: ReviewVerificationCommand[]
  /**
   * Creator-declared guaranteed minimum token allocation (M4-3, issue
   * #129), absent when the task declares none (pre-M4-3 stored records keep
   * a byte-identical stored shape). The declaration is durable task
   * contract metadata; the reservation HOLD it produces is derived
   * scheduling state — the sum of the reservations of `in_progress` tasks —
   * never stored. A claim is reservation-admissible only while
   * `usedTokens + holds (including this task) <= tokenLimit`; reservations
   * are inert while no `tokenLimit` is configured.
   */
  readonly reservationTokens?: number
  /** Captain-selected member that alone may claim this task. */
  readonly targetMemberSessionId?: string
  readonly ownerSessionId?: string
  readonly currentAttemptId?: AttemptId
  readonly output?: string
  readonly createdAt: number
  readonly updatedAt: number
}

type TaskAttemptPhase =
  | 'running'
  | 'submitted'
  | 'verifying'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'stale'

export interface TaskAttempt {
  readonly id: AttemptId
  readonly taskId: TaskId
  readonly generation: number
  readonly memberSessionId: string
  readonly phase: TaskAttemptPhase
  readonly assignmentPhase: 'reserved' | 'delivered'
  readonly assignmentDeliveredAt?: number
  /**
   * The attempt this one replaced in place through the atomic same-owner
   * retry (issue #83): set only by `retryAttempt`, so a misfired retry whose
   * premise died mid-flight can be reversed onto exactly the attempt it
   * fenced. Absent on every other attempt shape.
   */
  readonly replacesAttemptId?: AttemptId
  readonly output?: string
  readonly evidence: string[]
  readonly diagnostic?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type TeamMessageDelivery = 'quiet' | 'wakeup'
type TeamMessagePhase = 'queued' | 'delivered' | 'cancelled'

export interface TeamMessage {
  readonly id: TeamMessageId
  readonly senderSessionId: string
  readonly senderName: string
  readonly targetSessionId: string
  readonly targetName: string
  readonly content: string
  readonly delivery: TeamMessageDelivery
  readonly phase: TeamMessagePhase
  readonly createdAt: number
  readonly deliveredAt?: number
}

export interface TeamBudget {
  readonly tokenLimit?: number
  readonly requestLimit?: number
  readonly retryLimit?: number
  readonly deadlineAt?: number
  readonly usedTokens: number
  readonly usedRequests: number
  readonly usedRetries: number
}

export type TeamMemoryCategory = 'decision' | 'lesson' | 'member' | 'context'

export interface TeamMemoryEntry {
  readonly id: string
  readonly category: TeamMemoryCategory
  readonly content: string
  readonly evidenceRefs: string[]
  readonly createdAt: number
}

export interface TeamState {
  readonly schemaVersion: 1
  readonly id: TeamId
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly captainSessionId: string
  readonly phase: 'active' | 'archived'
  readonly members: TeamMember[]
  readonly tasks: TeamTask[]
  readonly attempts: TaskAttempt[]
  readonly messages: TeamMessage[]
  readonly budget: TeamBudget
  readonly usageCursors: Readonly<Record<string, number>>
  readonly memory: TeamMemoryEntry[]
  readonly nextTaskNumber: number
  readonly nextMemoryNumber: number
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Deployment limits of one Team domain. Mailbox admission follows the
 * official `maxPendingMessagesPerMember` semantics (only queued-minus-
 * delivered mail counts, per target); terminal receipts are bounded
 * separately by `maxRetainedMessages` (M1B/F6). Retained attempt history
 * is bounded per task by `maxRetainedAttempts` (M1B/F7): only terminal
 * attempts (accepted/rejected/cancelled/stale) beyond the newest N of
 * their task are pruned, the referenced current attempt is never pruned,
 * and pruning can never revive a stale attempt id. Captain-declared
 * verification commands are bounded by `maxVerificationCommands` with a
 * hard per-command timeout ceiling of `maxVerificationCommandMs` (M3-2).
 */
export interface TeamLimits {
  readonly maxMembers: number
  readonly maxTasks: number
  /** Per-target pending (queued, not yet delivered/cancelled) mail quota. */
  readonly maxPendingMessagesPerMember: number
  /** Team-wide bound on retained delivered/cancelled receipts (oldest pruned). */
  readonly maxRetainedMessages: number
  /** Per-task bound on retained terminal attempts (oldest pruned). */
  readonly maxRetainedAttempts: number
  readonly maxMessageBytes: number
  readonly maxTaskBytes: number
  readonly maxDependencies: number
  readonly maxMemories: number
  /** Per-task bound on captain-declared verification commands (M3-2). */
  readonly maxVerificationCommands: number
  /** Hard per-command timeout ceiling for executable review (M3-2). */
  readonly maxVerificationCommandMs: number
}

export interface TeamMembership {
  readonly team: TeamState
  readonly role: 'captain' | 'member'
  readonly name: string
}

export interface TeamStatusSnapshot {
  readonly team: TeamState
  readonly readyTaskIds: TaskId[]
  readonly pendingMessageIds: TeamMessageId[]
}
