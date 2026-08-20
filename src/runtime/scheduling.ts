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
import { TaskId, type AttemptId, type TaskAttempt, type TeamId, type TeamState, type TeamTask } from '../domain/types.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
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
  readonly isClosing: () => boolean
  readonly trackTeamChildren: (captain: Agent, team: TeamState) => void
  readonly requestSchedule: (scope: TeamScope, teamId: TeamId, captain: Agent) => void
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
      await this.deps.delivery().deliverQueuedMessage(scope, teamId, captain, messageId, AbortSignal.timeout(30_000))
    }
    if (hadQueuedMail) snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)

    // 2. Reserved attempts: a durable claim whose delivery never reached the
    //    inbox checkpoint is re-dispatched (a failed dispatch rolls back).
    const reserved = snapshot.team.tasks.flatMap(task => {
      if (task.status !== 'in_progress' || task.currentAttemptId === undefined) return []
      const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
      return attempt?.phase === 'running' && attempt.assignmentPhase === 'reserved' ? [{ task, attempt }] : []
    })
    for (const { task, attempt } of reserved) {
      if (this.deps.isClosing()) return
      await this.dispatchAssignment(scope, snapshot.team, captain, task, attempt)
    }
    if (reserved.length > 0) snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)

    // 3. Stranded-ownership self-healing (docs/04 §8c).
    if (await this.healStrandedOwnership(scope, teamId, captain, snapshot.team)) {
      snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)
    }

    // 4. New assignments: ownership-busy members and live running members
    //    are excluded; the configured Provider decides among the rest.
    const busy = new Set(snapshot.team.tasks
      .filter(task => ['in_progress', 'submitted', 'verifying'].includes(task.status))
      .map(task => task.ownerSessionId)
      .filter((value): value is string => value !== undefined))
    const members = snapshot.team.members
      .filter(member => member.phase === 'active' && !busy.has(member.sessionId) && memberAvailable(this.ctx, member.sessionId))
      .toSorted((left, right) => left.createdAt - right.createdAt)
    const ready = snapshot.team.tasks
      .filter(task => snapshot.readyTaskIds.includes(task.id))
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
      seenMembers.add(member.sessionId)
      seenTasks.add(task.id)
      let claim
      try {
        claim = await this.deps.domain().claimTask(scope, teamId, captain.id, task.id, task.revision, member.sessionId)
      } catch (error) {
        if (error instanceof TeamDomainError && ['TEAM_TASK_STALE_REVISION', 'TEAM_MEMBER_BUSY'].includes(error.code)) continue
        throw error
      }
      await this.dispatchAssignment(scope, snapshot.team, captain, claim.task, claim.attempt)
    }
  }

  /** Deliver one claimed assignment, or roll back exactly its reservation. */
  private async dispatchAssignment(
    scope: TeamScope,
    team: TeamState,
    captain: Agent,
    task: TeamTask,
    attempt: TaskAttempt,
  ): Promise<void> {
    try {
      await this.ctx.subagents.followup(
        captain,
        SessionId(attempt.memberSessionId),
        [{ type: 'text', text: assignmentPrompt(team, task, attempt.id) }],
        { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal: AbortSignal.timeout(30_000) },
      )
      const member = this.ctx.agents.get(SessionId(attempt.memberSessionId))
      if (member !== undefined) await this.deps.usage().accountAgentUsage(scope, team.id, member)
    } catch (error) {
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
    try {
      await this.deps.domain().acknowledgeAssignment(scope, team.id, task.id, task.revision, attempt.id)
    } catch (error) {
      // The delivery itself succeeded, so this is not a delivery failure: a
      // lost acknowledgement race (the member settled faster than the
      // checkpoint) leaves the attempt reserved and the next pass re-
      // dispatches the same fenced attempt. Accepted work is never rolled
      // back through this path.
      this.ctx.logger.warn(`agent-swarm: assignment acknowledgement deferred for ${task.id}: ${String(error)}`)
    }
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
      if (attempt?.phase !== 'running' || attempt.assignmentPhase !== 'reserved') return
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
   * under a fresh fenced attempt (reference scheduler discipline); the
   * fenced attempt keeps the evidence in its diagnostic. A not-live owner is
   * never auto-released — cold members stay wakeup-resumable and
   * reassignment stays a captain decision surfaced as `stranded=` evidence.
   */
  private async healStrandedOwnership(
    scope: TeamScope,
    teamId: TeamId,
    captain: Agent,
    team: TeamState,
  ): Promise<boolean> {
    if (this.deps.isClosing() || this.deps.strandedAfterMs <= 0) return false
    let acted = false
    let nextDeadline: number | undefined
    for (const task of team.tasks) {
      if (this.deps.isClosing()) return acted
      if (task.status !== 'in_progress' || task.ownerSessionId === undefined) continue
      const owner = this.ctx.agents.get(SessionId(task.ownerSessionId))
      if (owner === undefined || owner.status !== 'idle') continue
      const deadline = task.updatedAt + this.deps.strandedAfterMs
      if (Date.now() < deadline) {
        nextDeadline = nextDeadline === undefined ? deadline : Math.min(nextDeadline, deadline)
        continue
      }
      try {
        const released = await this.deps.domain().cancelAttempt(
          scope, teamId, captain.id, task.id, task.revision,
          `stranded ownership self-heal: member ${task.ownerSessionId} is live and idle while task ${task.id} is still in_progress`,
        )
        const claim = await this.deps.domain().claimTask(
          scope, teamId, captain.id, task.id, released.revision, task.ownerSessionId,
        )
        await this.dispatchAssignment(scope, team, captain, claim.task, claim.attempt)
        acted = true
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
