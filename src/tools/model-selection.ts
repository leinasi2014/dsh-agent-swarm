import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import type { ToolExecutionAuthority } from '../runtime/authority.js'
import { compactJsonOutput, register } from './shared.js'

/** One shared registration shape for both self-selection tools; only the
 * name, description, registration label and the authorized public method
 * differ between the Captain-only alias and the participant surface. */
function registerModelSelectionTool(ctx: Context, shape: {
  readonly name: string
  readonly description: string
  readonly label: string
  readonly select: (exec: ToolExecutionAuthority, input: { llmProvider: string; model: string; reasoningEffort?: string }) => Promise<ModelSelection>
}): void {
  register(ctx, defineTool({
    name: shape.name,
    description: shape.description,
    parameters: {
      llm_provider: { type: 'string', required: true, description: 'Exact LLM provider for your next request.' },
      model: { type: 'string', required: true, description: 'Exact model for your next request.' },
      reasoning_effort: { type: 'string', description: 'Explicit supported effort; omit to use this model default.' },
    },
    output: compactJsonOutput({ type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
    } }),
    async execute(args, exec) {
      return await shape.select(exec, { llmProvider: args.llm_provider, model: args.model,
        ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }) })
    },
  }), shape.label)
}

export function registerSetCaptainModelTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  registerModelSelectionTool(ctx, {
    name: 'agent_swarm_set_captain_model',
    description: 'Active dedicated managed Captain only: select your own LLM provider/model for subsequent requests. The current request completes normally. Selection survives cold continuation and does not change plugin or global defaults. Omitted reasoning_effort uses the selected model default. Legacy root Captains use the Host model selector.',
    label: 'Captain model selection',
    select: (exec, input) => runtime.captainModels.select(exec, input),
  })
}

export function registerSetMemberModelTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  registerModelSelectionTool(ctx, {
    name: 'agent_swarm_set_member_model',
    description: 'Active Team participant (dedicated managed Captain or member) only: select your own LLM provider/model for subsequent requests. Self-only — there is no target parameter, so this never selects a model for another session. The current request completes normally. Selection survives cold continuation and does not change plugin or global defaults. Omitted reasoning_effort uses the selected model default. Legacy root Captains use the Host model selector.',
    label: 'Member model selection',
    select: (exec, input) => runtime.captainModels.selectParticipant(exec, input),
  })
}
