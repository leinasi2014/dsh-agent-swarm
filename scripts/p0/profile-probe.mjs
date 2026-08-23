import { appendFileSync } from 'node:fs'

export const name = 'agent-swarm-p0-profile-probe'
export const inject = [
  'agentSwarm',
  'agentSwarmProducerFloor',
  'agentSwarmReadRpc',
  'tools',
  'storageDomain',
  'sessionPersistence',
]

function append(phase, ctx) {
  const path = process.env.DSH_SWARM_P0_PROBE_PATH
  if (path === undefined || path.length === 0) throw new Error('DSH_SWARM_P0_PROBE_PATH is required')
  const tools = ctx.tools.schemas().map(tool => tool.name).filter(tool => tool.startsWith('agent_swarm_')).sort()
  appendFileSync(path, `${JSON.stringify({
    phase,
    services: {
      agentSwarm: ctx.agentSwarm !== undefined,
      agentSwarmProducerFloor: ctx.agentSwarmProducerFloor !== undefined,
      agentSwarmReadRpc: ctx.agentSwarmReadRpc !== undefined,
      storageDomain: ctx.storageDomain !== undefined,
      sessionPersistence: ctx.sessionPersistence !== undefined,
      tools: ctx.tools !== undefined,
    },
    tools,
  })}\n`, 'utf8')
}

export function apply(ctx) {
  append('active', ctx)
  ctx.effect(() => () => {
    append('unloaded', ctx)
  })
}
