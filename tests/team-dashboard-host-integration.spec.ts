import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import { AttemptId, TaskId, TeamId, type TeamState } from '../src/domain/types.js'
import { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import type { SwarmReadRpcRequest } from '../src/rpc/read-rpc-contract.js'
import { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { ManualSchedule, waitFor } from './helpers/dashboard-controller.js'

const root = { id: 'captain-real', session: { header: { cwd: 'D:/read-integration' } } } as unknown as Agent
function harness() {
  const team: TeamState = { schemaVersion: 1, id: TeamId('team-real'), name: 'Real projection', description: '', revision: 7, phase: 'active', captainSessionId: root.id,
    members: [], tasks: Array.from({ length: 51 }, (_, index) => ({ id: TaskId(`task-${index}`), subject: `Task ${index}`, description: `Description ${index}`, acceptanceCriteria: [],
      revision: 1, status: index === 0 ? 'in_progress' : 'pending', assignmentMode: 'open-claim', blockedBy: [], writeScopes: [], verification: [], reservationTokens: 0, priority: index,
      ...(index === 0 ? { ownerSessionId: root.id, currentAttemptId: AttemptId('attempt-real') } : {}), createdAt: 1, updatedAt: 2 })),
    attempts: [{ id: AttemptId('attempt-real'), taskId: TaskId('task-0'), memberSessionId: root.id, generation: 1, phase: 'running', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 2 }],
    messages: [], memory: [], usageCursors: {}, budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 }, nextTaskNumber: 52, nextMemoryNumber: 1, createdAt: 1, updatedAt: 2 }
  let visible = true, legacy = false, rejectVersion: string | undefined, breakSnapshot: 'target' | 'transport' | 'schema' | undefined
  const teams = async () => visible ? [team] : []
  const host = new AgentSwarmHostReadService({ currentInitiator: () => root, isExactLiveRoot: value => value === root, scopeOf: () => root.session.header.cwd!, teams,
    domain: () => { throw new Error('Reads must use the authoritative aggregate') }, now: () => 10,
    overlay: { list: () => [{ schemaVersion: 1, scope: root.session.header.cwd!, request: { schemaVersion: 1, requestId: 'human-real', teamId: team.id,
      source: { kind: 'captain-mediated', captainSessionId: root.id }, target: { kind: 'team' }, intent: 'message', body: 'Question', expectedTeamRevision: 7, createdAt: 1 },
      receipt: { requestId: 'human-real', teamId: team.id, status: 'pending', updatedAt: 2 }, createdAt: 1, updatedAt: 2 }] } })
  const ctx = { agents: { get: (id: string) => id === root.id ? root : undefined, roots: () => [root] },
    sessions: { get: (id: string) => id === root.id ? root.session : undefined } } as unknown as Context
  const runtime = { listTeamAggregates: teams, managedCaptainSessionsOf: () => [], scopeOf: () => root.session.header.cwd! } as unknown as AgentSwarmRuntime
  const service = new AgentSwarmReadRpcService({ ctx, runtime, hostRead: host, webServer: { host: '127.0.0.1', port: 8279, register: () => () => {} } })
  const seen: SwarmReadRpcRequest[] = []
  const client = new SwarmReadClient(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as SwarmReadRpcRequest; seen.push(request)
    if (request.method === 'snapshot' && request.schemaVersion === 2) {
      if (breakSnapshot === 'target') visible = false
      if (breakSnapshot === 'transport') throw new Error('Transport lost')
    }
    // Only the legacy version gate is emulated; every admitted read uses the real Host, RPC parser and projection.
    if (request.schemaVersion === 2 && (legacy || rejectVersion !== undefined)) return new Response(JSON.stringify({ schemaVersion: 1, ok: false,
      error: { code: rejectVersion ?? 'SWARM_RPC_INVALID_REQUEST', message: 'Swarm RPC request is invalid' } }), { status: 400 })
    let status = 0, body = ''
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(request))]), { method: 'POST', headers: { host: 'localhost:8279', origin: 'http://localhost:8279', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } }) as unknown as IncomingMessage
    const res = { writeHead: (code: number) => { status = code }, end: (value: string) => { body = value }, destroyed: false, writableEnded: false } as unknown as ServerResponse
    await service.handle(req, res)
    if (request.method === 'snapshot' && breakSnapshot === 'schema') {
      const invalid = JSON.parse(body) as { value: { schemaVersion: number } }; invalid.value.schemaVersion = 999; body = JSON.stringify(invalid)
    }
    return new Response(body, { status })
  })
  const controller = new TeamDashboardController(client, new ManualSchedule())
  return { host, service, controller, seen, setLegacy: (value: boolean) => { legacy = value }, rejectVersion: (code: string) => { rejectVersion = code },
    breakSnapshot: (mode: 'target' | 'transport' | 'schema') => { breakSnapshot = mode }, dispose: async () => { controller.dispose(); await service.dispose(); await host.dispose() } }
}

it('loads real v2 Host cursors with two task pages and same-cut nonempty attempts/interactions', async () => {
  const h = harness()
  try {
    const target = { rootSessionId: root.id, teamId: 'team-real' }
    const legacy = await h.service.invoke({ schemaVersion: 1, method: 'snapshot', target })
    const modern = await h.service.invoke({ schemaVersion: 2, method: 'snapshot', target })
    expect('cursor' in legacy && 'cursor' in modern && legacy.cursor !== modern.cursor).toBe(true)
    h.controller.open(root.id); await waitFor(() => ['ready', 'error'].includes(h.controller.getSnapshot().phase))
    expect(h.controller.getSnapshot().error).toBeUndefined()
    const projection = h.controller.getSnapshot().data!.projection
    expect(projection.schemaVersion).toBe(2); expect(projection.tasks).toHaveLength(51)
    expect(projection.attempts).toHaveLength(1); expect(projection.pendingInteractions).toHaveLength(1)
    expect(projection.tasks.every(task => task.assignmentMode === 'open-claim')).toBe(true)
    const pages = h.seen.filter(request => request.method === 'page')
    expect(pages).toHaveLength(2)
    expect(pages.every(request => request.schemaVersion === 2 && request.page.kind === 'tasks' && request.afterCursor === projection.cursor)).toBe(true)
    const detail = await h.controller.readTaskDetail({ targetSessionId: root.id, binding: projection.binding, taskId: 'task-0', cursor: projection.cursor, teamRevision: projection.team.revision }, new AbortController().signal)
    expect(detail.schemaVersion).toBe(2)
  } finally { await h.dispose() }
})

it('falls back only at an explicit legacy version rejection and reads every later page/detail as v1', async () => {
  const h = harness(); h.setLegacy(true)
  try {
    h.controller.open(root.id); await waitFor(() => ['ready', 'error'].includes(h.controller.getSnapshot().phase))
    expect(h.controller.getSnapshot().error).toBeUndefined()
    const projection = h.controller.getSnapshot().data!.projection
    expect(projection.schemaVersion).toBe(1); expect(projection.tasks).toHaveLength(51)
    expect(h.seen.filter(request => request.method === 'page').every(request => request.schemaVersion === 1 && request.afterCursor === projection.cursor)).toBe(true)
    const detail = await h.controller.readTaskDetail({ targetSessionId: root.id, binding: projection.binding, taskId: 'task-0', cursor: projection.cursor, teamRevision: projection.team.revision }, new AbortController().signal)
    expect(detail.schemaVersion).toBe(1)
  } finally { await h.dispose() }
})

it('does not downgrade an authorization failure into a legacy retry', async () => {
  const h = harness(); h.rejectVersion('SWARM_RPC_FORBIDDEN')
  try {
    h.controller.open(root.id); await waitFor(() => h.controller.getSnapshot().phase === 'error')
    expect(h.controller.getSnapshot().error?.code).toBe('SWARM_RPC_FORBIDDEN')
    expect(h.seen.filter(request => request.method === 'snapshot')).toHaveLength(1)
  } finally { await h.dispose() }
})

it.each(['target', 'transport', 'schema'] as const)('does not downgrade a %s failure', async mode => {
  const h = harness(); h.breakSnapshot(mode)
  try {
    h.controller.open(root.id); await waitFor(() => h.controller.getSnapshot().phase === 'error')
    expect(h.controller.getSnapshot().error).toBeDefined()
    expect(h.seen.filter(request => request.method === 'snapshot')).toHaveLength(1)
    expect(h.seen.filter(request => request.method === 'page')).toHaveLength(0)
  } finally { await h.dispose() }
})

it('does not reuse a cursor when switching between real v2 and legacy v1 snapshots', async () => {
  const h = harness()
  try {
    h.controller.open(root.id); await waitFor(() => h.controller.getSnapshot().phase === 'ready')
    h.setLegacy(true); h.seen.length = 0; h.controller.refresh()
    await waitFor(() => h.controller.getSnapshot().phase === 'ready')
    expect(h.controller.getSnapshot().data?.projection.schemaVersion).toBe(1)
    const downgraded = h.seen.find(request => request.method === 'snapshot' && request.schemaVersion === 1)
    expect(downgraded).toBeDefined(); expect(downgraded).not.toHaveProperty('afterCursor')
    h.setLegacy(false); h.seen.length = 0; h.controller.refresh()
    await waitFor(() => h.controller.getSnapshot().phase === 'ready')
    expect(h.controller.getSnapshot().data?.projection.schemaVersion).toBe(2)
    const upgraded = h.seen.find(request => request.method === 'snapshot' && request.schemaVersion === 2)
    expect(upgraded).toBeDefined(); expect(upgraded).not.toHaveProperty('afterCursor')
  } finally { await h.dispose() }
})
