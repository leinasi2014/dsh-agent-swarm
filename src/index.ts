/**
 * Durable Team orchestration for DeepSeek Harness.
 *
 * The host plugin composes a framework-neutral Team domain with DSH tools,
 * continuable subagents, Agent lifecycle events, official Storage Domain
 * persistence and an ordered system-prompt contribution. Richer
 * workspace/workflow/distributed Providers remain replaceable instead of
 * being embedded in the Agent loop.
 *
 * Durable Team mode fails closed: `sessionPersistence` and `storageDomain`
 * are required injections, so a Profile without durable Session storage or
 * the official Storage Domain form never activates this plugin. The
 * authoritative Team aggregate lives in the `agent_swarm` storage domain —
 * never in the shared workspace (ADR-0007).
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { TeamDomainError } from './domain/error.js'
import { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'
import { registerAgentSwarmTools, registerFreshV2AgentSwarmTools } from './tools.js'
import { DEFAULT_TEAM_LIMITS } from './domain/team-domain.js'
import { recoverActiveRosters } from './runtime/usage-recovery.js'
import { TeamBridgeWorkflowEngine } from './runtime/workflow/team-bridge-engine.js'
import { TeamJobProjection } from './runtime/jobs/team-job-projection.js'
import { defaultExecutionRootsBase, expectExecutionRootsBase } from './runtime/execution-roots.js'
import { CaptainLiaison } from './human/captain-liaison.js'
import { HumanControlGateway } from './human/human-control-gateway.js'
import { HumanInteractionOverlayStore, humanInteractionDomainSpec } from './human/human-interaction-store.js'
import { humanReviewProvider } from './human/human-review-provider.js'
import { officialCaptainQuestionPresentation } from './human/official-question-presentation.js'
import { effectiveToolPolicy, TeamPermissionSurface } from './runtime/permission-surface.js'
import { reviewerAgentReviewProvider } from './runtime/reviewer-boundary.js'
import { assembleAgentSwarmHostRead, assembleAgentSwarmProducerFloor, mountAgentSwarmReadRpc } from './host/host-read-assembly.js'
import { AGENT_SWARM_USAGE_PROMPT } from './runtime/usage-prompt.js'
import { AGENT_SWARM_SETTINGS_NAMESPACE, installAgentSwarmSettings } from './runtime/settings.js'
import { FreshV2InitialRuntime } from './runtime/fresh-v2-initial-runtime.js'
import { attachFreshV2Hooks } from './runtime/fresh-v2-hooks.js'

export * from './public-api.js'

export const name = 'agent-swarm'
export { AGENT_SWARM_SETTINGS_NAMESPACE }
export const inject = [
  'tools',
  'subagents',
  'agents',
  'sessions',
  'systemPrompt',
  'sessionPersistence',
  'storageDomain',
] as const

/** Official experimental default for `disposalTimeoutMs` (F4 alignment). */
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/**
 * Default stranded-ownership grace bound (issue #12 / F10): long enough that
 * a captain's interrupt-then-wakeup dance on a parked owner is unaffected,
 * short enough to un-stick a member that stopped early within a minute.
 */
const DEFAULT_STRANDED_AFTER_MS = 60_000

/** Bridge engine default total-agent ceiling (official engine default parity). */
const DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS = 1_000

export interface Config {
  /** Mount all host contributions. */
  enabled?: boolean
  /** Continuable `ctx.subagents` Provider used for members. */
  memberProvider?: string
  /** Optional model override for every member. */
  memberModel?: string
  /** Declare members without a model turn until first assignment; default true. False preserves legacy eager startup. */
  lazyMemberStart?: boolean
  /** A1b-only isolated fresh-v2 walking skeleton; default false and never opens v1. */
  experimentalFreshV2?: boolean
  /** Exact lowercase SHA-256 of the A1b candidate artifact/config contract. */
  freshV2ArtifactContract?: string
  freshV2HostContract?: string
  /** Reserved legacy-manifest capacity bound for the fresh-v2 authority record. */
  freshV2LegacyManifestCapacity?: number
  /** Optional LLM Provider override for future members. */
  memberLlmProvider?: string
  /** Default additional deny-only tools for future members. */
  memberDenyTools?: string[]
  /** Default official DSH Skill assignments for future members. */
  memberSkills?: string[]
  /** Enable optional official-DSH-model re-ranking of bounded Team memory candidates. */
  memorySemanticEnabled?: boolean
  memorySemanticProvider?: string
  memorySemanticModel?: string
  memoryQueryMaxCandidates?: number
  memoryQueryTimeoutMs?: number
  /** Absolute child delegation depth cap. */
  memberMaxDepth?: number
  /** Registered scheduling Provider name. */
  schedulerProvider?: string
  /** Registered verification/review Provider name. */
  reviewProvider?: string
  /**
   * Registered review execution root supply name (M3-2, issue #101):
   * builtin `temp` (plain temp directory with candidate artifact check-in)
   * or a #100-family Provider registered through
   * `ctx.agentSwarm.registerReviewRootProvider`. Consumed by the `executable`
   * review Provider. Default `temp`.
   */
  reviewRootProvider?: string
  maxMembers?: number
  maxTasks?: number
  /** Per-target pending (queued-minus-delivered) mail quota, official default 64. */
  maxPendingMessagesPerMember?: number
  /** Team-wide bound on retained delivered/cancelled receipts. */
  maxRetainedMessages?: number
  /** Per-task bound on retained terminal attempts (default 64). */
  maxRetainedAttempts?: number
  maxMessageBytes?: number
  maxTaskBytes?: number
  maxDependencies?: number
  maxMemories?: number
  /** Per-task bound on captain-declared verification commands (default 16, M3-2). */
  maxVerificationCommands?: number
  /** Hard per-command timeout ceiling for executable review in ms (default 600000, M3-2). */
  maxVerificationCommandMs?: number
  /**
   * Bound for every disposal settlement step (F4), same name and default as
   * the official experimental config. Positive safe integer, default 5000.
   */
  disposalTimeoutMs?: number
  /**
   * Stranded-ownership grace bound (issue #12 / F10): a live-and-idle member
   * still holding an open in_progress task is retried under a fresh fenced
   * attempt for the same owner once this many ms elapsed since the task's
   * last transition; 0 disables automatic retry (evidence-only `stranded=`
   * hints remain). Safe non-negative integer, default 60000. Decisions and
   * official-boundary rationale: docs/04 §8c.
   */
  strandedAfterMs?: number
  /**
   * Explicit orchestration mode (M2-3, issue #77): `'adaptive'` (default) is
   * the event-scheduling status quo — idle edges drive scheduling passes and
   * stranded self-healing, byte-identical to the pre-mode plugin when no
   * workflow run is live. `'workflow'` deactivates that autonomous event
   * face (no idle listener is registered; no stranded heal or re-kick) and
   * Teams advance only through workflow runs (requires `workflowBridge`:
   * the combination without it fails activation — no driver would exist)
   * plus explicit operations. While a workflow run owns a Team, the
   * autonomous face defers to it in EITHER mode (single-owner discipline).
   * Decisions: docs/04 §8g and
   * docs/development/2026-08-21-m2c-modes-design.md.
   */
  orchestrationMode?: 'adaptive' | 'workflow'
  /**
   * Mount the Team bridge workflow engine (M2-1, issue #75): an
   * implementation of the official abstract `WorkflowEngine` whose runs are
   * backed by a Team aggregate, registered in an isolated `workflowEngine`
   * service scope (never over the default-scope official engine) with the
   * durable run overlay in the `agent_swarm_workflow` storage domain.
   * Default false: when disabled no bridge service, overlay domain or
   * listener exists and behavior is identical to the pre-bridge plugin.
   */
  workflowBridge?: boolean
  /** Bridge engine ceiling for one run's total `agent()` calls (default 1000). */
  workflowMaxTotalAgents?: number
  /** Bridge run cancellation/disposal settlement grace in ms (default 5000). */
  workflowDisposeGraceMs?: number
  /**
   * Mount the Team bridge job registry (M2-2, issue #76): an implementation
   * of the official abstract `JobRegistry` whose records are a READ-ONLY
   * projection of the authoritative Team task board (derived from
   * post-durability `domain/changed` snapshots), registered in an isolated
   * `jobs` service scope (never over the default-scope official registry).
   * The job face refuses `start`/`kill` — creation and cancellation stay on
   * the Team face. Default false: when disabled no bridge service or
   * listener exists; the `agent_swarm_list_jobs` read tool (issue #93) stays
   * registered on the stable tool surface and fails that call with the
   * structured `TEAM_JOBS_BRIDGE_DISABLED` naming this config.
   */
  jobsBridge?: boolean
  /**
   * Mount per-attempt execution roots (M3-1, issue #100): every claimed
   * attempt is fenced into an isolated physical working root (default
   * Provider `git-worktree`: a detached git worktree of the Team workspace's
   * repository, degrading to an independent temporary directory when the
   * scope holds no repository — the capability difference is declared per
   * root, never silent). The root's absolute path is declared in the
   * assignment frame and the claim result (the official cwd seam: members
   * pass it as the absolute `workdir`), released when the attempt settles,
   * and crash residue is alarmed and marked reclaimable at activation —
   * never auto-deleted. Default false: behavior is byte-identical to the
   * pre-M3-1 plugin. Decisions: docs/04 §8l.
   */
  executionRoots?: boolean
  /** Registered execution-root Provider name (default `git-worktree`). */
  executionRootProvider?: string
  /**
   * Absolute base directory under which execution roots are laid out
   * (default: a dedicated partition under the platform temp directory).
   */
  executionRootsBase?: string
  /**
   * I1a tiered allow/ask/deny tool policy for this plugin's Team members.
   * Plugin tools are allowed and unlisted host tools inherit the official DSH
   * preset/sandbox/guard decision by default; explicit deny/ask only narrows. `ask` is valid
   * only for the live root captain through the official same-turn approval
   * seam and becomes deny for delegated members.
   */
  toolPolicy?: { allow?: string[]; ask?: string[]; deny?: string[] }
  /** Ordered system-prompt contribution. */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  lazyMemberStart: z.boolean().default(true),
  experimentalFreshV2: z.boolean().default(false),
  freshV2ArtifactContract: z.string(),
  freshV2HostContract: z.string(),
  freshV2LegacyManifestCapacity: z.natural().default(0),
  memberLlmProvider: z.string(),
  memberDenyTools: z.array(z.string()).default([]),
  memberSkills: z.array(z.string()).default([]),
  memorySemanticEnabled: z.boolean().default(false),
  memorySemanticProvider: z.string(),
  memorySemanticModel: z.string(),
  memoryQueryMaxCandidates: z.number().step(1).min(1).max(128).default(32),
  memoryQueryTimeoutMs: z.number().step(1).min(1000).max(120000).default(15000),
  memberMaxDepth: z.natural().default(1),
  schedulerProvider: z.string().default('priority-ready'),
  reviewProvider: z.string().default('manual'),
  reviewRootProvider: z.string().default('temp'),
  maxMembers: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMembers),
  maxTasks: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxTasks),
  maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxPendingMessagesPerMember),
  maxRetainedMessages: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxRetainedMessages),
  maxRetainedAttempts: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxRetainedAttempts),
  maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMessageBytes),
  maxTaskBytes: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxTaskBytes),
  maxDependencies: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxDependencies),
  maxMemories: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMemories),
  maxVerificationCommands: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxVerificationCommands),
  maxVerificationCommandMs: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxVerificationCommandMs),
  disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  strandedAfterMs: z.number().step(0).min(0).default(DEFAULT_STRANDED_AFTER_MS),
  orchestrationMode: z.union(['adaptive', 'workflow']).default('adaptive'),
  workflowBridge: z.boolean().default(false),
  workflowMaxTotalAgents: z.number().step(1).min(1).default(DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS),
  workflowDisposeGraceMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  jobsBridge: z.boolean().default(false),
  executionRoots: z.boolean().default(false),
  executionRootProvider: z.string().default('git-worktree'),
  executionRootsBase: z.string(),
  toolPolicy: z.object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({ allow: [], ask: [], deny: [] }),
  promptSectionOrder: z.natural().default(118),
})

function rejectUnsupportedFreshV2Config(config: Config): void {
  const unsupported: string[] = []
  const reject = (changed: boolean, key: keyof Config): void => {
    if (changed) unsupported.push(key)
  }
  reject(config.lazyMemberStart === false, 'lazyMemberStart')
  reject(config.memorySemanticEnabled === true, 'memorySemanticEnabled')
  reject(config.memorySemanticProvider !== undefined, 'memorySemanticProvider')
  reject(config.memorySemanticModel !== undefined, 'memorySemanticModel')
  reject(config.memoryQueryMaxCandidates !== undefined && config.memoryQueryMaxCandidates !== 32, 'memoryQueryMaxCandidates')
  reject(config.memoryQueryTimeoutMs !== undefined && config.memoryQueryTimeoutMs !== 15_000, 'memoryQueryTimeoutMs')
  reject(config.schedulerProvider !== undefined && config.schedulerProvider !== 'priority-ready', 'schedulerProvider')
  reject(config.reviewProvider !== undefined && config.reviewProvider !== 'manual', 'reviewProvider')
  reject(config.reviewRootProvider !== undefined && config.reviewRootProvider !== 'temp', 'reviewRootProvider')
  reject(config.maxTasks !== undefined && config.maxTasks !== DEFAULT_TEAM_LIMITS.maxTasks, 'maxTasks')
  reject(config.maxPendingMessagesPerMember !== undefined
    && config.maxPendingMessagesPerMember !== DEFAULT_TEAM_LIMITS.maxPendingMessagesPerMember, 'maxPendingMessagesPerMember')
  reject(config.maxRetainedMessages !== undefined
    && config.maxRetainedMessages !== DEFAULT_TEAM_LIMITS.maxRetainedMessages, 'maxRetainedMessages')
  reject(config.maxRetainedAttempts !== undefined
    && config.maxRetainedAttempts !== DEFAULT_TEAM_LIMITS.maxRetainedAttempts, 'maxRetainedAttempts')
  reject(config.maxMessageBytes !== undefined && config.maxMessageBytes !== DEFAULT_TEAM_LIMITS.maxMessageBytes, 'maxMessageBytes')
  reject(config.maxTaskBytes !== undefined && config.maxTaskBytes !== DEFAULT_TEAM_LIMITS.maxTaskBytes, 'maxTaskBytes')
  reject(config.maxDependencies !== undefined && config.maxDependencies !== DEFAULT_TEAM_LIMITS.maxDependencies, 'maxDependencies')
  reject(config.maxMemories !== undefined && config.maxMemories !== DEFAULT_TEAM_LIMITS.maxMemories, 'maxMemories')
  reject(config.strandedAfterMs !== undefined && config.strandedAfterMs !== DEFAULT_STRANDED_AFTER_MS, 'strandedAfterMs')
  reject(config.orchestrationMode !== undefined && config.orchestrationMode !== 'adaptive', 'orchestrationMode')
  reject(config.workflowBridge === true, 'workflowBridge')
  reject(config.workflowMaxTotalAgents !== undefined
    && config.workflowMaxTotalAgents !== DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS, 'workflowMaxTotalAgents')
  reject(config.workflowDisposeGraceMs !== undefined
    && config.workflowDisposeGraceMs !== DEFAULT_DISPOSAL_TIMEOUT_MS, 'workflowDisposeGraceMs')
  reject(config.jobsBridge === true, 'jobsBridge')
  reject(config.executionRoots === true, 'executionRoots')
  reject(config.executionRootProvider !== undefined && config.executionRootProvider !== 'git-worktree', 'executionRootProvider')
  reject(config.executionRootsBase !== undefined, 'executionRootsBase')
  reject((config.toolPolicy?.allow?.length ?? 0) > 0
    || (config.toolPolicy?.ask?.length ?? 0) > 0
    || (config.toolPolicy?.deny?.length ?? 0) > 0, 'toolPolicy')
  reject(config.promptSectionOrder !== undefined && config.promptSectionOrder !== 118, 'promptSectionOrder')
  if (unsupported.length > 0) {
    throw new TeamDomainError(
      `fresh-v2 A1b does not implement configured capabilities: ${unsupported.join(', ')}`,
      'TEAM_EXPERIMENTAL_UNSUPPORTED_CONFIG',
    )
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) return
  const memberProvider = (config.memberProvider ?? 'spawn').trim()
  if (memberProvider === '') throw new Error('agent-swarm: memberProvider must not be empty')
  if (config.experimentalFreshV2 === true) {
    rejectUnsupportedFreshV2Config(config)
    if (ctx.get('llm') === undefined) {
      throw new TeamDomainError('fresh-v2 A1b requires the official LLM registry', 'TEAM_RUNTIME_NOT_STARTED')
    }
    const artifactContract = config.freshV2ArtifactContract?.trim()
    if (artifactContract === undefined || !/^[0-9a-f]{64}$/.test(artifactContract)) {
      throw new Error('agent-swarm: experimentalFreshV2 requires freshV2ArtifactContract as a lowercase SHA-256 digest')
    }
    const hostContract = config.freshV2HostContract?.trim()
    if (hostContract === undefined || (!/^[0-9a-f]{40}$/.test(hostContract) && !/^[0-9a-f]{64}$/.test(hostContract))) {
      throw new Error('agent-swarm: experimentalFreshV2 requires freshV2HostContract as an exact lowercase Git SHA or SHA-256 digest')
    }
    const runtime = new FreshV2InitialRuntime(ctx, {
      artifactContract,
      hostContract,
      legacyManifestCapacity: config.freshV2LegacyManifestCapacity ?? 0,
      memberProvider,
      ...(config.memberLlmProvider === undefined ? {} : { memberLlmProvider: config.memberLlmProvider }),
      ...(config.memberModel === undefined ? {} : { memberModel: config.memberModel }),
      memberDenyTools: config.memberDenyTools ?? [],
      memberSkills: config.memberSkills ?? [],
      memberMaxDepth: config.memberMaxDepth ?? 1,
      maxMembers: config.maxMembers ?? DEFAULT_TEAM_LIMITS.maxMembers,
      maxVerificationCommands: config.maxVerificationCommands ?? DEFAULT_TEAM_LIMITS.maxVerificationCommands,
      maxVerificationCommandMs: config.maxVerificationCommandMs ?? DEFAULT_TEAM_LIMITS.maxVerificationCommandMs,
      disposalTimeoutMs: config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
    })
    await runtime.start()
    ctx.effect(() => async () => { await runtime.dispose() }, 'agent-swarm: fresh-v2 runtime disposal')
    attachFreshV2Hooks(ctx, runtime)
    await runtime.reconcileColdDispatches()
    await runtime.driveColdRecoveries()
    ctx.effect(() => ctx.provide('agentSwarmV2Initial', runtime), 'agent-swarm: fresh-v2 inspection service')
    registerFreshV2AgentSwarmTools(ctx, runtime)
    return
  }
  const schedulerProvider = (config.schedulerProvider ?? 'priority-ready').trim()
  const reviewProvider = (config.reviewProvider ?? 'manual').trim()
  const reviewRootProvider = (config.reviewRootProvider ?? 'temp').trim()
  if (schedulerProvider === '') throw new Error('agent-swarm: schedulerProvider must not be empty')
  if (reviewProvider === '') throw new Error('agent-swarm: reviewProvider must not be empty')
  if (reviewRootProvider === '') throw new Error('agent-swarm: reviewRootProvider must not be empty')
  const orchestrationMode = config.orchestrationMode ?? 'adaptive'
  if (orchestrationMode !== 'adaptive' && orchestrationMode !== 'workflow') {
    throw new Error(`agent-swarm: orchestrationMode must be "adaptive" or "workflow", got "${orchestrationMode}"`)
  }
  // M2-3 fail-closed combination (issue #77): workflow mode with no bridge
  // leaves Teams without any orchestration driver — reject before the runtime
  // constructs or opens anything (zero side effects).
  if (orchestrationMode === 'workflow' && config.workflowBridge !== true) {
    throw new Error('agent-swarm: orchestrationMode "workflow" requires workflowBridge: true (no orchestration driver would exist)')
  }
  const executionRootsEnabled = config.executionRoots ?? false
  const executionRootProvider = (config.executionRootProvider ?? 'git-worktree').trim()
  if (executionRootProvider === '') throw new Error('agent-swarm: executionRootProvider must not be empty')
  const executionRootsBase = expectExecutionRootsBase(config.executionRootsBase) ?? defaultExecutionRootsBase()
  const toolPolicy = effectiveToolPolicy(config.toolPolicy)
  const memberToolPolicyDeny = [...(toolPolicy.ask ?? []), ...(toolPolicy.deny ?? [])]
  const disposalTimeoutMs = config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS
  const currentSettings = installAgentSwarmSettings(ctx, Config, config, memberProvider)
  let drainHumanInteractions: (() => Promise<void>) | undefined

  const runtime = new AgentSwarmRuntime(ctx, {
    memberProvider,
    ...(config.memberModel === undefined ? {} : { memberModel: config.memberModel }),
    lazyMemberStart: config.lazyMemberStart ?? true,
    memberMaxDepth: config.memberMaxDepth ?? 1,
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
      maxVerificationCommands: config.maxVerificationCommands ?? DEFAULT_TEAM_LIMITS.maxVerificationCommands,
      maxVerificationCommandMs: config.maxVerificationCommandMs ?? DEFAULT_TEAM_LIMITS.maxVerificationCommandMs,
    },
    disposalTimeoutMs,
    strandedAfterMs: config.strandedAfterMs ?? DEFAULT_STRANDED_AFTER_MS,
    executionRootsEnabled,
    executionRootProvider,
    executionRootsBase,
    memberToolPolicyDeny,
    currentSettings,
  })

  // Fail closed: official Storage Domain opens before tools/listeners.
  await runtime.start()
  ctx.effect(() => async () => {
    await drainHumanInteractions?.()
    await runtime.dispose()
  }, 'agent-swarm: runtime disposal')

  registerAgentSwarmTools(ctx, runtime)
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
    ctx.effect(
      () => runtime.registerReviewProvider('reviewer-agent', reviewerAgentReviewProvider(() => permission!.reviewerAgent)),
      'agent-swarm: reviewer-agent review provider',
    )
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  if (permission === undefined) {
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
  ctx.effect(() => ctx.on('agent/request', async ({ agent, signal }, next) => {
    await runtime.observeAgentRequest(agent, signal)
    return await next()
  }), 'agent-swarm: assignment pre-model gate')
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
    runtime.workflowBridge = bridge
    await bridge.activate()
    ctx.effect(() => () => bridge.dispose(), 'agent-swarm: workflow bridge disposal')
  }

  // M2-2 (issue #76): the Team bridge job registry — a read-only projection
  // of the authoritative task board onto the official `ctx.jobs` seam,
  // registered in an isolated `jobs` service scope (never over the
  // default-scope official registry). Independent of the workflow bridge:
  // it projects every watched workspace scope, not only workflow-driven
  // Teams. Registered after the runtime disposal effect so Cordis's LIFO
  // teardown retires the projection before the aggregate store closes.
  if (config.jobsBridge === true) {
    const projection = new TeamJobProjection(ctx.isolate('jobs'), runtime)
    runtime.jobsBridge = projection
    await projection.activate()
    ctx.effect(() => () => projection.dispose(), 'agent-swarm: jobs bridge disposal')
  }
}
