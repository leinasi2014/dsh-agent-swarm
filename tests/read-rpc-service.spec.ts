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
  host?: SwarmWebServer['host']; root?: Agent; captain?: string; projection?: SwarmHostReadProjectionV1
} = {}) {
  const root = options.root ?? ROOT
  let liveRoots: readonly Agent[] = [root]
  let session = root.session
  let initiator: Agent | undefined
  const team = {
    id: 'team-r2', captainSessionId: options.captain ?? root.id, phase: 'active',
  } as TeamState
  const hostRead = {
    read: vi.fn(async (input: { afterCursor?: string }) => {
      expect(initiator).toBe(root)
      return { ...(options.projection ?? projection), binding: { rootSessionId: root.id, teamId: team.id },
        changed: input.afterCursor !== CURSOR, resyncRequired: input.afterCursor !== undefined && input.afterCursor !== CURSOR }
    }),
  } as unknown as AgentSwarmHostReadService
  const ctx = {
    agents: {
      get: (id: string) => id === root.id ? root : undefined,
      roots: () => liveRoots,
      withInitiator: async <T>(agent: Agent, callback: () => Promise<T>) => {
        initiator = agent
        try { return await callback() } finally { initiator = undefined }
      },
    },
    sessions: { get: (id: string) => id === root.id ? session : undefined },
  } as unknown as Context
  const snapshot = vi.fn(async () => ({ team }))
  const runtime = {
    scopeOf: (agent: Agent) => agent.session.header.cwd!,
    listTeamAggregates: vi.fn(async () => [team]),
    domain: { snapshot },
  } as unknown as AgentSwarmRuntime
  const webServer = { host: options.host ?? '127.0.0.1', port: 8279, register: vi.fn() } satisfies SwarmWebServer
  const service = new AgentSwarmReadRpcService({ ctx, runtime, hostRead, webServer })
  return {
    service, hostRead, snapshot, webServer,
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
        { capability: 'binding.read', state: 'available' },
        { capability: 'status.read', state: 'available' },
        { capability: 'snapshot.read', state: 'available' },
        { capability: 'page.read', state: 'available' },
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
