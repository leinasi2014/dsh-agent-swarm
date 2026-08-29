/**
 * The sole authority boundary for the Team aggregate (ADR-0007, M1A).
 *
 * Tools and orchestration consume {@link TeamDomainPort} only; exactly one
 * Provider — a `TeamDomain` over one {@link TeamAggregateStore} — owns
 * roster, task board, mailbox, budget and memory state. The production
 * store persists one versioned Team aggregate record per Team inside an
 * official Storage Domain. The legacy `FileTeamStore` is a read-only
 * offline migration reader and never carries runtime authority.
 */

import type {
  AttemptId,
  TaskAttempt,
  TaskId,
  TeamAnnouncement,
  TeamBudget,
  TeamId,
  TeamMember,
  TeamMemoryCategory,
  TeamMemoryEntry,
  TeamMessage,
  TeamMessageCausal,
  TeamMessageDelivery,
  TeamMessageId,
  TeamInteractionEffect,
  TeamMembership,
  TeamState,
  TeamStatusSnapshot,
  TeamTask,
  ReviewVerificationCommand,
} from './types.js'
import type { MemberIdentityInput } from './identity-profile.js'
import type { QueueMessageOnceResult } from './team-domain-interaction.js'

/**
 * Canonical workspace identity scoping one Team namespace inside the shared
 * storage domain. Each captain/member Session is bound to one workspace cwd,
 * so the resolved cwd is the partition key. Records of other scopes are
 * invisible to `read`/`list` in this scope.
 */
export type TeamScope = string

/** One atomic read-modify-write over a single Team aggregate. */
export type TeamTransaction<T> = (draft: TeamState) => T | Promise<T>

/** Durable proof that one legacy Team aggregate was migrated one-way. */
export interface MigrationReceipt {
  readonly teamId: TeamId
  readonly scope: TeamScope
  /** Legacy workspace-relative state file the aggregate was read from. */
  readonly sourcePath: string
  /** SHA-256 of the untouched legacy source file at migration time. */
  readonly sourceSha256: string
  /** Team revision verified after the durable destination write. */
  readonly revision: number
  readonly migratedAt: number
}

/**
 * Storage-level port behind the domain protocol. One implementation owns the
 * aggregate in production (`StorageDomainTeamStore`); the read-only legacy
 * reader serves migration only. Process-local serialization is explicit and
 * is not a cross-process claim.
 */
export interface TeamAggregateStore {
  /** Stable identifier of the backing authority, for diagnostics. */
  readonly backend: string
  createUniqueForCaptain(scope: TeamScope, state: TeamState): Promise<void>
  read(scope: TeamScope, teamId: TeamId): Promise<TeamState | undefined>
  list(scope: TeamScope): Promise<TeamState[]>
  transact<T>(scope: TeamScope, teamId: TeamId, operation: TeamTransaction<T>): Promise<T>
  waitForChange(scope: TeamScope, teamId: TeamId, afterRevision: number, signal: AbortSignal): Promise<TeamState>
  /**
   * Migration-only durable import of one validated aggregate. Requires an
   * empty destination, writes durably, and verifies the authoritative
   * read-back before resolving.
   */
  importAggregate(scope: TeamScope, team: TeamState): Promise<void>
  readMigrationReceipt(teamId: TeamId): Promise<MigrationReceipt | undefined>
  recordMigrationReceipt(receipt: MigrationReceipt): Promise<void>
  /** Reject waiters and release process-local resources (not the domain). */
  close(): Promise<void>
}

/** Input of one task-creation call. */
export interface CreateTaskInput {
  readonly subject: string
  readonly description: string
  readonly acceptanceCriteria?: readonly string[]
  readonly blockedBy?: readonly TaskId[]
  readonly writeScopes?: readonly string[]
  readonly priority?: number
  /**
   * Captain-declared verification command list (M3-2, issue #101). Frozen
   * task metadata — NOT a review-call parameter: the deterministic check
   * set is part of the task contract, so it cannot drift across rework
   * attempts and the reviewed party has no path to influence it at review
   * time. Executed only inside a review execution root.
   */
  readonly verification?: readonly ReviewVerificationCommand[]
  /**
   * Creator-declared guaranteed minimum token allocation (M4-3, issue
   * #129). Durable task contract metadata; the hold it produces is derived
   * per evaluation (sum of the reservations of in_progress tasks), never
   * stored. A claim is admitted only while the floor plus the outstanding
   * holds fit the remaining budget (`TEAM_BUDGET_RESERVATION` otherwise —
   * admission-postpone, never exhaustion); inert while no `tokenLimit` is
   * configured.
   */
  readonly reservationTokens?: number
  /** Optional strict assignment target; the scheduler must not fall back. */
  readonly targetMemberSessionId?: string
}

/**
 * The one Team authority port consumed by tools and orchestration. All
 * methods are scoped to one workspace partition and enforce the protocol
 * invariants (revision CAS, attempt fencing, review gate, budgets) against
 * the selected aggregate store.
 */
export interface TeamDomainPort {
  createTeam(
    scope: TeamScope,
    captainSessionId: string,
    name: string,
    description: string,
    captainUsageSeq?: number,
  ): Promise<TeamState>
  findMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined>
  requireMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership>
  /**
   * Read-side membership resolution (F14): active-Team membership wins; a
   * session captain of exactly one archived Team keeps read access to that
   * terminal aggregate. Ambiguity fails loud with the same
   * `TEAM_MEMBERSHIP_AMBIGUOUS` vocabulary as the active path.
   */
  findReadMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined>
  requireReadMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership>
  /**
   * Usage-accounting membership resolution (issue #92): resolves exactly the
   * Teams whose ledger `recordSessionUsageBatch` accepts — the captain or a
   * roster row at any member phase, active Teams first, non-active Teams as
   * the fallback tier. This is a billing face, not an authority face: the
   * active-phase-only {@link findMembership} drops a `provisioning` member's
   * first-turn usage (and drain-time usage) by resolving `undefined`.
   */
  findAccountingMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined>
  provisionMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: { name: string; role: string; sessionId: string; provider: string } & MemberIdentityInput,
  ): Promise<TeamMember>
  /** Captain-only: set the Team's public identity profile (validated; expected_revision CAS). */
  setCaptainProfile(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    expectedRevision: number,
    input: MemberIdentityInput,
  ): Promise<TeamState>
  /** Captain-only: publish one bounded public announcement (expected_revision CAS). */
  publishAnnouncement(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    expectedRevision: number,
    text: string,
  ): Promise<{ team: TeamState; announcement: TeamAnnouncement }>
  settleMember(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    outcome: { active: true } | { active: false; error: string },
  ): Promise<TeamMember>
  recoverProvisioningMembers(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    diagnostic: string,
  ): Promise<TeamMember[]>
  removeMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    name: string,
    diagnostic: string,
  ): Promise<{ member: TeamMember; requeuedTaskIds: TaskId[] }>
  archiveTeam(scope: TeamScope, teamId: TeamId, captainSessionId: string, diagnostic: string): Promise<TeamState>
  createTask(scope: TeamScope, teamId: TeamId, actorSessionId: string, input: CreateTaskInput): Promise<TeamTask>
  claimTask(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    assigneeSessionId?: string,
  ): Promise<{ task: TeamTask; attempt: TaskAttempt }>
  /**
   * Durable delivery checkpoint of one assignment attempt (issue #45):
   * fenced by the exact `attemptId` only. The fencing reference
   * (`currentAttemptId`) plus the running-phase check reject every
   * acknowledgement whose generation lost a handoff or already settled;
   * no task metadata revision is required or checked, so a concurrent
   * task write that keeps this attempt current cannot strand the
   * checkpoint in `reserved` (the duplicate re-dispatch face).
   * Idempotent: acknowledging an already-delivered running attempt
   * returns its committed record.
   */
  acknowledgeAssignment(
    scope: TeamScope,
    teamId: TeamId,
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<TaskAttempt>
  submitTask(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
    output: string,
    evidence?: readonly string[],
  ): Promise<TeamTask>
  reviewTask(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
    decision: 'accept' | 'reject',
    diagnostic?: string,
  ): Promise<TeamTask>
  cancelAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    diagnostic: string,
    targetMemberSessionId?: string,
  ): Promise<TeamTask>
  /**
   * Retry the current owner's open `in_progress` attempt in place (issue
   * #83): one transaction stales the fenced attempt with the retry
   * diagnostic and allocates the same-owner successor (recording the attempt
   * it replaced), so the task is continuously `in_progress` — never exposed
   * as `pending` to a reader or a scheduling lane between the transitions.
   * Cost-aware retryLimit (M4-3, issue #129): the retry also charges one
   * `usedRetries` (a failure-driven re-execution generation) alongside the
   * request seat charge; no reservation re-admission happens (the task
   * never leaves `in_progress`, so its hold is already accounted).
   * @returns the retried task and its fresh reserved attempt.
   * @throws {@link TeamDomainError} `TEAM_TASK_STALE_REVISION`,
   * `TEAM_TASK_NOT_REASSIGNABLE` (not the owner's open attempt),
   * `TEAM_CAPTAIN_REQUIRED`, `TEAM_UNAUTHORIZED` (inactive assignee), or a
   * budget exhaustion code.
   */
  retryAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    assigneeSessionId: string,
    diagnostic: string,
  ): Promise<{ task: TeamTask; attempt: TaskAttempt }>
  /**
   * Reverse one misfired in-place retry (issue #83): the undelivered retry
   * attempt is cancelled and the attempt it replaced is reinstated as the
   * task's current running attempt inside one transaction, restoring the
   * not-live owner's evidence-only state without ever exposing `pending`.
   * @returns the reinstated task.
   * @throws {@link TeamDomainError} `TEAM_TASK_STALE_REVISION`,
   * `TEAM_ATTEMPT_STALE` (not the current retry, or no recorded replaced
   * attempt / mismatched replacement), `TEAM_ATTEMPT_PHASE_INVALID` (the
   * retry was already delivered or settled), `TEAM_CAPTAIN_REQUIRED`.
   */
  reinstateAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    misfiredAttemptId: AttemptId,
    diagnostic: string,
  ): Promise<TeamTask>
  queueMessage(
    scope: TeamScope,
    teamId: TeamId,
    senderSessionId: string,
    targetName: string,
    content: string,
    delivery: TeamMessageDelivery,
    causal?: TeamMessageCausal,
    supersedes?: TeamMessage['supersedes'],
  ): Promise<TeamMessage>
  /**
   * Settle one queued message terminal as obsolete with its admission reason
   * (mail-obsolescence). Idempotent for already-obsolete/delivered rows;
   * rejects any other terminal phase. The delivery admission funnel is the
   * sole caller in the runtime; anything that removes the causal context
   * surfaces here through the derived obsolete decision, never a second queue.
   */
  markMessageObsolete(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId, reason: string): Promise<TeamMessage>
  /** I1b first vertical: mailbox mutation and applied evidence are one Team transaction. */
  queueMemberQuestionRelayOnce(
    scope: TeamScope,
    teamId: TeamId,
    senderSessionId: string,
    requestId: string,
    body: string,
  ): Promise<QueueMessageOnceResult>
  findMemberQuestionRelayEffect(
    scope: TeamScope,
    teamId: TeamId,
    requestId: string,
    memberSessionId: string,
    body: string,
  ): Promise<TeamInteractionEffect | undefined>
  acknowledgeMessage(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId): Promise<TeamMessage>
  setBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    limits: Pick<TeamBudget, 'tokenLimit' | 'requestLimit' | 'retryLimit' | 'deadlineAt'>,
  ): Promise<TeamBudget>
  /**
   * Seed one fresh Team's ledger with a prior Team's final budget face (M2-5,
   * issue #79: the budget lifecycle is decoupled from the workflow run).
   * Limits and used counters adopt together in one transaction; the target
   * must still be the untouched fresh-Team default (`TEAM_BUDGET_INVALID`
   * otherwise), so adoption can never overwrite a live ledger. Not a usage
   * write: the per-session usage cursors and the M1B fold semantics are
   * untouched.
   */
  adoptBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    carried: TeamBudget,
  ): Promise<TeamBudget>
  consumeTokens(scope: TeamScope, teamId: TeamId, tokens: number): Promise<TeamBudget>
  recordSessionUsage(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    eventSeq: number,
    tokens: number,
  ): Promise<TeamBudget>
  /**
   * Fold one coalesced batch of usage events in a single transaction (M1C
   * usage write coalescing). Entries fold in ascending event-seq order
   * regardless of submission order (P2-3), so an out-of-order batch matches
   * the single-event semantics exactly: each entry counts only while its
   * event seq exceeds the session's durable usage cursor, and the cursor
   * moves to the highest folded seq, so replay and reload recovery never
   * double-count.
   */
  recordSessionUsageBatch(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    entries: readonly { readonly eventSeq: number; readonly tokens: number }[],
  ): Promise<TeamBudget>
  addMemory(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    category: TeamMemoryCategory,
    content: string,
    evidenceRefs: readonly string[],
  ): Promise<TeamMemoryEntry>
  snapshot(scope: TeamScope, teamId: TeamId, actorSessionId: string): Promise<TeamStatusSnapshot>
  waitForChange(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    afterRevision: number,
    signal: AbortSignal,
  ): Promise<TeamStatusSnapshot>
}
