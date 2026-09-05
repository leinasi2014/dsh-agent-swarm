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

/** Team lifecycle phases: staged is the plan-first declaration (no Captain Session yet). */
type TeamPhase = 'staged' | 'active' | 'archived'

/**
 * Captain-declared identity profile for one roster member. Every field is
 * optional on the durable record: when absent the read projection honestly
 * reports `not_generated` — old records and members added without a profile
 * keep the exact pre-feature stored shape. When present the values were
 * validated at admission ({@link normalizeMemberIdentity}); `pixelAvatarSvg`
 * passed the strict pixel-rect allowlist and is therefore safe to publish.
 */
export interface TeamMemberIdentityProfile {
  readonly displayName?: string
  readonly profession?: string
  readonly personality?: string
  /** Strictly allowlisted static pixel SVG (`<svg viewBox>` + self-closing
   *  `<rect>` only). Present only when the Captain supplied a safe avatar. */
  readonly pixelAvatarSvg?: string
}

export interface TeamMember extends TeamMemberIdentityProfile {
  readonly name: string
  readonly role: string
  readonly sessionId: string
  readonly provider: string
  readonly phase: TeamMemberPhase
  readonly createdAt: number
  readonly error?: string
  /**
   * Captain-declared member-assigned Skill subset (issue #184): recruit-time
   * names validated against the Team allow-list AND the current scoped Skill
   * catalog before any roster mutation, then persisted in the Team aggregate
   * and reconstructed on restart. Distinct from Team-allowed Skills and from
   * the Session-visible catalog.
   */
  readonly assignedSkills?: string[]
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
type TeamMessagePhase = 'queued' | 'delivered' | 'cancelled' | 'obsolete'

/**
 * Optional causal identity attached to a queued message (mail-obsolescence).
 *
 * The sender may bind a message to the task/attempt context it belongs to so
 * that pre-delivery admission can prove whether that context is still live. All
 * three fields are optional and the whole block is optional; a message with no
 * causal block is not fenced on task/attempt state (only on target removal).
 * The identity is persisted verbatim in the Team aggregate and therefore
 * survives and is rebuilt across reload-restart from the sole authoritative
 * aggregate — it is never regenerated or derived at delivery time.
 */
export interface TeamMessageCausal {
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly revision?: number
}

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
  /**
   * Optional causal identity recorded at queue time (above). Absent on
   * messages queued without a causal binding (including all pre-existing
   * records, which load unchanged).
   */
  readonly causal?: TeamMessageCausal
  /**
   * Explicit supersede: this message supersedes the referenced still-pending
   * earlier message of the same causal chain. The referenced message is marked
   * terminal and auditable as obsolete when this message is queued.
   */
  readonly supersedes?: TeamMessageId
  /** Set on the message superseded by a later queued message (audit inverse). */
  readonly supersededBy?: TeamMessageId
  /** Present exactly when the message settled obsolete (terminal admission). */
  readonly obsoletedAt?: number
  /** Human-readable reason for the obsolete settlement, when obsolete. */
  readonly obsoletedReason?: string
}

/**
 * Durable, secret-free proof that a Team-internal human effect committed in
 * the same aggregate transaction as its mailbox mutation.  This is not a
 * second HumanInteraction store: it is the canonical Team-side read-back
 * evidence used only for the operation named by {@link step}.
 */
export interface TeamInteractionEffect {
  readonly effectId: string
  readonly requestId: string
  readonly step: 'member-question-relay-mail'
  /** Canonical fixed binding, separate from the request/step identity. */
  readonly bindingDigest: string
  readonly senderSessionId: string
  readonly targetSessionId: string
  readonly bodyDigest: string
  readonly delivery: TeamMessageDelivery
  readonly messageId: TeamMessageId
  /** Aggregate revision produced by this same transaction. */
  readonly resultingTeamRevision: number
  readonly committedAt: number
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

/** One Captain-published public announcement (bounded list in the aggregate). */
export interface TeamAnnouncement {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

/** One bounded member declaration inside a staged plan draft. */
interface TeamPlanMember {
  readonly name: string
  readonly role: string
  readonly llmProvider?: string
  readonly model?: string
  readonly denyTools?: readonly string[]
}

/** One bounded task declaration inside a staged plan draft (plan-local keys). */
interface TeamPlanTask {
  readonly key: string
  readonly subject: string
  readonly description: string
  readonly acceptanceCriteria?: readonly string[]
  readonly dependencies?: readonly string[]
  readonly targetMemberName?: string
  readonly writeScopes?: readonly string[]
}

/** Plan-first declaration: the whole pre-approval roster and task graph. */
export interface TeamPlanDraft {
  readonly members: readonly TeamPlanMember[]
  readonly tasks: readonly TeamPlanTask[]
}

export interface TeamState {
  readonly schemaVersion: 1 | 2
  readonly id: TeamId
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly captainSessionId: string
  /** Managed-Team operation identity (MainBrainSessionId + turn), persisted so a
   *  real store reload can re-discover and reuse the same operation's Team.
   *  Absent for plain `agent_swarm_create` (captain-owned compatibility) Teams. */
  readonly managedOrigin?: string
  /**
   * Immutable Skill allow-list chosen when this Team was created. Absent means
   * the Team predates the policy or intentionally inherits host defaults.
   */
  readonly allowedSkills?: string[]
  readonly phase: TeamPhase
  /** Plan-first declaration; present only while phase === 'staged'. */
  readonly planDraft?: TeamPlanDraft
  /** Terminal marker for a discarded staged plan. */
  readonly discardReason?: string
  readonly members: TeamMember[]
  /** Canonical bounded public goal (schema v2, Captain-declared). Absence = explicit
   *  `not_generated` on the read; presence is always the validated canonical form. */
  readonly publicGoal?: string
  /** Captain self-declared identity profile (schema v2). Presence = `generated`,
   *  absence = honest `not_generated`; same code-point/allowlist rules as members. */
  readonly captainProfile?: TeamMemberIdentityProfile
  /** Captain-published public announcements (bounded); absent on pre-feature records. */
  readonly announcements?: TeamAnnouncement[]
  readonly tasks: TeamTask[]
  readonly attempts: TaskAttempt[]
  readonly messages: TeamMessage[]
  /** Required for schema v2; v1 records are upgraded before public read. */
  readonly interactionEffects?: TeamInteractionEffect[]
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
  /** Permanent bound for restart-safe Team-internal effect evidence. */
  readonly maxInteractionEffects: number
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


