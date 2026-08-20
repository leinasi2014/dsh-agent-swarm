/**
 * DSH-facing Team orchestrator.
 *
 * Composes the framework-neutral Team domain with continuable subagents and
 * the official Storage Domain. This class owns lifecycle, the Provider
 * registries, the scheduling pass and tool-facing operations; provisioning,
 * mailbox delivery and token accounting live in dedicated collaborators.
 */
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import { TaskId, type AttemptId, type TeamId, type TeamLimits, type TeamMessage, type TeamState, type TeamTask } from '../domain/types.js'
import { TeamDomain } from '../domain/team-domain.js'
import type { CreateTaskInput, TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import { StorageDomainTeamStore } from '../storage/storage-domain-team-store.js'
import { teamDomainSpec } from '../storage/team-spec.js'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { expectDomainTimeout, requireAgent, workspaceOf, type ToolExecutionAuthority } from './authority.js'
import { MemberProvisioner } from './member-provisioning.js'
import { MessageDelivery } from './message-delivery.js'
import { assignmentPrompt } from './prompts.js'
import { manualReview, priorityReadyScheduler, type ReviewProviderInput, type ReviewProviderResult, type SchedulerDecision, type SchedulerSelectionInput, type TeamReviewProvider, type TeamSchedulerProvider } from './providers.js'
import { UsageAccountant } from './usage-accounting.js'
import type { TaskAttempt } from '../domain/types.js'

export type { ToolExecutionAuthority }
export type { ReviewProviderInput, ReviewProviderResult, SchedulerDecision, SchedulerSelectionInput, TeamReviewProvider, TeamSchedulerProvider }

export interface RuntimeConfig {
  readonly memberProvider: string
  readonly memberModel?: string
  readonly memberMaxDepth: number
  readonly schedulerProvider: string
  readonly reviewProvider: string
  readonly limits: TeamLimits
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authoritative host API; model tools are only one Consumer. */
    agentSwarm: AgentSwarmRuntime
  }
}

/** DSH-facing runtime that composes the framework-neutral domain with continuable subagents. */
export class AgentSwarmRuntime extends Service {
  private domainInstance?: TeamDomainPort
  private storeInstance?: StorageDomainTeamStore
  private domainHandle?: Domain<typeof teamDomainSpec>
  private startPromise?: Promise<void>
  private readonly scheduling = new Map<string, Promise<void>>()
  private readonly schedulerProviders = new Map<string, TeamSchedulerProvider>()
  private readonly reviewProviders = new Map<string, TeamReviewProvider>()
  private readonly ownedChildren = new Map<string, Set<string>>()
  private readonly usage: UsageAccountant
  private readonly delivery: MessageDelivery
  private readonly provisioning: MemberProvisioner
  private closing = false

  constructor(
    ctx: Context,
    readonly config: RuntimeConfig,
  ) {
    super(ctx, 'agentSwarm')
    this.schedulerProviders.set('priority-ready', priorityReadyScheduler())
    this.reviewProviders.set('manual', manualReview())
    this.usage = new UsageAccountant(ctx, { domain: () => this.domain, isClosing: () => this.closing })
    this.delivery = new MessageDelivery(ctx, {
      domain: () => this.domain,
      isClosing: () => this.closing,
      scopeOf: agent => this.scopeOf(agent),
      accountAgentUsage: (scope, teamId, agent) => this.usage.accountAgentUsage(scope, teamId, agent),
    })
    this.provisioning = new MemberProvisioner(ctx, {
      domain: () => this.domain,
      config,
      scopeOf: agent => this.scopeOf(agent),
      trackChild: (captain, childId) => this.trackChild(captain, childId),
      afterActivation: async (scope, teamId, captain, childId) => {
        const child = this.ctx.agents.get(childId)
        if (child !== undefined) await this.usage.accountAgentUsage(scope, teamId, child)
        this.requestSchedule(scope, teamId, captain)
      },
    })
  }

  /**
   * Open the official Storage Domain and construct the authoritative Team
   * port over it. Fail closed: an unavailable domain, missing backend route,
   * version mismatch or invalid stored record fails plugin activation.
   */
  start(): Promise<void> {
    this.startPromise ??= (async () => {
      if (this.closing) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
      const handle = await this.ctx.storageDomain.open(teamDomainSpec)
      const store = new StorageDomainTeamStore(this.ctx, handle)
      this.domainHandle = handle
      this.storeInstance = store
      this.domainInstance = new TeamDomain(store, this.config.limits)
    })()
    return this.startPromise
  }

  private async ensureReady(): Promise<void> {
    if (this.domainInstance === undefined) await this.start()
    if (this.domainInstance === undefined) {
      throw new TeamDomainError('Team orchestrator storage did not start', 'TEAM_RUNTIME_NOT_STARTED')
    }
  }

  /** The authoritative Team port. Throws before `start()` resolves. */
  get domain(): TeamDomainPort {
    if (this.domainInstance === undefined) {
      throw new TeamDomainError('Team orchestrator storage did not start', 'TEAM_RUNTIME_NOT_STARTED')
    }
    return this.domainInstance
  }

  registerSchedulerProvider(name: string, provider: TeamSchedulerProvider): () => void {
    const key = name.trim()
    if (key === '') throw new TeamDomainError('scheduler Provider name must not be empty', 'TEAM_INVALID_CONFIG')
    if (this.schedulerProviders.has(key)) throw new TeamDomainError(`scheduler Provider "${key}" is already registered`, 'TEAM_PROVIDER_DUPLICATE')
    this.schedulerProviders.set(key, provider)
    return () => { if (this.schedulerProviders.get(key) === provider) this.schedulerProviders.delete(key) }
  }

  registerReviewProvider(name: string, provider: TeamReviewProvider): () => void {
    const key = name.trim()
    if (key === '') throw new TeamDomainError('review Provider name must not be empty', 'TEAM_INVALID_CONFIG')
    if (this.reviewProviders.has(key)) throw new TeamDomainError(`review Provider "${key}" is already registered`, 'TEAM_PROVIDER_DUPLICATE')
    this.reviewProviders.set(key, provider)
    return () => { if (this.reviewProviders.get(key) === provider) this.reviewProviders.delete(key) }
  }

  /** Canonical workspace scope key partitioning this agent's Team namespace. */
  scopeOf(agent: Agent): TeamScope {
    return resolve(workspaceOf(agent))
  }

  private assertOpen(): void {
    if (this.closing) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  }

  private assertConfiguredProviders(): void {
    if (!this.schedulerProviders.has(this.config.schedulerProvider)) {
      throw new TeamDomainError(`scheduler Provider "${this.config.schedulerProvider}" is unavailable`, 'TEAM_SCHEDULER_PROVIDER_MISSING')
    }
    if (!this.reviewProviders.has(this.config.reviewProvider)) {
      throw new TeamDomainError(`review Provider "${this.config.reviewProvider}" is unavailable`, 'TEAM_REVIEW_PROVIDER_MISSING')
    }
  }

  async create(exec: ToolExecutionAuthority, name: string, description: string): Promise<TeamState> {
    await this.ensureReady()
    this.assertOpen()
    const agent = requireAgent(exec)
    return await this.domain.createTeam(
      this.scopeOf(agent), agent.id, name, description, agent.session.events.at(-1)?.seq ?? -1,
    )
  }

  async addMember(
    exec: ToolExecutionAuthority,
    input: { name: string; role: string; provider?: string; model?: string },
  ): Promise<TeamState['members'][number]> {
    await this.ensureReady()
    this.assertOpen()
    return await this.provisioning.addMember(exec, input)
  }

  async createTask(exec: ToolExecutionAuthority, input: CreateTaskInput): Promise<TeamTask> {
    await this.ensureReady()
    this.assertOpen()
    this.assertConfiguredProviders()
    const actor = requireAgent(exec)
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireMembership(scope, actor.id)
    const task = await this.domain.createTask(scope, membership.team.id, actor.id, input)
    const captain = this.ctx.agents.get(SessionId(membership.team.captainSessionId))
    if (captain !== undefined) this.requestSchedule(scope, membership.team.id, captain)
    return task
  }

  async removeMember(exec: ToolExecutionAuthority, name: string, reason: string) {
    await this.ensureReady()
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = await this.domain.requireMembership(scope, captain.id)
    const removed = await this.domain.removeMember(scope, membership.team.id, captain.id, name, reason)
    this.ctx.subagents.interrupt(SessionId(removed.member.sessionId), { kind: 'ancestor', agent: captain })
    await this.ctx.subagents.drainContinuableChildren(captain, [SessionId(removed.member.sessionId)])
    this.requestSchedule(scope, membership.team.id, captain)
    return removed
  }

  async archive(exec: ToolExecutionAuthority, reason: string): Promise<TeamState> {
    await this.ensureReady()
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = await this.domain.requireMembership(scope, captain.id)
    const activeIds = membership.team.members
      .filter(member => member.phase === 'active' || member.phase === 'provisioning')
      .map(member => SessionId(member.sessionId))
    const archived = await this.domain.archiveTeam(scope, membership.team.id, captain.id, reason)
    for (const id of activeIds) this.ctx.subagents.interrupt(id, { kind: 'ancestor', agent: captain })
    await this.ctx.subagents.drainContinuableChildren(captain, activeIds)
    return archived
  }

  async claimTask(exec: ToolExecutionAuthority, taskId: string, expectedRevision: number) {
    await this.ensureReady()
    this.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireMembership(scope, actor.id)
    return await this.domain.claimTask(
      scope, membership.team.id, actor.id, TaskId(taskId), expectedRevision,
    )
  }

  async submitTask(
    exec: ToolExecutionAuthority,
    input: { taskId: string; expectedRevision: number; attemptId: string; output: string; evidence?: readonly string[] },
  ): Promise<TeamTask> {
    await this.ensureReady()
    this.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireMembership(scope, actor.id)
    return await this.domain.submitTask(
      scope,
      membership.team.id,
      actor.id,
      TaskId(input.taskId),
      input.expectedRevision,
      input.attemptId as AttemptId,
      input.output,
      input.evidence,
    )
  }

  async reassignTask(exec: ToolExecutionAuthority, taskId: string, expectedRevision: number, reason: string): Promise<TeamTask> {
    await this.ensureReady()
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = await this.domain.requireMembership(scope, captain.id)
    const before = membership.team.tasks.find(task => task.id === taskId)
    const released = await this.domain.cancelAttempt(
      scope, membership.team.id, captain.id, TaskId(taskId), expectedRevision, reason,
    )
    if (before?.ownerSessionId !== undefined) {
      this.ctx.subagents.interrupt(SessionId(before.ownerSessionId), { kind: 'ancestor', agent: captain })
    }
    this.requestSchedule(scope, membership.team.id, captain)
    return released
  }

  async reviewTask(
    exec: ToolExecutionAuthority,
    input: { taskId: string; expectedRevision: number; attemptId: string; decision: 'accept' | 'reject'; diagnostic?: string },
  ): Promise<{ task: TeamTask; decision: 'accept' | 'reject' }> {
    await this.ensureReady()
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = await this.domain.requireMembership(scope, captain.id)
    const taskBefore = membership.team.tasks.find(task => task.id === input.taskId)
    if (taskBefore === undefined) throw new TeamDomainError(`task "${input.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
    const attemptBefore = membership.team.attempts.find(attempt => attempt.id === input.attemptId)
    if (attemptBefore === undefined) throw new TeamDomainError(`attempt "${input.attemptId}" not found`, 'TEAM_ATTEMPT_NOT_FOUND')
    const provider = this.reviewProviders.get(this.config.reviewProvider)
    if (provider === undefined) {
      throw new TeamDomainError(`review Provider "${this.config.reviewProvider}" is unavailable`, 'TEAM_REVIEW_PROVIDER_MISSING')
    }
    const outcome = await provider.review({
      captain,
      workspace: workspaceOf(captain),
      team: membership.team,
      task: taskBefore,
      attempt: attemptBefore,
      requestedDecision: input.decision,
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      signal: exec.signal,
    })
    const task = await this.domain.reviewTask(
      scope,
      membership.team.id,
      captain.id,
      TaskId(input.taskId),
      input.expectedRevision,
      input.attemptId as AttemptId,
      outcome.decision,
      outcome.diagnostic,
    )
    if (outcome.decision === 'reject') this.requestSchedule(scope, membership.team.id, captain)
    return { task, decision: outcome.decision }
  }

  async sendMessage(
    exec: ToolExecutionAuthority,
    target: string,
    content: string,
    delivery: 'quiet' | 'wakeup',
  ): Promise<TeamMessage> {
    await this.ensureReady()
    this.assertOpen()
    const sender = requireAgent(exec)
    const scope = this.scopeOf(sender)
    const membership = await this.domain.requireMembership(scope, sender.id)
    const message = await this.domain.queueMessage(
      scope, membership.team.id, sender.id, target, content, delivery,
    )
    const captain = this.ctx.agents.get(SessionId(membership.team.captainSessionId))
    if (captain === undefined) return message
    return await this.delivery.deliverQueuedMessage(scope, membership.team.id, captain, message.id, exec.signal) ?? message
  }

  async status(exec: ToolExecutionAuthority) {
    await this.ensureReady()
    this.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireMembership(scope, actor.id)
    return await this.domain.snapshot(scope, membership.team.id, actor.id)
  }

  async waitForChange(exec: ToolExecutionAuthority, afterRevision: number, timeoutMs: number) {
    await this.ensureReady()
    this.assertOpen()
    const actor = requireAgent(exec)
    expectDomainTimeout(timeoutMs)
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireMembership(scope, actor.id)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    try {
      const snapshot = await this.domain.waitForChange(
        scope,
        membership.team.id,
        actor.id,
        afterRevision,
        AbortSignal.any([exec.signal, timeoutSignal]),
      )
      return { snapshot, changed: true }
    } catch (error) {
      if (timeoutSignal.aborted && !exec.signal.aborted) {
        return { snapshot: await this.domain.snapshot(scope, membership.team.id, actor.id), changed: false }
      }
      throw error
    }
  }

  async setBudget(
    exec: ToolExecutionAuthority,
    limits: { tokenLimit?: number; requestLimit?: number; retryLimit?: number; deadlineAt?: number },
  ) {
    await this.ensureReady()
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = await this.domain.requireMembership(scope, captain.id)
    return await this.domain.setBudget(scope, membership.team.id, captain.id, limits)
  }

  async addMemory(
    exec: ToolExecutionAuthority,
    category: 'decision' | 'lesson' | 'member' | 'context',
    content: string,
    evidenceRefs: readonly string[],
  ) {
    await this.ensureReady()
    this.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireMembership(scope, actor.id)
    return await this.domain.addMemory(
      scope, membership.team.id, actor.id, category, content, evidenceRefs,
    )
  }

  observeAgentIdle(agent: Agent): void {
    void this.recoverAgent(agent).catch(error => {
      if (!this.closing) this.ctx.logger.warn(`agent-swarm: idle recovery failed: ${String(error)}`)
    })
  }

  async recoverAgent(agent: Agent): Promise<void> {
    if (this.closing) return
    const scope = this.scopeOf(agent)
    let membership = await this.domain.findMembership(scope, agent.id)
    if (membership === undefined || this.closing) return
    if (membership.role === 'captain') {
      const recovered = await this.domain.recoverProvisioningMembers(
        scope,
        membership.team.id,
        agent.id,
        'member provisioning did not commit before runtime recovery',
      )
      if (recovered.length > 0) {
        this.ctx.logger.warn(`agent-swarm: recovered ${recovered.length} interrupted member provisioning record(s) for ${membership.team.id}`)
        membership = await this.domain.requireMembership(scope, agent.id)
      }
    }
    const captain = this.ctx.agents.get(SessionId(membership.team.captainSessionId))
    if (captain === undefined) return
    this.trackTeamChildren(captain, membership.team)
    if (agent.status === 'idle') this.requestSchedule(scope, membership.team.id, captain)
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    this.usage.observeSessionEvent(session, event)
  }

  private requestSchedule(scope: TeamScope, teamId: TeamId, captain: Agent): void {
    const key = `${scope}\0${teamId}`
    const previous = this.scheduling.get(key) ?? Promise.resolve()
    const next = previous.then(async () => { await this.schedulePass(scope, teamId, captain) })
      .catch(error => {
        if (!this.closing) this.ctx.logger.warn(`agent-swarm: scheduler failed for ${teamId}: ${String(error)}`)
      })
      .finally(() => {
        if (this.scheduling.get(key) === next) this.scheduling.delete(key)
      })
    this.scheduling.set(key, next)
  }

  private async schedulePass(scope: TeamScope, teamId: TeamId, captain: Agent): Promise<void> {
    if (this.closing) return
    let snapshot = await this.domain.snapshot(scope, teamId, captain.id)
    this.trackTeamChildren(captain, snapshot.team)
    const hadQueuedMail = snapshot.pendingMessageIds.length > 0
    for (const messageId of snapshot.pendingMessageIds) {
      if (this.closing) return
      await this.delivery.deliverQueuedMessage(scope, teamId, captain, messageId, AbortSignal.timeout(30_000))
    }
    if (hadQueuedMail) snapshot = await this.domain.snapshot(scope, teamId, captain.id)

    const reserved = snapshot.team.tasks.flatMap(task => {
      if (task.status !== 'in_progress' || task.currentAttemptId === undefined) return []
      const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
      return attempt?.phase === 'running' && attempt.assignmentPhase === 'reserved' ? [{ task, attempt }] : []
    })
    for (const { task, attempt } of reserved) {
      if (this.closing) return
      await this.dispatchAssignment(scope, snapshot.team, captain, task, attempt)
    }
    if (reserved.length > 0) snapshot = await this.domain.snapshot(scope, teamId, captain.id)

    const busy = new Set(snapshot.team.tasks
      .filter(task => ['in_progress', 'submitted', 'verifying'].includes(task.status))
      .map(task => task.ownerSessionId)
      .filter((value): value is string => value !== undefined))
    const members = snapshot.team.members
      .filter(member => member.phase === 'active' && !busy.has(member.sessionId))
      .toSorted((left, right) => left.createdAt - right.createdAt)
    const ready = snapshot.team.tasks
      .filter(task => snapshot.readyTaskIds.includes(task.id))
      .toSorted((left, right) => right.priority - left.priority || left.createdAt - right.createdAt)

    const provider = this.schedulerProviders.get(this.config.schedulerProvider)
    if (provider === undefined) throw new TeamDomainError(`scheduler Provider "${this.config.schedulerProvider}" is unavailable`, 'TEAM_SCHEDULER_PROVIDER_MISSING')
    const decisions = await provider.select({ team: snapshot.team, readyTasks: ready, availableMembers: members })
    const availableById = new Map(members.map(member => [member.sessionId, member]))
    const readyById = new Map(ready.map(task => [task.id, task]))
    const seenMembers = new Set<string>()
    const seenTasks = new Set<string>()
    for (const decision of decisions) {
      if (this.closing) break
      const member = availableById.get(decision.memberSessionId)
      const task = readyById.get(TaskId(decision.taskId))
      if (member === undefined || task === undefined || seenMembers.has(member.sessionId) || seenTasks.has(task.id)) {
        throw new TeamDomainError('scheduler Provider returned an invalid or duplicate decision', 'TEAM_SCHEDULER_DECISION_INVALID')
      }
      seenMembers.add(member.sessionId)
      seenTasks.add(task.id)
      let claim
      try {
        claim = await this.domain.claimTask(scope, teamId, captain.id, task.id, task.revision, member.sessionId)
      } catch (error) {
        if (error instanceof TeamDomainError && ['TEAM_TASK_STALE_REVISION', 'TEAM_MEMBER_BUSY'].includes(error.code)) continue
        throw error
      }
      await this.dispatchAssignment(scope, snapshot.team, captain, claim.task, claim.attempt)
    }
  }

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
      if (member !== undefined) await this.usage.accountAgentUsage(scope, team.id, member)
      await this.domain.acknowledgeAssignment(scope, team.id, task.id, task.revision, attempt.id)
    } catch (error) {
      await this.domain.cancelAttempt(
        scope,
        team.id,
        captain.id,
        task.id,
        task.revision,
        `assignment delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(rollbackError => {
        this.ctx.logger.error(`agent-swarm: exact assignment rollback failed: ${String(rollbackError)}`)
      })
    }
  }

  private trackChild(captain: Agent, childId: string): void {
    const children = this.ownedChildren.get(captain.id) ?? new Set<string>()
    children.add(childId)
    this.ownedChildren.set(captain.id, children)
  }

  private trackTeamChildren(captain: Agent, team: TeamState): void {
    for (const member of team.members) {
      if (member.phase === 'active') this.trackChild(captain, member.sessionId)
    }
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    await this.provisioning.wait()
    await Promise.allSettled(this.scheduling.values())
    await this.usage.wait()
    await this.delivery.wait()
    const failures: unknown[] = []
    for (const [captainId, childIds] of this.ownedChildren) {
      const captain = this.ctx.agents.get(SessionId(captainId))
      if (captain === undefined) continue
      try {
        await this.ctx.subagents.drainContinuableChildren(
          captain,
          [...childIds].map(SessionId),
        )
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      // Reject revision waiters, stop listening to domain changes, then
      // release the storage-domain unit so the name frees for a later open.
      await this.storeInstance?.close()
      await this.domainHandle?.close()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Team orchestrator disposal failed')
  }
}
