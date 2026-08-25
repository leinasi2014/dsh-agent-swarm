/**
 * One serialized Team scheduling pass (issue #12 / F10 discipline).
 *
 * Collaborator of the orchestrator runtime: it consumes the authoritative
 * snapshot and executes, in order, the reference scheduler discipline
 * (docs/02 §7.2): queued mailbox backlog first, then reserved-attempt
 * delivery, then stranded-ownership self-healing, then new assignments
 * restricted to genuinely available members. A failed assignment dispatch
 * rolls back exactly its own reservation under a `currentAttemptId` CAS
 * guard. Decisions and divergences: docs/04 §7 and §8c.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskId, type AttemptId, type TaskAttempt, type TeamId, type TeamMember, type TeamState, type TeamTask } from '../domain/types.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import { budgetExhaustion, outstandingReservationTokens, reservationAdmissible } from '../domain/team-domain-budget.js'
import { frameVisibility, waitForFrameClaim, type FrameVisibility } from './frame-visibility.js'
import type { ExecutionRoots } from './execution-roots.js'
import type { MessageDelivery } from './message-delivery.js'
import { assignmentPrompt } from './prompts.js'
import type { TeamSchedulerProvider } from './providers.js'
import type { UsageAccountant } from './usage-accounting.js'

export interface SchedulingDeps {
  readonly domain: () => TeamDomainPort
  readonly delivery: () => MessageDelivery
  readonly usage: () => UsageAccountant
  readonly schedulerProvider: () => string
  readonly schedulerProviders: () => Map<string, TeamSchedulerProvider>
  /** Stranded-ownership grace bound in ms; 0 disables automatic retry. */
  readonly strandedAfterMs: number
  /**
   * When the live owner's CURRENT idle stretch began (the observed
   * `agent/status → idle` edge), or `undefined` when this runtime never
   * observed an edge for it. The stranded grace consumes this latch so a
   * teardown's fresh idle edge cannot fire the heal through the teardown
   * window (issue #83).
   */
  readonly idleSince: (sessionId: string) => number | undefined
  /**
   * Whether the autonomous event face may drive this Team (M2-3, issue
   * #77): `adaptive` mode and not workflow-run-owned. Gates the stranded
   * self-healing (and with it the re-kick timers) — the one scheduling-pass
   * section that makes autonomous retry decisions. Delivery sections
   * (mailbox backlog, reserved folds, assignment dispatch) run in every
   * pass on every Team: they are the run/operation's own consumption of
   * the delivery mechanics, fenced by the revision CAS.
   */
  readonly eventFaceActive: (scope: TeamScope, teamId: TeamId) => boolean
  readonly isClosing: () => boolean
  readonly trackTeamChildren: (captain: Agent, team: TeamState) => void
  readonly requestSchedule: (scope: TeamScope, teamId: TeamId, captain: Agent) => void
  /**
   * Per-attempt execution roots (M3-1, issue #100): the manager that fences
   * every dispatched assignment into its isolated working root and releases
   * roots once their attempt settles.
   */
  readonly executionRoots: () => ExecutionRoots
  /** Whether the execution-root capability is enabled for this runtime. */
  readonly executionRootsEnabled: () => boolean
  /** Release roots whose attempts settled (authority-derived sweep). */
  readonly sweepExecutionRoots: (scope: TeamScope, teamId: TeamId) => Promise<void>
  /** Materialize a dormant declared member with its first assignment frame. */
  readonly startAssignedMember: (
    captain: Agent,
    scope: TeamScope,
    team: TeamState,
    member: TeamMember,
    frame: string,
    signal: AbortSignal,
  ) => Promise<void>
}

/**
 * A member is schedulable for new work only when it is not live (a cold
 * member is cold-resumed by the assignment delivery itself), or live and
 * idle. A live `running` member owns its current turn and is excluded
 * (issue #12 / F10); the `agent/status → idle` edge remains the wake that
 * re-runs the deferred assignment.
 */
function memberAvailable(ctx: Context, sessionId: string): boolean {
  const live = ctx.agents.get(SessionId(sessionId))
  return live === undefined || live.status === 'idle'
}

/** Serialized scheduling passes plus the stranded self-healing state. */
export class SchedulingPass {
  private readonly rekickTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: SchedulingDeps,
  ) {}

  async run(scope: TeamScope, teamId: TeamId, captain: Agent): Promise<void> {
    if (this.deps.isClosing()) return
    let snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)
    this.deps.trackTeamChildren(captain, snapshot.team)

    // 1. Mailbox backlog first (reference discipline): queued fallback mail
    //    is real pending work and delivers before any new assignment. A
    //    member that just received waking mail is running again, so its new
    //    assignment defers to the next idle edge.
    const hadQueuedMail = snapshot.pendingMessageIds.length > 0
    for (const messageId of snapshot.pendingMessageIds) {
      if (this.deps.isClosing()) return
      const queued = snapshot.team.messages.find(message => message.id === messageId)
      const target = queued === undefined
        ? undefined
        : snapshot.team.members.find(member => member.sessionId === queued.targetSessionId)
      // A declared member has no Session yet. Its first model-visible user
      // frame must remain the authoritative assignment; queued peer mail is
      // retained and delivered after that activation instead of creating an
      // unassigned bootstrap turn or blocking the first assignment forever.
      if (target?.phase === 'provisioning') continue
      await this.deps.delivery().deliverQueuedMessage(scope, teamId, captain, messageId, AbortSignal.timeout(30_000))
    }
    if (hadQueuedMail) snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)

    // 2. Reserved attempts (issue #60 / P2-1): fold each delivery debt
    //    against the owner's durable facts first — an already-CLAIMED frame
    //    owes only its acknowledgement, a still-PENDING (or unverifiable)
    //    frame is neither resent nor acknowledged (a second frame would
    //    duplicate model-visible delivery), and an ABSENT frame (never
    //    delivered, or discarded unread by an official teardown drain) is
    //    redelivered exactly once.
    const reserved = snapshot.team.tasks.flatMap(task => {
      if (task.status !== 'in_progress' || task.currentAttemptId === undefined) return []
      const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
      return attempt?.phase === 'running' && attempt.assignmentPhase === 'reserved' ? [{ task, attempt }] : []
    })
    for (const { task, attempt } of reserved) {
      if (this.deps.isClosing()) return
      const owner = snapshot.team.members.find(member => member.sessionId === attempt.memberSessionId)
      if (owner?.phase === 'provisioning') {
        await this.dispatchAssignment(scope, snapshot.team, captain, task, attempt)
        continue
      }
      if (await this.settleReservedAssignment(scope, snapshot.team, task, attempt)) continue
      await this.dispatchAssignment(scope, snapshot.team, captain, task, attempt)
    }
    if (reserved.length > 0) snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)

    // 3. Stranded-ownership self-healing (docs/04 §8c). Skipped entirely
    //    while the budget face is exhausted (M4-3, issue #129): a budget
    //    hold is TEAM economics, not an owner-liveness defect — no retry
    //    can pass admission, so the pre-M4-3 doomed retryAttempt calls and
    //    per-pass warn noise are gone; open tasks surface as budget-hold
    //    evidence and the §8n recovery pass re-drives them once the captain
    //    raises the budget.
    if (await this.healStrandedOwnership(scope, teamId, captain, snapshot.team)) {
      snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)
    }

    // 4. New assignments: ownership-busy members and live running members
    //    are excluded; the configured Provider decides among the rest.
    //    Budget-aware selection (M4-3, issue #129): ready tasks whose
    //    declared reservation floor does not fit the remaining budget
    //    (after the outstanding in_progress holds) are POSTPONED — never
    //    offered to the Provider this pass; claimTask enforces the same
    //    predicate authoritatively, and its `TEAM_BUDGET_RESERVATION` (a
    //    racing settlement moved the face between filter and claim) is a
    //    skip-and-next-pass like the stale-revision/member-busy races.
    const busy = new Set(snapshot.team.tasks
      .filter(task => ['in_progress', 'submitted', 'verifying'].includes(task.status))
      .map(task => task.ownerSessionId)
      .filter((value): value is string => value !== undefined))
    const members = snapshot.team.members
      .filter(member => (member.phase === 'provisioning' || member.phase === 'active')
        && !busy.has(member.sessionId) && memberAvailable(this.ctx, member.sessionId))
      .toSorted((left, right) => left.createdAt - right.createdAt)
    const outstandingReserved = outstandingReservationTokens(snapshot.team.tasks)
    const ready = snapshot.team.tasks
      .filter(task => snapshot.readyTaskIds.includes(task.id)
        && reservationAdmissible(snapshot.team.budget, outstandingReserved, task.reservationTokens ?? 0))
      .toSorted((left, right) => right.priority - left.priority || left.createdAt - right.createdAt)

    const provider = this.deps.schedulerProviders().get(this.deps.schedulerProvider())
    if (provider === undefined) {
      throw new TeamDomainError(`scheduler Provider "${this.deps.schedulerProvider()}" is unavailable`, 'TEAM_SCHEDULER_PROVIDER_MISSING')
    }
    const decisions = await provider.select({ team: snapshot.team, readyTasks: ready, availableMembers: members })
    const availableById = new Map(members.map(member => [member.sessionId, member]))
    const readyById = new Map(ready.map(task => [task.id, task]))
    const seenMembers = new Set<string>()
    const seenTasks = new Set<string>()
    for (const decision of decisions) {
      if (this.deps.isClosing()) break
      const member = availableById.get(decision.memberSessionId)
      const task = readyById.get(TaskId(decision.taskId))
      if (member === undefined || task === undefined || seenMembers.has(member.sessionId) || seenTasks.has(task.id)) {
        throw new TeamDomainError('scheduler Provider returned an invalid or duplicate decision', 'TEAM_SCHEDULER_DECISION_INVALID')
      }
      if (task.targetMemberSessionId !== undefined && task.targetMemberSessionId !== member.sessionId) {
        throw new TeamDomainError('scheduler Provider violated a strict task assignment', 'TEAM_SCHEDULER_DECISION_INVALID')
      }
      seenMembers.add(member.sessionId)
      seenTasks.add(task.id)
      let claim
      try {
        claim = await this.deps.domain().claimTask(scope, teamId, captain.id, task.id, task.revision, member.sessionId)
      } catch (error) {
        if (error instanceof TeamDomainError && ['TEAM_TASK_STALE_REVISION', 'TEAM_MEMBER_BUSY', 'TEAM_BUDGET_RESERVATION'].includes(error.code)) continue
        throw error
      }
      await this.dispatchAssignment(scope, snapshot.team, captain, claim.task, claim.attempt)
    }
  }

  /**
   * Deliver one claimed assignment, or roll back exactly its reservation.
   *
   * Issue #60 / P2-1 (the #52 claimed-gate, generalized): the followup's
   * return only proves inbox ADMISSION — the pending form, which an aborted
   * turn's teardown or an Activation disposal drain may still discard. The
   * `delivered` checkpoint therefore commits only after the assignment frame
   * is CLAIMED into the member's model-visible history; an unclaimed frame
   * keeps the attempt `reserved`, and the reserved fold above (or the
   * member's next `agent/status → idle` edge driving it) settles the debt.
   */
  private async dispatchAssignment(
    scope: TeamScope,
    team: TeamState,
    captain: Agent,
    task: TeamTask,
    attempt: TaskAttempt,
  ): Promise<void> {
    // M3-1 (issue #100): fence this attempt into its execution root BEFORE
    // the frame exists — the frame declares the deterministic root path, and
    // a failed acquisition is a failed dispatch that rolls back exactly its
    // own reservation (the claim-time discipline of §8c).
    let executionRootPath: string | undefined
    if (this.deps.executionRootsEnabled()) {
      try {
        executionRootPath = (await this.deps.executionRoots().acquire(scope, team.id, task.id, attempt.id)).path
      } catch (error) {
        await this.rollbackUndeliveredAssignment(
          scope,
          team.id,
          captain.id,
          task.id,
          attempt.id,
          `execution root acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
    }
    const frame = assignmentPrompt(team, task, attempt.id, executionRootPath)
    try {
      const owner = team.members.find(member => member.sessionId === attempt.memberSessionId)
      if (owner?.phase === 'provisioning') {
        await this.deps.startAssignedMember(captain, scope, team, owner, frame, AbortSignal.timeout(30_000))
      } else {
        await this.ctx.subagents.followup(
          captain,
          SessionId(attempt.memberSessionId),
          [{ type: 'text', text: frame }],
          { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal: AbortSignal.timeout(30_000) },
        )
      }
    } catch (error) {
      const owner = team.members.find(member => member.sessionId === attempt.memberSessionId)
      if (owner?.phase === 'provisioning') {
        const diagnostic = `initial assignment delivery failed: ${error instanceof Error ? error.message : String(error)}`
        await this.deps.domain().settleMember(scope, team.id, owner.sessionId, { active: false, error: diagnostic })
        await this.deps.sweepExecutionRoots(scope, team.id)
        this.deps.requestSchedule(scope, team.id, captain)
        return
      }
      await this.rollbackUndeliveredAssignment(
        scope,
        team.id,
        captain.id,
        task.id,
        attempt.id,
        `assignment delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    // Observe the CURRENT live member (the followup may have cold-resumed
    // it) and wait one bounded claim grace; an absent member or an unclaimed
    // frame leaves the attempt reserved — never a rollback, because the
    // accepted frame may still be claimed by the turn it parked behind.
    try {
      const member = this.ctx.agents.get(SessionId(attempt.memberSessionId))
      if (member === undefined || !await waitForFrameClaim(this.ctx, member, frame, AbortSignal.timeout(30_000))) return
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: assignment claim wait failed for ${task.id}: ${String(error)}`)
      return
    }
    const declaredOwner = team.members.find(member => member.sessionId === attempt.memberSessionId)?.phase === 'provisioning'
    if (declaredOwner) {
      try {
        await this.deps.domain().activateInitialAssignment(
          scope, team.id, attempt.memberSessionId, task.id, attempt.id,
        )
      } catch (error) {
        this.ctx.logger.warn(`agent-swarm: initial assignment activation deferred for ${task.id}: ${String(error)}`)
        return
      }
      await this.deps.sweepExecutionRoots(scope, team.id)
    } else {
      await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)
    }
    const member = this.ctx.agents.get(SessionId(attempt.memberSessionId))
    if (member !== undefined) await this.deps.usage().accountAgentUsage(scope, team.id, member)
  }

  /**
   * Fold one reserved attempt's delivery debt against the owner's durable
   * facts (issue #60, the #52 fold on the assignment path): `true` means the
   * attempt needs no dispatch this pass — the frame is already CLAIMED (the
   * acknowledgement is the only debt), or still PENDING / unverifiable
   * (never resend: the parked frame is still claimable at its turn boundary,
   * and a second frame would duplicate model-visible delivery); `false`
   * means no acceptance exists anywhere and {@link dispatchAssignment}
   * redelivers exactly once.
   */
  private async settleReservedAssignment(
    scope: TeamScope,
    team: TeamState,
    task: TeamTask,
    attempt: TaskAttempt,
  ): Promise<boolean> {
    // The frame identity recomputed here must stay byte-identical to the one
    // dispatched — with execution roots enabled (M3-1) that includes the
    // attempt's deterministic root path, derived the same pure way.
    const executionRootPath = this.deps.executionRootsEnabled()
      ? this.deps.executionRoots().declarationPathFor(scope, team.id, task.id, attempt.id)
      : undefined
    const visibility: FrameVisibility = await frameVisibility(
      this.ctx, attempt.memberSessionId, assignmentPrompt(team, task, attempt.id, executionRootPath),
      AbortSignal.timeout(30_000), `assignment ${attempt.id}`,
    )
    if (visibility === 'absent') return false
    if (visibility === 'claimed') await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)
    return true
  }

  /**
   * Commit the delivered checkpoint over an observed claim. The delivery
   * itself already succeeded, so a failure here is not a delivery failure: a
   * lost acknowledgement race (the member settled faster than the
   * checkpoint) leaves the attempt reserved and the next pass re-folds the
   * same fenced attempt. Accepted work is never rolled back through this
   * path.
   */
  private async commitAssignmentAcknowledgement(
    scope: TeamScope,
    teamId: TeamId,
    task: TeamTask,
    attemptId: AttemptId,
  ): Promise<void> {
    try {
      await this.deps.domain().acknowledgeAssignment(scope, teamId, task.id, attemptId)
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: assignment acknowledgement deferred for ${task.id}: ${String(error)}`)
    }
    // The delivered checkpoint closes this attempt's reinstate window, so any
    // execution root still held by the stale attempt it replaced can now
    // release (authority-derived; never blocks the delivery path).
    await this.deps.sweepExecutionRoots(scope, teamId)
  }

  /**
   * Roll back one failed dispatch, guarded on the exact attempt (issue #12 /
   * F10). Evaluation recorded in docs/04 §8c: the claim-time revision CAS
   * already prevented state corruption (every attempt transition bumps the
   * revision), but it was not an exact-dispatch guard — it fired doomed
   * domain calls and masked diagnostics. The rollback therefore re-reads the
   * authoritative snapshot and cancels only when the task still fences this
   * dispatch's `currentAttemptId` and the attempt was never acknowledged as
   * delivered; a concurrent captain handoff has already changed the fencing
   * reference and wins, and a member that settled despite the failed
   * delivery keeps its settlement.
   */
  private async rollbackUndeliveredAssignment(
    scope: TeamScope,
    teamId: TeamId,
    captainId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    diagnostic: string,
  ): Promise<void> {
    try {
      const snapshot = await this.deps.domain().snapshot(scope, teamId, captainId)
      const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
      const attempt = snapshot.team.attempts.find(candidate => candidate.id === attemptId)
      if (task?.currentAttemptId !== attemptId) return
      if (attempt?.phase !== 'running' || attempt?.assignmentPhase !== 'reserved') return
      await this.deps.domain().cancelAttempt(scope, teamId, captainId, taskId, task.revision, diagnostic)
    } catch (error) {
      this.ctx.logger.error(`agent-swarm: exact assignment rollback failed: ${String(error)}`)
    }
  }

  /**
   * Stranded-ownership self-healing (issue #12 / F10, decisions in docs/04
   * §8c): a live-and-idle member still holding an open in_progress task lost
   * the turn that was executing it (model stopped early, keepInbox interrupt
   * settlement, restart). Past the configured grace the SAME owner retries
   * under a fresh fenced attempt (reference scheduler discipline); the fenced
   * attempt keeps the evidence in its diagnostic. A not-live owner is never
   * auto-released — cold members stay wakeup-resumable and reassignment
   * stays a captain decision surfaced as `stranded=` evidence.
   *
   * Issue #83 hardening, two seams the pre-fix race exposed on a slow
   * runner: the grace bounds the owner's CURRENT idle stretch (an idle edge
   * from a captain teardown is age zero, so the heal cannot fire through the
   * teardown window and re-drive the member the captain is tearing down),
   * and the retry is one atomic domain transition — no reader and no
   * scheduling lane can observe the task `pending` between the stale fence
   * and the fresh attempt. If the owner still stops being live while the
   * retry commits, the misfire is reversed (`reinstateAttempt`) and the
   * evidence-only state is restored.
   *
   * M2-3 (issue #77): the heal is an AUTONOMOUS event-face decision, so it
   * (and the re-kick timers only it arms) requires the event face to be
   * active for this Team — `workflow` mode deactivates it globally and a
   * workflow-run-owned Team defers its re-drive to its run. Delivery
   * sections of the pass are unaffected.
   */
  private async healStrandedOwnership(
    scope: TeamScope,
    teamId: TeamId,
    captain: Agent,
    team: TeamState,
  ): Promise<boolean> {
    if (this.deps.isClosing() || this.deps.strandedAfterMs <= 0) return false
    // Budget-hold gating (M4-3, issue #129): stranding is an owner-liveness
    // defect; an exhausted budget face is a TEAM-economics hold. While the
    // face is exhausted no retry can pass admission, so the heal stays off
    // entirely (no doomed domain calls, no re-kick arming) — docs/04 §8n.
    if (budgetExhaustion(team.budget, Date.now()) !== undefined) return false
    if (!this.deps.eventFaceActive(scope, teamId)) return false
    let acted = false
    let nextDeadline: number | undefined
    for (const task of team.tasks) {
      if (this.deps.isClosing()) return acted
      if (task.status !== 'in_progress' || task.ownerSessionId === undefined) continue
      const owner = this.ctx.agents.get(SessionId(task.ownerSessionId))
      if (owner === undefined || owner.status !== 'idle') continue
      const anchor = Math.max(task.updatedAt, this.deps.idleSince(task.ownerSessionId) ?? task.updatedAt)
      const deadline = anchor + this.deps.strandedAfterMs
      if (Date.now() < deadline) {
        nextDeadline = nextDeadline === undefined ? deadline : Math.min(nextDeadline, deadline)
        continue
      }
      try {
        const retried = await this.deps.domain().retryAttempt(
          scope, teamId, captain.id, task.id, task.revision, task.ownerSessionId,
          `stranded ownership self-heal: member ${task.ownerSessionId} is live and idle while task ${task.id} is still in_progress`,
        )
        acted = true
        if (this.ctx.agents.get(SessionId(task.ownerSessionId)) === undefined) {
          await this.deps.domain().reinstateAttempt(
            scope, teamId, captain.id, task.id, retried.task.revision, retried.attempt.id,
            `stranded ownership self-heal misfired: owner ${task.ownerSessionId} stopped being live during the retry; evidence restored`,
          )
          continue
        }
        await this.dispatchAssignment(scope, team, captain, retried.task, retried.attempt)
      } catch (error) {
        // A raced transition (stale revision, dependencies no longer
        // satisfied, budget exhausted) defers to the next pass.
        this.ctx.logger.warn(`agent-swarm: stranded self-heal deferred for task ${task.id}: ${String(error)}`)
      }
    }
    if (nextDeadline !== undefined) this.armRekick(scope, teamId, captain.id, nextDeadline)
    return acted
  }

  /**
   * One bounded re-kick timer per Team: a pass that found only under-grace
   * stranded ownership schedules the next pass slightly past the earliest
   * grace deadline, because the stranded member is already idle and no
   * further event may ever arrive. Cleared synchronously on disposal.
   */
  private armRekick(scope: TeamScope, teamId: TeamId, captainId: string, deadline: number): void {
    if (this.deps.isClosing()) return
    const key = `${scope}\0${teamId}`
    if (this.rekickTimers.has(key)) return
    const timer = setTimeout(() => {
      if (this.rekickTimers.get(key) === timer) this.rekickTimers.delete(key)
      if (this.deps.isClosing()) return
      const captain = this.ctx.agents.get(SessionId(captainId))
      if (captain !== undefined) this.deps.requestSchedule(scope, teamId, captain)
    }, Math.max(0, deadline - Date.now()) + 50)
    this.rekickTimers.set(key, timer)
  }

  /** Evidence-only stranding hint for the status projection (docs/04 §8c). */
  strandedEvidence(task: TeamTask): string {
    if (task.status !== 'in_progress' || task.ownerSessionId === undefined) return ''
    const owner = this.ctx.agents.get(SessionId(task.ownerSessionId))
    if (owner === undefined) return ' stranded=owner-not-live'
    return owner.status === 'idle' && this.deps.strandedAfterMs > 0 ? ' stranded=idle-holder' : ''
  }

  /** Synchronously stop every pending re-kick timer (disposal path). */
  dispose(): void {
    for (const timer of this.rekickTimers.values()) clearTimeout(timer)
    this.rekickTimers.clear()
  }
}
