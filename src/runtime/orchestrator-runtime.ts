import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import { TaskId, TeamId, TeamMessageId, type AttemptId, type TaskAttempt, type TeamLimits, type TeamMessage, type TeamState, type TeamTask } from '../domain/types.js'
import { TeamDomain } from '../domain/team-domain.js'
import type { CreateTaskInput, TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import { StorageDomainTeamStore } from '../storage/storage-domain-team-store.js'
import { teamDomainSpec } from '../storage/team-spec.js'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

export interface RuntimeConfig {
  readonly memberProvider: string
  readonly memberModel?: string
  readonly memberMaxDepth: number
  readonly schedulerProvider: string
  readonly reviewProvider: string
  readonly limits: TeamLimits
}

export interface ToolExecutionAuthority {
  readonly agent?: Agent
  readonly signal: AbortSignal
}

export interface SchedulerSelectionInput {
  readonly team: TeamState
  readonly readyTasks: readonly TeamTask[]
  readonly availableMembers: readonly TeamState['members'][number][]
}

export interface SchedulerDecision {
  readonly taskId: string
  readonly memberSessionId: string
}

export interface TeamSchedulerProvider {
  select(input: SchedulerSelectionInput): readonly SchedulerDecision[] | Promise<readonly SchedulerDecision[]>
}

export interface ReviewProviderInput {
  readonly captain: Agent
  readonly workspace: string
  readonly team: TeamState
  readonly task: TeamTask
  readonly attempt: TaskAttempt
  readonly requestedDecision: 'accept' | 'reject'
  readonly diagnostic?: string
  readonly signal: AbortSignal
}

export interface ReviewProviderResult {
  readonly decision: 'accept' | 'reject'
  readonly diagnostic?: string
}

export interface TeamReviewProvider {
  review(input: ReviewProviderInput): ReviewProviderResult | Promise<ReviewProviderResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authoritative host API; model tools are only one Consumer. */
    agentSwarm: AgentSwarmRuntime
  }
}

const CAPTAIN_ONLY_TOOLS = [
  'agent_swarm_create',
  'agent_swarm_add_member',
  'agent_swarm_remove_member',
  'agent_swarm_archive',
  'agent_swarm_reassign_task',
  'agent_swarm_review_task',
  'agent_swarm_set_budget',
] as const

function requireAgent(exec: ToolExecutionAuthority): Agent {
  if (exec.agent === undefined) {
    throw new TeamDomainError('Team tools require an Agent-backed DSH session', 'TEAM_AGENT_REQUIRED')
  }
  return exec.agent
}

function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

function expectDomainTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new TeamDomainError('timeout_ms must be a safe integer from 1 to 300000', 'TEAM_INPUT_INVALID')
  }
}

function billedTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

function assignmentPrompt(team: TeamState, task: TeamTask, attemptId: AttemptId): string {
  const criteria = task.acceptanceCriteria.length === 0
    ? '- Follow the task description and provide concrete evidence.'
    : task.acceptanceCriteria.map(value => `- ${value}`).join('\n')
  return `Team assignment from captain.

Team: ${team.name} (${team.id})
Task: ${task.subject} (${task.id}, revision ${task.revision})
Attempt capability: ${attemptId}
Description: ${task.description}
Acceptance criteria:
${criteria}

Work only on this current attempt. When finished, call agent_swarm_submit_task with task_id=${task.id}, expected_revision=${task.revision}, and attempt_id=${attemptId}. Submission is not completion: the captain review gate accepts or rejects it. If the tool reports TEAM_ATTEMPT_STALE, stop immediately because ownership changed.`
}

function memberPersona(team: TeamState, name: string, role: string): string {
  return `You are ${name}, an implementation member of the DSH team "${team.name}". Your role is: ${role}.

Use the agent_swarm_* tools for all Team state; the authoritative Team aggregate lives in the host storage domain, outside this workspace, and is only reachable through those tools. Work on only one assigned attempt at a time. Preserve the exact task revision and attempt id supplied in the assignment. Submit output plus evidence, message the captain when blocked, and stop immediately on a stale-attempt error. You may create dependency-aware tasks and communicate with peers, but captain-only administration and review tools are intentionally hidden.`
}

/** DSH-facing runtime that composes the framework-neutral domain with continuable subagents. */
export class AgentSwarmRuntime extends Service {
  private domainInstance?: TeamDomainPort
  private storeInstance?: StorageDomainTeamStore
  private domainHandle?: Domain<typeof teamDomainSpec>
  private startPromise?: Promise<void>
  private readonly scheduling = new Map<string, Promise<void>>()
  private readonly usageAccounting = new Map<string, Promise<void>>()
  private readonly messageDeliveries = new Map<string, Promise<TeamMessage | undefined>>()
  private readonly schedulerProviders = new Map<string, TeamSchedulerProvider>()
  private readonly reviewProviders = new Map<string, TeamReviewProvider>()
  private readonly ownedChildren = new Map<string, Set<string>>()
  private readonly memberOperations = new Set<Promise<void>>()
  private closing = false

  constructor(
    ctx: Context,
    readonly config: RuntimeConfig,
  ) {
    super(ctx, 'agentSwarm')
    this.schedulerProviders.set('priority-ready', {
      select: ({ readyTasks, availableMembers }) => availableMembers.flatMap((member, index) => {
        const task = readyTasks[index]
        return task === undefined ? [] : [{ taskId: task.id, memberSessionId: member.sessionId }]
      }),
    })
    this.reviewProviders.set('manual', {
      review: input => ({
        decision: input.requestedDecision,
        ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      }),
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
    let completeOperation!: () => void
    const operation = new Promise<void>(settle => { completeOperation = settle })
    this.memberOperations.add(operation)
    try {
      const captain = requireAgent(exec)
      const scope = this.scopeOf(captain)
      const membership = await this.domain.requireMembership(scope, captain.id)
      if (membership.role !== 'captain') throw new TeamDomainError('only the captain can add members', 'TEAM_CAPTAIN_REQUIRED')

      const providerName = input.provider ?? this.config.memberProvider
      const provider = this.ctx.subagents.getProvider(providerName)
      if (provider === undefined) {
        throw new TeamDomainError(
          `subagent provider "${providerName}" is unavailable; registered providers: ${this.ctx.subagents.list().join(', ') || 'none'}`,
          'TEAM_MEMBER_PROVIDER_MISSING',
        )
      }
      if (provider.prepareContinuable === undefined) {
        throw new TeamDomainError(`subagent provider "${providerName}" is not continuable`, 'TEAM_MEMBER_PROVIDER_INCOMPATIBLE')
      }
      if (!provider.capabilities.persona || !provider.capabilities.toolFilter) {
        throw new TeamDomainError(
          `subagent provider "${providerName}" must support persona and toolFilter`,
          'TEAM_MEMBER_PROVIDER_INCOMPATIBLE',
        )
      }

      const childId = SessionId(randomUUID())
      const provisioning = await this.domain.provisionMember(scope, membership.team.id, captain.id, {
        name: input.name,
        role: input.role,
        sessionId: childId,
        provider: providerName,
      })
      try {
        await this.ctx.subagents.startContinuable({
          provider: providerName,
          label: `agent-swarm:${membership.team.id}:${provisioning.name}`,
          childId,
          request: {
            prompt: [{ type: 'text', text: `You joined Team "${membership.team.name}". Wait for a task assignment.` }],
            parent: captain,
            persona: memberPersona(membership.team, provisioning.name, provisioning.role),
            toolFilter: { deny: [...CAPTAIN_ONLY_TOOLS] },
            agentOptions: {
              ...(captain.options.provider === undefined ? {} : { provider: captain.options.provider }),
              ...(input.model ?? this.config.memberModel ?? captain.options.model) === undefined
                ? {}
                : { model: input.model ?? this.config.memberModel ?? captain.options.model },
            },
            maxDepth: this.config.memberMaxDepth,
          },
          signal: exec.signal,
        })
      } catch (error) {
        await this.domain.settleMember(scope, membership.team.id, childId, {
          active: false,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      try {
        const active = await this.domain.settleMember(scope, membership.team.id, childId, { active: true })
        this.trackChild(captain, childId)
        const child = this.ctx.agents.get(childId)
        if (child !== undefined) await this.accountAgentUsage(scope, membership.team.id, child)
        this.requestSchedule(scope, membership.team.id, captain)
        return active
      } catch (error) {
        await this.domain.settleMember(scope, membership.team.id, childId, {
          active: false,
          error: `member activation did not commit: ${error instanceof Error ? error.message : String(error)}`,
        }).catch(settleError => {
          this.ctx.logger.warn(`agent-swarm: failed to settle uncommitted child ${childId}: ${String(settleError)}`)
        })
        let drained = false
        await this.ctx.subagents.drainContinuableChildren(captain, [childId]).then(() => {
          drained = true
        }).catch(drainError => {
          this.ctx.logger.warn(`agent-swarm: failed to drain uncommitted child ${childId}: ${String(drainError)}`)
        })
        if (!drained) this.trackChild(captain, childId)
        throw error
      }
    } finally {
      completeOperation()
      this.memberOperations.delete(operation)
    }
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
    return await this.deliverQueuedMessage(scope, membership.team.id, captain, message.id, exec.signal) ?? message
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
    if (this.closing || event.type !== 'assistant/message' || event.data.usage === undefined) return
    const tokens = billedTokens(event.data.usage)
    const scope = resolve(session.header.cwd ?? process.cwd())
    const key = `${scope}\0${session.id}`
    const previous = this.usageAccounting.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      const membership = await this.domain.findMembership(scope, session.id)
      if (membership === undefined) return
      await this.domain.recordSessionUsage(scope, membership.team.id, session.id, event.seq, tokens)
    }).catch(error => {
      if (!this.closing) this.ctx.logger.warn(`agent-swarm: token accounting failed: ${String(error)}`)
    }).finally(() => {
      if (this.usageAccounting.get(key) === next) this.usageAccounting.delete(key)
    })
    this.usageAccounting.set(key, next)
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
      await this.deliverQueuedMessage(scope, teamId, captain, messageId, AbortSignal.timeout(30_000))
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
      if (member !== undefined) await this.accountAgentUsage(scope, team.id, member)
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

  private async deliverMessage(
    team: TeamState,
    sender: Agent,
    message: TeamMessage,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      if (message.targetSessionId === team.captainSessionId && sender.id !== team.captainSessionId) {
        await this.ctx.subagents.reportFrom(sender, [{ type: 'text', text: message.content }], {
          delivery: message.delivery === 'quiet' ? 'quiet' : 'next-step',
          signal,
        })
        return true
      }
      const captain = sender.id === team.captainSessionId
        ? sender
        : this.ctx.agents.get(SessionId(team.captainSessionId))
      if (captain === undefined) return false
      await this.ctx.subagents.followup(
        captain,
        SessionId(message.targetSessionId),
        [{ type: 'text', text: `Team message ${message.id} from ${message.senderName}:\n${message.content}` }],
        { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal },
      )
      const target = this.ctx.agents.get(SessionId(message.targetSessionId))
      if (target !== undefined) await this.accountAgentUsage(this.scopeOf(captain), team.id, target)
      return true
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: message ${message.id} remains queued: ${String(error)}`)
      return false
    }
  }

  private async deliverQueuedMessage(
    scope: TeamScope,
    teamId: TeamId,
    captain: Agent,
    messageId: TeamMessageId,
    signal: AbortSignal,
  ): Promise<TeamMessage | undefined> {
    const key = `${scope}\0${teamId}\0${messageId}`
    const previous = this.messageDeliveries.get(key) ?? Promise.resolve(undefined)
    const next = previous.then(async () => {
      if (this.closing) return undefined
      const snapshot = await this.domain.snapshot(scope, teamId, captain.id)
      const message = snapshot.team.messages.find(candidate => candidate.id === messageId)
      if (message === undefined || message.phase !== 'queued') return message
      const sender = message.senderSessionId === captain.id
        ? captain
        : this.ctx.agents.get(SessionId(message.senderSessionId))
      if (sender === undefined && message.targetSessionId === captain.id) return undefined
      const delivered = await this.deliverMessage(snapshot.team, sender ?? captain, message, signal)
      if (!delivered) return undefined
      return await this.domain.acknowledgeMessage(scope, teamId, message.id)
    }).finally(() => {
      if (this.messageDeliveries.get(key) === next) this.messageDeliveries.delete(key)
    })
    this.messageDeliveries.set(key, next)
    return await next
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

  private async accountAgentUsage(scope: TeamScope, teamId: TeamId, agent: Agent): Promise<void> {
    const snapshot = await this.domain.snapshot(scope, teamId, agent.id)
    const afterSeq = snapshot.team.usageCursors[agent.id] ?? -1
    for (const event of agent.session.events) {
      if (event.seq <= afterSeq) continue
      if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
      const tokens = billedTokens(event.data.usage)
      await this.domain.recordSessionUsage(scope, teamId, agent.id, event.seq, tokens)
    }
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    await Promise.allSettled(this.memberOperations)
    await Promise.allSettled(this.scheduling.values())
    await Promise.allSettled(this.usageAccounting.values())
    await Promise.allSettled(this.messageDeliveries.values())
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
