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
import type { SwarmReadTaskDetailV2 } from '../src/rpc/read-rpc-contract.js'
import { SWARM_READ_RPC_CONTRACT_V1, SWARM_READ_RPC_CONTRACT_DIGEST_V1 } from '../src/rpc/read-rpc-artifact-schema.js'
import { canonicalSwarmReadRpcJson } from '../src/rpc/read-rpc-artifact.js'
import { createHash } from 'node:crypto'
import { SWARM_READ_RPC_FIXTURES_V1, SWARM_READ_RPC_FIXTURES_V2 } from '../src/rpc/read-rpc-artifact-fixtures.js'

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
  it('opts into v2 task facts without widening the strict v1 wire', async () => {
    const team = teamState()
    Object.assign(team.tasks[0]!, { assignmentMode: 'open-claim', createdBySessionId: CAPTAIN,
      source: { workRequestId: 'request-1', itemKey: 'design', origin: { kind: 'main', sessionId: ROOT } },
      submittedAt: 50, submittedBySessionId: MEMBER, reviewedAt: 60, reviewedBySessionId: CAPTAIN })
    Object.assign(team.attempts[0]!, { submittedAt: 50, submittedBySessionId: MEMBER, reviewedAt: 60, reviewedBySessionId: CAPTAIN })
    const h = harness(team)
    const legacy = await h.service.invoke(request)
    expect(() => assertSwarmReadRpcValue('taskDetail', legacy)).not.toThrow()
    expect(JSON.stringify(legacy)).not.toContain('submittedAt')
    expect(JSON.stringify(legacy)).not.toContain('assignmentMode')
    const detail = await h.service.invoke({ ...request, schemaVersion: 2 })
    expect(detail).toMatchObject({ schemaVersion: 2, task: { assignmentMode: 'open-claim', readiness: 'not-pending',
      ownerSessionId: MEMBER, createdBySessionId: CAPTAIN, source: team.tasks[0]!.source,
      submittedAt: 50, submittedBySessionId: MEMBER, reviewedAt: 60, reviewedBySessionId: CAPTAIN },
      attempts: { entries: [{ submittedAt: 50, submittedBySessionId: MEMBER, reviewedAt: 60, reviewedBySessionId: CAPTAIN }] } })
    expect(() => assertSwarmReadRpcValue('taskDetail', detail)).not.toThrow()
    const snapshot = await h.service.invoke({ schemaVersion: 2, method: 'snapshot', target })
    expect(snapshot).toMatchObject({ schemaVersion: 2, tasks: [{ assignmentMode: 'open-claim', readiness: 'not-pending' }] })
    expect(() => assertSwarmReadRpcValue('snapshot', snapshot)).not.toThrow()
    expect(JSON.stringify(snapshot)).not.toContain('submittedAt')
    const page = await h.service.invoke({ schemaVersion: 2, method: 'page', target, page: { kind: 'tasks' } })
    expect(page).toMatchObject({ schemaVersion: 2, kind: 'tasks', entries: [{ assignmentMode: 'open-claim' }] })
    expect(() => assertSwarmReadRpcValue('page', page)).not.toThrow()
  })

  it('v2 defaults old task policy and leaves unrecorded creation and event identities absent', async () => {
    const detail = await harness().service.invoke({ ...request, schemaVersion: 2 })
    expect(detail).toMatchObject({ schemaVersion: 2, task: { assignmentMode: 'automatic' } })
    for (const key of ['createdBySessionId', 'source', 'submittedAt', 'submittedBySessionId', 'reviewedAt', 'reviewedBySessionId']) {
      expect(JSON.stringify(detail)).not.toContain(`"${key}"`)
    }
  })

  it.each(['status', 'binding', 'teams', 'capabilities'])('does not implicitly version unrelated %s methods', async method => {
    await expect(harness().service.invoke({ schemaVersion: 2, method, target })).rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
  })

  it('keeps the frozen v1 artifact identity and rejects v2-only fields tagged as v1', async () => {
    expect(createHash('sha256').update(canonicalSwarmReadRpcJson({ contract: SWARM_READ_RPC_CONTRACT_V1,
      fixtures: SWARM_READ_RPC_FIXTURES_V1 })).digest('hex')).toBe(SWARM_READ_RPC_CONTRACT_DIGEST_V1)
    for (const [method, value] of Object.entries(SWARM_READ_RPC_FIXTURES_V2.values)) {
      expect(() => assertSwarmReadRpcValue(method, value)).not.toThrow()
    }
    const h = harness()
    for (const method of ['snapshot', 'page', 'taskDetail']) {
      const input = { schemaVersion: 2, method, target, ...(method === 'taskDetail' ? { taskId: 'task-1' } : {}),
        ...(method === 'page' ? { page: { kind: 'tasks' } } : {}) }
      const value = await h.service.invoke(input)
      expect(() => assertSwarmReadRpcValue(method, { ...value, schemaVersion: 1 })).toThrow()
    }
    await expect(h.service.invoke({ schemaVersion: 2, method: 'page', target, page: { kind: 'attempts' } }))
      .rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
  })

  it('computes v2 readiness from the whole board and current budget even when a dependency is outside the visible window', async () => {
    const team = teamState(), task = team.tasks[0]!
    Object.assign(task, { status: 'pending', ownerSessionId: undefined, targetMemberSessionId: undefined,
      currentAttemptId: undefined, assignmentMode: 'open-claim', blockedBy: [TaskId('hidden-dependency')], updatedAt: 999 })
    const dependency = { ...task, id: TaskId('hidden-dependency'), blockedBy: [], status: 'completed' as const, updatedAt: 0 }
    team.tasks.push(dependency)
    for (let index = 0; index < 100; index++) team.tasks.push({ ...dependency, id: TaskId(`other-${index}`), updatedAt: 10 })
    const h = harness(team)
    const read = async () => await h.service.invoke({ schemaVersion: 2, method: 'snapshot', target })
    const ready = await read()
    expect(ready).toMatchObject({ tasks: [expect.objectContaining({ id: task.id, readiness: 'ready' }), ...Array.from({ length: 99 }, () => expect.anything())], truncated: { tasks: true } })
    expect(JSON.stringify(ready)).not.toContain('"id":"hidden-dependency"')
    Object.assign(dependency, { status: 'pending' })
    expect(await read()).toMatchObject({ tasks: [expect.objectContaining({ readiness: 'blocked' }), ...Array.from({ length: 99 }, () => expect.anything())] })
    Object.assign(dependency, { status: 'completed' })
    Object.assign(team.budget, { tokenLimit: 22 })
    expect(await h.service.invoke({ ...request, schemaVersion: 2 })).toMatchObject({ task: { readiness: 'budget-hold' } })
    Object.assign(team.budget, { tokenLimit: 100, requestLimit: 0 })
    expect(await h.service.invoke({ ...request, schemaVersion: 2 })).toMatchObject({ task: { readiness: 'budget-hold' } })
    Object.assign(team.budget, { requestLimit: 100, deadlineAt: 1 })
    expect(await h.service.invoke({ ...request, schemaVersion: 2 })).toMatchObject({ task: { readiness: 'budget-hold' } })
    Object.assign(team.budget, { deadlineAt: undefined })
    Object.assign(team, { phase: 'archived' })
    expect(await h.service.invoke({ ...request, schemaVersion: 2 })).toMatchObject({ task: { readiness: 'team-inactive' } })
  })

  it('v2 cursor includes policy and readiness without changing a legacy cursor', async () => {
    const team = teamState(), h = harness(team)
    const input = { schemaVersion: 2, method: 'snapshot', target }
    const first = await h.service.invoke(input) as { cursor: string }
    expect(await h.service.invoke({ ...input, afterCursor: first.cursor })).toMatchObject({ changed: false, resyncRequired: false })
    const legacy = await h.service.invoke({ ...input, schemaVersion: 1 }) as { cursor: string }
    Object.assign(team.tasks[0]!, { assignmentMode: 'open-claim' })
    expect(await h.service.invoke({ ...input, afterCursor: first.cursor })).toMatchObject({ changed: true, resyncRequired: true })
    expect(await h.service.invoke({ ...input, schemaVersion: 1, afterCursor: legacy.cursor })).toMatchObject({ changed: false })
  })

  it('copies source identity and rejects unallowlisted v2 data and cross-task facts', async () => {
    const team = teamState()
    Object.assign(team.tasks[0]!, { source: { workRequestId: 'request-1', itemKey: 'item', origin: { kind: 'local-operator' } } })
    const result = await harness(team).service.invoke({ ...request, schemaVersion: 2 }) as SwarmReadTaskDetailV2
    expect(result.task.source).toEqual(team.tasks[0]!.source)
    expect(Object.isFrozen(result.task.source!.origin)).toBe(true)
    expect(Object.isFrozen(team.tasks[0]!.source)).toBe(false)
    for (const task of [
      { ...result.task, privateMemory: 'private' },
      { ...result.task, source: { ...result.task.source, origin: { kind: 'local-operator', sessionId: CAPTAIN } } },
      { ...result.task, readiness: 'paused' },
    ]) expect(() => assertSwarmReadRpcValue('taskDetail', { ...result, task })).toThrow()
    expect(() => assertSwarmReadRpcValue('taskDetail', { ...result, attempts: { ...result.attempts,
      entries: result.attempts.entries.map(row => ({ ...row, taskId: 'foreign-task' })) } })).toThrow()
  })

  it('v2 shows only the actual recorded review provider and keeps it absent from v1', async () => {
    const team = teamState(), h = harness(team)
    const first = await h.service.invoke({ ...request, schemaVersion: 2 }) as SwarmReadTaskDetailV2
    expect(first.attempts.entries[0]).not.toHaveProperty('reviewProvider')
    Object.assign(team.attempts[0]!, { reviewProvider: 'actual-selected-review' })
    const recorded = await h.service.invoke({ ...request, schemaVersion: 2 }) as SwarmReadTaskDetailV2
    expect(recorded.attempts.entries[0]).toHaveProperty('reviewProvider', 'actual-selected-review')
    expect(() => assertSwarmReadRpcValue('taskDetail', recorded)).not.toThrow()
    expect((await h.service.invoke(request) as SwarmReadTaskDetailV1).attempts.entries[0]).not.toHaveProperty('reviewProvider')
  })

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

  it('projects the latest selected task after asynchronous ancestry checks', async () => {
    const h = harness()
    const latest = { ...h.teams[0]!, revision: 10,
      tasks: h.teams[0]!.tasks.map(task => ({ ...task, revision: task.revision + 1, description: 'Updated while reading' })) }
    h.list.mockResolvedValueOnce(h.teams).mockResolvedValue([latest])
    await expect(h.service.invoke(request)).resolves.toMatchObject({ teamRevision: 10,
      task: { revision: 4, description: 'Updated while reading' } })
  })

  it('rejects a replaced Captain after asynchronous ancestry checks', async () => {
    const h = harness()
    h.list.mockResolvedValueOnce(h.teams).mockResolvedValue([{ ...h.teams[0]!, captainSessionId: 'other-captain' }])
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
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

  it.each(['removed', 'retried', 'source-captain-replaced', 'main-replaced'] as const)(
    'never returns sibling detail after %s during a late aggregate read', async change => {
      // Exercise both late scan boundaries. Eliminating an extra await is
      // valid: a transition scheduled at that absent boundary never happened.
      for (const transitionScan of [3, 4]) {
        const h = harness()
        const member = { id: MEMBER, session: { header: { cwd: 'D:/detail', parentSession: CAPTAIN } } } as unknown as Agent
        const siblingCaptain = { id: 'sibling-captain', session: { header: { cwd: 'D:/detail', parentSession: ROOT } } } as unknown as Agent
        for (const agent of [member, siblingCaptain]) {
          h.agents.set(agent.id, agent)
          h.sessions.set(agent.id, agent.session)
        }
        h.teams.push({ ...teamState(), id: TeamId('sibling-team'), captainSessionId: siblingCaptain.id })
        let transitioned = false
        let scans = 0
        h.list.mockImplementation(async () => {
          if (++scans === transitionScan) {
            transitioned = true
            if (change === 'removed' || change === 'retried') {
              const source = h.teams[0]!
              h.teams[0] = { ...source, revision: source.revision + 1, members: source.members.map(row => ({
                ...row, ...(change === 'removed' ? { phase: 'removed' as const } : { sessionId: 'replacement-member' }),
              })) }
            } else {
              const id = change === 'main-replaced' ? ROOT : CAPTAIN
              h.sessions.set(id, { ...h.sessions.get(id)! } as Agent['session'])
            }
          }
          return [...h.teams]
        })
        const outcome = await h.service.invoke({ ...request, target: { rootSessionId: MEMBER, teamId: 'sibling-team' } })
          .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
        if (transitioned) {
          expect(outcome, `changed authority at scan ${transitionScan} must reject`).toMatchObject({ ok: false,
            error: { code: expect.stringMatching(/^SWARM_(HOST_BINDING_MISMATCH|RPC_TARGET_NOT_LIVE)$/) } })
        } else {
          expect(outcome).toMatchObject({ ok: true, value: { binding: { rootSessionId: 'sibling-captain', teamId: 'sibling-team' } } })
        }
      }
    },
  )

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

  it('keeps a Domain-valid 512-byte title readable through the snapshot and page before opening detail', async () => {
    const team = teamState(), subject = 's'.repeat(512)
    Object.assign(team.tasks[0]!, { subject })
    const h = harness(team)
    const snapshot = await h.service.invoke({ schemaVersion: 1, method: 'snapshot', target })
    expect(() => assertSwarmReadRpcValue('snapshot', snapshot)).not.toThrow()
    expect(snapshot).toMatchObject({ tasks: [{ subject }] })
    const page = await h.service.invoke({ schemaVersion: 1, method: 'page', target,
      page: { kind: 'tasks', offset: 0, limit: 10 } })
    expect(() => assertSwarmReadRpcValue('page', page)).not.toThrow()
    expect(page).toMatchObject({ entries: [{ subject }] })
    expect(await h.service.invoke(request)).toMatchObject({ task: { subject } })
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
