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
