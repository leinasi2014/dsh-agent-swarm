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
  'agentLoop',
  'llm',
]

// Deliberately local-only test adapter.  It is registered only by the disposable
// smoke Profile and never claims to be an external provider or model.
function devSmokeAdapter() {
  let call = 0
  return {
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    async * stream(options) {
      const text = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content).filter(block => block.type === 'text')
        .map(block => block.text).join('\n')
      const match = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/.exec(text)
      if (match !== null) {
        const [, taskId, revision, attemptId] = match
        const args = JSON.stringify({ task_id: taskId, expected_revision: Number(revision), attempt_id: attemptId, output: `DEV_SMOKE completed ${taskId}.` })
        const id = `dev-smoke-submit-${++call}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_submit_task', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_submit_task', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'DEV_SMOKE ready.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DEV_SMOKE ready.' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

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
  let created = false
  while (!signal.aborted) {
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined && Array.from(ctx.agents.roots()).includes(agent)) return agent
    // The official RPC owns durable session creation.  Once it exists, attach
    // an actual AgentLoop root using the isolated DEV_SMOKE adapter.
    if (!created) {
      try {
        ctx.llm.registerAdapter(['dev-smoke'], devSmokeAdapter())
        const root = ctx.agentLoop.create(sessionId, { provider: 'dev-smoke', model: 'DEV_SMOKE' }, { cwd: process.env.DSH_SWARM_P0_WORKSPACE_ROOT })
        created = true
        if (Array.from(ctx.agents.roots()).includes(root)) return root
      } catch { /* persisted session may not exist yet; retry */ }
    }
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

async function tool(ctx, agent, name, arguments_) {
  const result = await ctx.tools.execute({ signal: AbortSignal.timeout(8_000), callId: `dev-smoke-${name}-${Date.now()}`, name, arguments: arguments_, agent })
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  return result.value
}

async function exerciseRealAgentLoop(ctx, agent, team) {
  if (team.tasks.length > 0) return { resumed: true, team }
  const member = await tool(ctx, agent, 'agent_swarm_add_member', { name: 'dev-smoke-member', role: 'Submit exactly one DEV_SMOKE task.' })
  const created = await tool(ctx, agent, 'agent_swarm_create_task', { subject: 'DEV_SMOKE real Agent Loop', description: 'Member must submit using agent_swarm_submit_task.', acceptance_criteria: ['one real submit', 'captain accepts'] })
  const deadline = Date.now() + 15_000
  let task
  while (Date.now() < deadline) {
    const snapshot = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(agent), team.id, agent.id)
    task = snapshot.team.tasks.find(candidate => candidate.id === created.task_id)
    if (task?.status === 'submitted') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (task?.status !== 'submitted' || task.currentAttemptId === undefined) throw new Error(`DEV_SMOKE member did not submit: ${JSON.stringify(task)}`)
  const reviewed = await tool(ctx, agent, 'agent_swarm_review_task', { task_id: task.id, expected_revision: task.revision, attempt_id: task.currentAttemptId, decision: 'accept', diagnostic: 'DEV_SMOKE captain review bound to submitted attempt.' })
  return { resumed: false, memberSessionId: member.session_id, taskId: task.id, review: reviewed }
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
  append('w0-scope-ready', ctx, { rootSessionId: agent.id })
  const scope = ctx.agentSwarm.scopeOf(agent)
  append('w0-membership-start', ctx, { rootSessionId: agent.id })
  const bounded = async (label, operation) => await Promise.race([
    operation(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`DEV_SMOKE_TIMEOUT:${label}`)), 8_000)),
  ])
  const membership = await bounded('findReadMembership', async () => await ctx.agentSwarm.domain.findReadMembership(scope, agent.id))
  append('w0-membership-done', ctx, { rootSessionId: agent.id, found: membership !== undefined })
  append('w0-create-start', ctx, { rootSessionId: agent.id })
  const team = membership?.team ?? await bounded('create', async () => await ctx.agentSwarm.create(
    { agent, signal },
    'R2 isolated Profile team',
    'Real captain Team for the read-only /swarm Profile proof.',
  ))
  append('w0-create-done', ctx, { rootSessionId: agent.id, teamId: team.id })
  const e2e = await exerciseRealAgentLoop(ctx, agent, team)
  append('w0-agent-loop-e2e', ctx, { rootSessionId: agent.id, teamId: team.id, e2e })
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
        // Keep this deliberately secret-free: a Profile probe must never
        // serialize stacks, environment, prompt text, or adapter options.
        error: error instanceof Error ? error.message.replaceAll(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/giu, '[redacted]') : String(error),
      })
    })
    return () => {
      controller.abort(new Error('profile probe unloaded'))
      append('unloaded', ctx)
    }
  })
}
