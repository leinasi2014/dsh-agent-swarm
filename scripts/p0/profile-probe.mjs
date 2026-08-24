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
  const representative = await ensureRepresentativeTeam(
    ctx, scope, team.id, agent.id, membership === undefined,
  )
  append('r2-target-ready', ctx, {
    rootSessionId: agent.id,
    teamId: team.id,
    teamRevision: team.revision,
    resumed: membership !== undefined,
    sessionFixture: fixture,
    representative,
  })
}

const REPRESENTATIVE_MEMBER = {
  name: 'profile-reviewer',
  role: 'Review member for populated browser acceptance.',
  sessionId: 'p0-profile-reviewer-session',
  provider: 'spawn',
  llmProvider: 'p0-provider',
  model: 'p0-model',
  modelSource: 'explicit',
  deniedTools: ['agent_swarm_list_tasks'],
  assignedSkills: ['dsh-plugin-development'],
}
const TEAM_MEMORY = 'P0 shared decision: keep browser evidence claim-local.'
const PERSONAL_MEMORY = 'P0 personal lesson: verify populated state after reload.'

async function ensureRepresentativeTeam(ctx, scope, teamId, captainSessionId, seed) {
  let snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, captainSessionId)
  let member = snapshot.team.members.find(candidate => candidate.name === REPRESENTATIVE_MEMBER.name)
  if (member === undefined) {
    if (!seed) throw new Error('representative member did not survive Profile restart')
    member = await ctx.agentSwarm.domain.provisionMember(scope, teamId, captainSessionId, REPRESENTATIVE_MEMBER)
    member = await ctx.agentSwarm.domain.settleMember(scope, teamId, member.sessionId, { active: true })
  }
  const stableProfile = member.phase === 'active'
    && member.sessionId === REPRESENTATIVE_MEMBER.sessionId
    && member.provider === REPRESENTATIVE_MEMBER.provider
    && member.llmProvider === REPRESENTATIVE_MEMBER.llmProvider
    && member.model === REPRESENTATIVE_MEMBER.model
    && member.modelSource === REPRESENTATIVE_MEMBER.modelSource
    && JSON.stringify(member.deniedTools) === JSON.stringify(REPRESENTATIVE_MEMBER.deniedTools)
    && JSON.stringify(member.assignedSkills) === JSON.stringify(REPRESENTATIVE_MEMBER.assignedSkills)
  if (!stableProfile) throw new Error(`representative member fixture drifted: ${JSON.stringify(member)}`)

  snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, captainSessionId)
  if (!snapshot.team.memory.some(entry => entry.scope === 'team' && entry.content === TEAM_MEMORY)) {
    if (!seed) throw new Error('representative Team memory did not survive Profile restart')
    await ctx.agentSwarm.domain.addMemory(
      scope, teamId, captainSessionId, 'decision', TEAM_MEMORY, ['p0:team-memory'],
    )
  }
  if (!snapshot.team.memory.some(entry => entry.scope === 'member'
    && entry.ownerSessionId === REPRESENTATIVE_MEMBER.sessionId && entry.content === PERSONAL_MEMORY)) {
    if (!seed) throw new Error('representative personal memory did not survive Profile restart')
    await ctx.agentSwarm.domain.addMemory(
      scope, teamId, REPRESENTATIVE_MEMBER.sessionId, 'lesson', PERSONAL_MEMORY, ['p0:personal-memory'],
      { scope: 'member', ownerSessionId: REPRESENTATIVE_MEMBER.sessionId },
    )
  }
  snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, captainSessionId)
  if (snapshot.team.members.length !== 1 || snapshot.team.memory.length !== 2) {
    throw new Error(`representative fixture cardinality drifted: ${JSON.stringify({
      roster: snapshot.team.members.length, memory: snapshot.team.memory.length,
    })}`)
  }
  const memories = snapshot.team.memory
    .filter(entry => entry.content === TEAM_MEMORY || entry.content === PERSONAL_MEMORY)
    .toSorted((left, right) => left.content.localeCompare(right.content))
  return {
    mode: seed ? 'seeded' : 'reused',
    source: 'synthetic-authoritative-storage-fixture',
    claimCeiling: 'member profile and memory projection/persistence; not live subagent execution',
    member: {
      name: member.name,
      role: member.role,
      sessionId: member.sessionId,
      provider: member.provider,
      llmProvider: member.llmProvider,
      model: member.model,
      modelSource: member.modelSource,
      deniedTools: member.deniedTools,
      assignedSkills: member.assignedSkills,
      phase: member.phase,
    },
    rosterCount: snapshot.team.members.length,
    memoryCount: snapshot.team.memory.length,
    memoryIds: memories.map(entry => entry.id),
    teamMemory: TEAM_MEMORY,
    personalMemory: PERSONAL_MEMORY,
  }
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
