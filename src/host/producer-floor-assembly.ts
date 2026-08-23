/** Plugin assembly for the internal pre-I2/I3 producer floor. */
import type { Context } from '@deepseek-ai/cordis'
import type { HumanInteractionOverlayStore } from '../human/human-interaction-store.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { AgentSwarmProducerFloorService, provideAgentSwarmProducerFloor } from './producer-floor-service.js'

export function assembleAgentSwarmProducerFloor(
  ctx: Context,
  runtime: AgentSwarmRuntime,
  overlay: HumanInteractionOverlayStore,
  disposalTimeoutMs: number,
): () => Promise<void> {
  const service = new AgentSwarmProducerFloorService({
    domain: () => runtime.domain,
    overlay,
    scopeOf: agent => runtime.scopeOf(agent),
    isExactLiveRoot: agent => ctx.agents.roots().includes(agent),
    now: Date.now,
    disposalTimeoutMs,
  })
  return provideAgentSwarmProducerFloor(ctx, service)
}
