import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import { TeamDomainError } from '../domain/error.js'
import { isTaskReady } from '../domain/graph.js'
import {
  draftTaskV2,
  TeamV2StartDomain,
  type CreateTaskV2Input,
  type InitialDispatchCheckpoint,
} from '../domain/team-domain-v2-start.js'
import type { ContinuationIntent, TeamMemberV2, TeamStateV2 } from '../domain/team-state-v2.js'
import { AttemptId, type TeamTask } from '../domain/types.js'
import { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { teamDomainSpecV2 } from '../storage/team-spec-v2.js'
import type { InitialTaskBoardRuntime, ReassignTaskRuntime, SubmitTaskRuntime } from '../tools/task-board.js'
import type { InitialTeamLifecycleRuntime } from '../tools/team-lifecycle.js'
import { requireAgent, workspaceOf, type ToolExecutionAuthority } from './authority.js'
import { boundedSettle } from './disposal.js'
import { assistantEvidenceAt, claimedInitialFrame, currentStepContainsInitialFrame, initialPromptDigest } from './fresh-v2-session-fold.js'
import {
  compileInitialVerification, currentFreshV2InitialAttempt, describeFreshV2Error,
  findFreshV2Membership, initialCheckpointOf,
  type CurrentInitialAttempt,
  type FreshV2Membership,
} from './fresh-v2-initial-support.js'
import { resolveAssignedSkills } from './member-skill-policy.js'
import { assignmentPrompt, memberPersona } from './prompts.js'
import { memberToolDeny } from './tool-policy.js'
import type { RuntimeCreateTaskInput } from './verification-commands.js'
import { FreshV2WitnessCapability } from './fresh-v2-witness-capability.js'
import { FreshV2ContinuationRuntime } from './fresh-v2-continuation-runtime.js'
import type { ContinuationRuntime } from '../tools/continuation.js'
import {
  consumeFreshV2ModelPermit,
  retireFreshV2ModelPermit,
  type FreshV2ModelPermit,
} from './fresh-v2-model-permit.js'
import { FreshV2EvidenceCoordinator } from './fresh-v2-evidence-coordinator.js'
import { FreshV2TaskControlRuntime } from './fresh-v2-task-control-runtime.js'
import type { FreshV2InitialConfig } from './fresh-v2-initial-config.js'
import { ownsFreshV2InitialModelDispatch } from './fresh-v2-initial-model-gate.js'
export type { FreshV2InitialConfig } from './fresh-v2-initial-config.js'

export class FreshV2InitialRuntime implements InitialTeamLifecycleRuntime, InitialTaskBoardRuntime, ContinuationRuntime, SubmitTaskRuntime, ReassignTaskRuntime {
  private domainHandle?: Domain<typeof teamDomainSpecV2>
  private store?: StorageDomainTeamStoreV2
  private domain?: TeamV2StartDomain
  private continuation?: FreshV2ContinuationRuntime
  private taskControl?: FreshV2TaskControlRuntime
  private readonly children = new Map<string, Set<string>>()
  private readonly dispatchStreams = new Set<Promise<void>>()
  private readonly evidence: FreshV2EvidenceCoordinator
  private readonly modelPermits = new Map<string, FreshV2ModelPermit>()
  private readonly retiredModelSignals = new WeakSet<AbortSignal>()
  private closing = false
  private readonly witnessCapability: FreshV2WitnessCapability

  constructor(private readonly ctx: Context, readonly config: FreshV2InitialConfig) {
    if (!/^[0-9a-f]{64}$/.test(config.artifactContract)) {
      throw new TeamDomainError('fresh-v2 artifact contract must be a lowercase SHA-256 digest', 'TEAM_INVALID_CONFIG')
    }
    if (!/^[0-9a-f]{40}$/.test(config.hostContract) && !/^[0-9a-f]{64}$/.test(config.hostContract)) {
      throw new TeamDomainError('fresh-v2 host contract must be a lowercase Git SHA or SHA-256 digest', 'TEAM_INVALID_CONFIG')
    }
    this.witnessCapability = new FreshV2WitnessCapability(ctx, config.artifactContract, config.hostContract)
    this.evidence = new FreshV2EvidenceCoordinator(ctx, {
      assistant: async (session, event) => { await this.foldAssistantEvidence(session, event) },
      turnEnd: async (session, event) => { await this.requireContinuation().foldTurnEnd(session, event) },
      inboxClaimed: async (agent, message) => { await this.requireContinuation().foldInboxClaimed(agent, message) },
      agentIdle: async agent => { await this.requireContinuation().foldAgentIdle(agent) },
      isClosing: () => this.closing,
      describeError: describeFreshV2Error,
    })
  }

  get witnessCapabilityDigest(): string { return this.witnessCapability.digest }
  async activateWitnessCapability(): Promise<string> { return await this.witnessCapability.activate() }
  async assertWitnessCapabilityCurrent(): Promise<string> { return await this.witnessCapability.assertCurrent() }
  revokeWitnessCapability(): void { this.witnessCapability.revoke() }

  async start(): Promise<void> {
    if (this.domain !== undefined) return
    const handle = await this.ctx.storageDomain.open(teamDomainSpecV2)
    const store = new StorageDomainTeamStoreV2(this.ctx, handle, {
      artifactContract: this.config.artifactContract,
      legacyManifestCapacity: this.config.legacyManifestCapacity,
    })
    try {
      await store.initializeFreshAuthority()
    } catch (error) {
      await store.close()
      await handle.close()
      throw error
    }
    this.domainHandle = handle
    this.store = store
    this.domain = new TeamV2StartDomain(store, { maxMembers: this.config.maxMembers })
    this.continuation = new FreshV2ContinuationRuntime(this.ctx, store, this.witnessCapability)
    this.taskControl = new FreshV2TaskControlRuntime(this.ctx, store, agent => this.scopeOf(agent))
  }
  async reconcileColdDispatches(): Promise<void> { this.assertOpen(); await this.requireContinuation().reconcileColdDispatches() } async driveColdRecoveries(): Promise<void> { this.assertOpen(); await this.requireContinuation().driveColdRecoveries() }

  scopeOf(agent: Agent): string {
    return resolve(workspaceOf(agent))
  }

  snapshot(scope: string, teamId: string): TeamStateV2 | undefined {
    return this.requireStore().read(scope, teamId as TeamStateV2['id'])
  }

  async create(exec: ToolExecutionAuthority, name: string, description: string): Promise<TeamStateV2> {
    this.assertOpen()
    const captain = requireAgent(exec)
    return await this.requireDomain().createTeam(this.scopeOf(captain), captain.id, name, description)
  }

  async addMember(
    exec: ToolExecutionAuthority,
    input: {
      name: string; role: string; provider?: string; llmProvider?: string; model?: string
      denyTools?: readonly string[]; skills?: readonly string[]
    },
  ): Promise<TeamMemberV2> {
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = this.requireCaptain(scope, captain.id)
    const providerName = (input.provider ?? this.config.memberProvider).trim()
    const provider = this.ctx.subagents.getProvider(providerName)
    if (provider === undefined) {
      throw new TeamDomainError(`subagent provider "${providerName}" is unavailable`, 'TEAM_MEMBER_PROVIDER_MISSING')
    }
    if (provider.prepareContinuable === undefined || !provider.capabilities.depthLimit
      || !provider.capabilities.persona || !provider.capabilities.toolFilter) {
      throw new TeamDomainError(
        `subagent provider "${providerName}" must support continuable, depthLimit, persona and toolFilter`,
        'TEAM_MEMBER_PROVIDER_INCOMPATIBLE',
      )
    }
    const declaredDeny = [...new Set(input.denyTools ?? this.config.memberDenyTools)]
    for (const name of declaredDeny) {
      if (this.ctx.tools.get(name, captain) === undefined && this.ctx.tools.get(name) === undefined) {
        throw new TeamDomainError(`member deny tool "${name}" is unavailable`, 'TEAM_INPUT_INVALID')
      }
    }
    const deny = memberToolDeny(declaredDeny)
      .filter(name => this.ctx.tools.get(name, captain) !== undefined || this.ctx.tools.get(name) !== undefined)
    const assignedSkills = await resolveAssignedSkills(
      this.ctx,
      captain,
      exec.signal,
      input.skills ?? this.config.memberSkills,
      'at most 32 Skills may be assigned',
    )
    const llmProvider = input.llmProvider ?? this.config.memberLlmProvider ?? captain.options.provider
    const model = input.model ?? this.config.memberModel ?? captain.options.model
    if ((llmProvider === undefined) !== (model === undefined)) {
      throw new TeamDomainError('member LLM selection must resolve both Provider and model', 'TEAM_MEMBER_MODEL_INVALID')
    }
    if (llmProvider !== undefined && model !== undefined) {
      try {
        const llm = this.ctx.get('llm')
        if (llm === undefined) throw new Error('official LLM registry is unavailable')
        await llm.resolveModelInfo(llmProvider, model, exec.signal)
      } catch (cause) {
        throw new TeamDomainError(`member LLM route ${llmProvider}/${model} is unavailable`, 'TEAM_MEMBER_MODEL_INVALID', { cause })
      }
    }
    const modelSource = input.llmProvider !== undefined || input.model !== undefined
      ? 'explicit' as const
      : this.config.memberLlmProvider !== undefined || this.config.memberModel !== undefined
        ? 'member-default' as const
        : captain.options.provider !== undefined || captain.options.model !== undefined
          ? 'captain-inherited' as const
          : 'unresolved' as const
    return await this.requireDomain().declareMember(scope, membership.team.id, captain.id, {
      name: input.name,
      role: input.role,
      sessionId: SessionId(randomUUID()),
      provider: providerName,
      ...(llmProvider === undefined ? {} : { llmProvider }),
      ...(model === undefined ? {} : { model }),
      modelSource,
      deniedTools: deny,
      assignedSkills,
      maxDepth: this.config.memberMaxDepth,
    })
  }

  async createTask(exec: ToolExecutionAuthority, input: RuntimeCreateTaskInput): Promise<TeamTask> {
    this.assertOpen()
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = this.requireCaptain(scope, captain.id)
    const candidates = membership.team.members
      .filter(member => member.phase === 'declared')
      .toSorted((left, right) => left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId))
    const target = input.targetMemberName === undefined
      ? candidates[0]
      : candidates.find(member => member.name === input.targetMemberName)
    if (input.targetMemberName !== undefined && target === undefined) {
      throw new TeamDomainError(`Team member "${input.targetMemberName}" is unavailable`, 'TEAM_ASSIGNEE_INVALID')
    }
    const verification = compileInitialVerification(
      input.verification,
      this.config.maxVerificationCommands,
      this.config.maxVerificationCommandMs,
    )
    const taskInput: CreateTaskV2Input = {
      subject: input.subject,
      description: input.description,
      ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: [...input.acceptanceCriteria] }),
      ...(input.blockedBy === undefined ? {} : { blockedBy: [...input.blockedBy] }),
      ...(input.writeScopes === undefined ? {} : { writeScopes: [...input.writeScopes] }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.reservationTokens === undefined ? {} : { reservationTokens: input.reservationTokens }),
      ...(verification === undefined ? {} : { verification }),
      ...(target === undefined ? {} : { targetMemberSessionId: target.sessionId }),
    }
    const draft = draftTaskV2(membership.team, taskInput, Date.now())
    if (target === undefined || !isTaskReady([...membership.team.tasks, draft], draft)) {
      return await this.requireDomain().createTask(scope, membership.team.id, captain.id, taskInput)
    }
    const attemptId = AttemptId(`attempt-${randomUUID()}`)
    const reservedTask: TeamTask = {
      ...draft,
      revision: draft.revision + 1,
      status: 'in_progress',
      ownerSessionId: target.sessionId,
      currentAttemptId: attemptId,
    }
    const frame = assignmentPrompt(membership.team, reservedTask, attemptId)
    const reserved = await this.requireDomain().createAndReserveInitialAssignment(
      scope,
      membership.team.id,
      captain.id,
      taskInput,
      draft.id,
      target.sessionId,
      initialPromptDigest(frame),
      attemptId,
    )
    try {
      await this.ctx.subagents.startContinuable({
        provider: target.provider,
        label: `agent-swarm:${membership.team.id}:${target.name}`,
        childId: SessionId(target.sessionId),
        request: {
          prompt: [{ type: 'text', text: frame }],
          parent: captain,
          persona: memberPersona(membership.team, target.name, target.role, target.assignedSkills),
          toolFilter: { deny: target.deniedTools },
          agentOptions: {
            ...(target.llmProvider === undefined ? {} : { provider: target.llmProvider }),
            ...(target.model === undefined ? {} : { model: target.model }),
          },
          maxDepth: target.maxDepth,
        },
        signal: exec.signal,
      })
      const owned = this.children.get(captain.id) ?? new Set<string>()
      owned.add(target.sessionId)
      this.children.set(captain.id, owned)
    } catch (error) {
      await this.requireDomain().failInitialAssignment(
        scope, membership.team.id, target.sessionId, reserved.task.id, reserved.attempt.id, describeFreshV2Error(error),
      )
      throw error
    }
    return reserved.task
  }

  async continueTask(exec: ToolExecutionAuthority, input: {
    readonly taskId: string
    readonly expectedRevision: number
    readonly attemptId: string
    readonly idempotencyKey: string
    readonly checkpointDigest?: string
    readonly wakeCondition?: string
  }): Promise<ContinuationIntent> {
    this.assertOpen()
    await this.evidence.drainSession(requireAgent(exec).id)
    return await this.requireContinuation().continueTask(exec, input)
  }

  async submitTask(exec: ToolExecutionAuthority, input: Parameters<SubmitTaskRuntime['submitTask']>[1]): Promise<TeamTask> { this.assertOpen(); await this.evidence.drainSession(requireAgent(exec).id); return await this.requireTaskControl().submitTask(exec, input) }
  async reassignTask(exec: ToolExecutionAuthority, taskId: string, expectedRevision: number, reason: string, targetMemberName?: string): Promise<TeamTask> { this.assertOpen(); return await this.requireTaskControl().reassignTask(exec, taskId, expectedRevision, reason, targetMemberName) }

  async beforeAgentRequest(input: {
    readonly agent: Agent
    readonly turn: number
    readonly step: number
    readonly signal: AbortSignal
  }): Promise<void> {
    if (this.closing) return
    await this.evidence.drainSession(input.agent.id)
    if (await this.requireContinuation().beforeAgentRequest(input)) return
    const scope = this.scopeOf(input.agent)
    const membership = this.findMembership(scope, input.agent.id)
    if (membership?.role !== 'member') return
    await this.witnessCapability.assertCurrent()
    let current = this.currentInitialAttempt(membership.team, input.agent.id)
    if (current === undefined) {
      if (membership.member.initialPromptDigest !== undefined
        && currentStepContainsInitialFrame(input.agent.session, input.turn, input.step, membership.member.initialPromptDigest)) {
        throw new TeamDomainError('initial assignment frame was superseded', 'TEAM_ATTEMPT_STALE')
      }
      return
    }
    if (current.attempt.phase === 'running' && current.dispatch?.phase === 'settled') {
      this.modelPermits.delete(input.agent.id)
      return
    }
    if (current.dispatch?.phase === 'dispatch-entered') {
      await this.evidence.drainSession(input.agent.id)
      const afterEvidence = this.findMembership(scope, input.agent.id)
      if (afterEvidence?.role !== 'member') {
        throw new TeamDomainError('initial assignment membership changed', 'TEAM_ATTEMPT_STALE')
      }
      current = this.currentInitialAttempt(afterEvidence.team, input.agent.id)
      if (current === undefined) throw new TeamDomainError('initial assignment attempt changed', 'TEAM_ATTEMPT_STALE')
      if (current.attempt.phase === 'running' && current.dispatch?.phase === 'settled') return
    }
    if (current.attempt.phase !== 'reserved' || current.member.initialPromptDigest === undefined) {
      throw new TeamDomainError('initial assignment lacks a dispatchable reserved Attempt', 'TEAM_ATTEMPT_STALE')
    }
    if (current.dispatch !== undefined
      && (current.dispatch.phase !== 'dispatch-pending' && current.dispatch.phase !== 'dispatch-entered')) {
      throw new TeamDomainError('initial assignment has a non-dispatchable epoch', 'TEAM_ATTEMPT_STALE')
    }
    if (current.dispatch !== undefined
      && (current.dispatch.turn !== input.turn || current.dispatch.step !== input.step)) {
      throw new TeamDomainError('prior initial dispatch lacks durable assistant evidence', 'TEAM_ATTEMPT_STALE')
    }
    try {
      claimedInitialFrame(input.agent.session, input.turn, input.step, current.member.initialPromptDigest)
      input.signal.throwIfAborted()
      if (!await this.ctx.sessions.flush(input.agent.session)) {
        throw new TeamDomainError('initial assignment requires durable Session persistence', 'TEAM_RUNTIME_NOT_STARTED')
      }
      input.signal.throwIfAborted()
      const refreshed = this.findMembership(scope, input.agent.id)
      if (refreshed?.role !== 'member') throw new TeamDomainError('initial assignment membership changed', 'TEAM_ATTEMPT_STALE')
      const exact = this.currentInitialAttempt(refreshed.team, input.agent.id)
      if (exact === undefined || exact.member.initialPromptDigest === undefined) {
        throw new TeamDomainError('initial assignment attempt changed', 'TEAM_ATTEMPT_STALE')
      }
      const claimed = claimedInitialFrame(input.agent.session, input.turn, input.step, exact.member.initialPromptDigest)
      const checkpoint: InitialDispatchCheckpoint = {
        initialPromptDigest: exact.member.initialPromptDigest,
        messageSeq: claimed.messageSeq,
        turn: input.turn,
        step: input.step,
        witnessCapabilityDigest: this.witnessCapabilityDigest,
        dispatchId: `dispatch:${exact.attempt.id}:initial:1`,
        effectId: `effect:${exact.attempt.id}:initial:1`,
      }
      await this.requireDomain().settleInitialAssignment(
        scope, refreshed.team.id, input.agent.id, exact.task.id, exact.attempt.id, checkpoint,
      )
      const readBack = this.findMembership(scope, input.agent.id)
      const settled = readBack?.role === 'member' ? this.currentInitialAttempt(readBack.team, input.agent.id) : undefined
      if (settled?.dispatch?.phase !== 'dispatch-pending'
        || settled.dispatch.dispatchId !== checkpoint.dispatchId) {
        throw new TeamDomainError('initial assignment checkpoint read-back failed', 'TEAM_MIGRATION_VERIFY_FAILED')
      }
      this.modelPermits.set(input.agent.id, {
        signal: input.signal,
        turn: input.turn,
        step: input.step,
      })
    } catch (error) {
      this.modelPermits.delete(input.agent.id)
      await this.compensateUncommittedInitial(scope, membership.team.id, input.agent.id, current, error)
      throw error
    }
  }

  wrapModelStream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const sentinel = this.witnessCapability.intercept(options)
    if (sentinel !== undefined) return sentinel
    const continuation = this.continuation?.wrapModelStream(options, next)
    if (continuation !== undefined) return continuation
    if (!this.ownsInitialModelDispatch(options)) return next()
    return (async function* (runtime: FreshV2InitialRuntime): AsyncIterable<StreamChunk> {
      let complete!: () => void
      const completion = new Promise<void>(resolveCompletion => { complete = resolveCompletion })
      runtime.dispatchStreams.add(completion)
      try {
        if (runtime.closing) throw new TeamDomainError('fresh-v2 runtime is closing', 'TEAM_RUNTIME_CLOSING')
        await runtime.enterModelDispatch(options)
        if (runtime.closing) throw new TeamDomainError('fresh-v2 runtime is closing', 'TEAM_RUNTIME_CLOSING')
        yield* next()
      } finally {
        complete()
        runtime.dispatchStreams.delete(completion)
      }
    })(this)
  }

  private ownsInitialModelDispatch(options: GenerateOptions): boolean {
    if (options.sessionId === undefined) return false
    return ownsFreshV2InitialModelDispatch({
      ctx: this.ctx, store: this.requireStore(), scopeOf: agent => this.scopeOf(agent),
      permits: this.modelPermits, retiredSignals: this.retiredModelSignals, witness: this.witnessCapability,
    }, options)
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/end') {
      const permit = this.modelPermits.get(session.id)
      if (permit?.turn === event.data.turn) {
        retireFreshV2ModelPermit(this.modelPermits, this.retiredModelSignals, session.id)
      }
      this.continuation?.retireTurnPermit(session.id, event.data.turn)
    }
    this.evidence.observeSessionEvent(session, event)
  }

  observeInboxClaimed(agent: Agent, message: UserMessage): void {
    this.evidence.observeInboxClaimed(agent, message)
  }

  observeAgentIdle(agent: Agent): void {
    this.evidence.observeAgentIdle(agent)
  }

  async drainEvidence(): Promise<void> {
    await this.evidence.drain()
  }

  private async compensateUncommittedInitial(
    scope: string,
    teamId: TeamStateV2['id'],
    memberSessionId: string,
    original: CurrentInitialAttempt,
    error: unknown,
  ): Promise<void> {
    const membership = this.findMembership(scope, memberSessionId)
    if (membership?.role !== 'member' || membership.team.id !== teamId) return
    const current = this.currentInitialAttempt(membership.team, memberSessionId)
    if (current === undefined || current.attempt.id !== original.attempt.id
      || current.member.phase !== 'starting' || current.attempt.phase !== 'reserved'
      || current.attempt.assignmentPhase !== 'reserved' || current.dispatch !== undefined) return
    await this.requireDomain().failInitialAssignment(
      scope, teamId, memberSessionId, current.task.id, current.attempt.id,
      `initial model dispatch was not admitted: ${describeFreshV2Error(error)}`,
    )
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.witnessCapability.revoke('fresh-v2 runtime is closing', true)
    this.modelPermits.clear()
    const failures: unknown[] = []
    await boundedSettle(
      this.ctx, this.config.disposalTimeoutMs, 'fresh-v2 continuation streams',
      this.continuation?.dispose() ?? Promise.resolve(), failures,
    )
    for (const [captainId, childIds] of this.children) {
      const captain = this.ctx.agents.get(SessionId(captainId))
      if (captain === undefined) continue
      await boundedSettle(
        this.ctx,
        this.config.disposalTimeoutMs,
        `fresh-v2 children of ${captainId}`,
        this.ctx.subagents.drainContinuableChildren(captain, [...childIds].map(SessionId)),
        failures,
      )
    }
    await boundedSettle(
      this.ctx, this.config.disposalTimeoutMs, 'fresh-v2 dispatch streams',
      Promise.allSettled(this.dispatchStreams).then(() => undefined), failures,
    )
    await boundedSettle(
      this.ctx, this.config.disposalTimeoutMs, 'fresh-v2 evidence folds',
      this.drainEvidence(), failures,
    )
    if (this.store !== undefined) {
      await boundedSettle(this.ctx, this.config.disposalTimeoutMs, 'fresh-v2 store', this.store.close(), failures)
    }
    if (this.domainHandle !== undefined) {
      await boundedSettle(this.ctx, this.config.disposalTimeoutMs, 'fresh-v2 domain', this.domainHandle.close(), failures)
    }
    this.children.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'fresh-v2 runtime disposal failed')
  }

  private async enterModelDispatch(options: GenerateOptions): Promise<void> {
    const { agent, session } = consumeFreshV2ModelPermit(this.ctx, this.modelPermits, options, 'model-dispatch')
    const scope = this.scopeOf(agent)
    const membership = this.findMembership(scope, agent.id)
    if (membership?.role !== 'member') {
      throw new TeamDomainError('owned model dispatch lost its Team membership', 'TEAM_ATTEMPT_STALE')
    }
    const current = this.currentInitialAttempt(membership.team, agent.id)
    const dispatch = current?.dispatch
    if (current === undefined || dispatch === undefined
      || (dispatch.phase !== 'dispatch-pending' && dispatch.phase !== 'dispatch-entered')) {
      throw new TeamDomainError('owned model dispatch lost its exact Attempt', 'TEAM_ATTEMPT_STALE')
    }
    const checkpoint = initialCheckpointOf(current.member, dispatch)
    this.witnessCapability.assertDigest(checkpoint.witnessCapabilityDigest)
    const before = claimedInitialFrame(session, checkpoint.turn, checkpoint.step, checkpoint.initialPromptDigest)
    if (before.messageSeq !== checkpoint.messageSeq) throw new TeamDomainError('dispatch message sequence changed', 'TEAM_ATTEMPT_STALE')
    options.signal?.throwIfAborted()
    if (!await this.ctx.sessions.flush(session)) {
      throw new TeamDomainError('model dispatch requires durable Session persistence', 'TEAM_RUNTIME_NOT_STARTED')
    }
    options.signal?.throwIfAborted()
    const after = claimedInitialFrame(session, checkpoint.turn, checkpoint.step, checkpoint.initialPromptDigest)
    if (after.messageSeq !== checkpoint.messageSeq) throw new TeamDomainError('dispatch message sequence changed', 'TEAM_ATTEMPT_STALE')
    await this.requireDomain().enterInitialDispatch(
      scope, membership.team.id, agent.id, current.task.id, current.attempt.id, checkpoint,
    )
    const readBack = this.findMembership(scope, agent.id)
    const entered = readBack?.role === 'member' ? this.currentInitialAttempt(readBack.team, agent.id) : undefined
    if (entered?.dispatch?.phase !== 'dispatch-entered'
      || entered.dispatch.dispatchId !== checkpoint.dispatchId) {
      throw new TeamDomainError('model-dispatch witness read-back failed', 'TEAM_MIGRATION_VERIFY_FAILED')
    }
  }

  private async foldAssistantEvidence(
    session: Session,
    event: SessionEvent<'assistant/message'>,
  ): Promise<void> {
    if (await this.requireContinuation().foldAssistantEvidence(session, event)) return
    const scope = resolve(session.header.cwd ?? process.cwd())
    const membership = this.findMembership(scope, session.id)
    if (membership?.role !== 'member') return
    const current = this.currentInitialAttempt(membership.team, session.id)
    const dispatch = current?.dispatch
    if (current === undefined || dispatch?.phase !== 'dispatch-entered') return
    const checkpoint = initialCheckpointOf(current.member, dispatch)
    if (event.data.turn !== checkpoint.turn || event.data.step !== checkpoint.step) return
    assistantEvidenceAt(session, event.seq, event.type, checkpoint.turn, checkpoint.step)
    await this.requireDomain().settleInitialAssistantEvidence(
      scope,
      membership.team.id,
      session.id,
      current.task.id,
      current.attempt.id,
      checkpoint,
      { eventSeq: event.seq, eventType: event.type },
    )
  }

  private findMembership(scope: string, sessionId: string): FreshV2Membership | undefined {
    return findFreshV2Membership(this.requireStore(), scope, sessionId)
  }

  private requireCaptain(scope: string, sessionId: string): Extract<FreshV2Membership, { readonly role: 'captain' }> {
    const membership = this.findMembership(scope, sessionId)
    if (membership?.role !== 'captain') throw new TeamDomainError('only the active Team captain may perform this operation', 'TEAM_CAPTAIN_REQUIRED')
    return membership
  }

  private currentInitialAttempt(team: TeamStateV2, sessionId: string): CurrentInitialAttempt | undefined {
    return currentFreshV2InitialAttempt(team, sessionId)
  }

  private requireStore(): StorageDomainTeamStoreV2 {
    if (this.store === undefined) throw new TeamDomainError('fresh-v2 runtime has not started', 'TEAM_RUNTIME_NOT_STARTED')
    return this.store
  }

  private requireDomain(): TeamV2StartDomain {
    if (this.domain === undefined) throw new TeamDomainError('fresh-v2 runtime has not started', 'TEAM_RUNTIME_NOT_STARTED')
    return this.domain
  }

  private requireContinuation(): FreshV2ContinuationRuntime {
    if (this.continuation === undefined) throw new TeamDomainError('fresh-v2 runtime has not started', 'TEAM_RUNTIME_NOT_STARTED')
    return this.continuation
  }

  private requireTaskControl(): FreshV2TaskControlRuntime {
    if (this.taskControl === undefined) throw new TeamDomainError('fresh-v2 runtime has not started', 'TEAM_RUNTIME_NOT_STARTED')
    return this.taskControl
  }

  private assertOpen(): void {
    if (this.closing) throw new TeamDomainError('fresh-v2 runtime is closing', 'TEAM_RUNTIME_CLOSING')
  }
}
