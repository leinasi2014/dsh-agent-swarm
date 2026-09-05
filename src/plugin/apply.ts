/** DSH composition root. It wires adapters around the durable Team domain. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { registerAgentSwarmTools } from '../tools/index.js'
import { DEFAULT_TEAM_LIMITS } from '../domain/team-domain.js'
import { normalizeAllowedSkills } from '../domain/team-skill-policy.js'
import { recoverActiveRosters } from '../runtime/usage-recovery.js'
import { TeamBridgeWorkflowEngine } from '../runtime/workflow/team-bridge-engine.js'
import { TeamJobProjection } from '../runtime/jobs/team-job-projection.js'
import { MemberPrivateMemoryService } from '../runtime/member-private-memory-service.js'
import { MemberPrivateMemoryStore, privateMemoryDomainSpec } from '../storage/member-private-memory.js'
import { defaultExecutionRootsBase, expectExecutionRootsBase } from '../runtime/execution-roots.js'
import { CaptainLiaison } from '../human/captain-liaison.js'
import { HumanControlGateway } from '../human/human-control-gateway.js'
import { HumanInteractionOverlayStore, humanInteractionDomainSpec } from '../human/human-interaction-store.js'
import { humanReviewProvider } from '../human/human-review-provider.js'
import { officialCaptainQuestionPresentation } from '../human/official-question-presentation.js'
import { officialPlanApprovalProvider } from '../human/plan-approval-provider.js'
import { DEFAULT_HOST_CONTEXT_TTL_MS, DEFAULT_MAX_HOST_CONTEXTS, mountHostContext } from '../human/host-context-service.js'
import { effectiveToolPolicy, TeamPermissionSurface } from '../runtime/permission-surface.js'
import { TeamDomainError } from '../domain/error.js'
import { assembleAgentSwarmHostRead, assembleAgentSwarmProducerFloor, mountAgentSwarmReadRpc } from '../host/host-read-assembly.js'
import { AGENT_SWARM_USAGE_PROMPT } from '../runtime/usage-prompt.js'
import { installSwarmGestureBoundary } from '../runtime/gesture.js'
import { TeamSkillSurface } from '../runtime/team-skill-surface.js'
import {
  AGENT_SWARM_SETTINGS_NAMESPACE,
  assertServiceableConfig,
  Config as ConfigSchema,
  DEFAULT_DISPOSAL_TIMEOUT_MS,
  DEFAULT_STRANDED_AFTER_MS,
  DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS,
} from './config.js'
import type { Config as ConfigInput } from './config.js'

export async function apply(ctx: Context, config: ConfigInput): Promise<void> {
  const registerSettings = (settingsCtx: Context) => settingsCtx.settings.register(AGENT_SWARM_SETTINGS_NAMESPACE, ConfigSchema, {
      base: config,
      applies: 'restart',
      validate: assertServiceableConfig,
    })
  // A normal web Profile provides Settings before external plugins. Resolve
  // its stored user layer before constructing this generation's runtime so a
  // restart really applies every field. Headless compositions without
  // Settings still run from loader config; if Settings appears later we
  // register the UI namespace, but deliberately do not partially mutate the
  // already-constructed runtime.
  const settings = ctx.get('settings')
  if (settings === undefined) {
    ctx.inject(['settings'], settingsCtx => { registerSettings(settingsCtx) })
  } else {
    config = settings.register(AGENT_SWARM_SETTINGS_NAMESPACE, ConfigSchema, {
      base: config,
      applies: 'restart',
      validate: assertServiceableConfig,
    }).get()
    // The direct registration above is needed to resolve restart-applied
    // settings before the runtime is constructed. Keep a scoped injection as
    // well so a replacement Settings Provider receives the namespace again.
    // The first callback observes the already-registered current Provider;
    // later Provider generations start without this namespace and register it.
    ctx.inject(['settings'], settingsCtx => {
      if (settingsCtx.settings.get(AGENT_SWARM_SETTINGS_NAMESPACE) === undefined) {
        registerSettings(settingsCtx)
      }
    })
  }
  if (config.enabled === false) return
  ctx.effect(() => installSwarmGestureBoundary(ctx, config.swarmGesture !== false), 'agent-swarm: /swarm gesture boundary')
  assertServiceableConfig(config)
  const memberProvider = (config.memberProvider ?? 'spawn').trim()
  const schedulerProvider = (config.schedulerProvider ?? 'priority-ready').trim()
  const reviewProvider = (config.reviewProvider ?? 'manual').trim()
  const reviewRootProvider = (config.reviewRootProvider ?? 'temp').trim()
  const orchestrationMode = config.orchestrationMode ?? 'adaptive'
  if (orchestrationMode !== 'adaptive' && orchestrationMode !== 'workflow') {
    throw new Error(`agent-swarm: orchestrationMode must be "adaptive" or "workflow", got "${orchestrationMode}"`)
  }
  // M2-3 fail-closed combination (issue #77): workflow mode with no bridge
  // leaves Teams without any orchestration driver — reject before the runtime
  // constructs or opens anything (zero side effects).
  const executionRootsEnabled = config.executionRoots ?? false
  const executionRootProvider = (config.executionRootProvider ?? 'git-worktree').trim()
  const executionRootsBase = expectExecutionRootsBase(config.executionRootsBase) ?? defaultExecutionRootsBase()
  const toolPolicy = effectiveToolPolicy(config.toolPolicy)
  const memberToolPolicyDeny = [...(toolPolicy.ask ?? []), ...(toolPolicy.deny ?? [])]
  const disposalTimeoutMs = config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS
  const teamSkills = new TeamSkillSurface(ctx)
  let drainHumanInteractions: (() => Promise<void>) | undefined

  const runtime = new AgentSwarmRuntime(ctx, {
    memberProvider,
    ...(config.memberLlmProvider === undefined ? {} : { memberLlmProvider: config.memberLlmProvider }),
    ...(config.memberModel === undefined ? {} : { memberModel: config.memberModel }),
    ...(config.captainLlmProvider === undefined ? {} : { captainLlmProvider: config.captainLlmProvider }),
    ...(config.captainModel === undefined ? {} : { captainModel: config.captainModel }),
    memberMaxDepth: config.memberMaxDepth ?? 1,
    planApproval: officialPlanApprovalProvider(ctx),
    schedulerProvider,
    reviewProvider,
    reviewRootProvider,
    orchestrationMode,
    limits: {
      maxMembers: config.maxMembers ?? DEFAULT_TEAM_LIMITS.maxMembers,
      maxTasks: config.maxTasks ?? DEFAULT_TEAM_LIMITS.maxTasks,
      maxPendingMessagesPerMember: config.maxPendingMessagesPerMember ?? DEFAULT_TEAM_LIMITS.maxPendingMessagesPerMember,
      maxRetainedMessages: config.maxRetainedMessages ?? DEFAULT_TEAM_LIMITS.maxRetainedMessages,
      maxRetainedAttempts: config.maxRetainedAttempts ?? DEFAULT_TEAM_LIMITS.maxRetainedAttempts,
      maxMessageBytes: config.maxMessageBytes ?? DEFAULT_TEAM_LIMITS.maxMessageBytes,
      maxTaskBytes: config.maxTaskBytes ?? DEFAULT_TEAM_LIMITS.maxTaskBytes,
      maxDependencies: config.maxDependencies ?? DEFAULT_TEAM_LIMITS.maxDependencies,
      maxMemories: config.maxMemories ?? DEFAULT_TEAM_LIMITS.maxMemories,
      maxInteractionEffects: config.maxInteractionEffects ?? DEFAULT_TEAM_LIMITS.maxInteractionEffects,
      maxVerificationCommands: config.maxVerificationCommands ?? DEFAULT_TEAM_LIMITS.maxVerificationCommands,
      maxVerificationCommandMs: config.maxVerificationCommandMs ?? DEFAULT_TEAM_LIMITS.maxVerificationCommandMs,
    },
    disposalTimeoutMs,
    strandedAfterMs: config.strandedAfterMs ?? DEFAULT_STRANDED_AFTER_MS,
    executionRootsEnabled,
    executionRootProvider,
    executionRootsBase,
    memberToolPolicyDeny,
    newTeamAllowedSkills: () => normalizeAllowedSkills(config.allowedSkills) ?? [],
    teamSkills,
  })

  // Fail closed: official Storage Domain opens before tools/listeners.
  await runtime.start()
  ctx.effect(() => async () => {
    await drainHumanInteractions?.()
    await runtime.dispose()
  }, 'agent-swarm: runtime disposal')
  // The plugin-owned member-private-memory sibling service (2026-08-26): a
  // separate Storage Domain from `agent_swarm` (workflow/human overlay
  // precedent) so the authoritative Team aggregate keeps its frozen version stamp.
  // The `AgentSwarmRuntime` is deliberately untouched; the store + service are
  // local composition here, provided for consumers/tests and closed on teardown and
  // on every later apply-failure path through `closePrivateMemory`.
  let privateMemoryDomain: Domain<typeof privateMemoryDomainSpec> | undefined
  let privateMemoryStore: MemberPrivateMemoryStore | undefined
  let privateMemoryService: MemberPrivateMemoryService | undefined
  let unprovidePrivateMemory: (() => void) | undefined
  const closePrivateMemory = async (): Promise<void> => {
    const unprovide = unprovidePrivateMemory
    unprovidePrivateMemory = undefined
    await unprovide?.()
    privateMemoryService = undefined
    privateMemoryStore?.close()
    privateMemoryStore = undefined
    if (privateMemoryDomain !== undefined) {
      await privateMemoryDomain.close()
      privateMemoryDomain = undefined
    }
  }
  try {
    const domain = await ctx.storageDomain.open(privateMemoryDomainSpec)
    privateMemoryDomain = domain
    privateMemoryStore = new MemberPrivateMemoryStore(ctx, domain)
    privateMemoryService = new MemberPrivateMemoryService({
      domain: () => runtime.domain,
      scopeOf: agent => runtime.scopeOf(agent),
      store: () => privateMemoryStore,
      liveAgent: id => ctx.agents.get(SessionId(id)),
    })
    ctx.effect(() => {
      unprovidePrivateMemory = ctx.provide('agentSwarmPrivateMemory', privateMemoryService!)
      return () => closePrivateMemory()
    }, 'agent-swarm: member private memory service')
  } catch (error) {
    await closePrivateMemory()
    await runtime.dispose()
    throw error
  }
  // Mounted second so reverse disposal closes Host admission before Team authority.
  const disposeHostContext = ctx.effect(() => mountHostContext(ctx, runtime, {
    maxActive: config.maxHostContexts ?? DEFAULT_MAX_HOST_CONTEXTS,
    ttlMs: config.hostContextTtlMs ?? DEFAULT_HOST_CONTEXT_TTL_MS,
  }), 'agent-swarm: Host context lifecycle')
  registerAgentSwarmTools(ctx, runtime, privateMemoryService)
  // I1a permission boundary: project policy consumes the official
  // tools/pre-execute + approval seams. It cannot widen downstream denial.
  let permission: TeamPermissionSurface | undefined
  try {
    permission = new TeamPermissionSurface({ ctx, runtime, policy: toolPolicy })
    ctx.effect(() => {
      const unprovidePermission = ctx.provide('agentSwarmPermission', permission!)
      return async () => {
        await unprovidePermission?.()
        await permission!.dispose()
      }
    }, 'agent-swarm: permission surface')
    ctx.effect(() => permission!.attachPreExecute(ctx), 'agent-swarm: team tool permission')
    // Loader's actual assembly boundary permits a Host to register after
    // Swarm mounts. Awaiting this child here would wait on our own entry.
    // A bare Context has no assembly-complete event; admission still checks
    // the actual provider registry before creating a Team or task.
    if (reviewProvider === 'reviewer-agent') ctx.inject({ loader: { await: true } }, () => {
      if (permission!.reviewerAgent === undefined) throw new TeamDomainError(
        'reviewProvider=reviewer-agent requires a Host provider registered through ctx.agentSwarmPermission.registerReviewerAgentProvider',
        'TEAM_INVALID_CONFIG',
      )
    })
  } catch (error) {
    await closePrivateMemory()
    await disposeHostContext()
    await runtime.dispose()
    throw error
  }
  if (permission === undefined) {
    await closePrivateMemory()
    await disposeHostContext()
    await runtime.dispose()
    throw new Error('agent-swarm: permission surface was not assembled')
  }

  // I1a human review stays inside the existing captain review transaction;
  // the provider produces a decision, TeamDomainPort owns the mutation.
  ctx.effect(() => runtime.registerReviewProvider('human', humanReviewProvider(ctx)), 'agent-swarm: human review provider')
  let humanDomain: Domain<typeof humanInteractionDomainSpec> | undefined
  let humanOverlay: HumanInteractionOverlayStore | undefined
  let unprovideControl: (() => void) | undefined, unprovideInteraction: (() => void) | undefined
  let disposeProducerFloor: (() => Promise<void>) | undefined, disposeHostRead: (() => Promise<void>) | undefined
  try {
    const domain = await ctx.storageDomain.open(humanInteractionDomainSpec)
    humanDomain = domain
    const overlay = new HumanInteractionOverlayStore(ctx, domain)
    humanOverlay = overlay
    let drainPromise: Promise<void> | undefined
    const drain = () => drainPromise ??= overlay.stopAdmissionAndDrain(disposalTimeoutMs)
    drainHumanInteractions = drain
    const liaison = new CaptainLiaison(
      runtime.domain,
      overlay,
      officialCaptainQuestionPresentation(ctx),
      Date.now,
      {
        resolve: sessionId => ctx.agents.get(SessionId(sessionId)),
        isRoot: agent => ctx.agents.roots().includes(agent),
      },
    )
    const humanControl = new HumanControlGateway({
      ctx,
      domain: () => runtime.domain,
      overlay,
      now: Date.now,
      sendMessage: (exec, target, content, delivery) => runtime.sendMessage(exec, target, content, delivery),
      interruptMember: (exec, memberName) => runtime.interruptMember(exec, memberName),
      reassignTask: (exec, taskId, expectedRevision, reason) => runtime.reassignTask(exec, taskId, expectedRevision, reason),
      reviewTask: (exec, input) => runtime.reviewTask(exec, input),
      verifyHumanPrincipal: (principalRef, request) => permission.verifyHumanPrincipal(principalRef, request),
    })
    ctx.effect(() => {
      unprovideControl = ctx.provide('agentSwarmHumanControl', humanControl)
      unprovideInteraction = ctx.provide('agentSwarmHumanInteraction', liaison)
      disposeProducerFloor = assembleAgentSwarmProducerFloor(ctx, runtime, overlay, disposalTimeoutMs)
      disposeHostRead = assembleAgentSwarmHostRead(ctx, runtime, overlay, disposalTimeoutMs)
      mountAgentSwarmReadRpc(ctx, runtime, disposalTimeoutMs)
      return async () => {
        const drained = drain()
        await disposeHostRead?.()
        await disposeProducerFloor?.()
        await unprovideControl?.()
        await unprovideInteraction?.()
        await drained
        overlay.close()
        await domain.close()
        if (drainHumanInteractions === drain) drainHumanInteractions = undefined
      }
    }, 'agent-swarm: human interaction domain')
  } catch (error) {
    await disposeHostRead?.()
    await disposeProducerFloor?.()
    await unprovideControl?.()
    await unprovideInteraction?.()
    humanOverlay?.close()
    drainHumanInteractions = undefined
    if (humanDomain !== undefined) await humanDomain.close()
    await closePrivateMemory()
    await disposeHostContext()
    await runtime.dispose()
    throw error
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agent-swarm:usage',
    order: config.promptSectionOrder ?? 118,
    text: AGENT_SWARM_USAGE_PROMPT,
  }), 'agent-swarm: system prompt')
  // M2-3 (issue #77): the adaptive event face — idle edges drive scheduling
  // passes (assignment delivery, reserved folds, stranded self-healing).
  // `workflow` mode does not register it: Teams advance only through
  // workflow runs and explicit operations there (the bridge's runs drive
  // their own Teams through the runtime's ownership-gated seam, and the
  // stranded heal/re-kick sections are mode-gated inside the pass).
  if (orchestrationMode === 'adaptive') {
    ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') runtime.observeAgentIdle(agent)
    }), 'agent-swarm: idle scheduler')
  }
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    runtime.observeSessionEvent(session, event)
  }), 'agent-swarm: token accounting')
  ctx.effect(async () => {
    await Promise.all(ctx.agents.roots().map(agent => runtime.recoverAgent(agent)))
    // Issue #92's durable net: after agent recovery, refold every active
    // roster's usage from live logs and persisted history so a drop on the
    // live path can never survive a reload as a permanent billed-token gap.
    const scopes = [...new Set(ctx.agents.roots().map(agent => runtime.scopeOf(agent)))]
    await recoverActiveRosters(ctx, {
      domain: () => runtime.domain,
      scopes,
      teams: scope => runtime.listTeamAggregates(scope),
    })
    // P0-2 S4: an approved managed Team whose Captain never registered after
    // the durable staged->active commit is re-provisioned now (crash window).
    for (const scope of scopes) {
      for (const team of await runtime.listTeamAggregates(scope)) {
        if (team.phase !== 'active' || team.managedOrigin === undefined || team.captainSessionId === '') continue
        if (ctx.agents.get(SessionId(team.captainSessionId)) !== undefined) continue
        try { await runtime.recoverApprovedTeam(scope, team) }
        catch (error) { ctx.logger.warn(`agent-swarm: approved Captain recovery failed for ${team.id}: ${String(error)}`) }
      }
    }
    // M3-1 (issue #100): the execution-root residue scan — crash-left roots
    // whose attempts no longer hold them are alarmed and marked reclaimable
    // (kept for captain decision); roots of still-redrivable attempts report
    // as reattachable. The report is the D1 dogfood root-residue observation
    // input (docs/13 §5).
    if (executionRootsEnabled) {
      for (const scope of scopes) await runtime.scanExecutionRootResidue(scope)
    }
    return () => undefined
  }, 'agent-swarm: activation recovery')
  // M2-1 (issue #75): the Team bridge workflow engine. Registered in an
  // isolated `workflowEngine` service scope (the official mechanism for a
  // second implementation beside the default-scope official engine) and
  // fail-closed on the overlay domain. Registered AFTER the runtime disposal
  // effect so Cordis's LIFO teardown settles bridge runs before the runtime
  // store closes (the bridge drives Team state through the runtime).
  if (config.workflowBridge === true) {
    const bridge = new TeamBridgeWorkflowEngine(ctx.isolate('workflowEngine'), runtime, {
      maxTotalAgents: config.workflowMaxTotalAgents ?? DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS,
      disposeGraceMs: config.workflowDisposeGraceMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
    })
    ctx.effect(() => () => bridge.dispose(), 'agent-swarm: workflow bridge disposal')
    await bridge.activate()
    runtime.workflowBridge = bridge
    ctx.effect(() => ctx.provide('agentSwarmWorkflow', {
      start: request => bridge.start(request),
    }), 'agent-swarm: workflow Consumer')
  }

  // Caller-scoped, read-only task projection. It deliberately is not mounted
  // as `ctx.jobs`: TeamDomainPort owns task lifecycle, while JobRegistry owns
  // producer/controller/teardown semantics this view cannot provide. It is
  // independent of the workflow bridge and retires before the aggregate store.
  if (config.jobsBridge === true) {
    const projection = new TeamJobProjection(ctx, runtime)
    runtime.jobsBridge = projection
    await projection.activate()
    ctx.effect(() => () => projection.dispose(), 'agent-swarm: jobs bridge disposal')
  }
}

