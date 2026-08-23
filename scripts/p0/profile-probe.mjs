import { appendFileSync } from 'node:fs'

export const name = 'agent-swarm-p0-profile-probe'
export const inject = [
  'agentSwarm',
  'agentSwarmProducerFloor',
  'agentSwarmReadRpc',
  'agents',
  'tools',
  'storageDomain',
  'sessionPersistence',
  'sessions',
]

function append(phase, ctx, detail = {}) {
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
      sessions: ctx.sessions !== undefined,
      tools: ctx.tools !== undefined,
    },
    tools,
    ...detail,
  })}\n`, 'utf8')
}

async function waitForRoot(ctx, sessionId, signal) {
  while (!signal.aborted) {
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined && Array.from(ctx.agents.roots()).includes(agent)) return agent
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 25)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  signal.throwIfAborted()
}

async function bindTarget(ctx, signal) {
  const rootSessionId = process.env.DSH_SWARM_R2_ROOT_SESSION_ID
  if (rootSessionId === undefined || rootSessionId.length === 0) return
  const agent = await waitForRoot(ctx, rootSessionId, signal)
  const priorEvents = agent.session.events
  const priorTurnStarts = priorEvents.filter(event => event.type === 'turn/start').length
  let fixture
  if (priorTurnStarts === 0) {
    const start = agent.session.append('turn/start', { turn: 1 })
    const end = agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const flushParticipated = await ctx.sessions.flush(agent.session)
    fixture = {
      mode: 'seeded',
      prefixEventCount: priorEvents.length,
      priorTurnStarts,
      events: [
        { seq: start.seq, type: start.type, turn: start.data.turn },
        { seq: end.seq, type: end.type, turn: end.data.turn, reason: end.data.reason },
      ],
      flushParticipated,
    }
  } else {
    fixture = {
      mode: 'reused',
      prefixEventCount: priorEvents.length,
      priorTurnStarts,
      events: agent.session.events
        .filter(event => event.type === 'turn/start' || event.type === 'turn/end')
        .map(event => event.type === 'turn/start'
          ? { seq: event.seq, type: event.type, turn: event.data.turn }
          : { seq: event.seq, type: event.type, turn: event.data.turn, reason: event.data.reason }),
      flushParticipated: false,
    }
  }
  append('r3-session-fixture-ready', ctx, {
    rootSessionId: agent.id,
    fixture,
  })
  const scope = ctx.agentSwarm.scopeOf(agent)
  const membership = await ctx.agentSwarm.domain.findReadMembership(scope, agent.id)
  const team = membership?.team ?? await ctx.agentSwarm.create(
    { agent, signal },
    'R2 isolated Profile team',
    'Real captain Team for the read-only /swarm Profile proof.',
  )
  append('r2-target-ready', ctx, {
    rootSessionId: agent.id,
    teamId: team.id,
    teamRevision: team.revision,
    resumed: membership !== undefined,
    sessionFixture: fixture,
  })
}

export function apply(ctx) {
  append('active', ctx)
  ctx.effect(() => {
    const controller = new AbortController()
    void bindTarget(ctx, controller.signal).catch(error => {
      if (!controller.signal.aborted) append('r2-target-error', ctx, {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return () => {
      controller.abort(new Error('profile probe unloaded'))
      append('unloaded', ctx)
    }
  })
}
