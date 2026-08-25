import type { Context } from '@deepseek-ai/cordis'
import type { FreshV2InitialRuntime } from './fresh-v2-initial-runtime.js'

/** Mount the complete official event/witness face for the isolated fresh-v2 runtime. */
export function attachFreshV2Hooks(ctx: Context, runtime: FreshV2InitialRuntime): void {
  ctx.effect(() => ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    await runtime.beforeAgentRequest({ agent, turn, step, signal })
    return await next()
  }, { global: true, prepend: true }), 'agent-swarm: fresh-v2 assignment pre-model gate')
  ctx.effect(() => ctx.on('llm/stream', (options, next) => runtime.wrapModelStream(options, next), {
    global: true,
    prepend: true,
  }), 'agent-swarm: fresh-v2 model dispatch witness')
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    runtime.observeSessionEvent(session, event)
  }, { global: true }), 'agent-swarm: fresh-v2 durable Session evidence')
  ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    runtime.observeInboxClaimed(agent, message)
  }, { global: true }), 'agent-swarm: fresh-v2 continuation claim evidence')
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') runtime.observeAgentIdle(agent)
  }, { global: true }), 'agent-swarm: fresh-v2 continuation quiescence')
  ctx.effect(() => ctx.on('llm/adapters-updated', () => {
    runtime.revokeWitnessCapability()
  }), 'agent-swarm: fresh-v2 provider topology revocation')
}
