import type { TeamDashboardSchedule } from '../../src/client/team-dashboard-controller.js'
import type { SwarmFetch } from '../../src/client/read-client.js'
import type { SwarmReadRpcRequest } from '../../src/rpc/read-rpc-contract.js'

export const CURSOR = `r1:${'a'.repeat(64)}`
const CHANGED_CURSOR = `r1:${'b'.repeat(64)}`
export const binding = {
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
    { capability: 'toolCatalog.read', state: 'available' },
    { capability: 'skillCatalog.read', state: 'available' },
    { capability: 'teams.read', state: 'available' },
    { capability: 'binding.read', state: 'available' },
    { capability: 'status.read', state: 'available' },
    { capability: 'snapshot.read', state: 'available' },
    { capability: 'page.read', state: 'available' },
    { capability: 'captainMembers.read', state: 'available' },
    { capability: 'captainAnnouncements.read', state: 'available' },
    { capability: 'captainDiagnostics.read', state: 'available' },
    { capability: 'taskDetail.read', state: 'available' },
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

export const tasks = Array.from({ length: 51 }, (_, index) => task(index))
export const attempts = [{
  id: 'attempt-1', taskId: 'task-0', generation: 1, memberName: 'worker', phase: 'running',
  assignmentPhase: 'delivered', createdAt: 1_700_000_002_000, updatedAt: 1_700_000_003_000,
}] as const
export const interactions = [{
  requestId: 'interaction-1', intent: 'clarify', targetKind: 'captain', status: 'pending',
  createdAt: 1_700_000_004_000, updatedAt: 1_700_000_005_000,
}] as const
export const snapshot = {
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
export const teams = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1' },
  teams: [{
    teamId: 'team-1', name: 'Alpha', phase: 'active', captainSessionId: 'root-1',
    avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
    identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
    goal: { state: 'not_generated', reason: 'goal_not_set' },
    endpoints: {
      members: { method: 'captainMembers', target: { rootSessionId: 'root-1', teamId: 'team-1' } },
      announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root-1', teamId: 'team-1' } },
      diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root-1', teamId: 'team-1' } },
    },
  }],
  observedAt: 1_700_000_006_000,
  complete: true,
} as const

export const announcements = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1', teamId: 'team-1' },
  state: 'available',
  entries: [{ id: 'ann-00000000-0000-0000-0000-000000000001', text: 'Team notice', createdAt: 1_700_000_005_000 }],
  observedAt: 1_700_000_006_000,
} as const
export const captainDiagnostics = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1', teamId: 'team-1' },
  diagnostics: { revision: 4, phase: 'active', taskCount: 51, attemptCount: 1, memberCount: 1, backend: 'team-domain' },
  observedAt: 1_700_000_006_000,
} as const

export const captainMembers = {
  schemaVersion: 1,
  binding: { rootSessionId: 'root-1', teamId: 'team-1' },
  members: [{
    name: 'worker', role: 'implementation', phase: 'active', createdAt: 1_700_000_000_000,
    avatar: { state: 'generated', svg: '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
    identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
    composition: {
      state: 'available', reason: 'available', runtimeProvider: 'spawn',
      llmProvider: 'mock', model: 'worker-model', personaConfigured: true,
      deniedTools: ['agent_swarm_create_managed'],
    },
    growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
  }],
  observedAt: 1_700_000_006_000,
} as const

export class ManualSchedule implements TeamDashboardSchedule {
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

export function success(value: unknown): Response {
  return Response.json({ schemaVersion: 1, ok: true, value })
}

export function requestOf(init: RequestInit | undefined): SwarmReadRpcRequest {
  return JSON.parse(String(init?.body)) as SwarmReadRpcRequest
}

export function goodFetch(seen: SwarmReadRpcRequest[], options: { driftFirstTaskPage?: boolean } = {}): SwarmFetch {
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
    if (request.method === 'captainMembers') return success(captainMembers)
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

export async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition did not settle')
}
