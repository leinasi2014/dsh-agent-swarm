import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_TEAM_LIMITS } from '../domain/team-domain.js'
import { normalizeAllowedSkills } from '../domain/team-skill-policy.js'
import { DEFAULT_HOST_CONTEXT_TTL_MS, DEFAULT_MAX_HOST_CONTEXTS } from '../human/host-context-service.js'
import { expectExecutionRootsBase } from '../runtime/execution-roots.js'
import { effectiveToolPolicy } from '../runtime/permission-surface.js'

export const AGENT_SWARM_SETTINGS_NAMESPACE = settingsNamespace('agent-swarm')
export const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000
export const DEFAULT_STRANDED_AFTER_MS = 60_000
export const DEFAULT_WORKFLOW_MAX_TOTAL_AGENTS = 1_000

/** User-facing plugin configuration. Runtime code must consume only this normalized surface. */
export interface Config {
  enabled?: boolean
  memberProvider?: string
  memberLlmProvider?: string
  memberModel?: string
  captainLlmProvider?: string
  captainModel?: string
  memberMaxDepth?: number
  schedulerProvider?: string
  reviewProvider?: string
  reviewRootProvider?: string
  maxMembers?: number
  maxTasks?: number
  maxPendingMessagesPerMember?: number
  maxRetainedMessages?: number
  maxRetainedAttempts?: number
  maxMessageBytes?: number
  maxTaskBytes?: number
  maxDependencies?: number
  maxMemories?: number
  maxInteractionEffects?: number
  maxVerificationCommands?: number
  maxVerificationCommandMs?: number
  maxHostContexts?: number
  hostContextTtlMs?: number
  disposalTimeoutMs?: number
  strandedAfterMs?: number
  orchestrationMode?: 'adaptive' | 'workflow'
  workflowBridge?: boolean
  workflowMaxTotalAgents?: number
  workflowDisposeGraceMs?: number
  jobsBridge?: boolean
  executionRoots?: boolean
  executionRootProvider?: string
  executionRootsBase?: string
  toolPolicy?: { allow?: string[]; ask?: string[]; deny?: string[] }
  allowedSkills?: string[]
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  memberProvider: z.string().default('spawn'),
  memberLlmProvider: z.string(),
  memberModel: z.string(),
  captainLlmProvider: z.string(),
  captainModel: z.string(),
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
  maxInteractionEffects: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxInteractionEffects),
  maxVerificationCommands: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxVerificationCommands),
  maxVerificationCommandMs: z.number().step(1).min(1).default(DEFAULT_TEAM_LIMITS.maxVerificationCommandMs),
  maxHostContexts: z.number().step(1).min(1).default(DEFAULT_MAX_HOST_CONTEXTS),
  hostContextTtlMs: z.number().step(1).min(1).default(DEFAULT_HOST_CONTEXT_TTL_MS),
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
  allowedSkills: z.array(z.string()).default([]),
  promptSectionOrder: z.natural().default(118),
})

/** Validate combinations before any runtime, listener or storage side effect is created. */
export function assertServiceableConfig(value: Config): void {
  for (const [field, raw] of [
    ['memberProvider', value.memberProvider ?? 'spawn'],
    ['schedulerProvider', value.schedulerProvider ?? 'priority-ready'],
    ['reviewProvider', value.reviewProvider ?? 'manual'],
    ['reviewRootProvider', value.reviewRootProvider ?? 'temp'],
    ['executionRootProvider', value.executionRootProvider ?? 'git-worktree'],
  ] as const) {
    if (raw.trim() === '') throw new Error(`agent-swarm: ${field} must not be empty`)
  }
  if ((value.orchestrationMode ?? 'adaptive') === 'workflow' && value.workflowBridge !== true) {
    throw new Error('agent-swarm: orchestrationMode "workflow" requires workflowBridge: true (no orchestration driver would exist)')
  }
  expectExecutionRootsBase(value.executionRootsBase)
  normalizeAllowedSkills(value.allowedSkills)
  effectiveToolPolicy(value.toolPolicy)
}
