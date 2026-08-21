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
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'
import { registerAgentSwarmTools } from './tools.js'
import { DEFAULT_TEAM_LIMITS } from './domain/team-domain.js'
import { TeamBridgeWorkflowEngine } from './runtime/workflow/team-bridge-engine.js'
import { TeamJobProjection } from './runtime/jobs/team-job-projection.js'

export { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'
export type {
  ReviewProviderInput,
  ReviewProviderResult,
  RuntimeConfig,
  SchedulerDecision,
  SchedulerSelectionInput,
  TeamReviewProvider,
  TeamSchedulerProvider,
  ToolExecutionAuthority,
} from './runtime/orchestrator-runtime.js'
export { OrchestrationOwnership } from './runtime/orchestration-ownership.js'
export type { OrchestrationMode } from './runtime/orchestration-ownership.js'
export { TeamBridgeWorkflowEngine, validateBridgeMeta } from './runtime/workflow/team-bridge-engine.js'
export type { BridgeEngineConfig } from './runtime/workflow/team-bridge-engine.js'
export { TeamJobProjection } from './runtime/jobs/team-job-projection.js'
export { TEAM_TASK_JOB_KIND } from './runtime/jobs/projection-derive.js'
export type { DerivedTeamJob } from './runtime/jobs/projection-derive.js'
export {
  WorkflowRunOverlayStore,
  workflowOverlayDomainSpec,
  WORKFLOW_OVERLAY_DOMAIN_NAME,
  WORKFLOW_OVERLAY_DOMAIN_VERSION,
} from './storage/workflow-run-overlay.js'
export type { WorkflowRunOverlayRecord, WorkflowRunOverlayState } from './storage/workflow-run-overlay.js'
export { TeamDomainError } from './domain/error.js'
export { compileNodePlan, applyNodePlan } from './patterns/node-mapping.js'
export type {
  AppliedNodePlan,
  CompiledNodePlan,
  CompiledReviewGate,
  CompiledTaskInput,
  CompiledTaskOp,
  NodePlan,
  PhaseDecl,
  PipelineItemDecl,
  PlanNodeDecl,
  TaskStepDecl,
} from './patterns/node-mapping.js'
export { AttemptId, TaskId, TeamId, TeamMessageId } from './domain/types.js'
export type {
  TeamBudget,
  TeamMember,
  TeamMemoryEntry,
  TeamMessage,
  TeamState,
  TeamStatusSnapshot,
  TeamTask,
} from './domain/types.js'
export type {
  CreateTaskInput,
  MigrationReceipt,
  TeamAggregateStore,
  TeamDomainPort,
  TeamScope,
  TeamTransaction,
} from './domain/team-domain-port.js'
export { StorageDomainTeamStore } from './storage/storage-domain-team-store.js'
export { TEAM_DOMAIN_NAME, TEAM_DOMAIN_VERSION, teamDomainSpec } from './storage/team-spec.js'
export { FileTeamStore, resolveStateRoot } from './storage/team-store.js'
export { migrateLegacyTeamStore } from './migration/migrate-legacy-store.js'
export type { MigrationOptions, MigrationReport, MigrationTeamOutcome } from './migration/migrate-legacy-store.js'

export const name = 'agent-swarm'
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
  /** Absolute child delegation depth cap. */
  memberMaxDepth?: number
  /** Registered scheduling Provider name. */
  schedulerProvider?: string
  /** Registered verification/review Provider name. */
  reviewProvider?: string
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
  /** Ordered system-prompt contribution. */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  memberMaxDepth: z.natural().default(1),
  schedulerProvider: z.string().default('priority-ready'),
  reviewProvider: z.string().default('manual'),
  maxMembers: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMembers),
  maxTasks: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxTasks),
  maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxPendingMessagesPerMember),
  maxRetainedMessages: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxRetainedMessages),
  maxRetainedAttempts: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxRetainedAttempts),
  maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMessageBytes),
  maxTaskBytes: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxTaskBytes),
  maxDependencies: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxDependencies),
  maxMemories: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMemories),
  disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  strandedAfterMs: z.number().step(0).min(0).default(DEFAULT_STRANDED_AFTER_MS),
  orchestrationMode: z.union(['adaptive', 'workflow']).default('adaptive'),
  workflowBridge: z.boolean().default(false),
  workflowMaxTotalAgents: z.number().step(1).min(1).default(DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS),
  workflowDisposeGraceMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  jobsBridge: z.boolean().default(false),
  promptSectionOrder: z.natural().default(118),
})

const usage = `Use agent_swarm_* when the user requests a coordinated multi-agent Team.
1. Create one Team, then add role-specific continuable members.
2. Decompose the goal into tasks with explicit acceptance criteria and dependency ids. The event scheduler assigns ready tasks.
3. Compose workflows on the task DAG itself: serial stages are dependency chains (a stage's join is every dependent naming its blockers); fan out through dependency-free same-layer tasks only — actual concurrency is bounded by the member count and mailbox quotas, never around them; hand pipeline artifacts through task outputs and Team mail; put human decisions at the review transaction (a submission waiting for review IS the human gate); a task whose dependency has not completed stays held — never skip or auto-fail it.
4. Every task mutation uses the latest revision. Every worker submission also carries its exact attempt id; stale attempts stop immediately.
5. A worker submission is evidence, not completion. The captain must call agent_swarm_review_task to accept or reject it.
6. Persist peer messages before delivery. A queued result is durable; never resend it automatically. Prefer quiet for information the recipient should read on its next turn; quiet mail to an inactive member stays queued until a wakeup or its own return, and wakeup is the delivery that resumes it.
7. Treat write scopes as coordination hints, not filesystem authorization. Use agent_swarm_status for fixed Team counters and agent_swarm_list_tasks (with status/owner/ready filters and pagination) for task rows after any conflict.
8. The captain may interrupt one member's current turn with agent_swarm_interrupt_member; the member keeps its inbox, tasks and membership, and a later wakeup resumes it.
9. When waiting for another mutation, call agent_swarm_wait with the current Team revision instead of polling status. It returns no_progress immediately when no other member is running or provisioning: re-read status and the task list, wake the required members with wakeup messages, then wait again.
10. Read background Team executions with agent_swarm_list_jobs (kind/status filters, pagination) — every row is one task that entered execution. The job face is read-only: create work as Team tasks and cancel through the Team face, never through the job face.`

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) return
  const memberProvider = (config.memberProvider ?? 'spawn').trim()
  if (memberProvider === '') throw new Error('agent-swarm: memberProvider must not be empty')
  const schedulerProvider = (config.schedulerProvider ?? 'priority-ready').trim()
  const reviewProvider = (config.reviewProvider ?? 'manual').trim()
  if (schedulerProvider === '') throw new Error('agent-swarm: schedulerProvider must not be empty')
  if (reviewProvider === '') throw new Error('agent-swarm: reviewProvider must not be empty')
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

  const runtime = new AgentSwarmRuntime(ctx, {
    memberProvider,
    ...(config.memberModel === undefined ? {} : { memberModel: config.memberModel }),
    memberMaxDepth: config.memberMaxDepth ?? 1,
    schedulerProvider,
    reviewProvider,
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
    },
    disposalTimeoutMs: config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
    strandedAfterMs: config.strandedAfterMs ?? DEFAULT_STRANDED_AFTER_MS,
  })

  // Fail closed: the official Storage Domain must open (backend routed, unit
  // version matching, stored records schema-valid) before any tool, prompt
  // section or listener is registered.
  await runtime.start()

  registerAgentSwarmTools(ctx, runtime)
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agent-swarm:usage',
    order: config.promptSectionOrder ?? 118,
    text: usage,
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
    return () => undefined
  }, 'agent-swarm: activation recovery')
  ctx.effect(() => () => runtime.dispose(), 'agent-swarm: runtime disposal')

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
