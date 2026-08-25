import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
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
import type { TeamMemberV2, TeamStateV2 } from '../domain/team-state-v2.js'
import { AttemptId, type TeamTask } from '../domain/types.js'
import { canonicalV2Digest } from '../protocol/canonical-v2.js'
import { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { teamDomainSpecV2 } from '../storage/team-spec-v2.js'
import type { InitialTaskBoardRuntime } from '../tools/task-board.js'
import type { InitialTeamLifecycleRuntime } from '../tools/team-lifecycle.js'
import { requireAgent, workspaceOf, type ToolExecutionAuthority } from './authority.js'
import { boundedSettle } from './disposal.js'
import { assistantEvidenceAt, claimedInitialFrame, initialPromptDigest } from './fresh-v2-session-fold.js'
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

export interface FreshV2InitialConfig {
  readonly artifactContract: string
  readonly legacyManifestCapacity: number
  readonly memberProvider: string
  readonly memberLlmProvider?: string
  readonly memberModel?: string
  readonly memberDenyTools: readonly string[]
  readonly memberSkills: readonly string[]
  readonly memberMaxDepth: number
  readonly maxMembers: number
  readonly maxVerificationCommands: number
  readonly maxVerificationCommandMs: number
  readonly disposalTimeoutMs: number
}

/** A1b walking skeleton over the official Subagent, AgentLoop, Session and LLM seams. */
export class FreshV2InitialRuntime implements InitialTeamLifecycleRuntime, InitialTaskBoardRuntime {
  private domainHandle?: Domain<typeof teamDomainSpecV2>
  private store?: StorageDomainTeamStoreV2
  private domain?: TeamV2StartDomain
  private readonly children = new Map<string, Set<string>>()
  private readonly dispatchStreams = new Set<Promise<void>>()
  private readonly evidenceChains = new Map<string, Promise<void>>()
  private readonly modelPermits = new Map<string, {
    readonly signal: AbortSignal
    readonly turn: number
    readonly step: number
  }>()
  private readonly backgroundFailures: Array<{ readonly sessionId: string; readonly error: unknown }> = []
  private closing = false

  readonly witnessCapabilityDigest: string

  constructor(private readonly ctx: Context, readonly config: FreshV2InitialConfig) {
    if (!/^[0-9a-f]{64}$/.test(config.artifactContract)) {
      throw new TeamDomainError('fresh-v2 artifact contract must be a lowercase SHA-256 digest', 'TEAM_INVALID_CONFIG')
    }
    this.witnessCapabilityDigest = canonicalV2Digest(
      'dsh-agent-swarm/a1b/model-dispatch-witness/v1',
      { artifactContract: config.artifactContract },
    )
  }

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
  }

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

  async beforeAgentRequest(input: {
    readonly agent: Agent
    readonly turn: number
    readonly step: number
    readonly signal: AbortSignal
  }): Promise<void> {
    if (this.closing) return
    const scope = this.scopeOf(input.agent)
    const membership = this.findMembership(scope, input.agent.id)
    if (membership?.role !== 'member') return
    let current = this.currentInitialAttempt(membership.team, input.agent.id)
    if (current === undefined) return
    if (current.attempt.phase === 'running' && current.dispatch?.phase === 'settled') {
      this.modelPermits.delete(input.agent.id)
      return
    }
    if (current.dispatch?.phase === 'dispatch-entered') {
      await this.drainSessionEvidence(input.agent.id)
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
      // The official Agent Loop gives this waterfall the exact turn AbortSignal.
      // Retain that process-local object identity as the cross-package dispatch
      // authority: an installed plugin may resolve a second dsh-llm module, so
      // its private isAgentLoopRequest WeakSet cannot see the Host's marker.
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
    const permit = this.modelPermits.get(options.sessionId)
    if (permit === undefined || options.signal !== permit.signal) return false
    const agent = this.ctx.agents.get(SessionId(options.sessionId))
    const session = this.ctx.sessions.get(SessionId(options.sessionId))
    if (agent === undefined || session === undefined || agent.session !== session) return false
    const membership = this.findMembership(this.scopeOf(agent), agent.id)
    if (membership?.role !== 'member') return false
    const current = this.currentInitialAttempt(membership.team, agent.id)
    if (current === undefined) return false
    if (current.attempt.phase === 'running' && current.dispatch?.phase === 'settled') return false
    if (current.attempt.phase !== 'reserved' || current.dispatch === undefined
      || (current.dispatch.phase !== 'dispatch-pending' && current.dispatch.phase !== 'dispatch-entered')) {
      throw new TeamDomainError('Team model request lacks its exact dispatch fence', 'TEAM_ATTEMPT_STALE')
    }
    if (current.dispatch.turn !== permit.turn || current.dispatch.step !== permit.step) {
      throw new TeamDomainError('Team model request does not match its official Agent Loop permit', 'TEAM_ATTEMPT_STALE')
    }
    return true
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.closing || event.type !== 'assistant/message') return
    // Start the official durability barrier synchronously while this exact
    // Session is still entered. The fire-and-forget observer may run its fold
    // after a fast child has already settled and left the live Session store.
    const durability = this.ctx.sessions.flush(session)
    const previous = this.evidenceChains.get(session.id) ?? Promise.resolve()
    const chain = previous.then(async () => {
      if (this.closing) return
      await this.foldAssistantEvidence(session, event, durability)
    }).catch((error: unknown) => {
      this.backgroundFailures.push({ sessionId: session.id, error })
      this.ctx.logger.error(`agent-swarm: fresh-v2 assistant evidence fold failed: ${describeFreshV2Error(error)}`)
    })
    this.evidenceChains.set(session.id, chain)
    void chain.finally(() => {
      if (this.evidenceChains.get(session.id) === chain) this.evidenceChains.delete(session.id)
    })
  }

  async drainEvidence(): Promise<void> {
    await Promise.allSettled(this.evidenceChains.values())
    if (this.backgroundFailures.length > 0) {
      throw new AggregateError(
        this.backgroundFailures.map(failure => failure.error),
        `fresh-v2 assistant evidence fold failed: ${this.backgroundFailures.map(failure => describeFreshV2Error(failure.error)).join('; ')}`,
      )
    }
  }

  private async drainSessionEvidence(sessionId: string): Promise<void> {
    await this.evidenceChains.get(sessionId)
    const failures = this.backgroundFailures.filter(failure => failure.sessionId === sessionId)
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(failure => failure.error),
        `fresh-v2 assistant evidence for ${sessionId} is not durable`,
      )
    }
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
    this.modelPermits.clear()
    const failures: unknown[] = []
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
    if (options.sessionId === undefined) throw new TeamDomainError('AgentLoop request lacks Session identity', 'TEAM_STATE_CORRUPT')
    const permit = this.modelPermits.get(options.sessionId)
    if (permit === undefined || options.signal !== permit.signal) {
      throw new TeamDomainError('AgentLoop request lacks its exact model-dispatch permit', 'TEAM_ATTEMPT_STALE')
    }
    // One official Agent request authorizes one provider entry. Consume before
    // the durable witness so any uncertain failure remains pending for A2
    // reconciliation instead of being retried through an unfenced second call.
    this.modelPermits.delete(options.sessionId)
    const agent = this.ctx.agents.get(SessionId(options.sessionId))
    const session = this.ctx.sessions.get(SessionId(options.sessionId))
    if (agent === undefined || session === undefined || agent.session !== session) {
      throw new TeamDomainError('AgentLoop request does not resolve to one exact live Agent/Session', 'TEAM_STATE_CORRUPT')
    }
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
    durability: Promise<boolean>,
  ): Promise<void> {
    if (!await durability) {
      throw new TeamDomainError('assistant evidence requires durable Session persistence', 'TEAM_RUNTIME_NOT_STARTED')
    }
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

  private assertOpen(): void {
    if (this.closing) throw new TeamDomainError('fresh-v2 runtime is closing', 'TEAM_RUNTIME_CLOSING')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentSwarmV2Initial: FreshV2InitialRuntime
  }
}
