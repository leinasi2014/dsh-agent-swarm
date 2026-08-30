/** DSH-facing Team orchestrator over the domain and official DSH services. */
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type { TaskAttempt, TeamAnnouncement, TeamId, TeamMessage, TeamMessageCausal, TeamState, TeamStatusSnapshot, TeamTask } from '../domain/types.js'
import { TeamDomain } from '../domain/team-domain.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import type { MemberIdentityInput } from '../domain/identity-profile.js'
import { StorageDomainTeamStore } from '../storage/storage-domain-team-store.js'
import { teamDomainSpec } from '../storage/team-spec.js'
import { requireAgent, workspaceOf, type ToolExecutionAuthority } from './authority.js'
import { boundedSettle } from './disposal.js'
import { ExecutionRootSurface } from './execution-root-surface.js'
import type { ExecutionRootResidue, TeamExecutionRootProvider } from './execution-roots.js'
import { interruptMember, interruptMemberFromModel } from './member-control.js'
import { MemberProfileReader } from './member-profile-reader.js'
import { MemberProvisioner } from './member-provisioning.js'
import { MessageDelivery } from './message-delivery.js'
import { manualReview, priorityReadyScheduler, type ReviewProviderInput, type ReviewProviderResult, type SchedulerDecision, type SchedulerSelectionInput, type TeamReviewProvider, type TeamSchedulerProvider } from './providers.js'
import { executableReview } from './executable-review.js'
import type { ReviewRootCapabilities, ReviewRootProvider } from './review-root.js'
import { OrchestrationOwnership } from './orchestration-ownership.js'
import { SchedulingPass } from './scheduling.js'
import { UsageAccountant } from './usage-accounting.js'
import { activePeerEvidence, status, waitForChange, WaitSpinFuse, type WaitSpinObservation, type WaitSpinVerdict, type WaitSurfaceDeps } from './wait-surface.js'
import type { RuntimeConfig } from './runtime-contract.js'
import type { TeamJobProjection } from './jobs/team-job-projection.js'
import type { TeamBridgeWorkflowEngine } from './workflow/team-bridge-engine.js'
import type { RuntimeCreateTaskInput, VerificationCommandTemplate } from './verification-commands.js'
import { VerificationFamily } from './verification-family.js'
import { DedicatedCaptainProvisioner } from './dedicated-captain-provisioning.js'
import { RuntimeMutationSurface } from './runtime-mutation-surface.js'

export type { ToolExecutionAuthority }
export type { ReviewProviderInput, ReviewProviderResult, SchedulerDecision, SchedulerSelectionInput, TeamReviewProvider, TeamSchedulerProvider }
export type { RuntimeConfig } from './runtime-contract.js'

/** DSH-facing runtime that composes the framework-neutral domain with continuable subagents. */
export class AgentSwarmRuntime extends Service {
  private domainInstance?: TeamDomainPort
  private storeInstance?: StorageDomainTeamStore
  private domainHandle?: Domain<typeof teamDomainSpec>
  private startPromise?: Promise<void>
  private readonly scheduling = new Map<string, Promise<void>>()
  private readonly schedulerProviders = new Map<string, TeamSchedulerProvider>()
  private readonly reviewProviders = new Map<string, TeamReviewProvider>()
  private readonly verificationFamily = new VerificationFamily()
  private readonly ownedChildren = new Map<string, Set<string>>()
  /**
   * In-process single-flight of managed-Team creation keyed by the resolved
   * operation identity (MainBrainSessionId + turn). Pure acceleration: concurrent
   * same-identity calls share one provisioning promise. The AUTHORITATIVE
   * correctness (and cross-process safety) is the persisted managed origin —
   * check-then-create against Storage Domain, plus createUniqueForCaptain's
   * origin non-duplication under the scope lock. Never the sole guarantee.
   */
  /** Session id → its idle-stretch start, latched per `agent/status → idle` edge (issue #83; absent = task clock). */
  private readonly idleSince = new Map<string, number>()
  private readonly waitSpinFuse = new WaitSpinFuse()
  private readonly usage: UsageAccountant
  private readonly delivery: MessageDelivery
  private readonly memberProfiles: MemberProfileReader
  private readonly provisioning: MemberProvisioner
  private readonly captainProvisioning: DedicatedCaptainProvisioner
  private readonly schedulingPass: SchedulingPass
  private readonly mutations: RuntimeMutationSurface
  readonly orchestration: OrchestrationOwnership
  readonly executionRoots: ExecutionRootSurface
  private closing = false
  /** The Team bridge workflow engine (M2-1, issue #75), attached by plugin
   * activation when `workflowBridge` is enabled. Registered in an isolated
   * `workflowEngine` service scope — never over the default-scope official
   * engine. Absent (undefined) when the capability is disabled: default
   * behavior is byte-identical to the pre-bridge plugin.
   */
  workflowBridge?: TeamBridgeWorkflowEngine
  /** The caller-scoped Team task read projection, attached when `jobsBridge`
   * is enabled. It is deliberately not a `ctx.jobs` Provider: it has no
   * producer or task-lifecycle ownership. Absent (undefined) when disabled.
   */
  jobsBridge?: TeamJobProjection

  constructor(
    ctx: Context,
    readonly config: RuntimeConfig,
  ) {
    super(ctx, 'agentSwarm')
    if (!Number.isSafeInteger(config.disposalTimeoutMs) || config.disposalTimeoutMs < 1) { throw new TeamDomainError('disposalTimeoutMs must be a positive safe integer', 'TEAM_INVALID_CONFIG') }
    if (!Number.isSafeInteger(config.strandedAfterMs) || config.strandedAfterMs < 0) { throw new TeamDomainError('strandedAfterMs must be a safe non-negative integer', 'TEAM_INVALID_CONFIG') }
    const requestSchedule = (scope: TeamScope, teamId: TeamId, captain: Agent): void => this.requestSchedule(scope, teamId, captain)
    this.orchestration = new OrchestrationOwnership({ mode: config.orchestrationMode, requestSchedule })
    this.schedulerProviders.set('priority-ready', priorityReadyScheduler())
    this.reviewProviders.set('manual', manualReview())
    const commandBound = config.limits.maxVerificationCommandMs
    this.reviewProviders.set('executable', executableReview({
      resolveRoot: name => this.verificationFamily.resolveRoot(name),
      resolveRootCapabilities: name => this.verificationFamily.resolveCapabilities(name),
      rootProviderName: () => this.config.reviewRootProvider,
      defaultCommandTimeoutMs: commandBound,
      maxCommandTimeoutMs: commandBound,
      warn: message => this.ctx.logger.warn(message),
    }))
    this.executionRoots = new ExecutionRootSurface({
      ctx,
      enabled: () => config.executionRootsEnabled,
      closing: () => this.closing,
      providerName: () => config.executionRootProvider,
      base: config.executionRootsBase,
      domain: () => this.domain,
      teams: scope => this.listTeamAggregates(scope),
    })
    this.usage = new UsageAccountant(ctx, { domain: () => this.domain, isClosing: () => this.closing })
    this.delivery = new MessageDelivery(ctx, {
      domain: () => this.domain,
      isClosing: () => this.closing,
      scopeOf: agent => this.scopeOf(agent),
      accountAgentUsage: (scope, teamId, agent) => this.usage.accountAgentUsage(scope, teamId, agent),
    })
    this.memberProfiles = new MemberProfileReader(ctx)
    this.schedulingPass = new SchedulingPass(ctx, {
      domain: () => this.domain,
      delivery: () => this.delivery,
      usage: () => this.usage,
      schedulerProvider: () => this.config.schedulerProvider,
      schedulerProviders: () => this.schedulerProviders,
      strandedAfterMs: this.config.strandedAfterMs,
      idleSince: sessionId => this.idleSince.get(sessionId),
      eventFaceActive: (scope, teamId) => this.orchestration.eventFaceActive(scope, teamId),
      isClosing: () => this.closing,
      trackTeamChildren: (captain, team) => this.trackTeamChildren(captain, team),
      requestSchedule: (scope, teamId, captain) => this.requestSchedule(scope, teamId, captain),
      executionRoots: () => this.executionRoots.roots,
      executionRootsEnabled: () => this.config.executionRootsEnabled,
      sweepExecutionRoots: (scope, teamId) => this.executionRoots.sweep(scope, teamId),
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
    this.captainProvisioning = new DedicatedCaptainProvisioner(ctx, {
      config, domain: () => this.domain, trackChild: (parent, childId) => this.trackChild(parent, childId),
    })
    this.mutations = new RuntimeMutationSurface({
      ctx, config, domain: () => this.domain,
      ensureReady: () => this.ensureReady(), assertOpen: () => this.assertOpen(),
      assertConfiguredProviders: () => this.assertConfiguredProviders(), scopeOf: agent => this.scopeOf(agent),
      watchJobsScope: scope => this.watchJobsScope(scope), listTeamAggregates: scope => this.listTeamAggregates(scope),
      provisioning: this.provisioning, captainProvisioning: this.captainProvisioning,
      verificationFamily: this.verificationFamily, executionRoots: this.executionRoots, delivery: this.delivery,
      reviewProvider: name => this.reviewProviders.get(name),
      requestSchedule: (scope, teamId, captain) => this.requestSchedule(scope, teamId, captain),
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
      // After a service restart the transient in-memory ownedChildren map is
      // empty, so the read-only enumeration/binding of Main Brain → dedicated
      // Captain → Team has no root→Captain edge until a Captain turns again.
      // Rebuild that transient relation from the OFFICIAL persisted Session
      // headers (parentSession), not from a second authority.
      await this.recoverOwnedChildrenFromPersistence()
    })()
    return this.startPromise
  }

  /**
   * Rebuild the transient root → dedicated-Captain (`ownedChildren`) edges from
   * the official Session persistence when this fresh process starts with it
   * empty — the "restart loses ownedChildren" recovery. Reads only the canonical
   * persisted Session headers (`sessionPersistence.list()`), and a persisted
   * Session counts as a managed child of its parent ONLY when an authoritative
   * StorageDomain Team aggregate in its own workspace scope (derived from the
   * header's `cwd`) names it as `captainSessionId`. Ordinary sibling subagents,
   * plain continuable children and Team members — none of which own a Team — are
   * never resurrected into `ownedChildren`, so read-only enumeration/binding
   * cannot fabricate a captain relationship from unrelated persisted Sessions.
   * No second authority, no new persistent state, no Agent Loop change.
   * Best-effort: an unavailable or empty persistence store leaves the map
   * untouched (queries then simply see no managed children, as before the fix).
   */
  private async recoverOwnedChildrenFromPersistence(): Promise<void> {
    const persistence = this.ctx.sessionPersistence
    const store = this.storeInstance
    if (persistence === undefined || store === undefined) return
    let headers
    try {
      headers = await persistence.list()
    } catch {
      return
    }
    const captainsByScope = new Map<TeamScope, ReadonlySet<string>>()
    for (const header of headers) {
      if (header.parentSession === undefined || header.cwd === undefined) continue
      const scope = resolve(header.cwd)
      let captains = captainsByScope.get(scope)
      if (captains === undefined) {
        try {
          // start() is awaiting this method, so read the already-open store
          // directly instead of recursing through listTeamAggregates()/start().
          const teams = await store.list(scope)
          for (const team of teams) this.config.teamSkills.rememberTeam(team)
          captains = new Set(teams.map(team => team.captainSessionId))
        } catch {
          continue
        }
        captainsByScope.set(scope, captains)
      }
      if (!captains.has(header.id)) continue
      const children = this.ownedChildren.get(header.parentSession) ?? new Set<string>()
      children.add(header.id)
      this.ownedChildren.set(header.parentSession, children)
    }
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

  /** Register a review execution root supply (M3-2, docs/04 §5). */
  registerReviewRootProvider(name: string, provider: ReviewRootProvider, capabilities?: ReviewRootCapabilities): () => void {
    return this.verificationFamily.registerRoot(name, provider, capabilities)
  }

  /** Register one named pre-commit verification command template. */
  registerVerificationCommandTemplate(name: string, template: VerificationCommandTemplate): () => void {
    return this.verificationFamily.registerTemplate(name, template)
  }

  /** Register one replaceable execution-root Provider (M3-1, issue #100). */
  registerExecutionRootProvider(name: string, provider: TeamExecutionRootProvider): () => void {
    return this.executionRoots.registerProvider(name, provider)
  }

  /** Canonical workspace scope key partitioning this agent's Team namespace. */
  scopeOf(agent: Agent): TeamScope {
    return resolve(workspaceOf(agent))
  }

  /**
   * Read-only enumeration of every Team aggregate in one workspace scope,
   * straight from the authoritative store. Consumed by derived projections
   * (the M2-2 jobs bridge's scope seeding); never a mutation path.
   */
  async listTeamAggregates(scope: TeamScope): Promise<TeamState[]> {
    if (this.storeInstance === undefined) await this.start()
    if (this.storeInstance === undefined) {
      throw new TeamDomainError('Team orchestrator storage did not start', 'TEAM_RUNTIME_NOT_STARTED')
    }
    return await this.storeInstance.list(scope)
  }

  /**
   * Read-only enumeration of every managed/owned Team visible to the caller
   * (a Main Brain root or a dedicated Captain). Reuses the exact Host
   * visibility predicate (`host-read-service.isVisibleToRoot`) but bounds it
   * to the live `exec.agent` — never an RPC-supplied root id or caller text:
   * a Team is listed iff the caller is its Captain, a managed dedicated
   * Captain child of the caller, or the persisted parent of its Captain.
   * Otherwise it is dropped fail-closed with no foreign metadata leak. Scope
   * is the caller's workspace scope only: no cross-principal union, no
   * process-wide fallback, no second authority. Read-only over
   * `listTeamAggregates`; never a mutation path.
   */
  async listManagedTeams(exec: ToolExecutionAuthority): Promise<TeamState[]> {
    await this.ensureReady(); this.assertOpen()
    const agent = requireAgent(exec)
    const callerId = String(agent.id)
    const teams = await this.listTeamAggregates(this.scopeOf(agent))
    const managedChildren = new Set(this.managedCaptainSessionsOf(callerId))
    const parentOf = (sessionId: string): string | undefined =>
      this.ctx.sessions.get(SessionId(sessionId))?.header.parentSession
    return teams.filter(team =>
      team.captainSessionId === callerId
      || managedChildren.has(team.captainSessionId)
      || parentOf(team.captainSessionId) === callerId)
  }

  /** Latch one scope into the jobs projection (idempotent, best-effort). */
  private watchJobsScope(scope: TeamScope): void {
    if (this.jobsBridge === undefined) return
    void this.jobsBridge.watchScope(scope)
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
    if (!this.verificationFamily.hasRoot(this.config.reviewRootProvider)) {
      throw new TeamDomainError(`review root Provider "${this.config.reviewRootProvider}" is unavailable`, 'TEAM_REVIEW_ROOT_PROVIDER_MISSING')
    }
  }

  async create(exec: ToolExecutionAuthority, name: string, description: string): Promise<TeamState> {
    return await this.mutations.create(exec, name, description)
  }

  async createWithDedicatedCaptain(exec: ToolExecutionAuthority, name: string, description: string, options: { llmProvider?: string; model?: string } = {}): Promise<TeamState> {
    return await this.mutations.createWithDedicatedCaptain(exec, name, description, options)
  }

  async addMember(exec: ToolExecutionAuthority, input: { name: string; role: string; provider?: string; llmProvider?: string; model?: string; denyTools?: readonly string[] } & MemberIdentityInput): Promise<TeamState['members'][number]> {
    return await this.mutations.addMember(exec, input)
  }

  /** Captain-only: set this Team's public identity profile (validated; expected_revision CAS in-domain). */
  async setCaptainProfile(exec: ToolExecutionAuthority, expectedRevision: number, input: MemberIdentityInput): Promise<TeamState> {
    return await this.mutations.setCaptainProfile(exec, expectedRevision, input)
  }

  /** Captain-only: publish one public announcement (expected_revision CAS). */
  async publishAnnouncement(exec: ToolExecutionAuthority, expectedRevision: number, text: string): Promise<{ team: TeamState; announcement: TeamAnnouncement }> {
    return await this.mutations.publishAnnouncement(exec, expectedRevision, text)
  }

  /** Captain-only: set this Team's public goal (canonical bounded text, expected_revision CAS). */
  async setPublicGoal(exec: ToolExecutionAuthority, expectedRevision: number, text: string): Promise<TeamState> {
    return await this.mutations.setPublicGoal(exec, expectedRevision, text)
  }

  async createTask(exec: ToolExecutionAuthority, input: RuntimeCreateTaskInput): Promise<TeamTask> {
    return await this.mutations.createTask(exec, input)
  }

  async removeMember(exec: ToolExecutionAuthority, name: string, reason: string) {
    return await this.mutations.removeMember(exec, name, reason)
  }

  async archive(exec: ToolExecutionAuthority, reason: string): Promise<TeamState> {
    return await this.mutations.archive(exec, reason)
  }

  async claimTask(
    exec: ToolExecutionAuthority,
    taskId: string,
    expectedRevision: number,
  ): Promise<{ task: TeamTask; attempt: TaskAttempt; executionRoot?: { path: string; isolation: 'git-worktree' | 'temp-directory' } }> {
    return await this.mutations.claimTask(exec, taskId, expectedRevision)
  }

  async submitTask(
    exec: ToolExecutionAuthority,
    input: { taskId: string; expectedRevision: number; attemptId: string; output: string; evidence?: readonly string[] },
  ): Promise<TeamTask> {
    return await this.mutations.submitTask(exec, input)
  }

  async reassignTask(exec: ToolExecutionAuthority, taskId: string, expectedRevision: number, reason: string, targetMemberName?: string): Promise<TeamTask> {
    return await this.mutations.reassignTask(exec, taskId, expectedRevision, reason, targetMemberName)
  }

  async reviewTask(
    exec: ToolExecutionAuthority,
    input: { taskId: string; expectedRevision: number; attemptId: string; decision: 'accept' | 'reject'; diagnostic?: string },
  ): Promise<{ task: TeamTask; decision: 'accept' | 'reject' }> {
    return await this.mutations.reviewTask(exec, input)
  }

  async sendMessage(
    exec: ToolExecutionAuthority, target: string, content: string,
    delivery: 'quiet' | 'wakeup', causal?: TeamMessageCausal, supersedes?: TeamMessage['supersedes'],
  ): Promise<TeamMessage> {
    return await this.mutations.sendMessage(exec, target, content, delivery, causal, supersedes)
  }

  async status(exec: ToolExecutionAuthority) {
    return await status(this.waitDeps(), exec)
  }

  /** Read durable roster composition; never resumes or repairs a child. */
  async listMemberProfiles(exec: ToolExecutionAuthority, input: { phase?: TeamState['members'][number]['phase']; cursor: number; limit: number }) {
    return await this.memberProfiles.listPage((await this.status(exec)).team, input, exec.signal)
  }

  async waitForChange(exec: ToolExecutionAuthority, afterRevision: number, timeoutMs: number) {
    return await waitForChange(this.waitDeps(), exec, afterRevision, timeoutMs)
  }

  noteWaitSpin(exec: ToolExecutionAuthority, observation: WaitSpinObservation, timeoutMs: number): WaitSpinVerdict { return this.waitSpinFuse.note(exec, observation, timeoutMs) }

  /** Issue #15 no-progress evidence; the read surface lives in `wait-surface.ts`. */
  async activePeerEvidence(exec: ToolExecutionAuthority): Promise<{ snapshot: TeamStatusSnapshot; activePeer: boolean }> {
    return await activePeerEvidence(this.waitDeps(), exec)
  }

  private waitDeps(): WaitSurfaceDeps {
    return {
      ctx: this.ctx, domain: () => this.domain, isClosing: () => this.closing,
      scopeOf: agent => this.scopeOf(agent), ensureReady: () => this.ensureReady(),
    }
  }

  /** Trusted Host/Human keepInbox interrupt; samples status before cancellation. */
  async interruptMember(exec: ToolExecutionAuthority, name: string): Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive' }> {
    return await interruptMember({ ctx: this.ctx, domain: () => this.domain, isClosing: () => this.closing, scopeOf: agent => this.scopeOf(agent), ensureReady: () => this.ensureReady(), now: Date.now }, exec, name)
  }

  /** Model-tool-only interrupt path; Host/Human callers retain interruptMember. */
  async interruptMemberFromModel(exec: ToolExecutionAuthority, name: string): Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive'; evidenceKind: 'host-confirmed-tool-timeout' }> {
    return await interruptMemberFromModel({ ctx: this.ctx, domain: () => this.domain, isClosing: () => this.closing, scopeOf: agent => this.scopeOf(agent), ensureReady: () => this.ensureReady(), now: Date.now }, exec, name)
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
    const budget = await this.domain.setBudget(scope, membership.team.id, captain.id, limits)
    return (this.requestSchedule(scope, membership.team.id, captain), budget) // §7 budget-release event (M4-3/#129): the recovery pass of held/postponed work
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
    this.idleSince.set(agent.id, Date.now())
    void this.recoverAgent(agent).catch(error => {
      if (!this.closing) this.ctx.logger.warn(`agent-swarm: idle recovery failed: ${String(error)}`)
    })
  }

  async recoverAgent(agent: Agent): Promise<void> {
    if (this.closing) return
    const scope = this.scopeOf(agent)
    this.watchJobsScope(scope)
    let membership = await this.domain.findMembership(scope, agent.id)
    if (membership === undefined || this.closing) return
    if (membership.role === 'captain') {
      const settled = await this.provisioning.recoverInterrupted(agent, scope, membership)
      if (settled > 0) membership = await this.domain.requireMembership(scope, agent.id)
    }
    const captain = this.ctx.agents.get(SessionId(membership.team.captainSessionId))
    if (captain === undefined) return
    this.trackTeamChildren(captain, membership.team)
    // Single-owner discipline (M2-3): autonomous drives defer to a live run
    // owner; `workflow` mode deactivates the face entirely (docs/04 §8g).
    if (agent.status === 'idle' && this.orchestration.eventFaceActive(scope, membership.team.id)) {
      this.requestSchedule(scope, membership.team.id, captain)
    }
  }

  observeSessionEvent(session: Session, event: SessionEvent): void { this.usage.observeSessionEvent(session, event); this.provisioning.observeSessionEvent(session, event); this.captainProvisioning.observeSessionEvent(session, event) }

  private requestSchedule(scope: TeamScope, teamId: TeamId, captain: Agent): void {
    const key = `${scope}\0${teamId}`
    const previous = this.scheduling.get(key) ?? Promise.resolve()
    const next = previous.then(async () => { await this.schedulingPass.run(scope, teamId, captain) })
      .catch(error => {
        if (!this.closing) this.ctx.logger.warn(`agent-swarm: scheduler failed for ${teamId}: ${String(error)}`)
        this.orchestration.notePassFailure(scope, teamId, error)
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

  /** Managed dedicated Captain child Session ids of a root (Main Brain or Captain parent). */
  managedCaptainSessionsOf(rootSessionId: string): readonly string[] { return [...(this.ownedChildren.get(rootSessionId) ?? [])] }

  private trackTeamChildren(captain: Agent, team: TeamState): void {
    for (const member of team.members) {
      if (member.phase === 'active') this.trackChild(captain, member.sessionId)
    }
  }

  /**
   * Activation-recovery residue scan (M3-1, issue #100): fold every on-disk
   * execution root of one scope against the authoritative aggregates. Called
   * once per root-reachable scope at plugin activation; orphans are alarmed
   * and marked reclaimable (never auto-deleted), reattachable roots are
   * reported. Returns the report for observation (D1 root-residue metric).
   */
  async scanExecutionRootResidue(scope: TeamScope): Promise<ExecutionRootResidue[]> {
    await this.ensureReady()
    return await this.executionRoots.scan(scope)
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.captainProvisioning.dispose()
    this.provisioning.dispose()
    this.schedulingPass.dispose()
    this.idleSince.clear()
    this.orchestration.clear()
    const failures: unknown[] = []
    const bound = <T>(label: string, operation: Promise<T>): Promise<void> =>
      boundedSettle(this.ctx, this.config.disposalTimeoutMs, label, operation, failures)
    await bound('Captain provisioning', this.captainProvisioning.wait())
    await bound('member provisioning', this.provisioning.wait())
    await bound('scheduling', Promise.allSettled(this.scheduling.values()))
    await bound('message delivery', this.delivery.wait())
    await bound('execution roots', this.executionRoots.releaseAll('runtime disposal'))
    for (const [captainId, childIds] of this.ownedChildren) {
      const captain = this.ctx.agents.get(SessionId(captainId))
      if (captain === undefined) continue
      await bound(
        `child drain for ${captainId}`,
        this.ctx.subagents.drainContinuableChildren(captain, [...childIds].map(SessionId)),
      )
    }
    await bound('token accounting', this.usage.wait()) // after the child drain: final usage lands during it (issue #92, docs/04 §8k)
    await bound('aggregate store close', (async () => {
      // Reject revision waiters, stop listening to domain changes, then
      // release the storage-domain unit so the name frees for a later open.
      await this.storeInstance?.close()
      await this.domainHandle?.close()
    })())
    if (failures.length > 0) throw new AggregateError(failures, 'Team orchestrator disposal failed')
  }
}
