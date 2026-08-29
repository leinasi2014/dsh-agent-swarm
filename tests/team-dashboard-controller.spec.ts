import { describe, expect, it } from 'vitest'
import { TeamDashboardController, type TeamDashboardSchedule } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient, type SwarmFetch } from '../src/client/read-client.js'
import type { SwarmReadRpcRequest } from '../src/rpc/read-rpc-contract.js'

const CURSOR = `r1:${'a'.repeat(64)}`
const CHANGED_CURSOR = `r1:${'b'.repeat(64)}`
const binding = {
  binding: { rootSessionId: 'root-1', teamId: 'team-1' },
  team: {
    id: 'team-1', name: 'Alpha', phase: 'active', revision: 4,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000,
  },
  cursor: CURSOR,
  changed: true,
  resyncRequired: false,
} as const
const capabilities = {
  protocol: 'dsh-agent-swarm/read-rpc', version: 1, namespace: '/swarm',
  trust: { mode: 'local-single-user-target-bound', principalBound: false, listener: 'loopback' },
  capabilities: [
    { capability: 'teams.read', state: 'available' },
    { capability: 'binding.read', state: 'available' },
    { capability: 'status.read', state: 'available' },
    { capability: 'snapshot.read', state: 'available' },
    { capability: 'page.read', state: 'available' },
    { capability: 'captainMembers.read', state: 'available' },
    { capability: 'captainAnnouncements.read', state: 'available' },
    { capability: 'captainDiagnostics.read', state: 'available' },
    { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
    { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
    { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  ],
} as const
const projectionCapabilities = [
  { capability: 'snapshot.read', state: 'available' },
  { capability: 'receipt.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
] as const

function task(index: number) {
  return {
    id: `task-${String(index)}`, revision: 1, subject: `Task ${String(index)}`, status: 'pending',
    blockedBy: [], priority: index, createdAt: 1_700_000_000_000 + index, updatedAt: 1_700_000_001_000 + index,
  } as const
}

const tasks = Array.from({ length: 51 }, (_, index) => task(index))
const attempts = [{
  id: 'attempt-1', taskId: 'task-0', generation: 1, memberName: 'worker', phase: 'running',
  assignmentPhase: 'delivered', createdAt: 1_700_000_002_000, updatedAt: 1_700_000_003_000,
}] as const
const interactions = [{
  requestId: 'interaction-1', intent: 'clarify', targetKind: 'captain', status: 'pending',
  createdAt: 1_700_000_004_000, updatedAt: 1_700_000_005_000,
}] as const
const snapshot = {
  schemaVersion: 1,
  ...binding,
  roster: [{ name: 'worker', role: 'implementation', phase: 'active', createdAt: 1_700_000_000_000 }],
  tasks,
  attempts,
  budget: { usedTokens: 12, usedRequests: 2, usedRetries: 0, tokenLimit: 1000 },
  pendingInteractions: interactions,
  totals: { roster: 1, tasks: 51, attempts: 1, pendingInteractions: 1 },
  truncated: { roster: false, tasks: false, attempts: false, pendingInteractions: false },
  capabilities: projectionCapabilities,
  observedAt: 1_700_000_006_000,
} as const
const teams = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1' },
  teams: [{
    teamId: 'team-1', name: 'Alpha', phase: 'active', captainSessionId: 'root-1',
    avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
    identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
    endpoints: {
      members: { method: 'captainMembers', target: { rootSessionId: 'root-1', teamId: 'team-1' } },
      announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root-1', teamId: 'team-1' } },
      diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root-1', teamId: 'team-1' } },
    },
  }],
  observedAt: 1_700_000_006_000,
  complete: true,
} as const

const announcements = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1', teamId: 'team-1' },
  state: 'unavailable', reason: 'notice_board_not_implemented', entries: [],
  observedAt: 1_700_000_006_000,
} as const
const captainDiagnostics = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1', teamId: 'team-1' },
  diagnostics: { revision: 4, phase: 'active', taskCount: 51, attemptCount: 1, memberCount: 1, backend: 'team-domain' },
  observedAt: 1_700_000_006_000,
} as const

class ManualSchedule implements TeamDashboardSchedule {
  readonly pending = new Map<object, () => void>()
  set(_delayMs: number, callback: () => void): object {
    const handle = {}
    this.pending.set(handle, callback)
    return handle
  }
  clear(handle: unknown): void { this.pending.delete(handle as object) }
  fire(): void {
    const callback = this.pending.values().next().value as (() => void) | undefined
    if (callback === undefined) throw new Error('no scheduled callback')
    this.pending.clear()
    callback()
  }
}

function success(value: unknown): Response {
  return Response.json({ schemaVersion: 1, ok: true, value })
}

function requestOf(init: RequestInit | undefined): SwarmReadRpcRequest {
  return JSON.parse(String(init?.body)) as SwarmReadRpcRequest
}

function goodFetch(seen: SwarmReadRpcRequest[], options: { driftFirstTaskPage?: boolean } = {}): SwarmFetch {
  let drifted = false
  return async (_input, init) => {
    const request = requestOf(init)
    seen.push(request)
    if (request.method === 'capabilities') return success(capabilities)
    if (request.method === 'binding') return success(binding)
    if (request.method === 'snapshot') return success(snapshot)
    if (request.method === 'teams') return success(teams)
    if (request.method === 'captainAnnouncements') return success(announcements)
    if (request.method === 'captainDiagnostics') return success(captainDiagnostics)
    if (request.method !== 'page') throw new Error(`unexpected method ${request.method}`)
    const rows = request.page.kind === 'tasks' ? tasks
      : request.page.kind === 'attempts' ? attempts : interactions
    const offset = request.page.offset ?? 0
    const limit = request.page.limit ?? 50
    const entries = rows.slice(offset, offset + limit)
    const nextOffset = offset + entries.length < rows.length ? offset + entries.length : undefined
    const cursor = options.driftFirstTaskPage && request.page.kind === 'tasks' && !drifted
      ? (drifted = true, CHANGED_CURSOR) : CURSOR
    return success({
      kind: request.page.kind,
      entries,
      offset,
      limit,
      visibleTotal: rows.length,
      authoritativeTotal: rows.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      projectionTruncated: false,
      cursor,
      changed: false,
      resyncRequired: cursor !== CURSOR,
      observedAt: 1_700_000_006_000,
    })
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition did not settle')
}

describe('TeamDashboardController', () => {
  it('stays inert until open and loads every strict page without issuing a write', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const schedule = new ManualSchedule()
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen)), schedule)
    expect(seen).toEqual([])

    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')

    const state = controller.getSnapshot()
    expect(state.data?.projection.tasks).toHaveLength(51)
    expect(state.data?.projection.attempts).toEqual(attempts)
    expect(state.data?.projection.pendingInteractions).toEqual(interactions)
    expect(seen.map(request => request.method)).toEqual([
      'capabilities', 'binding', 'snapshot', 'teams', 'captainAnnouncements', 'captainDiagnostics', 'page', 'page', 'page', 'page',
    ])
    expect(seen.every(request => ['capabilities', 'binding', 'snapshot', 'teams', 'captainAnnouncements', 'captainDiagnostics', 'page'].includes(request.method))).toBe(true)
    expect(schedule.pending.size).toBe(1)
    controller.dispose()
  })

  it('discards a mixed-cursor aggregate and restarts once from a fresh snapshot', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen, { driftFirstTaskPage: true })), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(seen.filter(request => request.method === 'snapshot')).toHaveLength(2)
    expect(controller.getSnapshot().data?.projection.tasks).toHaveLength(51)
    controller.dispose()
  })

  it('rejects a stable row id repeated across otherwise canonical pages', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      const response = await normal(input, init)
      if (request.method !== 'page' || request.page.kind !== 'tasks' || request.page.offset !== 50) return response
      const envelope = await response.json() as { value: Record<string, unknown> }
      return success({ ...envelope.value, entries: [tasks[0]] })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'error')
    expect(controller.getSnapshot().error?.code).toBe('SWARM_UI_PAGE_INVALID')
    controller.dispose()
  })

  it('rejects a page total that exceeds or drifts from the frozen snapshot ceiling', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      const response = await normal(input, init)
      if (request.method !== 'page' || request.page.kind !== 'tasks' || request.page.offset !== 0) return response
      const envelope = await response.json() as { value: Record<string, unknown> }
      return success({ ...envelope.value, visibleTotal: 101, authoritativeTotal: 101, nextOffset: 50 })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'error')
    expect(controller.getSnapshot().error?.code).toBe('SWARM_UI_PAGE_INVALID')
    controller.dispose()
  })

  it('keeps the last complete projection stale after a reconnect failure', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const schedule = new ManualSchedule()
    let fail = false
    const fetcher: SwarmFetch = async (input, init) => {
      if (fail) throw new Error('offline')
      return goodFetch(seen)(input, init)
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), schedule)
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    fail = true
    controller.connectionReset()
    schedule.fire()
    await waitFor(() => controller.getSnapshot().phase === 'stale')
    expect(controller.getSnapshot().data?.projection.team.id).toBe('team-1')
    expect(controller.getSnapshot().error?.code).toBe('SWARM_UI_READ_FAILED')
    controller.dispose()
  })

  it('aborts an admitted read when the panel closes', async () => {
    let aborted = false
    const fetcher: SwarmFetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await Promise.resolve()
    controller.close()
    await waitFor(() => aborted)
    expect(controller.getSnapshot()).toEqual({ open: false, phase: 'closed' })
    controller.dispose()
  })

  it('drives a role>256 roster to ready, not the SWARM_UI_READ_FAILED fallback, and never truncates the authoritative role', async () => {
    const longRole = '开发 writer（仅负责本 P0）：修复 SWARM_UI_READ_FAILED。在受管 lane p0-swarm-ui-read-v2（pnpm isolation open，owner terra-p0）内实施：契约一致（role 上限有界提升并同步 CONTRACT_DIGEST）'.repeat(6)
    expect(longRole.length).toBeGreaterThan(256)
    const longRoleSnapshot = {
      ...snapshot,
      roster: [{ name: 'worker', role: longRole, phase: 'active', createdAt: 1_700_000_000_000 }],
    }
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      if (request.method === 'snapshot') return success(longRoleSnapshot)
      if (request.method !== 'page') return normal(input, init)
      const rows = request.page.kind === 'tasks' ? tasks : request.page.kind === 'attempts' ? attempts : interactions
      const offset = request.page.offset ?? 0
      const limit = request.page.limit ?? 50
      const entries = rows.slice(offset, offset + limit)
      const nextOffset = offset + entries.length < rows.length ? offset + entries.length : undefined
      return success({
        kind: request.page.kind, entries, offset, limit,
        visibleTotal: rows.length, authoritativeTotal: rows.length,
        ...(nextOffset === undefined ? {} : { nextOffset }),
        projectionTruncated: false, cursor: CURSOR, changed: false, resyncRequired: false,
        observedAt: 1_700_000_006_000,
      })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const state = controller.getSnapshot()
    // No fallback to the generic read-failed signal and no swallowed error.
    expect(state.phase).toBe('ready')
    expect(state.error).toBeUndefined()
    // The authoritative role reaches the consumer un-truncated.
    expect(state.data?.projection.roster[0]?.role).toBe(longRole)
    controller.dispose()
  })

  it('revalidates the exact binding immediately before official Captain navigation', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen)), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const opened: string[] = []
    await controller.openCaptainChat(rootSessionId => opened.push(rootSessionId))
    expect(opened).toEqual(['root-1'])
    expect(seen.at(-1)?.method).toBe('binding')
    expect(controller.getSnapshot().phase).toBe('closed')
    controller.dispose()
  })

  it('fails closed when the Captain binding changes before handoff', async () => {
    const seen: SwarmReadRpcRequest[] = []
    let handoff = false
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      if (handoff && request.method === 'binding') {
        return success({
          ...binding,
          binding: { rootSessionId: 'root-1', teamId: 'team-2' },
          team: { ...binding.team, id: 'team-2', name: 'Other Team' },
        })
      }
      return normal(input, init)
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    handoff = true
    const opened: string[] = []
    await expect(controller.openCaptainChat(rootSessionId => opened.push(rootSessionId))).rejects.toThrow('changed')
    expect(opened).toEqual([])
    expect(controller.getSnapshot().phase).toBe('stale')
    controller.dispose()
  })
})
