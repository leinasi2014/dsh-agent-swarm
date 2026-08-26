/** SWARM-P1-02: internal Host-owned opaque context lifecycle. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { mountStorageStackOn } from './helpers/storage-stack.js'

class GatedAdapter extends LlmAdapter {
  private readonly gate: Promise<void>
  private releaseGate!: () => void

  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseGate = resolve })
  }

  release(): void {
    this.releaseGate()
  }

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

const roots: string[] = []
const fibers: Fiber[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const fiber of fibers.splice(0).toReversed()) await fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)

function codeOf(error: unknown): string | undefined {
  const candidate = error as { code?: string; info?: { code?: string } }
  return candidate.code ?? candidate.info?.code
}

async function callTool(ctx: Context, agent: ReturnType<Context['agentLoop']['create']>, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name,
    arguments: args,
    agent,
  })
}

describe('SWARM-P1-02 Host opaque context lifecycle', () => {
  it('scenario 48: binds tokens to the exact live root and authoritative Team, rotates, bounds, aborts, expires, disposes and reloads closed', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-host-context-'))
    roots.push(sandbox)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
    await mountStorageStackOn(ctx, join(sandbox, 'storage'))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
    fibers.push(await ctx.plugin(SubagentService))
    fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
    let pluginFiber = await ctx.plugin(AgentSwarm, {
      memberProvider: 'spawn',
      memberMaxDepth: 1,
      maxHostContexts: 2,
      hostContextTtlMs: 60_000,
    })
    fibers.push(pluginFiber)
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)

    const workspace = join(sandbox, 'workspace')
    const captain = ctx.agentLoop.create(SessionId('host-context-captain'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const otherCaptain = ctx.agentLoop.create(SessionId('host-context-other'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const created = await callTool(ctx, captain, 'host-create-1', 'agent_swarm_create', { name: 'host-one', description: 'first Team' })
    const otherCreated = await callTool(ctx, otherCaptain, 'host-create-2', 'agent_swarm_create', { name: 'host-two', description: 'second Team' })
    expect(created.isError).toBe(false)
    expect(otherCreated.isError).toBe(false)

    const added = await callTool(ctx, captain, 'host-add', 'agent_swarm_add_member', { name: 'worker', role: 'member boundary probe' })
    expect(added.isError).toBe(false)
    const memberId = (added.value as { session_id: string }).session_id
    await vi.waitFor(() => expect(ctx.agents.get(SessionId(memberId))).toBeDefined())
    const member = ctx.agents.get(SessionId(memberId))!

    const signal = new AbortController().signal
    const host = ctx.agentSwarmHostContext
    const minted = await host.mint({ captain, signal })
    expect(minted.captainSessionId).toBe(captain.id)
    expect(minted.teamId).toBe((created.value as { team_id: string }).team_id)
    expect(minted.token).toHaveLength(43)
    expect(minted.token).not.toContain(captain.id)
    expect(minted.token).not.toContain(minted.teamId)
    expect((await host.resolve(minted.token, { captain, signal })).token).toBe(minted.token)

    const refreshed = await host.refresh(minted.token, { captain, signal })
    expect(refreshed.token).not.toBe(minted.token)
    expect(refreshed.generation).toBe(2)
    await expect(host.resolve(minted.token, { captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
    const rotated = await host.rotate(refreshed.token, { captain, signal })
    expect(rotated.token).not.toBe(refreshed.token)
    expect(rotated.generation).toBe(3)
    expect(rotated.expiresAt).toBe(refreshed.expiresAt)
    await expect(host.resolve(refreshed.token, { captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')

    const other = await host.mint({ captain: otherCaptain, signal })
    await expect(host.resolve(rotated.token, { captain: otherCaptain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_UNAUTHORIZED')
    await expect(host.resolve(rotated.token, { captain: member, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CAPTAIN_REQUIRED')
    adapter.release()
    const tampered = `${rotated.token.slice(0, -1)}${rotated.token.endsWith('x') ? 'y' : 'x'}`
    await expect(host.resolve(tampered, { captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
    await expect(host.mint({ captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CAPACITY')

    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    await expect(host.mint({ captain, signal: aborted.signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_ABORTED')

    await host.revoke(other.token, { captain: otherCaptain, signal })
    await expect(host.resolve(other.token, { captain: otherCaptain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')

    vi.spyOn(Date, 'now').mockReturnValue(rotated.expiresAt + 1)
    await expect(host.resolve(rotated.token, { captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_EXPIRED')
    vi.restoreAllMocks()
    const beforeReload = await host.mint({ captain, signal })

    await pluginFiber.dispose()
    fibers.splice(fibers.indexOf(pluginFiber), 1)
    await expect(host.resolve(beforeReload.token, { captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_CLOSED')

    pluginFiber = await ctx.plugin(AgentSwarm, {
      memberProvider: 'spawn',
      memberMaxDepth: 1,
      maxHostContexts: 2,
      hostContextTtlMs: 60_000,
    })
    fibers.push(pluginFiber)
    await expect(ctx.agentSwarmHostContext.resolve(beforeReload.token, { captain, signal })).rejects.toSatisfy(error => codeOf(error) === 'TEAM_HOST_CONTEXT_INVALID')
  }, 30_000)
})
