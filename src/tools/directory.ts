/** Same runtime projection for deliberate Agent reads and authenticated UI reads. */
import type { Context } from '@deepseek-ai/cordis'
import { valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { requireAgent } from '../runtime/authority.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { register } from './shared.js'

const sourceProperties = {
  state: { type: 'string', required: true, enum: ['available', 'unknown', 'unavailable', 'stale'] },
  source: { type: 'string', required: true }, version: { type: 'string' },
  observedAt: { type: 'number', required: true }, updatedAt: { type: 'number' }, reason: { type: 'string' },
} as const
const sourceSchema = { type: 'object', additionalProperties: false, properties: sourceProperties } as const
const skillSet = { type: 'object', additionalProperties: false, properties: { ...sourceProperties,
  entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', required: true }, description: { type: 'string' },
    descriptionTruncated: { type: 'boolean' },
  } } },
} } as const
const directorySchema = { type: 'object', additionalProperties: false, properties: {
  schemaVersion: { type: 'number', required: true, const: 2 },
  binding: { type: 'object', required: true, additionalProperties: false, properties: { rootSessionId: { type: 'string', required: true }, teamId: { type: 'string', required: true } } },
  directoryRevision: { type: 'string', required: true }, observedAt: { type: 'number', required: true },
  entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    memberId: { type: 'string', required: true }, role: { type: 'string', required: true, enum: ['captain', 'member'] },
    name: { type: 'string', required: true }, label: { type: 'string', required: true }, responsibility: { type: 'string', required: true },
    profession: { type: 'string' }, personality: { type: 'string' }, biography: { type: 'string' },
    phase: { type: 'string', required: true, enum: ['staged', 'active', 'archived', 'provisioning', 'failed', 'removed'] },
    profile: { ...sourceSchema, required: true },
    avatar: { type: 'object', required: true, additionalProperties: false, properties: {
      state: { type: 'string', required: true, enum: ['generated', 'not_generated', 'unavailable'] },
      reason: { type: 'string' }, svg: { type: 'string' },
    } },
    currentTasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, subject: { type: 'string', required: true }, status: { type: 'string', required: true },
    } } },
    skills: { type: 'object', required: true, additionalProperties: false, properties: {
      assigned: { ...skillSet, required: true }, sessionVisible: { ...skillSet, required: true }, catalog: { ...skillSet, required: true },
    } },
    tools: { type: 'object', required: true, additionalProperties: false, properties: { ...sourceProperties,
      complete: { type: 'boolean', required: true }, entries: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['available', 'approval-required', 'disabled', 'unknown'] },
          teamPolicy: { type: 'string', required: true, enum: ['allow', 'ask', 'deny', 'unknown'] },
        },
      } },
    } },
    model: { type: 'object', required: true, additionalProperties: false, properties: { ...sourceProperties,
      provider: { type: 'string' }, model: { type: 'string' }, imageInput: { type: 'string', required: true, enum: ['supported', 'unsupported', 'unknown'] },
    } },
  } } },
  page: { type: 'object', required: true, additionalProperties: false, properties: {
    offset: { type: 'number', required: true }, limit: { type: 'number', required: true }, totalCount: { type: 'number', required: true }, returnedCount: { type: 'number', required: true },
    hasMore: { type: 'boolean', required: true }, nextCursor: { type: 'string' }, unreadRanges: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: { offset: { type: 'number', required: true }, count: { type: 'number', required: true } },
    } },
  } },
} } as const

export function registerDirectoryTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, {
    name: 'agent_swarm_directory',
    description: 'Read the current public Team directory: exact member identities, profiles, responsibilities, tasks, Skills, tools, models and image support. Source states distinguish known from unknown. Pass nextCursor unchanged for the next page; stale pages must restart. This grants no execution authority and never reads private memory.',
    parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string' } } },
    output: { schema: valueSchemaSpecToJsonSchema(directorySchema), render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(4096).optional() }).strict().parse(args)
      const agent = requireAgent(exec), scope = runtime.scopeOf(agent)
      const membership = await runtime.domain.requireMembership(scope, agent.id)
      const result = await runtime.directory.read(scope, membership.team.id, {
        ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }, exec.signal)
      const current = await runtime.domain.requireMembership(scope, agent.id)
      exec.signal.throwIfAborted()
      if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session
        || current.team.id !== membership.team.id) throw new TeamDomainError('Directory caller changed', 'TEAM_AGENT_REQUIRED')
      return result
    },
  }, 'public directory tool')
}
