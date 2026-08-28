import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

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
  'agentDefaultModel',
  'llm',
]

// Deliberately local-only test adapter.  It is registered only by the disposable
// smoke Profile and never claims to be an external provider or model.
function devSmokeAdapter(ctx) {
  let call = 0
  const submittedAttempts = new Set()
  return new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async * stream(options) {
      const text = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content).filter(block => block.type === 'text')
        .map(block => block.text).join('\n')
      const match = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/.exec(text)
      append('w0-member-model-turn', ctx, { assignmentFrame: match !== null })
      if (match !== null && !submittedAttempts.has(match[3])) {
        const [, taskId, revision, attemptId] = match
        submittedAttempts.add(attemptId)
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
    }
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
        ctx.llm.registerAdapter(['dev-smoke'], devSmokeAdapter(ctx))
        // A persisted official Session is authoritative on reload. Resume it
        // first; creating a second AgentLoop root against its log is an id
        // collision, not a recovery mechanism.
        // Resume accepts explicit Agent options; derive them from the official
        // Profile-owned default-model service so the resumed root has the same
        // deployment:persona variables as the freshly created root.
        const selection = ctx.agentDefaultModel.currentSelection()
        const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: selection }).catch(() => undefined)
        const root = resumed?.agent ?? ctx.agentLoop.create(sessionId, selection, { cwd: process.env.DSH_SWARM_P0_WORKSPACE_ROOT })
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
  const result = await Promise.race([
    ctx.tools.execute({ signal: AbortSignal.timeout(8_000), callId: `dev-smoke-${name}-${Date.now()}`, name, arguments: arguments_, agent }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`DEV_SMOKE_TIMEOUT:${name}`)), 8_000)),
  ])
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  return result.value
}

async function exerciseRealAgentLoop(ctx, agent, team) {
  if (team.tasks.length > 0) return { resumed: true, team }
  // A valid 64-character no-whitespace display name keeps the browser proof on the Host contract boundary.
  const memberName = 'a'.repeat(64)
  const member = await tool(ctx, agent, 'agent_swarm_add_member', { name: memberName, role: 'Submit exactly one DEV_SMOKE task.' })
  const created = await tool(ctx, agent, 'agent_swarm_create_task', { subject: 'DEV_SMOKE real Agent Loop', description: 'Member must submit using agent_swarm_submit_task.', acceptance_criteria: ['one real submit', 'captain accepts'], target_member: memberName })
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
  const canonical = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(agent), team.id, agent.id)
  return { resumed: false, memberSessionId: member.session_id, taskId: task.id, review: reviewed, team: canonical.team }
}

const TURN_END_REASON_KINDS = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted'])
const ROOT_TURN_SETTLEMENT_TIMEOUT_MS = 8_000

// The official AgentLoop owns Session turn boundaries. This probe records only
// settled official turns; it never appends a competing turn/start fixture.
function captureRealAgentLoopFixture(events) {
  const starts = new Map()
  const ends = new Map()
  const boundaries = []
  for (const event of events) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    const turn = event.data.turn
    if (!Number.isSafeInteger(event.seq) || !Number.isSafeInteger(turn) || turn < 1) {
      throw new Error(`DEV_SMOKE invalid official turn boundary: ${JSON.stringify({ seq: event.seq, type: event.type, turn })}`)
    }
    if (event.type === 'turn/start') {
      if (starts.has(turn)) throw new Error(`DEV_SMOKE duplicate official turn/start: ${turn}`)
      starts.set(turn, event.seq)
      boundaries.push({ seq: event.seq, type: event.type, turn })
      continue
    }
    const kind = event.data.reason?.kind
    if (typeof kind !== 'string' || !TURN_END_REASON_KINDS.has(kind) || ends.has(turn)) {
      throw new Error(`DEV_SMOKE invalid official turn/end: ${JSON.stringify({ seq: event.seq, turn, kind })}`)
    }
    ends.set(turn, event.seq)
    boundaries.push({ seq: event.seq, type: event.type, turn, reason: event.data.reason })
  }
  if (starts.size === 0 || starts.size !== ends.size) {
    throw new Error(`DEV_SMOKE official turn boundary is incomplete: ${JSON.stringify({ starts: starts.size, ends: ends.size })}`)
  }
  for (const [turn, startSeq] of starts) {
    const endSeq = ends.get(turn)
    if (endSeq === undefined || endSeq <= startSeq) throw new Error(`DEV_SMOKE official turn is not closed in order: ${JSON.stringify({ turn, startSeq, endSeq })}`)
  }
  return { mode: 'agent-loop', events: boundaries }
}

export function assertCompletedRootProbeTurn(settledTurn, events) {
  if (settledTurn?.reason?.kind === 'completed') return
  const context = events
    .filter(event => event.data?.turn === settledTurn?.turn)
    .map(event => ({ seq: event.seq, type: event.type, reason: event.data?.reason }))
  throw new Error(`DEV_SMOKE root AgentLoop acceptance turn did not complete: ${JSON.stringify({
    turn: settledTurn?.turn, seq: settledTurn?.seq, reason: settledTurn?.reason, context,
  })}`)
}

async function settleRootAgentLoop(agent, { requireCompleted = true } = {}) {
  const priorTurn = agent.session.events.reduce((maximum, event) => event.type === 'turn/start' && Number.isSafeInteger(event.data.turn)
    ? Math.max(maximum, event.data.turn) : maximum, 0)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'DEV_SMOKE root settlement. Complete one official AgentLoop turn after the Captain review.' }],
    source: { kind: 'plugin', plugin: name },
  }))
  let rejectTimeout
  const timeout = new Promise((_, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => { rejectTimeout(new Error('DEV_SMOKE_TIMEOUT:root-agent-loop-settlement')) }, ROOT_TURN_SETTLEMENT_TIMEOUT_MS)
  try { await Promise.race([agent.whenIdle(), timeout]) } finally { clearTimeout(timer) }
  if (agent.status !== 'idle') throw new Error(`DEV_SMOKE root AgentLoop did not settle idle: ${agent.status}`)
  const fixture = captureRealAgentLoopFixture(agent.session.events)
  const settledTurn = fixture.events.find(event => event.type === 'turn/end' && event.turn > priorTurn)
  if (settledTurn === undefined) throw new Error(`DEV_SMOKE root AgentLoop produced no new closed turn after Captain review: ${priorTurn}`)
  if (requireCompleted) assertCompletedRootProbeTurn(settledTurn, agent.session.events)
  return { fixture, settledTurn }
}

function probeUsageEntries(events, settledTurn) {
  const entries = events
    .filter(event => event.type === 'assistant/message' && event.data?.turn === settledTurn.turn && event.data?.usage !== undefined)
    .map(event => {
      const usage = event.data.usage
      const tokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      if (!Number.isSafeInteger(event.seq) || !Number.isSafeInteger(tokens) || tokens < 0) {
        throw new Error(`DEV_SMOKE invalid durable root probe usage event: ${JSON.stringify({ seq: event.seq, usage })}`)
      }
      return { seq: event.seq, tokens }
    })
  if (entries.length === 0) throw new Error(`DEV_SMOKE root probe completed without a durable usage event: ${settledTurn.turn}`)
  return entries
}

async function snapshotAfterProbeUsage(ctx, scope, teamId, agent, entries, bounded) {
  const expectedCursor = entries.at(-1).seq
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const snapshot = await bounded('postProbeSnapshot', async () => await ctx.agentSwarm.domain.snapshot(scope, teamId, agent.id))
    if (snapshot.team.usageCursors[agent.id] === expectedCursor) return snapshot
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error(`DEV_SMOKE root probe usage was not durably folded: ${JSON.stringify({ expectedCursor })}`)
}

async function authoritativeReloadPreProbeTeam(ctx, rootSessionId) {
  const workspaceRoot = process.env.DSH_SWARM_P0_WORKSPACE_ROOT
  if (workspaceRoot === undefined || workspaceRoot.length === 0) throw new Error('DSH_SWARM_P0_WORKSPACE_ROOT is required')
  // The store is authoritative and this resolved workspace key is the same
  // one runtime.scopeOf(agent) would derive after a root exists. This read is
  // deliberately before waitForRoot(), the only resume/create boundary here.
  const teams = await ctx.agentSwarm.listTeamAggregates(resolve(workspaceRoot))
  const matches = teams.filter(team => team.captainSessionId === rootSessionId && team.phase === 'active')
  if (matches.length > 1) throw new Error(`DEV_SMOKE reload pre-probe captain binding is ambiguous: ${rootSessionId}`)
  return matches[0]
}

async function bindTarget(ctx, signal) {
  const rootSessionId = process.env.DSH_SWARM_R2_ROOT_SESSION_ID
  if (rootSessionId === undefined || rootSessionId.length === 0) return
  const reloadPreProbeTeam = await authoritativeReloadPreProbeTeam(ctx, rootSessionId)
  if (reloadPreProbeTeam !== undefined) append('w0-reload-pre-probe', ctx, { rootSessionId, team: reloadPreProbeTeam })
  const agent = await waitForRoot(ctx, rootSessionId, signal)
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
  const exercise = await exerciseRealAgentLoop(ctx, agent, team)
  const { fixture, settledTurn } = await settleRootAgentLoop(agent)
  const probeUsage = probeUsageEntries(agent.session.events, settledTurn)
  // The exact Team identity is sampled only after the root AgentLoop reaches
  // its terminal settlement.  This is the identity the R2 terminal snapshot
  // and the reload proof compare; review-time state is not an oracle.
  const terminalSnapshot = await snapshotAfterProbeUsage(ctx, scope, team.id, agent, probeUsage, bounded)
  const e2e = { ...exercise, team: terminalSnapshot.team }
  append('w0-root-agent-loop-settled', ctx, { rootSessionId: agent.id, settledTurn, probeUsage })
  append('w0-agent-loop-e2e', ctx, { rootSessionId: agent.id, teamId: team.id, e2e })
  append('r3-session-fixture-ready', ctx, { rootSessionId: agent.id, fixture })
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
