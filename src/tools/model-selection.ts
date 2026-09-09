import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { compactJsonOutput, register } from './shared.js'

export function registerSetCaptainModelTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_set_captain_model',
    description: 'Active dedicated managed Captain only: select your own LLM provider/model for subsequent requests. The current request completes normally. Selection survives cold continuation and does not change plugin or global defaults. Omitted reasoning_effort uses the selected model default. Legacy root Captains use the Host model selector.',
    parameters: {
      llm_provider: { type: 'string', required: true, description: 'Exact LLM provider for your next request.' },
      model: { type: 'string', required: true, description: 'Exact model for your next request.' },
      reasoning_effort: { type: 'string', description: 'Explicit supported effort; omit to use this model default.' },
    },
    output: compactJsonOutput({ type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
    } }),
    async execute(args, exec) {
      return await runtime.captainModels.select(exec, { llmProvider: args.llm_provider, model: args.model,
        ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }) })
    },
  }), 'Captain model selection')
}
