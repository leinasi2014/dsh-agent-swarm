/**
 * Team budget and memory tools (issue #74 split of src/tools.ts): the
 * captain-only budget configuration and durable Team memory writes.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { register } from './shared.js'

/** `agent_swarm_set_budget`. */
export function registerSetBudgetTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_set_budget',
    description: 'Captain-only. Configure Team token, request, retry, and deadline limits. Existing usage is retained.',
    parameters: {
      token_limit: { type: 'number' },
      request_limit: { type: 'number' },
      retry_limit: { type: 'number' },
      deadline_at: { type: 'number', description: 'Absolute Unix timestamp in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          used_tokens: { type: 'number', required: true },
          used_requests: { type: 'number', required: true },
          used_retries: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Budget usage: tokens=${value.used_tokens}, requests=${value.used_requests}, retries=${value.used_retries}.` }],
    },
    async execute(args, exec) {
      const budget = await runtime.setBudget(exec, {
        ...(args.token_limit === undefined ? {} : { tokenLimit: args.token_limit }),
        ...(args.request_limit === undefined ? {} : { requestLimit: args.request_limit }),
        ...(args.retry_limit === undefined ? {} : { retryLimit: args.retry_limit }),
        ...(args.deadline_at === undefined ? {} : { deadlineAt: args.deadline_at }),
      })
      return {
        used_tokens: budget.usedTokens,
        used_requests: budget.usedRequests,
        used_retries: budget.usedRetries,
      }
    },
  }), 'budget tool')
}

/** `agent_swarm_add_memory`. */
export function registerAddMemoryTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_add_memory',
    description: 'Store a compact Team decision, lesson, member capability, or durable context with evidence references.',
    parameters: {
      category: { type: 'string', required: true, enum: ['decision', 'lesson', 'member', 'context'] },
      content: { type: 'string', required: true },
      evidence_refs: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          category: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Stored ${value.category} memory ${value.memory_id}.` }],
    },
    async execute(args, exec) {
      const category = args.category as 'decision' | 'lesson' | 'member' | 'context'
      const entry = await runtime.addMemory(exec, category, args.content, args.evidence_refs ?? [])
      return { memory_id: entry.id, category: entry.category }
    },
  }), 'memory tool')
}

/** `agent_swarm_add_personal_memory`. */
export function registerAddPersonalMemoryTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_add_personal_memory',
    description: 'Store personal memory owned by the calling member. A captain must name one active member owner.',
    parameters: {
      category: { type: 'string', required: true, enum: ['decision', 'lesson', 'member', 'context'] },
      content: { type: 'string', required: true },
      evidence_refs: { type: 'array', items: { type: 'string' } },
      owner: { type: 'string', description: 'Active member name. Required only when the captain writes on a member\'s behalf.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          owner_session_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Stored personal memory ${value.memory_id}.` }],
    },
    async execute(args, exec) {
      const category = args.category as 'decision' | 'lesson' | 'member' | 'context'
      const entry = await runtime.addPersonalMemory(exec, category, args.content, args.evidence_refs ?? [], args.owner)
      return { memory_id: entry.id, owner_session_id: entry.ownerSessionId! }
    },
  }), 'personal memory tool')
}

/** `agent_swarm_list_memory`. */
export function registerListMemoryTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_memory',
    description: 'List or search authorized Team/personal memories. Optional semantic ranking uses the official DSH Provider/model configured in Settings and explicitly falls back to deterministic ranking.',
    parameters: {
      scope: { type: 'string', enum: ['team', 'personal', 'all'], description: 'Defaults to team.' },
      category: { type: 'string', enum: ['decision', 'lesson', 'member', 'context'] },
      owner: { type: 'string', description: 'Captain-only personal-memory owner filter by member name.' },
      query: { type: 'string' },
      semantic: { type: 'boolean' },
      cursor: { type: 'number' },
      limit: { type: 'number', description: '1-32; defaults to 8.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          strategy: { type: 'string', required: true },
          degraded: { type: 'string' },
          next_cursor: { type: 'number' },
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                category: { type: 'string', required: true },
                content: { type: 'string', required: true },
                evidence_refs: { type: 'array', items: { type: 'string' }, required: true },
                owner_session_id: { type: 'string' },
                created_at: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Memory query returned ${value.entries.length} record(s) via ${value.strategy}${value.degraded === undefined ? '' : ` (${value.degraded})`}.` }],
    },
    async execute(args, exec) {
      const limit = args.limit ?? 8
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('limit must be a safe integer from 1 to 32')
      const cursor = args.cursor ?? 0
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
      if (args.query !== undefined && [...args.query].length > 2_048) throw new Error('query must contain at most 2048 code points')
      const result = await runtime.listMemory(exec, {
        scope: (args.scope ?? 'team') as 'team' | 'personal' | 'all',
        ...(args.category === undefined ? {} : { category: args.category as 'decision' | 'lesson' | 'member' | 'context' }),
        ...(args.owner === undefined ? {} : { ownerName: args.owner }),
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.semantic === undefined ? {} : { semantic: args.semantic }),
        cursor,
        limit,
      })
      return {
        strategy: result.strategy,
        ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
        ...(result.nextCursor === undefined ? {} : { next_cursor: result.nextCursor }),
        entries: result.entries.map(entry => ({
          id: entry.id,
          scope: entry.scope ?? 'team',
          category: entry.category,
          content: entry.content,
          evidence_refs: entry.evidenceRefs,
          ...(entry.ownerSessionId === undefined ? {} : { owner_session_id: entry.ownerSessionId }),
          created_at: entry.createdAt,
        })),
      }
    },
  }), 'memory query tool')
}
