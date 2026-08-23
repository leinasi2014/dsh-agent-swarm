import { appendFileSync, existsSync } from 'node:fs'

export const name = 'agent-swarm-p0-profile-probe'
export const inject = [
  'agentSwarm',
  'agentSwarmProducerFloor',
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
      storageDomain: ctx.storageDomain !== undefined,
      sessionPersistence: ctx.sessionPersistence !== undefined,
      tools: ctx.tools !== undefined,
    },
    tools,
  })}\n`, 'utf8')
}

export function apply(ctx) {
  append('active', ctx)
  const stopPath = process.env.DSH_SWARM_P0_STOP_PATH
  if (stopPath === undefined || stopPath.length === 0) throw new Error('DSH_SWARM_P0_STOP_PATH is required')
  let stopping = false
  const timer = setInterval(() => {
    if (stopping || !existsSync(stopPath)) return
    stopping = true
    if (process.platform === 'win32') process.emit('SIGTERM')
    else process.kill(process.pid, 'SIGTERM')
  }, 100)
  timer.unref()
  ctx.effect(() => () => {
    clearInterval(timer)
    append('unloaded', ctx)
  })
}
