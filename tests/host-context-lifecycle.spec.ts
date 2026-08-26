/** SW-I2-H1: internal Host-owned opaque context lifecycle. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

class GatedAdapter extends LlmAdapter {
  private readonly gate: Promise<void>
  private releaseGate!: () => void

  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseGate = resolve })
  }

  release(): void { this.releaseGate() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await this.gate
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Acknowledged.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface MountedHost {
  readonly ctx: Context
  readonly captain: Agent
  readonly teamId: AgentSwarm.TeamId
  readonly adapter: GatedAdapter
  pluginFiber: Fiber
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

const roots: string[] = []
const fibers: Fiber[] = []
const adapters: GatedAdapter[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const adapter of adapters.splice(0)) adapter.release()
  for (const fiber of fibers.splice(0).toReversed()) await fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function codeOf(error: unknown): string | undefined {
  const candidate = error as { code?: string; info?: { code?: string } }
  return candidate.code ?? candidate.info?.code
}

async function callTool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId(callId), name, arguments: args, agent })
}

async function mountHost(maxHostContexts: number): Promise<MountedHost> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-host-context-'))
  roots.push(sandbox)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  const pluginFiber = await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn', memberMaxDepth: 1, maxHostContexts, hostContextTtlMs: 60_000,
  })
  fibers.push(pluginFiber)
  const adapter = new GatedAdapter()
  adapters.push(adapter)
  ctx.llm.registerAdapter(['mock'], adapter)
  const captain = ctx.agentLoop.create(
    SessionId(`host-captain-${Math.random().toString(36).slice(2, 10)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await callTool(ctx, captain, 'host-create', 'agent_swarm_create', { name: 'host-team', description: 'Host context Team' })
  if (created.isError) throw new Error(`Team creation failed: ${JSON.stringify(created.error)}`)
  return { ctx, captain, teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id), adapter, pluginFiber }
}

async function addCaptain(stack: MountedHost): Promise<Agent> {
  const captain = stack.ctx.agentLoop.create(
    SessionId(`host-other-${Math.random().toString(36).slice(2, 10)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: stack.ctx.agentSwarm.scopeOf(stack.captain) },
  )
  const created = await callTool(stack.ctx, captain, 'host-create-other', 'agent_swarm_create', { name: 'other-team', description: 'Other Host Team' })
  if (created.isError) throw new Error(`Other Team creation failed: ${JSON.stringify(created.error)}`)
  return captain
}

function removeFiber(fiber: Fiber): void {
  const index = fibers.indexOf(fiber)
  if (index >= 0) fibers.splice(index, 1)
}

function assertOpaqueSuccess(value: AgentSwarm.HostContextGrant, sensitiveValues: readonly string[]): void {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown
  const forbiddenKeys: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (/captain|session|principal|authority|agent/i.test(key)) forbiddenKeys.push(key)
      visit(child)
    }
  }
  visit(serialized)
  expect(forbiddenKeys).toEqual([])
  const text = JSON.stringify(serialized)
  for (const sensitive of sensitiveValues) expect(text).not.toContain(sensitive)
}

async function rejected(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected operation to reject')
}

function assertSanitizedAuthorityError(error: Error & { code?: string }, secrets: readonly string[]): void {
  expect(error.code).toBe('TEAM_HOST_CONTEXT_AUTHORITY_UNAVAILABLE')
  expect(error.message).toBe('Host context authority is unavailable')
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  const serialized = JSON.stringify(error)
  expect(serialized).not.toMatch(/stack|cause/i)
  for (const secret of secrets) {
    expect(error.message).not.toContain(secret)
    expect(serialized).not.toContain(secret)
    expect(error.stack).not.toContain(secret)
  }
}

function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
}

function rejectedResults<T>(results: PromiseSettledResult<T>[]): PromiseRejectedResult[] {
  return results.flatMap(result => result.status === 'rejected' ? [result] : [])
}

describe('SW-I2-H1 Host opaque context lifecycle', () => {
  it('closes Host admission before Team runtime disposal when later activation fails', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-host-context-activation-failure-'))
    roots.push(sandbox)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
    await mountStorageStackOn(ctx, join(sandbox, 'storage'))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
    fibers.push(await ctx.plugin(SubagentService))
    fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))

    const originalProvide = ctx.provide.bind(ctx)
    vi.spyOn(ctx, 'provide').mockImplementation(((name: string, value: unknown) => {
      if (name === 'agentSwarmPermission') throw new Error('injected permission assembly failure')
      return originalProvide(name as never, value as never)
    }) as Context['provide'])

    const originalDispose = AgentSwarmRuntime.prototype.dispose
    const hostCodesAtRuntimeDisposal: Array<string | undefined> = []
    vi.spyOn(AgentSwarmRuntime.prototype, 'dispose').mockImplementation(async function (this: AgentSwarmRuntime) {
      const closedProbe = rejected(ctx.agentSwarmHostContext.mint({
        captain: {} as Agent,
        signal: new AbortController().signal,
      }))
      hostCodesAtRuntimeDisposal.push(codeOf(await closedProbe))
      await originalDispose.call(this)
    })

    await expect(ctx.plugin(AgentSwarm, {
      memberProvider: 'spawn', memberMaxDepth: 1, maxHostContexts: 1, hostContextTtlMs: 60_000,
    })).rejects.toThrow('injected permission assembly failure')
    expect(hostCodesAtRuntimeDisposal[0]).toBe('TEAM_HOST_CONTEXT_CLOSED')
  })

  it('scenario 48: exposes no internal authority and binds lifecycle to the exact live root and authoritative Team', async () => {
    const stack = await mountHost(2)
    const otherCaptain = await addCaptain(stack)
    const added = await callTool(stack.ctx, stack.captain, 'host-add', 'agent_swarm_add_member', { name: 'worker', role: 'member boundary probe' })
    expect(added.isError).toBe(false)
    const memberId = (added.value as { session_id: string }).session_id
    await vi.waitFor(() => expect(stack.ctx.agents.get(SessionId(memberId))).toBeDefined())
    const member = stack.ctx.agents.get(SessionId(memberId))!
    const signal = new AbortController().signal
    const host = stack.ctx.agentSwarmHostContext

    const minted = await host.mint({ captain: stack.captain, signal })
    expect(minted.teamId).toBe(stack.teamId)
    expect(minted.token).toHaveLength(43)
    assertOpaqueSuccess(minted, [stack.captain.id, member.id])
    assertOpaqueSuccess(await host.resolve(minted.token, { captain: stack.captain, signal }), [stack.captain.id, member.id])

    const refreshed = await host.refresh(minted.token, { captain: stack.captain, signal })
    assertOpaqueSuccess(refreshed, [stack.captain.id, member.id])
    expect(refreshed.generation).toBe(2)
    await expect(host.resolve(minted.token, { captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
    const rotated = await host.rotate(refreshed.token, { captain: stack.captain, signal })
    assertOpaqueSuccess(rotated, [stack.captain.id, member.id])
    expect(rotated.generation).toBe(3)
    expect(rotated.expiresAt).toBe(refreshed.expiresAt)
    await expect(host.resolve(refreshed.token, { captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')

    const otherToken = await host.mint({ captain: otherCaptain, signal })
    assertOpaqueSuccess(otherToken, [otherCaptain.id])
    await expect(host.resolve(rotated.token, { captain: otherCaptain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_UNAUTHORIZED')
    await expect(host.resolve(rotated.token, { captain: member, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CAPTAIN_REQUIRED')
    stack.adapter.release()
    const tampered = `${rotated.token.slice(0, -1)}${rotated.token.endsWith('x') ? 'y' : 'x'}`
    await expect(host.resolve(tampered, { captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
    await expect(host.mint({ captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CAPACITY')

    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    await expect(host.mint({ captain: stack.captain, signal: aborted.signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_ABORTED')
    await host.revoke(otherToken.token, { captain: otherCaptain, signal })
    await expect(host.resolve(otherToken.token, { captain: otherCaptain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')

    vi.spyOn(Date, 'now').mockReturnValue(rotated.expiresAt)
    await expect(host.resolve(rotated.token, { captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_EXPIRED')
    vi.restoreAllMocks()
    const beforeReload = await host.mint({ captain: stack.captain, signal })
    await stack.pluginFiber.dispose()
    removeFiber(stack.pluginFiber)
    await expect(host.resolve(beforeReload.token, { captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CLOSED')

    stack.pluginFiber = await stack.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, maxHostContexts: 2, hostContextTtlMs: 60_000 })
    fibers.push(stack.pluginFiber)
    await expect(stack.ctx.agentSwarmHostContext.resolve(beforeReload.token, { captain: stack.captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
  }, 30_000)

  it('maps scope, ambiguous membership, storage and live-registry adapter failures to one sanitized Host error', async () => {
    const stack = await mountHost(2)
    const host = stack.ctx.agentSwarmHostContext
    const authority = { captain: stack.captain, signal: new AbortController().signal }

    const scopeSecret = 'C:\\secret\\captain-workspace'
    const scopeSpy = vi.spyOn(stack.ctx.agentSwarm, 'scopeOf').mockImplementation(() => { throw new Error(`scope failed at ${scopeSecret}`) })
    assertSanitizedAuthorityError(await rejected(host.mint(authority)), [scopeSecret, stack.captain.id])
    scopeSpy.mockRestore()

    const domain = stack.ctx.agentSwarm.domain
    const membershipSpy = vi.spyOn(domain, 'requireMembership')
    const ambiguousSecret = `ambiguous membership for ${stack.captain.id} across team-secret-a/team-secret-b`
    membershipSpy.mockRejectedValueOnce(new AgentSwarm.TeamDomainError(ambiguousSecret, 'TEAM_MEMBERSHIP_AMBIGUOUS'))
    assertSanitizedAuthorityError(await rejected(host.mint(authority)), [ambiguousSecret, stack.captain.id, 'team-secret-a'])
    const storageSecret = 'sqlite failure at D:\\private\\agent_swarm.db'
    membershipSpy.mockRejectedValueOnce(new Error(storageSecret))
    assertSanitizedAuthorityError(await rejected(host.mint(authority)), [storageSecret, 'agent_swarm.db'])
    membershipSpy.mockRestore()

    const adapterSecret = 'live registry adapter leaked session-internal-42'
    const adapterSpy = vi.spyOn(stack.ctx.agents, 'get').mockImplementation(() => { throw new Error(adapterSecret) })
    assertSanitizedAuthorityError(await rejected(host.mint(authority)), [adapterSecret, 'session-internal-42'])
    adapterSpy.mockRestore()
  })

  it('linearizes concurrent capacity, refresh/rotate, rotate/revoke and exact-expiry terminal state', async () => {
    const capacity = 3
    const stack = await mountHost(capacity)
    const host = stack.ctx.agentSwarmHostContext
    const authority = { captain: stack.captain, signal: new AbortController().signal }

    const burst = await Promise.allSettled(Array.from({ length: capacity + 2 }, async () => await host.mint(authority)))
    const active = fulfilled(burst)
    expect(active).toHaveLength(capacity)
    expect(new Set(active.map(grant => grant.token)).size).toBe(capacity)
    for (const grant of active) assertOpaqueSuccess(grant, [stack.captain.id])
    expect(rejectedResults(burst)).toHaveLength(2)
    for (const result of rejectedResults(burst)) expect(codeOf(result.reason)).toBe('TEAM_HOST_CONTEXT_CAPACITY')
    for (const grant of active) await host.revoke(grant.token, authority)

    const predecessor = await host.mint(authority)
    const successorRace = await Promise.allSettled([host.refresh(predecessor.token, authority), host.rotate(predecessor.token, authority)])
    expect(fulfilled(successorRace)).toHaveLength(1)
    expect(rejectedResults(successorRace)).toHaveLength(1)
    expect(codeOf(rejectedResults(successorRace)[0]!.reason)).toBe('TEAM_HOST_CONTEXT_INVALID')
    const successor = fulfilled(successorRace)[0]!
    expect(successor.generation).toBe(2)

    const terminalRace = await Promise.allSettled([host.rotate(successor.token, authority), host.revoke(successor.token, authority)])
    expect(terminalRace.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const terminalRejected = terminalRace.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(terminalRejected).toHaveLength(1)
    expect(codeOf(terminalRejected[0]!.reason)).toBe('TEAM_HOST_CONTEXT_INVALID')
    const rotatedWinner = terminalRace[0]?.status === 'fulfilled' ? terminalRace[0].value : undefined
    if (rotatedWinner !== undefined) await host.revoke(rotatedWinner.token, authority)

    const full = await Promise.all(Array.from({ length: capacity }, async () => await host.mint(authority)))
    const rotatedAtCapacity = await host.rotate(full[0]!.token, authority)
    await expect(host.mint(authority)).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CAPACITY')
    await host.revoke(rotatedAtCapacity.token, authority)
    for (const grant of full.slice(1)) await host.revoke(grant.token, authority)

    const expiring = await host.mint(authority)
    vi.spyOn(Date, 'now').mockReturnValue(expiring.expiresAt)
    await expect(host.resolve(expiring.token, authority)).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_EXPIRED')
    vi.restoreAllMocks()
    await expect(host.resolve(expiring.token, authority)).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
    await expect(host.refresh(expiring.token, authority)).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')

    const stale = Object.create(stack.captain) as Agent
    await expect(host.mint({ captain: stale, signal: authority.signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CAPTAIN_REQUIRED')
  })

  it('does not leave a ghost context when authorization is aborted or the service disposes', async () => {
    const stack = await mountHost(1)
    const host = stack.ctx.agentSwarmHostContext
    const domain = stack.ctx.agentSwarm.domain
    const original = domain.requireMembership.bind(domain)

    const abortEntered = deferred<void>()
    const abortRelease = deferred<void>()
    const abortSpy = vi.spyOn(domain, 'requireMembership').mockImplementation(async (...args) => {
      abortEntered.resolve()
      await abortRelease.promise
      return await original(...args)
    })
    const controller = new AbortController()
    const abortedMint = host.mint({ captain: stack.captain, signal: controller.signal })
    await abortEntered.promise
    controller.abort(new Error('abort during authority read'))
    abortRelease.resolve()
    await expect(abortedMint).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_ABORTED')
    abortSpy.mockRestore()
    const afterAbort = await host.mint({ captain: stack.captain, signal: new AbortController().signal })
    await host.revoke(afterAbort.token, { captain: stack.captain, signal: new AbortController().signal })

    const disposeEntered = deferred<void>()
    const disposeRelease = deferred<void>()
    const disposeSpy = vi.spyOn(domain, 'requireMembership').mockImplementation(async (...args) => {
      const membership = await original(...args)
      disposeEntered.resolve()
      await disposeRelease.promise
      return membership
    })
    const pending = host.mint({ captain: stack.captain, signal: new AbortController().signal })
    await disposeEntered.promise
    const disposing = stack.pluginFiber.dispose()
    await Promise.resolve()
    disposeRelease.resolve()
    await disposing
    removeFiber(stack.pluginFiber)
    await expect(pending).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CLOSED')
    disposeSpy.mockRestore()

    stack.pluginFiber = await stack.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, maxHostContexts: 1, hostContextTtlMs: 60_000 })
    fibers.push(stack.pluginFiber)
    const afterReload = await stack.ctx.agentSwarmHostContext.mint({ captain: stack.captain, signal: new AbortController().signal })
    assertOpaqueSuccess(afterReload, [stack.captain.id])
  })
})
