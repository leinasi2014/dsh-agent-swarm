import { existsSync } from 'node:fs'

export const name = 'agent-swarm-p0-shutdown-probe'

export function apply(ctx) {
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
  ctx.effect(() => () => clearInterval(timer))
}
