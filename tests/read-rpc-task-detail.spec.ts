/** Task detail reads the selected authoritative task without widening summaries. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { AttemptId, TaskId, TeamId, type TeamState } from '../src/domain/types.js'
import { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'
import { assertSwarmReadRpcValue } from '../src/rpc/read-rpc-artifact.js'
import type { SwarmReadTaskDetailV1 } from '../src/rpc/read-rpc-contract.js'

const ROOT = 'main-session'
const CAPTAIN = 'captain-session'
const MEMBER = 'private-member-session'
const target = { rootSessionId: ROOT, teamId: 'team-detail' }
const request = { schemaVersion: 1, method: 'taskDetail', target, taskId: 'task-1' }

function teamState(): TeamState {
  return {
    schemaVersion: 1, id: TeamId(target.teamId), name: 'Detail Team', description: 'private-team-description',
    revision: 9, captainSessionId: CAPTAIN, phase: 'active',
    members: [{ name: 'worker', role: 'writer', sessionId: MEMBER, phase: 'active', provider: 'private-provider', createdAt: 1 }],
    tasks: [{ id: TaskId('task-1'), revision: 3, subject: 'Actual task', description: 'Actual description',
      acceptanceCriteria: ['Actual criterion'], output: 'Actual task output', status: 'in_progress',
      blockedBy: [], priority: 2, ownerSessionId: MEMBER, targetMemberSessionId: MEMBER,
      currentAttemptId: AttemptId('attempt-2'), writeScopes: ['private-write-scope'],
      verification: [{ command: 'private-command' }], reservationTokens: 23, createdAt: 1, updatedAt: 3 }],
    attempts: [{ id: AttemptId('attempt-2'), taskId: TaskId('task-1'), generation: 2,
      memberSessionId: MEMBER, phase: 'running', assignmentPhase: 'delivered', assignmentDeliveredAt: 2,
      replacesAttemptId: AttemptId('attempt-1'), output: 'Actual attempt output', evidence: ['opaque evidence reference'],
      diagnostic: 'Actual diagnostic', createdAt: 1, updatedAt: 3 }],
    messages: [], memory: [{ id: 'private-memory', category: 'context', content: 'private-memory-content', evidenceRefs: [], createdAt: 1 }],
    usageCursors: {}, budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    nextTaskNumber: 2, nextMemoryNumber: 2, createdAt: 1, updatedAt: 3,
  }
}

function harness(team = teamState()) {
  const root = { id: ROOT, session: { header: { cwd: 'D:/detail' } } } as unknown as Agent
  const captain = { id: CAPTAIN, session: { header: { cwd: 'D:/detail', parentSession: ROOT } } } as unknown as Agent
  const agents = new Map([[ROOT, root], [CAPTAIN, captain]])
  const sessions = new Map([[ROOT, root.session], [CAPTAIN, captain.session]])
  const teams = [team]
  const list = vi.fn(async (_scope: string) => teams)
  const ctx = { agents: { get: (id: string) => agents.get(id), roots: () => [root] },
    sessions: { get: (id: string) => sessions.get(id) },
  } as unknown as Context
  const hostRead = new AgentSwarmHostReadService({
    currentInitiator: () => root, isExactLiveRoot: value => value === root,
    scopeOf: value => value.session.header.cwd!, teams: list,
    domain: () => { throw new Error('detail must use the existing authoritative aggregate read') },
    overlay: { list: () => [] }, now: () => 10, disposalTimeoutMs: 100,
  })
  const runtime = { listTeamAggregates: list, managedCaptainSessionsOf: () => [], scopeOf: (value: Agent) => value.session.header.cwd! } as unknown as AgentSwarmRuntime
  const service = new AgentSwarmReadRpcService({ ctx, runtime, hostRead,
    webServer: { host: '127.0.0.1', port: 8279, register: () => () => {} } })
  return { service, hostRead, teams, agents, sessions, list, root, captain }
}

describe('taskDetail target-bound read', () => {
  it('returns exact task content and its retained attempts through the frozen wire contract', async () => {
    const team = teamState()
    team.tasks.push({ ...team.tasks[0]!, id: TaskId('task-other'), description: 'OTHER TASK CONTENT' })
    team.attempts.push({ ...team.attempts[0]!, id: AttemptId('other-attempt'), taskId: TaskId('task-other'), output: 'OTHER ATTEMPT CONTENT' })
    const before = structuredClone(team)
    const h = harness(team)
    const value = await h.service.invoke(request)
    expect(value).toMatchObject({ schemaVersion: 1, state: 'available', binding: { rootSessionId: CAPTAIN, teamId: target.teamId },
      taskId: 'task-1', teamRevision: 9,
      task: { id: 'task-1', description: 'Actual description', acceptanceCriteria: ['Actual criterion'], output: 'Actual task output',
        ownerName: 'worker', targetMemberName: 'worker', currentAttemptId: 'attempt-2' },
      attempts: { scope: 'retained', retainedCount: 1, returnedCount: 1, limit: 100, truncated: false,
        entries: [{ id: 'attempt-2', taskId: 'task-1', generation: 2, memberName: 'worker', assignmentDeliveredAt: 2,
          replacesAttemptId: 'attempt-1', output: 'Actual attempt output', evidence: ['opaque evidence reference'], diagnostic: 'Actual diagnostic' }] },
      observedAt: expect.any(Number) })
    expect(() => assertSwarmReadRpcValue('taskDetail', value)).not.toThrow()
    expect(Object.isFrozen(value)).toBe(true)
    const wire = JSON.stringify(value)
    for (const excluded of ['private-', 'writeScopes', 'verification', 'reservationTokens', 'ownerSessionId', 'memberSessionId',
      'targetMemberSessionId', 'credentials', 'messages', 'memory', 'OTHER TASK CONTENT', 'OTHER ATTEMPT CONTENT']) expect(wire).not.toContain(excluded)
    expect(team).toEqual(before)
    const summary = await h.service.invoke({ schemaVersion: 1, method: 'snapshot', target })
    expect(() => assertSwarmReadRpcValue('snapshot', summary)).not.toThrow()
    for (const content of ['Actual description', 'Actual criterion', 'Actual task output', 'Actual attempt output', 'Actual diagnostic', 'opaque evidence reference', 'assignmentDeliveredAt', 'replacesAttemptId']) {
      expect(JSON.stringify(summary)).not.toContain(content)
    }
  })

  it('distinguishes a missing task from an existing task with no retained attempts', async () => {
    const team = teamState()
    team.attempts.length = 0
    const h = harness(team)
    await expect(h.service.invoke(request)).resolves.toMatchObject({ state: 'available', taskId: 'task-1',
      attempts: { entries: [], retainedCount: 0, returnedCount: 0, truncated: false, scope: 'retained' } })
    await expect(h.service.invoke({ ...request, taskId: 'missing' })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
  })

  it('selects before applying bounds and reports only currently retained history', async () => {
    const team = teamState()
    const source = team.attempts[0]!
    team.attempts.length = 0
    for (let generation = 101; generation <= 201; generation++) {
      team.attempts.push({ ...source, id: AttemptId(`retained-${generation}`), generation, phase: 'stale' })
    }
    for (let index = 0; index < 210; index++) {
      team.tasks.push({ ...team.tasks[0]!, id: TaskId(`other-${index}`), updatedAt: 999 })
      team.attempts.push({ ...source, id: AttemptId(`other-${index}`), taskId: TaskId(`other-${index}`), generation: 999, updatedAt: 999 })
    }
    const value = await harness(team).service.invoke(request)
    expect(value).toMatchObject({ taskId: 'task-1', attempts: { retainedCount: 101, returnedCount: 100, limit: 100, truncated: true } })
    const entries = (value as SwarmReadTaskDetailV1).attempts.entries
    expect(entries.map(row => row.generation)).toEqual(Array.from({ length: 100 }, (_, index) => 201 - index))
    expect(entries.every(row => row.taskId === 'task-1')).toBe(true)
    expect(() => assertSwarmReadRpcValue('taskDetail', value)).not.toThrow()
    expect(team.attempts).toHaveLength(311)
  })

  it('never resolves another root or Team to satisfy a task id', async () => {
    const h = harness()
    const foreign = { ...teamState(), id: TeamId('foreign-team'), captainSessionId: 'foreign-captain' }
    h.teams.push(foreign)
    const foreignCaptain = { id: 'foreign-captain', session: { header: { cwd: 'D:/detail', parentSession: 'foreign-root' } } } as unknown as Agent
    h.agents.set(foreignCaptain.id, foreignCaptain)
    h.sessions.set(foreignCaptain.id, foreignCaptain.session)
    await expect(h.service.invoke({ ...request, target: { ...target, teamId: foreign.id } })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
    await expect(h.service.invoke({ ...request, target: { ...target, rootSessionId: 'missing-root' } })).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    h.teams[0]!.tasks.length = 0
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
  })

  it('refuses replaced Sessions after an awaited aggregate read and respects Host disposal', async () => {
    const h = harness()
    h.list.mockImplementationOnce(async () => {
      h.sessions.set(ROOT, { ...h.root.session } as Agent['session'])
      return h.teams
    })
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    const closed = harness()
    await closed.hostRead.dispose()
    await expect(closed.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_HOST_READ_CLOSED' })
    expect(closed.list).not.toHaveBeenCalled()
  })

  it('revalidates Team revision and Captain after asynchronous ancestry checks', async () => {
    for (const replacement of [{ revision: 10 }, { captainSessionId: 'other-captain' }]) {
      const h = harness()
      h.list.mockResolvedValueOnce(h.teams).mockResolvedValueOnce([{ ...h.teams[0]!, ...replacement }])
      await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
    }
  })

  it('allows the current exact member via official ancestry but refuses its removed identity', async () => {
    const h = harness()
    const member = { id: MEMBER, session: { header: { cwd: 'D:/detail', parentSession: CAPTAIN } } } as unknown as Agent
    h.agents.set(MEMBER, member)
    h.sessions.set(MEMBER, member.session)
    const memberRequest = { ...request, target: { ...target, rootSessionId: MEMBER } }
    await expect(h.service.invoke(memberRequest)).resolves.toMatchObject({ binding: { rootSessionId: CAPTAIN, teamId: target.teamId }, taskId: 'task-1' })
    Object.assign(h.teams[0]!.members[0]!, { phase: 'removed' })
    await expect(h.service.invoke(memberRequest)).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  it('copies all arrays without freezing or mutating the canonical aggregate', async () => {
    const team = teamState()
    const value = await harness(team).service.invoke(request) as SwarmReadTaskDetailV1
    expect(Object.isFrozen(value.task.acceptanceCriteria)).toBe(true)
    expect(Object.isFrozen(value.attempts.entries[0]!.evidence)).toBe(true)
    team.tasks[0]!.acceptanceCriteria.push('later criterion')
    team.tasks[0]!.blockedBy.push(TaskId('later dependency'))
    team.attempts[0]!.evidence.push('later reference')
    expect(value.task.acceptanceCriteria).toEqual(['Actual criterion'])
    expect(value.task.blockedBy).toEqual([])
    expect(value.attempts.entries[0]!.evidence).toEqual(['opaque evidence reference'])
  })

  it('rejects unsupported historical field sizes instead of silently shortening content', async () => {
    const team = teamState()
    Object.assign(team.tasks[0]!, { description: 'x'.repeat(65_537) })
    await expect(harness(team).service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_PROJECTION_LIMIT' })
  })

  it('preserves the full default Domain text and item limits, including a 64KiB output', async () => {
    const team = teamState()
    const fullText = 'x'.repeat(65_536)
    const items = Array.from({ length: 64 }, () => 'y'.repeat(2048))
    Object.assign(team.tasks[0]!, { subject: 's'.repeat(512), description: fullText, output: fullText,
      acceptanceCriteria: [...items], blockedBy: Array.from({ length: 64 }, (_, i) => TaskId(`dependency-${i}`)) })
    Object.assign(team.attempts[0]!, { output: fullText, evidence: [...items], diagnostic: 'd'.repeat(8192) })
    const value = await harness(team).service.invoke(request) as SwarmReadTaskDetailV1
    expect(value.task.description).toBe(fullText)
    expect(value.task.output).toBe(fullText)
    expect(value.task.acceptanceCriteria).toEqual(items)
    expect(value.attempts.entries[0]!.output).toBe(fullText)
    expect(value.attempts.entries[0]!.evidence).toEqual(items)
    expect(value.attempts.entries[0]!.diagnostic).toHaveLength(8192)
  })

  it('returns a bounded public 404 for a missing task over the existing HTTP handler', async () => {
    const h = harness()
    const input = { ...request, taskId: 'missing-private-task' }
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: 'POST',
      headers: { host: 'localhost:8279', origin: 'http://localhost:8279', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } }) as unknown as IncomingMessage
    const writeHead = vi.fn()
    const end = vi.fn()
    const res = { writeHead, end, destroyed: false, writableEnded: false } as unknown as ServerResponse
    await h.service.handle(req, res)
    expect(writeHead).toHaveBeenCalledWith(404, expect.anything())
    expect(JSON.parse(end.mock.calls[0]![0] as string)).toEqual({ schemaVersion: 1, ok: false,
      error: { code: 'TEAM_TASK_NOT_FOUND', message: 'Target task was not found in this Team' } })
  })

  it('rejects injected private fields, cross-task attempts and false retained-history claims in wire values', async () => {
    const value = await harness().service.invoke(request) as SwarmReadTaskDetailV1
    const altered = [
      { ...value, task: { ...value.task, id: 'task-foreign' } },
      { ...value, task: { ...value.task, ownerSessionId: MEMBER } },
      { ...value, attempts: { ...value.attempts, scope: 'complete' } },
      { ...value, attempts: { ...value.attempts, truncated: true } },
      { ...value, attempts: { ...value.attempts, returnedCount: 0 } },
      { ...value, attempts: { ...value.attempts, retainedCount: 0 } },
      { ...value, attempts: { ...value.attempts, entries: [{ ...value.attempts.entries[0]!, taskId: 'task-foreign' }] } },
      { ...value, attempts: { ...value.attempts, entries: [{ ...value.attempts.entries[0]!, memberSessionId: MEMBER }] } },
    ]
    for (const candidate of altered) expect(() => assertSwarmReadRpcValue('taskDetail', candidate)).toThrow()
  })

  it.each([
    { ...request, taskId: '' }, { ...request, taskId: ' '.repeat(2) }, { ...request, taskId: 'x'.repeat(129) },
    { ...request, target: { rootSessionId: ROOT } }, { ...request, taskId: undefined },
    { ...request, afterCursor: `r1:${'a'.repeat(64)}` }, { ...request, ownerSessionId: MEMBER },
  ])('rejects invalid or implicit task selectors before reading (%j)', async input => {
    const h = harness()
    await expect(h.service.invoke(input)).rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
    expect(h.list).not.toHaveBeenCalled()
  })
})
