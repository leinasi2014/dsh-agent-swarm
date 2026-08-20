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
export { TeamDomainError } from './domain/error.js'
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
  'systemPrompt',
  'sessionPersistence',
  'storageDomain',
] as const

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
  maxMessages?: number
  maxMessageBytes?: number
  maxTaskBytes?: number
  maxDependencies?: number
  maxMemories?: number
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
  maxMessages: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMessages),
  maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMessageBytes),
  maxTaskBytes: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxTaskBytes),
  maxDependencies: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxDependencies),
  maxMemories: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxMemories),
  promptSectionOrder: z.natural().default(118),
})

const usage = `Use agent_swarm_* when the user requests a coordinated multi-agent Team.
1. Create one Team, then add role-specific continuable members.
2. Decompose the goal into tasks with explicit acceptance criteria and dependency ids. The event scheduler assigns ready tasks.
3. Every task mutation uses the latest revision. Every worker submission also carries its exact attempt id; stale attempts stop immediately.
4. A worker submission is evidence, not completion. The captain must call agent_swarm_review_task to accept or reject it.
5. Persist peer messages before delivery. A queued result is durable; never resend it automatically.
6. Treat write scopes as coordination hints, not filesystem authorization. Use status to reread authoritative state after any conflict.
7. When waiting for another mutation, call agent_swarm_wait with the current Team revision instead of polling status.`

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) return
  const memberProvider = (config.memberProvider ?? 'spawn').trim()
  if (memberProvider === '') throw new Error('agent-swarm: memberProvider must not be empty')
  const schedulerProvider = (config.schedulerProvider ?? 'priority-ready').trim()
  const reviewProvider = (config.reviewProvider ?? 'manual').trim()
  if (schedulerProvider === '') throw new Error('agent-swarm: schedulerProvider must not be empty')
  if (reviewProvider === '') throw new Error('agent-swarm: reviewProvider must not be empty')

  const runtime = new AgentSwarmRuntime(ctx, {
    memberProvider,
    ...(config.memberModel === undefined ? {} : { memberModel: config.memberModel }),
    memberMaxDepth: config.memberMaxDepth ?? 1,
    schedulerProvider,
    reviewProvider,
    limits: {
      maxMembers: config.maxMembers ?? DEFAULT_TEAM_LIMITS.maxMembers,
      maxTasks: config.maxTasks ?? DEFAULT_TEAM_LIMITS.maxTasks,
      maxMessages: config.maxMessages ?? DEFAULT_TEAM_LIMITS.maxMessages,
      maxMessageBytes: config.maxMessageBytes ?? DEFAULT_TEAM_LIMITS.maxMessageBytes,
      maxTaskBytes: config.maxTaskBytes ?? DEFAULT_TEAM_LIMITS.maxTaskBytes,
      maxDependencies: config.maxDependencies ?? DEFAULT_TEAM_LIMITS.maxDependencies,
      maxMemories: config.maxMemories ?? DEFAULT_TEAM_LIMITS.maxMemories,
    },
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
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') runtime.observeAgentIdle(agent)
  }), 'agent-swarm: idle scheduler')
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    runtime.observeSessionEvent(session, event)
  }), 'agent-swarm: token accounting')
  ctx.effect(async () => {
    await Promise.all(ctx.agents.roots().map(agent => runtime.recoverAgent(agent)))
    return () => undefined
  }, 'agent-swarm: activation recovery')
  ctx.effect(() => () => runtime.dispose(), 'agent-swarm: runtime disposal')
}
