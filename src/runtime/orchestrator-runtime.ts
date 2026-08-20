/**
 * DSH-facing Team orchestrator.
 *
 * Composes the framework-neutral Team domain with continuable subagents and
 * the official Storage Domain. This class owns lifecycle, the Provider
 * registries and tool-facing operations; provisioning, mailbox delivery,
 * token accounting and the scheduling pass (issue #12 / F10 discipline)
 * live in dedicated collaborators.
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
import { boundedSettle } from './disposal.js'
import { interruptMember } from './member-control.js'
import { MemberProvisioner } from './member-provisioning.js'
import { MessageDelivery } from './message-delivery.js'
import { manualReview, priorityReadyScheduler, type ReviewProviderInput, type ReviewProviderResult, type SchedulerDecision, type SchedulerSelectionInput, type TeamReviewProvider, type TeamSchedulerProvider } from './providers.js'
import { SchedulingPass } from './scheduling.js'
import { UsageAccountant } from './usage-accounting.js'

export type { ToolExecutionAuthority }
export type { ReviewProviderInput, ReviewProviderResult, SchedulerDecision, SchedulerSelectionInput, TeamReviewProvider, TeamSchedulerProvider }

export interface RuntimeConfig {
  readonly memberProvider: string
  readonly memberModel?: string
  readonly memberMaxDepth: number
  readonly schedulerProvider: string
  readonly reviewProvider: string
  readonly limits: TeamLimits
  /**
   * Bound for every disposal settlement step (F4), aligned with the official
   * experimental `disposalTimeoutMs` (default 5000). Positive safe integer.
   */
  readonly disposalTimeoutMs: number
  /**
   * Stranded-ownership grace bound (issue #12 / F10): a live-and-idle member
   * holding an open in_progress task is retried under a fresh attempt once
   * this many milliseconds elapsed since the task's last transition. Safe
   * non-negative integer; 0 disables automatic retry (evidence-only
   * `stranded=` hints remain). Decisions: docs/04 §8c.
   */
  readonly strandedAfterMs: number
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
  private readonly schedulingPass: SchedulingPass
  private closing = false

  constructor(
    ctx: Context,
    readonly config: RuntimeConfig,
  ) {
    super(ctx, 'agentSwarm')
    if (!Number.isSafeInteger(config.disposalTimeoutMs) || config.disposalTimeoutMs < 1) {
      throw new TeamDomainError('disposalTimeoutMs must be a positive safe integer', 'TEAM_INVALID_CONFIG')
    }
    if (!Number.isSafeInteger(config.strandedAfterMs) || config.strandedAfterMs < 0) {
      throw new TeamDomainError('strandedAfterMs must be a safe non-negative integer', 'TEAM_INVALID_CONFIG')
    }
    this.schedulerProviders.set('priority-ready', priorityReadyScheduler())
    this.reviewProviders.set('manual', manualReview())
    this.usage = new UsageAccountant(ctx, { domain: () => this.domain, isClosing: () => this.closing })
    this.delivery = new MessageDelivery(ctx, {
      domain: () => this.domain,
      isClosing: () => this.closing,
      scopeOf: agent => this.scopeOf(agent),
      accountAgentUsage: (scope, teamId, agent) => this.usage.accountAgentUsage(scope, teamId, agent),
    })
    this.schedulingPass = new SchedulingPass(ctx, {
      domain: () => this.domain,
      delivery: () => this.delivery,
      usage: () => this.usage,
      schedulerProvider: () => this.config.schedulerProvider,
      schedulerProviders: () => this.schedulerProviders,
      strandedAfterMs: this.config.strandedAfterMs,
      isClosing: () => this.closing,
      trackTeamChildren: (captain, team) => this.trackTeamChildren(captain, team),
      requestSchedule: (scope, teamId, captain) => this.requestSchedule(scope, teamId, captain),
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
    // F14 read path: reads resolve through the archived captain too, so the
    // terminal aggregate stays inspectable after archive.
    const membership = await this.domain.requireReadMembership(scope, actor.id)
    return await this.domain.snapshot(scope, membership.team.id, actor.id)
  }

  async waitForChange(exec: ToolExecutionAuthority, afterRevision: number, timeoutMs: number) {
    await this.ensureReady()
    this.assertOpen()
    const actor = requireAgent(exec)
    expectDomainTimeout(timeoutMs)
    // Official parity: caller cancellation rejects before waiter registration.
    exec.signal.throwIfAborted()
    const scope = this.scopeOf(actor)
    const membership = await this.domain.requireReadMembership(scope, actor.id)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    try {
      const snapshot = await this.domain.waitForChange(
        scope,
        membership.team.id,
        actor.id,
        afterRevision,
        AbortSignal.any([exec.signal, timeoutSignal]),
      )
      // An archived Team resolves immediately even at a current cursor (it
      // can never commit a later revision), so `changed` is derived from the
      // authoritative revision, not from the wait having returned.
      return { snapshot, changed: snapshot.team.revision > afterRevision }
    } catch (error) {
      if (timeoutSignal.aborted && !exec.signal.aborted) {
        return { snapshot: await this.domain.snapshot(scope, membership.team.id, actor.id), changed: false }
      }
      // Issue #19, official `TEAM_WAIT_ABORTED` parity: caller cancellation
      // surfaces as one structured domain error instead of a raw abort reason.
      if (exec.signal.aborted) {
        throw new TeamDomainError(
          `agent_swarm_wait aborted: ${error instanceof Error ? error.message : String(error)}`,
          'TEAM_WAIT_ABORTED',
          { cause: error },
        )
      }
      throw error
    }
  }

  /**
   * Captain-only keepInbox member interrupt (issue #19, official parity);
   * the control surface lives in `member-control.ts`.
   * @returns the target status sampled before the cancellation took effect.
   */
  async interruptMember(
    exec: ToolExecutionAuthority,
    name: string,
  ): Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive' }> {
    return await interruptMember({
      ctx: this.ctx,
      domain: () => this.domain,
      isClosing: () => this.closing,
      scopeOf: agent => this.scopeOf(agent),
      ensureReady: () => this.ensureReady(),
    }, exec, name)
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
      const settled = await this.provisioning.recoverInterrupted(agent, scope, membership)
      if (settled > 0) membership = await this.domain.requireMembership(scope, agent.id)
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
    const next = previous.then(async () => { await this.schedulingPass.run(scope, teamId, captain) })
      .catch(error => {
        if (!this.closing) this.ctx.logger.warn(`agent-swarm: scheduler failed for ${teamId}: ${String(error)}`)
      })
      .finally(() => {
        if (this.scheduling.get(key) === next) this.scheduling.delete(key)
      })
    this.scheduling.set(key, next)
  }

  /**
   * Evidence-only stranded-ownership hint consumed by the status projection
   * (issue #12 / F10): `stranded=idle-holder` while the owner is live and
   * idle, `stranded=owner-not-live` when it is cold. Never mutates
   * authoritative state — decisions in docs/04 §8c.
   */
  strandedEvidence(task: TeamTask): string {
    return this.schedulingPass.strandedEvidence(task)
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
    this.schedulingPass.dispose()
    const failures: unknown[] = []
    const bound = <T>(label: string, operation: Promise<T>): Promise<void> =>
      boundedSettle(this.ctx, this.config.disposalTimeoutMs, label, operation, failures)
    await bound('member provisioning', this.provisioning.wait())
    await bound('scheduling', Promise.allSettled(this.scheduling.values()))
    await bound('token accounting', this.usage.wait())
    await bound('message delivery', this.delivery.wait())
    for (const [captainId, childIds] of this.ownedChildren) {
      const captain = this.ctx.agents.get(SessionId(captainId))
      if (captain === undefined) continue
      await bound(
        `child drain for ${captainId}`,
        this.ctx.subagents.drainContinuableChildren(captain, [...childIds].map(SessionId)),
      )
    }
    await bound('aggregate store close', (async () => {
      // Reject revision waiters, stop listening to domain changes, then
      // release the storage-domain unit so the name frees for a later open.
      await this.storeInstance?.close()
      await this.domainHandle?.close()
    })())
    if (failures.length > 0) throw new AggregateError(failures, 'Team orchestrator disposal failed')
  }
}
