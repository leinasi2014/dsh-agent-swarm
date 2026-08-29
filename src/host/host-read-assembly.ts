import type { Context } from '@deepseek-ai/cordis'
import type { HumanInteractionOverlayStore } from '../human/human-interaction-store.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { AgentSwarmHostReadService, provideAgentSwarmHostRead } from './host-read-service.js'

export { assembleAgentSwarmProducerFloor } from './producer-floor-assembly.js'
export { mountAgentSwarmReadRpc } from '../rpc/read-rpc-service.js'

/** Assemble R1 only against official Host identity and authoritative stores. */
export function assembleAgentSwarmHostRead(
  ctx: Context,
  runtime: AgentSwarmRuntime,
  overlay: HumanInteractionOverlayStore,
  disposalTimeoutMs: number,
): () => Promise<void> {
  const service = new AgentSwarmHostReadService({
    currentInitiator: () => ctx.agents.currentInitiator(),
    isExactLiveRoot: agent => ctx.agents.get(agent.id) === agent
      && ctx.sessions.get(agent.id) === agent.session
      && (agent.session.header.parentSession !== undefined || ctx.agents.roots().includes(agent)),
    scopeOf: agent => runtime.scopeOf(agent),
    teams: scope => runtime.listTeamAggregates(scope),
    domain: () => runtime.domain,
    overlay,
    now: Date.now,
    disposalTimeoutMs,
  })
  return provideAgentSwarmHostRead(ctx, service)
}
