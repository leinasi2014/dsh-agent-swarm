/** R1/I2-R Host-owned binding, projection, resync and lifecycle evidence. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { TeamDomainError } from '../src/domain/error.js'
import { assertSwarmReadRpcValue } from '../src/rpc/read-rpc-artifact.js'

const NOW = 1_700_000_000_500
const ROOT = {
  id: 'root-session', session: { header: { cwd: 'C:\\secret\\workspace' } },
} as unknown as Agent
const OTHER_ROOT = {
  id: 'other-root-session', session: { header: { cwd: 'D:\\other\\workspace' } },
} as unknown as Agent
const CHILD = {
  id: 'child-session', session: { header: { cwd: 'C:\\secret\\workspace' } },
} as unknown as Agent
const ROOT_WITHOUT_WORKSPACE = {
  id: 'root-without-workspace', session: { header: {} },
} as unknown as Agent

function teamState(overrides: Partial<AgentSwarm.TeamState> = {}): AgentSwarm.TeamState {
  return {
    schemaVersion: 1,
    id: AgentSwarm.TeamId('team-r1'),
    revision: 9,
    name: 'R1 team',
    description: 'private description',
    captainSessionId: ROOT.id,
    phase: 'active',
    members: [{
      name: 'worker', role: 'developer', sessionId: CHILD.id, provider: 'secret-provider',
      phase: 'active', createdAt: NOW - 100, error: 'secret member error',
    }],
    tasks: [{
      id: AgentSwarm.TaskId('task-1'), revision: 3, subject: 'Visible subject',
      description: 'secret task body', acceptanceCriteria: ['secret criterion'], status: 'in_progress',
      blockedBy: [], writeScopes: ['secret/write/scope'], priority: 2,
      verification: [{ command: 'secret verification command' }], reservationTokens: 123,
      ownerSessionId: CHILD.id, currentAttemptId: AgentSwarm.AttemptId('attempt-1'), output: 'secret output',
      createdAt: NOW - 90, updatedAt: NOW - 40,
    }],
    attempts: [{
      id: AgentSwarm.AttemptId('attempt-1'), taskId: AgentSwarm.TaskId('task-1'), generation: 1,
      memberSessionId: CHILD.id, phase: 'running', assignmentPhase: 'delivered',
      assignmentDeliveredAt: NOW - 60, output: 'secret attempt output', evidence: ['secret evidence'],
      diagnostic: 'secret diagnostic', createdAt: NOW - 80, updatedAt: NOW - 30,
    }],
    messages: [],
    budget: { usedTokens: 50, usedRequests: 3, usedRetries: 1, tokenLimit: 1_000 },
    usageCursors: {},
    memory: [{ id: 'memory-1', category: 'context', content: 'secret memory', evidenceRefs: [], createdAt: NOW - 20 }],
    nextTaskNumber: 2,
    nextMemoryNumber: 2,
    createdAt: NOW - 200,
    updatedAt: NOW - 10,
    ...overrides,
  }
}

function interactions(): AgentSwarm.HumanInteractionRecord[] {
  return [
    {
      schemaVersion: 1,
      scope: 'C:\\secret\\workspace',
      request: {
        schemaVersion: 1, requestId: 'human-r1-00000001', teamId: AgentSwarm.TeamId('team-r1'),
        source: {
          kind: 'authenticated-human', captainSessionId: ROOT.id,
          principalRef: 'secret-principal', hostSurface: 'secret-host',
        },
        target: { kind: 'member', memberName: 'worker' }, intent: 'member-question',
        body: 'secret body', expectedTeamRevision: 9, createdAt: NOW - 15,
      },
      receipt: {
        requestId: 'human-r1-00000001', teamId: AgentSwarm.TeamId('team-r1'), status: 'acknowledged',
        diagnostic: 'secret receipt diagnostic', updatedAt: NOW - 5,
      },
      createdAt: NOW - 15,
      updatedAt: NOW - 5,
    },
    {
      schemaVersion: 1,
      scope: 'C:\\secret\\workspace',
      request: {
        schemaVersion: 1, requestId: 'human-r1-00000002', teamId: AgentSwarm.TeamId('team-r1'),
        source: { kind: 'captain-mediated', captainSessionId: ROOT.id },
        target: { kind: 'team' }, intent: 'message', body: 'already done',
        expectedTeamRevision: 9, createdAt: NOW - 25,
      },
      receipt: {
        requestId: 'human-r1-00000002', teamId: AgentSwarm.TeamId('team-r1'),
        status: 'executed', updatedAt: NOW - 20,
      },
      createdAt: NOW - 25,
      updatedAt: NOW - 20,
    },
  ]
}

function harness(overrides: {
  team?: AgentSwarm.TeamState
  snapshot?: () => Promise<AgentSwarm.TeamStatusSnapshot>
  disposalTimeoutMs?: number
} = {}) {
  let initiator: Agent | undefined = ROOT
  let liveRoots: readonly Agent[] = [ROOT, OTHER_ROOT]
  const team = overrides.team ?? teamState()
  const listTeams = vi.fn(async () => [team])
  const snapshot = vi.fn(async (_scope: string, id: AgentSwarm.TeamId, actorSessionId: string) => {
    if (overrides.snapshot !== undefined) return await overrides.snapshot()
    if (id !== team.id) throw new TeamDomainError(`team "${id}" not found`, 'TEAM_NOT_FOUND')
    if (actorSessionId !== team.captainSessionId) throw new TeamDomainError('not a participant', 'TEAM_UNAUTHORIZED')
    return { team, readyTaskIds: [], pendingMessageIds: [] }
  })
  const overlayList = vi.fn(() => interactions())
  const service = new AgentSwarm.AgentSwarmHostReadService({
    currentInitiator: () => initiator,
    isExactLiveRoot: agent => liveRoots.includes(agent),
    scopeOf: agent => agent === ROOT ? 'C:\\secret\\workspace' : 'D:\\other\\workspace',
    teams: listTeams,
    domain: () => ({ snapshot }) as unknown as Pick<AgentSwarm.TeamDomainPort, 'snapshot'>,
    overlay: { list: overlayList },
    now: () => NOW,
    disposalTimeoutMs: overrides.disposalTimeoutMs ?? 1_000,
  })
  return {
    service, listTeams, snapshot, overlayList,
    setInitiator: (agent: Agent | undefined) => { initiator = agent },
    setRoots: (roots: readonly Agent[]) => { liveRoots = roots },
  }
}

describe('R1 Host read producer', () => {
  it('derives authority from the live root and returns a frozen redacted UI projection', async () => {
    const { service, snapshot, overlayList } = harness()
    const result = await service.read({ teamId: 'team-r1' })
    expect(snapshot).toHaveBeenCalledWith('C:\\secret\\workspace', 'team-r1', ROOT.id)
    expect(overlayList).toHaveBeenCalledWith('C:\\secret\\workspace', 'team-r1')
    expect(result).toMatchObject({
      binding: { rootSessionId: ROOT.id, teamId: 'team-r1' },
      team: { id: 'team-r1', phase: 'active', revision: 9 },
      roster: [{
        name: 'worker', role: 'developer', phase: 'active', sessionId: CHILD.id,
        runtimeProvider: 'secret-provider', deniedTools: [], assignedSkills: [],
        dynamicTaskToolPolicy: 'unsupported',
      }],
      memory: [{ id: 'memory-1', scope: 'team', category: 'context', content: 'secret memory' }],
      memoryTotal: 1,
      memoryTruncated: false,
      tasks: [{ id: 'task-1', subject: 'Visible subject', ownerName: 'worker', currentAttemptId: 'attempt-1' }],
      attempts: [{ id: 'attempt-1', memberName: 'worker', phase: 'running' }],
      pendingInteractions: [{
        requestId: 'human-r1-00000001', intent: 'member-question', targetKind: 'member',
        targetRef: 'worker', status: 'acknowledged',
      }],
      totals: { roster: 1, tasks: 1, attempts: 1, pendingInteractions: 1 },
      truncated: { roster: false, tasks: false, attempts: false, pendingInteractions: false },
      capabilities: AgentSwarm.SWARM_PRODUCER_CAPABILITIES_V1,
      changed: true,
      resyncRequired: false,
      observedAt: NOW,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.tasks)).toBe(true)
    const serialized = JSON.stringify(result)
    for (const secret of [
      'secret\\workspace', 'secret member error', 'private description', 'secret task body',
      'secret criterion', 'secret/write/scope', 'secret verification command', 'secret output',
      'secret attempt output', 'secret evidence', 'secret diagnostic', 'secret-principal',
      'secret-host', 'secret body', 'secret receipt diagnostic',
    ]) expect(serialized).not.toContain(secret)
  })

  it('keeps caller fields strict and never accepts identity, scope or principal claims', async () => {
    const { service, snapshot } = harness()
    for (const input of [
      { sessionId: ROOT.id }, { scope: 'C:\\secret\\workspace' }, { principalRef: 'human' },
      { teamId: '' }, { teamId: 'x'.repeat(129) }, { afterCursor: 'r1:not-a-cursor' },
      Object.create({ teamId: 'team-r1' }),
    ]) await expect(service.read(input as never)).rejects.toMatchObject({ code: 'SWARM_HOST_INVALID_REQUEST' })
    const accessor = Object.defineProperty({}, 'teamId', { enumerable: true, get: () => 'team-r1' })
    await expect(service.read(accessor)).rejects.toMatchObject({ code: 'SWARM_HOST_INVALID_REQUEST' })
    await expect(service.read(new Proxy({}, {}))).rejects.toMatchObject({ code: 'SWARM_HOST_INVALID_REQUEST' })
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('reports absent, non-root, ambiguous, missing and mismatched bindings explicitly', async () => {
    const absent = harness()
    absent.setInitiator(undefined)
    await expect(absent.service.read()).rejects.toMatchObject({ code: 'SWARM_HOST_INITIATOR_REQUIRED' })

    const child = harness()
    child.setInitiator(CHILD)
    await expect(child.service.read()).rejects.toMatchObject({ code: 'SWARM_HOST_ROOT_REQUIRED' })

    const noWorkspace = harness()
    noWorkspace.setInitiator(ROOT_WITHOUT_WORKSPACE)
    noWorkspace.setRoots([ROOT_WITHOUT_WORKSPACE])
    await expect(noWorkspace.service.read()).rejects.toMatchObject({ code: 'SWARM_HOST_WORKSPACE_REQUIRED' })

    const noTeam = harness()
    noTeam.listTeams.mockResolvedValue([])
    await expect(noTeam.service.read()).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_NOT_FOUND' })

    const ambiguous = harness()
    ambiguous.listTeams.mockResolvedValue([
      teamState(),
      teamState({ id: AgentSwarm.TeamId('team-r1-other') }),
    ])
    await expect(ambiguous.service.read()).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_AMBIGUOUS' })

    const missing = harness()
    await expect(missing.service.read({ teamId: 'deleted-team' })).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })

    const mismatch = harness()
    mismatch.setInitiator(OTHER_ROOT)
    await expect(mismatch.service.read({ teamId: 'team-r1' })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  it('projects archived Teams terminally and rebinds every call after a Session switch', async () => {
    const archived = harness({ team: teamState({ phase: 'archived' }) })
    await expect(archived.service.read()).resolves.toMatchObject({ team: { phase: 'archived' } })

    let initiator: Agent | undefined = ROOT
    const rootTeam = teamState()
    const otherTeam = teamState({
      id: AgentSwarm.TeamId('team-other'), captainSessionId: OTHER_ROOT.id, name: 'Other Team',
    })
    const service = new AgentSwarm.AgentSwarmHostReadService({
      currentInitiator: () => initiator,
      isExactLiveRoot: agent => agent === ROOT || agent === OTHER_ROOT,
      scopeOf: agent => agent === ROOT ? 'scope-root' : 'scope-other',
      teams: async scope => [scope === 'scope-root' ? rootTeam : otherTeam],
      domain: () => ({
        snapshot: async (scope: AgentSwarm.TeamScope, teamId: AgentSwarm.TeamId, actor: string) => {
          const team = scope === 'scope-root' ? rootTeam : otherTeam
          if (teamId !== team.id || actor !== team.captainSessionId) throw new TeamDomainError('mismatch', 'TEAM_UNAUTHORIZED')
          return { team, readyTaskIds: [], pendingMessageIds: [] }
        },
      }) as unknown as Pick<AgentSwarm.TeamDomainPort, 'snapshot'>,
      overlay: { list: () => [] },
      now: () => NOW,
    })
    await expect(service.read()).resolves.toMatchObject({ binding: { rootSessionId: ROOT.id, teamId: 'team-r1' } })
    initiator = OTHER_ROOT
    await expect(service.read()).resolves.toMatchObject({ binding: { rootSessionId: OTHER_ROOT.id, teamId: 'team-other' } })
  })

  it('uses a complete projection cursor for unchanged and full-resync outcomes', async () => {
    const { service } = harness()
    const first = await service.read()
    const unchanged = await service.read({ afterCursor: first.cursor })
    expect(unchanged).toMatchObject({ cursor: first.cursor, changed: false, resyncRequired: false })
    const stale = `r1:${'0'.repeat(64)}`
    const resync = await service.read({ afterCursor: stale })
    expect(resync).toMatchObject({ cursor: first.cursor, changed: true, resyncRequired: true })
    const reorderedBudget = {
      tokenLimit: 1_000, usedRetries: 1, usedRequests: 3, usedTokens: 50,
    } satisfies AgentSwarm.TeamBudget
    const equivalent = await harness({ team: teamState({ budget: reorderedBudget }) }).service.read()
    expect(equivalent.cursor).toBe(first.cursor)
  })

  it('bounds every collection while preserving authoritative totals', async () => {
    const members = Array.from({ length: 101 }, (_, index) => ({
      name: `member-${index}`, role: 'worker', sessionId: `member-session-${index}`,
      provider: 'provider', phase: 'active' as const, createdAt: index,
    }))
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      id: AgentSwarm.TaskId(`task-${index}`), revision: 1, subject: `Task ${index}`,
      description: 'body', acceptanceCriteria: [], status: 'pending' as const, blockedBy: [], writeScopes: [],
      priority: 0, createdAt: index, updatedAt: index,
    }))
    const attempts = Array.from({ length: 201 }, (_, index) => ({
      id: AgentSwarm.AttemptId(`attempt-${index}`), taskId: tasks[index % tasks.length]!.id,
      generation: 1, memberSessionId: members[index % members.length]!.sessionId,
      phase: 'running' as const, assignmentPhase: 'delivered' as const,
      evidence: [], createdAt: index, updatedAt: index,
    }))
    const memory = Array.from({ length: 101 }, (_, index) => ({
      id: `memory-${index}`, category: 'context' as const, content: `memory ${index}`,
      evidenceRefs: [], createdAt: index,
    }))
    const bounded = harness({ team: teamState({ members, tasks, attempts, memory }) })
    bounded.overlayList.mockReturnValue(Array.from({ length: 101 }, (_, index) => ({
      ...interactions()[0]!,
      request: { ...interactions()[0]!.request, requestId: `human-r1-${String(index).padStart(8, '0')}` },
      receipt: { ...interactions()[0]!.receipt, requestId: `human-r1-${String(index).padStart(8, '0')}`, updatedAt: index },
    })))
    const result = await bounded.service.read()
    expect([result.roster.length, result.tasks.length, result.attempts.length, result.pendingInteractions.length])
      .toEqual([100, 100, 200, 100])
    expect(result.totals).toEqual({ roster: 101, tasks: 101, attempts: 201, pendingInteractions: 101 })
    expect(result.truncated).toEqual({ roster: true, tasks: true, attempts: true, pendingInteractions: true })
    expect(result.memory).toHaveLength(100)
    expect(result).toMatchObject({ memoryTotal: 101, memoryTruncated: true })
  })

  it('bounds long member and memory fields explicitly before the strict RPC contract', async () => {
    const role = '职'.repeat(2_048)
    const content = '忆'.repeat(16_384)
    const evidenceRefs = Array.from({ length: 65 }, (_, index) => `${index}-${'证'.repeat(2_045)}`)
    const bounded = harness({ team: teamState({
      members: [{
        name: 'worker', role, sessionId: CHILD.id, provider: 'spawn', phase: 'active', createdAt: NOW - 100,
      }],
      memory: [{
        id: 'memory-long', category: 'context', content, evidenceRefs, scope: 'team',
        authorSessionId: ROOT.id, createdAt: NOW - 20,
      }],
    }) })
    const result = await bounded.service.read()
    expect([...result.roster[0]!.role]).toHaveLength(256)
    expect(result.roster[0]!.roleTruncated).toBe(true)
    expect([...(result.memory?.[0]?.content ?? '')]).toHaveLength(2_048)
    expect(result.memory?.[0]).toMatchObject({ contentTruncated: true, evidenceTruncated: true })
    expect(result.memory?.[0]?.evidenceRefs).toHaveLength(64)
    expect([...(result.memory?.[0]?.evidenceRefs[0] ?? '')]).toHaveLength(512)
    expect(() => assertSwarmReadRpcValue('snapshot', result)).not.toThrow()
  })

  it('detects a root removal or Session change during an admitted read', async () => {
    let release!: (value: AgentSwarm.TeamStatusSnapshot) => void
    const blocked = new Promise<AgentSwarm.TeamStatusSnapshot>(resolve => { release = resolve })
    const midRead = harness({ snapshot: () => blocked })
    const reading = midRead.service.read({ teamId: 'team-r1' })
    midRead.setRoots([OTHER_ROOT])
    release({ team: teamState(), readyTaskIds: [], pendingMessageIds: [] })
    await expect(reading).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  it('closes admission, unprovides, drains and times out deterministically', async () => {
    let release!: (value: AgentSwarm.TeamStatusSnapshot) => void
    const blocked = new Promise<AgentSwarm.TeamStatusSnapshot>(resolve => { release = resolve })
    const { service } = harness({ snapshot: () => blocked })
    const ctx = new Context()
    const dispose = AgentSwarm.provideAgentSwarmHostRead(ctx, service)
    expect(ctx.agentSwarmHostRead).toBe(service)
    const reading = service.read({ teamId: 'team-r1' })
    const disposing = dispose()
    expect(ctx.get('agentSwarmHostRead')).toBeUndefined()
    await expect(service.read()).rejects.toMatchObject({ code: 'SWARM_HOST_READ_CLOSED' })
    release({ team: teamState(), readyTaskIds: [], pendingMessageIds: [] })
    await expect(reading).resolves.toMatchObject({ team: { id: 'team-r1' } })
    await expect(disposing).resolves.toBeUndefined()

    let timeoutRelease!: (value: AgentSwarm.TeamStatusSnapshot) => void
    const timeoutBlocked = new Promise<AgentSwarm.TeamStatusSnapshot>(resolve => { timeoutRelease = resolve })
    const timed = harness({ snapshot: () => timeoutBlocked, disposalTimeoutMs: 5 })
    const timedRead = timed.service.read({ teamId: 'team-r1' })
    await expect(timed.service.dispose()).rejects.toMatchObject({ code: 'SWARM_HOST_READ_DISPOSAL_TIMEOUT' })
    timeoutRelease({ team: teamState(), readyTaskIds: [], pendingMessageIds: [] })
    await expect(timedRead).resolves.toBeDefined()
  })
})
