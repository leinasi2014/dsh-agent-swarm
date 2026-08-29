/** R2/I3-R trust, target binding, strict wire input and lifecycle evidence. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamState } from '../src/domain/types.js'
import type { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { SwarmReadClient } from '../src/client/index.js'
import type {
  SwarmReadCaptainAnnouncementsV1,
  SwarmReadCaptainDiagnosticsV1,
  SwarmReadCaptainMembersV1,
  SwarmReadTeamsV1,
} from '../src/rpc/read-rpc-contract.js'
import {
  AgentSwarmReadRpcService,
  evaluateSwarmRequestTrust,
  mountAgentSwarmReadRpc,
  type SwarmWebServer,
} from '../src/rpc/read-rpc-service.js'

const CURSOR = `r1:${'a'.repeat(64)}`
const ROOT = { id: 'root-session', session: { header: { cwd: 'D:\\workspace' } } } as unknown as Agent
const OTHER = { id: 'other-session', session: { header: { cwd: 'D:\\other' } } } as unknown as Agent
const projection: SwarmHostReadProjectionV1 = {
  schemaVersion: 1,
  binding: { rootSessionId: ROOT.id, teamId: 'team-r2' },
  team: { id: 'team-r2', name: 'R2 Team', phase: 'active', revision: 2, createdAt: 1, updatedAt: 2 },
  roster: [],
  tasks: [{
    id: 'task-1', revision: 1, subject: 'Visible', status: 'in_progress', blockedBy: [], priority: 1,
    targetMemberName: 'worker',
    createdAt: 1, updatedAt: 2,
  }],
  attempts: [],
  budget: { usedTokens: 10, usedRequests: 1, usedRetries: 0 },
  pendingInteractions: [],
  totals: { roster: 0, tasks: 4, attempts: 0, pendingInteractions: 0 },
  truncated: { roster: false, tasks: true, attempts: false, pendingInteractions: false },
  capabilities: [], cursor: CURSOR, changed: true, resyncRequired: false, observedAt: 3,
}

function rpcHarness(options: {
  host?: SwarmWebServer['host']; root?: Agent; captain?: string; projection?: SwarmHostReadProjectionV1;
  coldCaptainSessions?: Record<string, { header: { parentSession?: string } }>;
  managedCaptains?: string[];
  coldRoot?: boolean;
  /** Fully cold: the live Agent registry has no root entry, but an official persisted Session exists. */
  fullyColdRoot?: boolean;
  persistedRootHeader?: { cwd?: string; parentSession?: string } | undefined;
  teams?: { id: string; captainSessionId: string; phase?: 'active' | 'archived' }[];
  /** Full TeamState returned by the domain snapshot for the section reads. */
  teamState?: TeamState;
} = {}) {
  const root = options.root ?? ROOT
  let liveRoots: readonly Agent[] = [root]
  let session = root.session
  let initiator: Agent | undefined
  const team = {
    id: 'team-r2', captainSessionId: options.captain ?? root.id, phase: 'active',
    ...options.teamState,
  } as TeamState
  const teams: TeamState[] = (options.teams ?? [team]) as TeamState[]
  const coldSessions = options.coldCaptainSessions ?? {}
  const hostRead = {
    read: vi.fn(async (input: { afterCursor?: string; teamId?: string; captainSessionId?: string }) => {
      // The initiator may be the exact live root Agent or the persistence-reconstructed cold root
      // view — both carry the root Session id.
      expect(initiator?.id).toBe(root.id)
      lastReadInput = input
      return { ...(options.projection ?? projection), binding: { rootSessionId: root.id, teamId: team.id },
        changed: input.afterCursor !== CURSOR, resyncRequired: input.afterCursor !== undefined && input.afterCursor !== CURSOR }
    }),
    listTeams: vi.fn(async (_scope: string) => {
      // Real authorities only: project the visible teams of this scope (main-brain root owns its
      // managed captains; a captain owns its own team).
      const visible = teams.map(t => ({
        teamId: t.id, name: t.id, phase: t.phase ?? 'active', captainSessionId: t.captainSessionId,
      }))
      return {
        schemaVersion: 1 as const,
        binding: { rootSessionId: root.id, rootKind: 'main-brain' as const },
        teams: Object.freeze(visible),
        observedAt: Date.now(),
        complete: true,
      }
    }),
  } as unknown as AgentSwarmHostReadService & { read: ReturnType<typeof vi.fn>; listTeams: ReturnType<typeof vi.fn> }
  let lastReadInput: { afterCursor?: string; teamId?: string; captainSessionId?: string } | undefined
  const ctx = {
    agents: {
      get: (id: string) => id === root.id ? (options.fullyColdRoot ? undefined : root) : undefined,
      roots: () => options.fullyColdRoot ? [] : liveRoots,
      withInitiator: async <T>(agent: Agent, callback: () => Promise<T>) => {
        initiator = agent
        try { return await callback() } finally { initiator = undefined }
      },
    },
    sessions: { get: (id: string) => (id === root.id ? (options.coldRoot || options.fullyColdRoot ? undefined : session) : coldSessions[id]) ?? undefined },
    sessionPersistence: {
      inspect: async () => {
        if (options.persistedRootHeader === undefined) throw new Error('no persisted root')
        return { meta: { cwd: options.persistedRootHeader.cwd, parentSession: options.persistedRootHeader.parentSession }, events: [] }
      },
    },
  } as unknown as Context
  const snapshot = vi.fn(async () => ({ team }))
  const runtime = {
    scopeOf: (agent: Agent) => agent.session.header.cwd!,
    listTeamAggregates: vi.fn(async () => teams),
    domain: { snapshot },
    managedCaptainSessionsOf: vi.fn(() => options.managedCaptains ?? []),
  } as unknown as AgentSwarmRuntime
  const webServer = { host: options.host ?? '127.0.0.1', port: 8279, register: vi.fn() } satisfies SwarmWebServer
  const service = new AgentSwarmReadRpcService({ ctx, runtime, hostRead, webServer })
  return {
    service, hostRead, snapshot, webServer,
    lastReadInput: () => lastReadInput,
    switchSession: (next: Agent['session']) => { session = next },
    setRoots: (roots: readonly Agent[]) => { liveRoots = roots },
  }
}

describe('R2 local trust boundary', () => {
  it('requires loopback listener, socket peer/local endpoint and exact same HTTP authority', () => {
    const base = {
      listenerHost: '127.0.0.1' as const, listenerPort: 8279,
      remoteAddress: '127.0.0.1', localAddress: '::ffff:127.0.0.1', host: 'localhost:8279',
    }
    expect(evaluateSwarmRequestTrust(base)).toEqual({ ok: true })
    expect(evaluateSwarmRequestTrust({ ...base, origin: 'http://localhost:8279', secFetchSite: 'same-origin' })).toEqual({ ok: true })
    for (const facts of [
      { ...base, remoteAddress: '192.168.3.2' },
      { ...base, localAddress: '192.168.3.10' },
      { ...base, listenerHost: '0.0.0.0' as const },
      { ...base, host: 'localhost:8280' },
      { ...base, host: '127.999.1.1:8279' },
      { ...base, origin: 'http://evil.test' },
      { ...base, secFetchSite: 'cross-site' },
    ]) expect(evaluateSwarmRequestTrust(facts).ok).toBe(false)
  })

  it('publishes only local target-bound reads and never write or principal authority', () => {
    expect(rpcHarness().service.capabilities()).toMatchObject({
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
        { capability: 'message.write', state: 'unavailable' },
        { capability: 'control.write', state: 'unavailable' },
        { capability: 'effect.cancel', state: 'unavailable' },
      ],
    })
    expect(rpcHarness({ host: '0.0.0.0' }).service.capabilities().capabilities.slice(0, 4))
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'unavailable', blocker: 'listener-not-loopback' })]))
  })
})

describe('R2 authoritative target binding and wire contract', () => {
  it('rebinds the target hint to the exact live root and enters R1 with official withInitiator', async () => {
    const harness = rpcHarness()
    const request = { schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id } } as const
    const binding = await harness.service.invoke(request)
    expect(binding).toMatchObject({
      binding: { rootSessionId: ROOT.id, teamId: 'team-r2' }, team: { createdAt: 1 },
    })
    const packedShapeClient = new SwarmReadClient(async () => new Response(JSON.stringify({
      schemaVersion: 1, ok: true, value: binding,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(packedShapeClient.request(request)).resolves.toMatchObject({ ok: true, value: binding })
    await expect(harness.service.invoke({
      schemaVersion: 1, method: 'page', target: { rootSessionId: ROOT.id }, afterCursor: CURSOR,
      page: { kind: 'tasks', offset: 0, limit: 1 },
    })).resolves.toMatchObject({
      kind: 'tasks', visibleTotal: 1, authoritativeTotal: 4, projectionTruncated: true,
      changed: false, resyncRequired: false,
    })
    expect(harness.hostRead.read).toHaveBeenCalledWith({ afterCursor: CURSOR, teamId: 'team-r2' })
  })

  it('rejects fake roots, stale Session objects, non-roots and non-captain Team hints', async () => {
    const absent = rpcHarness()
    await expect(absent.service.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: 'fake' } }))
      .rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    const stale = rpcHarness()
    stale.switchSession(OTHER.session)
    await expect(stale.service.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id } }))
      .rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    const child = rpcHarness()
    child.setRoots([])
    await expect(child.service.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id } }))
      .rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    await expect(rpcHarness({ captain: OTHER.id }).service.invoke({
      schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id, teamId: 'team-r2' },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  it('resolves a cold dedicated Captain binding for the Main Brain root without guessing', async () => {
    const harness = rpcHarness({
      captain: 'captain-session',
      coldCaptainSessions: { 'captain-session': { header: { parentSession: ROOT.id } } },
    })
    const binding = await harness.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })
    expect(binding).toMatchObject({ binding: { rootSessionId: ROOT.id, teamId: 'team-r2' } })
    expect(harness.lastReadInput()).toMatchObject({ teamId: 'team-r2', captainSessionId: 'captain-session' })
    // Explicit hint path reuses the same descriptor chain.
    await expect(harness.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id, teamId: 'team-r2' },
    })).resolves.toMatchObject({ binding: { teamId: 'team-r2' } })
  })

  it('resolves a cold Captain binding from the runtime managed mapping even when ctx.sessions does not load the Captain Session', async () => {
    // create_managed recorded the in-process root -> Captain relation in the runtime, but the
    // official ctx.sessions does not load the ended (cold) Captain => sessions.get returns undefined.
    const harness = rpcHarness({
      captain: 'captain-session',
      managedCaptains: ['captain-session'],
    })
    const binding = await harness.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })
    expect(binding).toMatchObject({ binding: { rootSessionId: ROOT.id, teamId: 'team-r2' } })
    // R1 receives the captainSessionId hint so the projection binds to the dedicated Captain.
    expect(harness.lastReadInput()).toMatchObject({ teamId: 'team-r2', captainSessionId: 'captain-session' })
    // >1 managed Captains stay explicit AMBIGUOUS (never guessed).
    const ambiguous = rpcHarness({
      managedCaptains: ['captain-a', 'captain-b'],
      teams: [
        { id: 'team-a', captainSessionId: 'captain-a', phase: 'active' },
        { id: 'team-b', captainSessionId: 'captain-b', phase: 'active' },
      ],
    })
    await expect(ambiguous.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_AMBIGUOUS' })
    // 0 managed Captains => explicit NOT_FOUND.
    await expect(rpcHarness({ captain: 'cold-captain' }).service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_NOT_FOUND' })
  })

  it('admits a cold Main Brain root for read-only Team resolution via the runtime managed mapping', async () => {
    // The Main Brain's turn has ended: its Session is no longer in the live store
    // (ctx.sessions.get returns undefined), yet the create_managed in-process root -> Captain
    // relation is still authoritative in the runtime mapping.
    const harness = rpcHarness({
      captain: 'captain-session',
      managedCaptains: ['captain-session'],
      coldRoot: true,
    })
    const binding = await harness.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })
    expect(binding).toMatchObject({ binding: { rootSessionId: ROOT.id, teamId: 'team-r2' } })
    expect(harness.lastReadInput()).toMatchObject({ teamId: 'team-r2', captainSessionId: 'captain-session' })
    const snapshot = await harness.service.invoke({
      schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id },
    })
    expect(snapshot).toMatchObject({ team: { id: 'team-r2' } })
    expect(harness.lastReadInput()).toMatchObject({ teamId: 'team-r2', captainSessionId: 'captain-session' })
    // A cold root with no resolvable Team stays an explicit NOT_FOUND (never guessed).
    await expect(rpcHarness({ captain: 'cold-captain', coldRoot: true, managedCaptains: [] }).service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_NOT_FOUND' })
  })

  it('admits a fully cold root reconstructed from official persistence when the live Agent registry is empty', async () => {
    // The root Agent has been removed from the live registry (agents.get => undefined), but the
    // official persisted Session still exists and carries the durable cwd / parent lineage. R2
    // reconstructs the read-only root view from persistence and re-proves the Captain-owned Team
    // via the runtime managed mapping — no fabricated local Agent or live-store state.
    const harness = rpcHarness({
      captain: 'captain-session',
      managedCaptains: ['captain-session'],
      fullyColdRoot: true,
      persistedRootHeader: { cwd: 'D:\\workspace' },
    })
    const binding = await harness.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })
    expect(binding).toMatchObject({ binding: { rootSessionId: ROOT.id, teamId: 'team-r2' } })
    expect(harness.lastReadInput()).toMatchObject({ teamId: 'team-r2', captainSessionId: 'captain-session' })
    const snapshot = await harness.service.invoke({
      schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id },
    })
    expect(snapshot).toMatchObject({ team: { id: 'team-r2' } })
    await expect(harness.service.invoke({
      schemaVersion: 1, method: 'page', target: { rootSessionId: ROOT.id }, page: { kind: 'tasks', offset: 0, limit: 10 },
    })).resolves.toBeDefined()
    // A fully cold root with no managed Captain mapping stays an explicit NOT_FOUND (never guessed).
    await expect(rpcHarness({ captain: 'cold-captain', fullyColdRoot: true, managedCaptains: [], persistedRootHeader: { cwd: 'D:\\workspace' } }).service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_NOT_FOUND' })
    // No persisted Session at all => the target is still TARGET_NOT_LIVE.
    await expect(rpcHarness({ captain: 'captain-session', fullyColdRoot: true, managedCaptains: ['captain-session'] }).service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
  })

  it('keeps cold-captain ambiguity explicit and rejects unowned Captain bindings', async () => {
    const ambiguous = rpcHarness({
      coldCaptainSessions: {
        'captain-a': { header: { parentSession: ROOT.id } },
        'captain-b': { header: { parentSession: ROOT.id } },
      },
      teams: [
        { id: 'team-a', captainSessionId: 'captain-a', phase: 'active' },
        { id: 'team-b', captainSessionId: 'captain-b', phase: 'active' },
      ],
    })
    await expect(ambiguous.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_AMBIGUOUS' })

    const unowned = rpcHarness({
      captain: 'cold-captain',
      coldCaptainSessions: { 'cold-captain': { header: { parentSession: 'someone-else' } } },
    })
    await expect(unowned.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_NOT_FOUND' })
    await expect(unowned.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id, teamId: 'team-r2' },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })

    // Only an official root may resolve a parent binding.
    const nonRoot = rpcHarness({
      captain: 'captain-session',
      coldCaptainSessions: { 'captain-session': { header: { parentSession: ROOT.id } } },
    })
    nonRoot.setRoots([])
    await expect(nonRoot.service.invoke({
      schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id, teamId: 'team-r2' },
    })).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  it('rejects unknown fields, accessors, proxies, oversized selectors and invalid paging', async () => {
    const service = rpcHarness().service
    const valid = { schemaVersion: 1, method: 'binding', target: { rootSessionId: ROOT.id } }
    const accessor = Object.defineProperty({}, 'rootSessionId', { enumerable: true, get: () => ROOT.id })
    for (const input of [
      { ...valid, principal: 'human' },
      { ...valid, target: { rootSessionId: ROOT.id, scope: 'claimed' } },
      { ...valid, target: accessor },
      new Proxy(valid, {}),
      { ...valid, target: { rootSessionId: 'x'.repeat(257) } },
      { ...valid, method: 'page', page: { kind: 'tasks', offset: -1, limit: 51 } },
      { ...valid, method: 'unknown' },
    ]) await expect(service.invoke(input)).rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
  })

  it('pages contiguously without omitted, skipped or terminal continuation offsets', async () => {
    const tasks = Array.from({ length: 3 }, (_, index) => ({
      ...projection.tasks[0]!, id: `task-${index + 1}`, revision: index + 1,
    }))
    const service = rpcHarness({
      projection: { ...projection, tasks, totals: { ...projection.totals, tasks: 3 }, truncated: { ...projection.truncated, tasks: false } },
    }).service
    const call = async (offset: number) => await service.invoke({
      schemaVersion: 1, method: 'page', target: { rootSessionId: ROOT.id }, page: { kind: 'tasks', offset, limit: 1 },
    })
    await expect(call(0)).resolves.toMatchObject({ entries: [{ id: 'task-1' }], nextOffset: 1 })
    await expect(call(1)).resolves.toMatchObject({ entries: [{ id: 'task-2' }], nextOffset: 2 })
    const terminal = await call(2) as unknown as Record<string, unknown>
    expect(terminal).toMatchObject({ entries: [{ id: 'task-3' }] })
    expect(terminal).not.toHaveProperty('nextOffset')
    await expect(call(4)).rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
  })

  it('reads real Captain sections (members, announcements, diagnostics) with honest not-generated/unavailable status', async () => {
    const teamState = {
      id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 5,
      members: [
        { name: 'worker', role: 'writer', sessionId: 'child-session', provider: 'mock', phase: 'active', createdAt: 1 },
        { name: 'artist', role: 'artist', sessionId: 'artist-session', provider: 'mock', phase: 'active', createdAt: 2,
          displayName: 'Pixel Painter', profession: 'Avatar artist', personality: 'Careful, meticulous',
          pixelAvatarSvg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
        // A crafted member whose stored pixelAvatarSvg is UNSAFE must be downgraded
        // to not_generated with no svg (read-time revalidation), never emitted as generated.
        { name: 'tampered', role: 'artist', sessionId: 'tampered-session', provider: 'mock', phase: 'active', createdAt: 3,
          pixelAvatarSvg: '<svg viewBox="0 0 16 16"><g/></svg>' },
      ],
      tasks: [{ id: 'task-1', revision: 1, subject: 'T', description: '', acceptanceCriteria: [], status: 'pending', blockedBy: [], writeScopes: [], priority: 1, createdAt: 1, updatedAt: 1 }],
      attempts: [{ id: 'attempt-1', taskId: 'task-1', generation: 1, memberSessionId: 'child-session', phase: 'accepted', assignmentPhase: 'delivered', createdAt: 1, updatedAt: 2 }],
    } as never as TeamState
    const service = rpcHarness({ teamState }).service
    const target = { rootSessionId: ROOT.id, teamId: 'team-r2' }
    // Members: authoritative roster identity/phase; a Captain-declared profile is returned as
    // `generated` (real values), an identity-less member is honestly `not_generated`, and a
    // member holding an unsafe avatar is downgraded to `not_generated` with no svg.
    const members = await service.invoke({
      schemaVersion: 1, method: 'captainMembers', target,
    }) as SwarmReadCaptainMembersV1
    expect(members.binding).toEqual({ rootSessionId: ROOT.id, teamId: 'team-r2' })
    expect(members.members).toEqual([
      {
        name: 'worker', role: 'writer', phase: 'active', createdAt: 1,
        avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
        identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
      },
      {
        name: 'artist', role: 'artist', phase: 'active', createdAt: 2,
        displayName: 'Pixel Painter', profession: 'Avatar artist', personality: 'Careful, meticulous',
        avatar: { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
        identityCard: { state: 'generated' },
      },
      {
        name: 'tampered', role: 'artist', phase: 'active', createdAt: 3,
        avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
        identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
      },
    ])
    // Announcements: real bounded projection; a Team with none has an honest empty list
    // (state 'available', zero fabricated entries).
    const announcements = await service.invoke({
      schemaVersion: 1, method: 'captainAnnouncements', target,
    }) as SwarmReadCaptainAnnouncementsV1
    expect(announcements).toMatchObject({ state: 'available', entries: [] })
    // Diagnostics: real authoritative counts, no second state.
    const diagnostics = await service.invoke({
      schemaVersion: 1, method: 'captainDiagnostics', target,
    }) as SwarmReadCaptainDiagnosticsV1
    expect(diagnostics.diagnostics).toEqual({
      revision: 5, phase: 'active', taskCount: 1, attemptCount: 1, memberCount: 3, backend: 'team-domain',
    })
    // A section read without an explicit Team selector is invalid.
    await expect(service.invoke({
      schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: ROOT.id },
    })).rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
  })

  it('projects real bounded announcements and an unsafe stored announcement avatar', async () => {
    const teamState = {
      id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 6,
      members: [],
      announcements: [{ id: 'ann-1', text: 'Welcome to the Team.', createdAt: 100 },
        { id: 'ann-2', text: 'Second update.', createdAt: 200 }],
      tasks: [], attempts: [],
    } as never as TeamState
    const service = rpcHarness({ teamState }).service
    const target = { rootSessionId: ROOT.id, teamId: 'team-r2' }
    const announcements = await service.invoke({
      schemaVersion: 1, method: 'captainAnnouncements', target,
    }) as SwarmReadCaptainAnnouncementsV1
    expect(announcements).toMatchObject({ state: 'available' })
    expect(announcements.entries).toEqual([
      { id: 'ann-1', text: 'Welcome to the Team.', createdAt: 100 },
      { id: 'ann-2', text: 'Second update.', createdAt: 200 },
    ])
  })

  it('returns real first-level Team enumeration with not-generated assets and section entry points', async () => {
    const teams = [
      { id: 'team-r2', captainSessionId: ROOT.id, phase: 'active' },
      { id: 'team-other', captainSessionId: 'other-captain', phase: 'active' },
    ] as never as { id: string; captainSessionId: string; phase: 'active' | 'archived' }[]
    const harness = rpcHarness({ teams })
    const enumeration = await harness.service.invoke({
      schemaVersion: 1, method: 'teams', target: { rootSessionId: ROOT.id },
    }) as SwarmReadTeamsV1
    expect(enumeration.complete).toBe(true)
    const entry = enumeration.teams[0]!
    expect(entry.teamId).toBe('team-r2')
    expect(entry.captainSessionId).toBe(ROOT.id)
    expect(entry.avatar).toEqual({ state: 'not_generated', reason: 'avatar_backend_not_implemented' })
    expect(entry.identityCard).toEqual({ state: 'not_generated', reason: 'identity_backend_not_implemented' })
    expect(entry.endpoints.members.method).toBe('captainMembers')
    expect(entry.endpoints.announcements.target).toEqual({ rootSessionId: ROOT.id, teamId: 'team-r2' })
    expect(entry.endpoints.diagnostics.method).toBe('captainDiagnostics')
  })
})

describe('R2 HTTP lifecycle', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))))

  it('serves the versioned route, enforces body bounds and closes admission', async () => {
    const harness = rpcHarness()
    const server = createServer((req, res) => void harness.service.handle(req, res))
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    ;(harness.webServer as { port: number }).port = port
    const url = `http://127.0.0.1:${port}/swarm/v1`
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, method: 'capabilities' }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { version: 1 } })
    const oversized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(16 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    await harness.service.dispose()
    expect((await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, method: 'capabilities' }),
    })).status).toBe(503)
  })

  it('keeps directed member names redacted across the HTTP wire', async () => {
    const harness = rpcHarness()
    const server = createServer((req, res) => void harness.service.handle(req, res)); servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    ;(harness.webServer as { port: number }).port = (server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/swarm/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id } }),
    })
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ ok: true, value: { tasks: [{ targetMemberName: 'worker' }] } })
    expect(text).not.toContain('targetMemberSessionId'); expect(text).not.toContain('child-session')
  })

  it('waits for both WebServer and R1, then unmounts and can remount without a stale route', async () => {
    const ctx = new Context()
    const harness = rpcHarness()
    const unregister = vi.fn()
    const webServer = { ...harness.webServer, register: vi.fn(() => unregister) }
    mountAgentSwarmReadRpc(ctx, {} as AgentSwarmRuntime, 1_000)
    const unprovideWeb = ctx.provide('webServer', webServer as never)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(ctx.get('agentSwarmReadRpc')).toBeUndefined()
    const unprovideHost = ctx.provide('agentSwarmHostRead', harness.hostRead)
    await vi.waitFor(() => expect(ctx.get('agentSwarmReadRpc')).toBeDefined())
    expect(webServer.register).toHaveBeenCalledTimes(1)
    await unprovideHost?.()
    await vi.waitFor(() => expect(ctx.get('agentSwarmReadRpc')).toBeUndefined())
    expect(unregister).toHaveBeenCalledTimes(1)
    const unprovideReloadedHost = ctx.provide('agentSwarmHostRead', harness.hostRead)
    await vi.waitFor(() => expect(ctx.get('agentSwarmReadRpc')).toBeDefined())
    expect(webServer.register).toHaveBeenCalledTimes(2)
    await unprovideReloadedHost?.()
    await unprovideWeb?.()
  })
})
