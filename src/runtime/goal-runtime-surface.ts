/** Goal consumers over the existing Team domain, scheduling owner and official recovery. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CancelTaskInput, GoalAdmissionGuards, GoalCoordinationInput, GoalOperationResult, GoalOrigin, GoalResultQuery } from '../domain/goal-lifecycle.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import { budgetExhaustion } from '../domain/team-domain-budget.js'
import { projectGoalSnapshot } from '../domain/team-domain-goal.js'
import { publicManagedParent } from '../domain/public-message.js'
import { TeamId, type TeamState, type TeamTask } from '../domain/types.js'
import type { ControlGoalInput, GoalSnapshot, SaveGoalInput } from '../shared/goal-lifecycle.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import { publicAppendEligibility } from './public-lineage.js'
import type { ManagedActivationRecovery } from './managed-activation-recovery.js'
import type { OrchestrationOwnership } from './orchestration-ownership.js'
import type { SchedulingAdmission } from './scheduling-admission.js'
import type { SchedulingPass } from './scheduling.js'
import type { UsageAccountant } from './usage-accounting.js'
import { captureTaskInterruption, type TaskInterruptionResult } from './goal-task-interruption.js'

interface GoalRuntimeDeps {
  domain(): TeamDomainPort
  ready(): Promise<void>
  assertOpen(): void
  scopeOf(agent: Agent): TeamScope
  teams(scope: TeamScope): Promise<TeamState[]>
  usage: UsageAccountant
  scheduling: SchedulingAdmission
  recovery(): ManagedActivationRecovery
  ownership: OrchestrationOwnership
  adaptive(): boolean
  signal: AbortSignal
  deadlines: Pick<SchedulingPass, 'trackGoalDeadline' | 'clearGoalDeadline'>
  sweep(scope: TeamScope, teamId: TeamId): Promise<void>
}

/** No goal queue, timer or execution state is owned here. */
export class GoalRuntimeSurface {
  constructor(private readonly ctx: Context, private readonly deps: GoalRuntimeDeps) {}

  private exact(exec: ToolExecutionAuthority, actor: Agent, scope: TeamScope): void {
    this.deps.assertOpen(); exec.signal.throwIfAborted()
    if (this.ctx.agents.get(actor.id) !== actor || this.ctx.sessions.get(actor.id) !== actor.session || this.deps.scopeOf(actor) !== scope) {
      throw new TeamDomainError('Goal control requires the exact live executing Session', 'TEAM_AGENT_REQUIRED')
    }
  }

  private guards(scope: TeamScope, teamId: TeamId, outer: GoalAdmissionGuards = {}): GoalAdmissionGuards {
    return { ...outer,
      assertExecution: () => { this.deps.assertOpen(); this.deps.signal.throwIfAborted(); outer.assertExecution?.() },
      assertCanStart: () => {
        outer.assertCanStart?.()
        if (!this.deps.adaptive()) throw new TeamDomainError('Autonomous goal start and resume require adaptive orchestration', 'TEAM_GOAL_UNSUPPORTED')
      },
      autonomousAllowed: () => this.deps.ownership.eventFaceActive(scope, teamId) && (outer.autonomousAllowed?.() ?? true),
    }
  }

  /** Projection only: reads never start a planning round. */
  async snapshot(scope: TeamScope, teamId: TeamId): Promise<GoalSnapshot> {
    await this.deps.ready(); this.deps.assertOpen()
    const team = (await this.deps.teams(scope)).find(candidate => candidate.id === teamId)
    if (team === undefined) throw new TeamDomainError('Team not found', 'TEAM_NOT_FOUND')
    return this.project(scope, team)
  }

  /** Pure projection of the exact Team generation read by the caller. */
  project(scope: TeamScope, team: TeamState): GoalSnapshot {
    const snapshot = projectGoalSnapshot(team, Date.now())
    const waitingReason = snapshot.lifecycle?.phase === 'paused' ? 'paused'
      : !this.deps.adaptive() ? 'unsupported'
      : this.deps.ownership.ownerOf(scope, team.id) !== undefined ? 'workflow-owner'
      : snapshot.waitingReason
    return { ...snapshot, ...(waitingReason === undefined ? {} : { waitingReason }) }
  }

  async operationResult(scope: TeamScope, teamId: TeamId, origin: GoalOrigin, input: GoalResultQuery) {
    await this.deps.ready(); this.deps.assertOpen()
    return await this.deps.domain().goalOperationResult(scope, teamId, origin, input)
  }

  private async foldUsage(scope: TeamScope, teamId: TeamId): Promise<void> {
    await this.deps.usage.wait()
    const team = (await this.deps.teams(scope)).find(candidate => candidate.id === teamId)
    if (team !== undefined) await this.deps.usage.recoverTeamUsage(scope, team)
  }

  async saveOperator(scope: TeamScope, teamId: TeamId, input: SaveGoalInput, guards: GoalAdmissionGuards = {}): Promise<GoalOperationResult> {
    await this.deps.ready(); this.deps.assertOpen()
    if (input.start) await this.foldUsage(scope, teamId)
    const result = await this.deps.domain().saveGoal(scope, teamId, { kind: 'local-operator' }, input, this.guards(scope, teamId, guards))
    this.deps.deadlines.trackGoalDeadline(scope, result.team)
    return result
  }

  async controlOperator(scope: TeamScope, teamId: TeamId, input: ControlGoalInput, guards: GoalAdmissionGuards = {}): Promise<GoalOperationResult> {
    await this.deps.ready(); this.deps.assertOpen()
    if (input.action !== 'pause') await this.foldUsage(scope, teamId)
    const result = await this.deps.domain().controlGoal(scope, teamId, { kind: 'local-operator' }, input, this.guards(scope, teamId, guards))
    this.deps.deadlines.trackGoalDeadline(scope, result.team)
    return result
  }

  /** Host calls this after releasing the shared public admission fence. */
  async afterOperatorOperation(scope: TeamScope, team: TeamState, signal = this.deps.signal): Promise<void> {
    await this.afterOperation(scope, team, undefined, signal)
  }

  /** Resolve genuine Main/Captain identity before admission, and again inside the Domain transaction. */
  private async actor(exec: ToolExecutionAuthority, requestedTeamId?: string) {
    await this.deps.ready()
    const actor = requireAgent(exec), scope = this.deps.scopeOf(actor)
    this.exact(exec, actor, scope)
    const membership = await this.deps.domain().findMembership(scope, actor.id)
    let team: TeamState | undefined, origin: GoalOrigin
    if (membership?.role === 'captain') {
      team = membership.team
      if (requestedTeamId !== undefined && requestedTeamId !== team.id) throw new TeamDomainError('Captain goal control targets its own Team', 'TEAM_GOAL_UNAUTHORIZED')
      origin = { kind: 'captain', sessionId: actor.id }
    } else {
      if (membership !== undefined || actor.session.header.parentSession !== undefined || requestedTeamId === undefined) {
        throw new TeamDomainError('Goal mutation is restricted to the owning Main or Captain', 'TEAM_GOAL_UNAUTHORIZED')
      }
      team = (await this.deps.teams(scope)).find(candidate => candidate.id === requestedTeamId && publicManagedParent(candidate.managedOrigin) === actor.id)
      if (team === undefined || (await publicAppendEligibility(this.ctx, scope, team, exec.signal)).state !== 'available') {
        throw new TeamDomainError('The managed Team does not belong to this Main', 'TEAM_GOAL_UNAUTHORIZED')
      }
      origin = { kind: 'main', sessionId: actor.id }
    }
    this.exact(exec, actor, scope)
    return { actor, scope, team, origin, guards: this.guards(scope, team.id, {
      assertExecution: () => this.exact(exec, actor, scope), expectedCaptainSessionId: team.captainSessionId,
      ...(team.managedOrigin === undefined ? {} : { expectedManagedOrigin: team.managedOrigin }),
    }) }
  }

  async saveAgent(exec: ToolExecutionAuthority, input: SaveGoalInput, teamId?: string): Promise<GoalOperationResult> {
    const resolved = await this.actor(exec, teamId)
    if (input.start) await this.foldUsage(resolved.scope, resolved.team.id)
    const result = await this.deps.domain().saveGoal(resolved.scope, resolved.team.id, resolved.origin, input, resolved.guards)
    await this.afterOperation(resolved.scope, result.team, resolved.actor, exec.signal)
    return result
  }

  async controlAgent(exec: ToolExecutionAuthority, input: ControlGoalInput, teamId?: string): Promise<GoalOperationResult> {
    const resolved = await this.actor(exec, teamId)
    if (input.action !== 'pause') await this.foldUsage(resolved.scope, resolved.team.id)
    const result = await this.deps.domain().controlGoal(resolved.scope, resolved.team.id, resolved.origin, input, resolved.guards)
    await this.afterOperation(resolved.scope, result.team, resolved.actor, exec.signal)
    return result
  }

  async readAgent(exec: ToolExecutionAuthority, teamId?: string): Promise<GoalSnapshot> {
    await this.deps.ready()
    const actor = requireAgent(exec), scope = this.deps.scopeOf(actor)
    this.exact(exec, actor, scope)
    const membership = await this.deps.domain().findMembership(scope, actor.id)
    if (membership !== undefined && (teamId === undefined || teamId === membership.team.id)) return await this.snapshot(scope, membership.team.id)
    const resolved = await this.actor(exec, teamId)
    return await this.snapshot(resolved.scope, resolved.team.id)
  }

  async coordinate(exec: ToolExecutionAuthority, input: GoalCoordinationInput) {
    const { actor, scope, team, origin, guards } = await this.actor(exec)
    if (origin.kind !== 'captain') throw new TeamDomainError('Only the actual Captain can confirm goal coordination', 'TEAM_CAPTAIN_REQUIRED')
    const result = await this.deps.domain().coordinateGoal(scope, team.id, actor.id, input, guards)
    await this.afterOperation(scope, result.team, actor, exec.signal)
    return result
  }

  async cancel(exec: ToolExecutionAuthority, input: CancelTaskInput) {
    const { actor, scope, team, origin, guards } = await this.actor(exec)
    if (origin.kind !== 'captain') throw new TeamDomainError('Only the actual Captain can cancel a task', 'TEAM_CAPTAIN_REQUIRED')
    const interruption: TaskInterruptionResult = { state: 'not-needed' }
    const result = await this.deps.domain().cancelTask(scope, team.id, actor.id, input, {
      assertExecution: () => guards.assertExecution?.(),
      captureInterruption: (current, task, attempt) => captureTaskInterruption(this.ctx, actor, current, task, attempt, interruption),
    })
    if (result.replayed) { interruption.state = 'not-repeated'; delete interruption.reason }
    return await this.deps.scheduling.committed({ ...result, interruption }, exec.signal,
      { codePrefix: 'TEAM_TASK_CANCEL_ADMISSION', description: `Task ${JSON.stringify(result.task.id)} committed as cancelled; interruption=${interruption.state}` }, async () => {
        await this.deps.sweep(scope, team.id)
        const current = (await this.deps.domain().requireMembership(scope, actor.id)).team
        await this.afterOperation(scope, await this.reconcile(scope, current), actor, exec.signal)
      })
  }

  /** Runs within the existing SchedulingPass before consuming its mailbox. */
  async reconcile(scope: TeamScope, team: TeamState): Promise<TeamState> {
    if (team.goalLifecycle === undefined || team.phase !== 'active') return team
    if (team.goalLifecycle.phase === 'waiting' && (team.goalLifecycle.nextDueAt ?? Infinity) <= Date.now()) await this.foldUsage(scope, team.id)
    const result = await this.deps.domain().reconcileGoal(scope, team.id, this.guards(scope, team.id))
    this.deps.deadlines.trackGoalDeadline(scope, result.team)
    return result.team
  }

  allowed(scope: TeamScope, teamId: TeamId): boolean {
    return !this.deps.signal.aborted && this.deps.ownership.eventFaceActive(scope, teamId)
  }

  canCoordinate(scope: TeamScope, team: TeamState): boolean {
    return team.phase === 'active' && team.goalLifecycle?.phase === 'running' && team.goalLifecycle.currentTrigger !== undefined
      && this.allowed(scope, team.id) && budgetExhaustion(team.budget, Date.now()) === undefined
      && (team.goalLifecycle.mode !== 'maintenance' || (team.budget.tokenLimit !== undefined && team.budget.tokenLimit > team.budget.usedTokens))
  }

  private async afterOperation(scope: TeamScope, team: TeamState, actor?: Agent, signal = this.deps.signal): Promise<void> {
    this.deps.deadlines.trackGoalDeadline(scope, team)
    if (team.goalLifecycle?.phase !== 'running' || team.goalLifecycle.currentTrigger === undefined || !this.allowed(scope, team.id)) return
    if (actor?.id === team.captainSessionId) {
      await this.deps.scheduling.committed(undefined, signal, { codePrefix: 'TEAM_GOAL_ADMISSION', description: 'Goal operation committed' },
        () => this.deps.scheduling.afterCommit(scope, team.id, actor, signal))
    } else {
      await this.deps.scheduling.committed(undefined, signal, { codePrefix: 'TEAM_GOAL_ADMISSION', description: 'Goal operation committed' },
        () => this.wake(scope, team.id))
    }
  }

  /** Called by the existing single timer/startup scan; the Team remains authority. */
  async wake(scope: TeamScope, teamId: TeamId): Promise<void> {
    await this.deps.ready(); this.deps.assertOpen()
    try {
      let team = (await this.deps.teams(scope)).find(candidate => candidate.id === teamId)
      if (team === undefined || team.phase !== 'active' || team.goalLifecycle === undefined || !this.allowed(scope, teamId)) return
      team = await this.reconcile(scope, team)
      if (!this.canCoordinate(scope, team)) return
      const parentId = publicManagedParent(team.managedOrigin)
      if (parentId === undefined) return
      const root = await this.deps.recovery().ensurePublicRoot(parentId, scope)
      this.deps.signal.throwIfAborted()
      const sameWork = (current: TeamState | undefined): current is TeamState => current !== undefined
        && this.canCoordinate(scope, current) && current.captainSessionId === team.captainSessionId
        && current.managedOrigin === team.managedOrigin && current.goalLifecycle?.currentTrigger?.id === team.goalLifecycle?.currentTrigger?.id
        && this.ctx.agents.get(root.id) === root && this.ctx.sessions.get(root.id) === root.session
        && root.id === parentId && root.session.header.parentSession === undefined && this.deps.scopeOf(root) === scope
      if (!sameWork((await this.deps.teams(scope)).find(candidate => candidate.id === teamId))) return
      await this.ctx.subagents.withContinuableChild(root, SessionId(team.captainSessionId), this.deps.signal, async captain => {
        if (!sameWork((await this.deps.teams(scope)).find(candidate => candidate.id === teamId))
          || this.ctx.agents.get(captain.id) !== captain || this.ctx.sessions.get(captain.id) !== captain.session) return
        await this.deps.scheduling.request(scope, teamId, captain, true)
      })
    } finally {
      if (this.deps.signal.aborted) this.deps.deadlines.clearGoalDeadline(scope, teamId)
      else try {
        // A successful pass can still leave deferred mailbox debt. Re-read
        // its original notice; never infer coordination from a resolved wake.
        const current = (await this.deps.teams(scope)).find(candidate => candidate.id === teamId)
        if (current === undefined) this.deps.deadlines.clearGoalDeadline(scope, teamId)
        else this.deps.deadlines.trackGoalDeadline(scope, current)
      } catch (error) {
        this.ctx.logger.warn(`agent-swarm: goal retry observation deferred for ${teamId}: ${String(error)}`)
      }
    }
  }

  /** Event consumers do not own another drain/loop. Failures keep canonical debt. */
  kick(scope: TeamScope, teamId: TeamId): void {
    void this.wake(scope, teamId).catch(error => {
      if (!this.deps.signal.aborted) this.ctx.logger.warn(`agent-swarm: goal admission deferred for ${teamId}: ${String(error)}`)
    })
  }

  async afterReview(exec: ToolExecutionAuthority, result: { task: TeamTask; decision: 'accept' | 'reject' }) {
    if (this.deps.signal.aborted) return result
    return await this.deps.scheduling.committedReview(result, exec.signal, async () => {
      const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
      const membership = await this.deps.domain().requireMembership(scope, captain.id)
      if (!this.allowed(scope, membership.team.id)) return
      if (membership.team.goalLifecycle !== undefined) {
        const team = await this.reconcile(scope, membership.team)
        if (team.goalLifecycle?.currentTrigger !== undefined && team.goalLifecycle.phase === 'running') {
          await this.afterOperation(scope, team, captain, exec.signal)
          return
        }
      }
      if (result.decision === 'accept' && (await this.deps.domain().snapshot(scope, membership.team.id, captain.id)).readyTaskIds.length > 0) {
        await this.deps.scheduling.afterCommit(scope, membership.team.id, captain, exec.signal)
      }
    })
  }

  async afterLegacyGoal(exec: ToolExecutionAuthority, team: TeamState): Promise<TeamState> {
    await this.afterOperation(this.deps.scopeOf(requireAgent(exec)), team, requireAgent(exec), exec.signal)
    return team
  }
}
