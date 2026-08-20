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
  TeamBudget,
  TeamId,
  TeamMember,
  TeamMemoryCategory,
  TeamMemoryEntry,
  TeamMessage,
  TeamMessageDelivery,
  TeamMessageId,
  TeamMembership,
  TeamState,
  TeamStatusSnapshot,
  TeamTask,
} from './types.js'

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
  provisionMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: { name: string; role: string; sessionId: string; provider: string },
  ): Promise<TeamMember>
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
  ): Promise<TeamTask>
  queueMessage(
    scope: TeamScope,
    teamId: TeamId,
    senderSessionId: string,
    targetName: string,
    content: string,
    delivery: TeamMessageDelivery,
  ): Promise<TeamMessage>
  acknowledgeMessage(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId): Promise<TeamMessage>
  setBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    limits: Pick<TeamBudget, 'tokenLimit' | 'requestLimit' | 'retryLimit' | 'deadlineAt'>,
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
