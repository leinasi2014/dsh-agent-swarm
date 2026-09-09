import type { RuntimeConfig } from './runtime-contract.js'
/** Team route precedence and validation over the official model resolver. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { TeamModelRoute } from '../domain/types.js'
import { nonEmpty } from '../domain/team-domain-shared.js'

export interface ModelRouteInput {
  llmProvider?: string
  model?: string
  reasoningEffort?: string
}

/** Resolve explicit > configured > current creator route before any effects. */
export async function resolveTeamModelRoute(ctx: Context, parent: Agent, explicit: ModelRouteInput, defaults: ModelRouteInput, signal: AbortSignal, frozenDefaults = false): Promise<TeamModelRoute> {
  const current = parent.session.requestHeader()?.config ?? parent.options
  const llmProvider = nonEmpty(explicit.llmProvider ?? defaults.llmProvider ?? current.provider ?? '', 'LLM provider', 128)
  const model = nonEmpty(explicit.model ?? defaults.model ?? current.model ?? '', 'model', 128)
  const sameRoute = llmProvider === current.provider && model === current.model
  const sameDefaultRoute = llmProvider === defaults.llmProvider && model === defaults.model
  const effort = explicit.reasoningEffort ?? (sameDefaultRoute ? defaults.reasoningEffort : undefined)
    ?? (sameRoute && !frozenDefaults ? current.reasoningEffort : undefined)
  const route: TeamModelRoute = { llmProvider, model,
    ...(effort === undefined ? {} : { reasoningEffort: nonEmpty(effort, 'reasoning effort', 128) }) }
  // Validation may resolve adapter defaults; preserve omission in our intent.
  await ctx.llm.resolveCallConfig(toAgentModelOptions(route), signal)
  signal.throwIfAborted()
  return route
}

/** An already resolved intent must not inherit a different effort on replay. */
export function toAgentModelOptions(route: TeamModelRoute): ModelSelection {
  const options: ModelSelection = { provider: route.llmProvider, model: route.model }
  // Official child composition spreads requested options over the parent.
  // An enumerable undefined clears inherited effort when this route chose the
  // adapter default, including replay after the parent has changed its model.
  Object.assign(options, { reasoningEffort: route.reasoningEffort === undefined ? undefined : ReasoningEffortId(route.reasoningEffort) })
  return options
}

export function captainModelDefaults(config: RuntimeConfig): ModelRouteInput {
  return {
    ...(config.captainLlmProvider === undefined ? {} : { llmProvider: config.captainLlmProvider }),
    ...(config.captainModel === undefined ? {} : { model: config.captainModel }),
  }
}
