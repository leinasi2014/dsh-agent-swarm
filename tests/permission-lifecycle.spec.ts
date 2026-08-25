/**
 * SW-I1a permission surface lifecycle, provide-conflict and storage-fault
 * composition evidence.
 *
 * 1. A pre-existing `agentSwarmPermission` service makes plugin activation
 *    fail loud; the already-started runtime/store retires, and the same
 *    durable root can be mounted again after the conflict is removed.
 * 2. Normal disposal unprovides the service, clears host registrations and
 *    allows a reload to re-register both capabilities.
 * 3. When Team identity resolution hits a domain/storage throw, the official
 *    pre-execute consumer fails loud/closed (probe execute stays 0) while a
 *    truly unrelated agent still passes through `next()` untouched.
 */
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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal
const PROBE_TOOL = 'test_lifecycle_probe'

class ImmediateAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    const text = 'Acknowledged.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Stack {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId?: AgentSwarm.TeamId
  readonly scope?: string
}

const stacks: Stack[] = []
const roots: string[] = []

async function disposeStack(stack: Stack): Promise<void> {
  const index = stacks.indexOf(stack)
  if (index >= 0) stacks.splice(index, 1)
  for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
}

afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) {
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)

async function callTool(
  ctx: Context,
  agent: ReturnType<Context['agentLoop']['create']>,
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

async function mount(sandbox: string): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, lazyMemberStart: false }))
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  const lead = ctx.agentLoop.create(
    SessionId(`lifecycle-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await callTool(ctx, lead, 'lc-create', 'agent_swarm_create', {
    name: 'SW-I1a lifecycle team',
    description: 'Prove permission surface lifecycle composition.',
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  const stack: Stack = {
    ctx,
    fibers,
    lead,
    teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id),
    scope: ctx.agentSwarm.scopeOf(lead),
  }
  stacks.push(stack)
  return stack
}

async function mountConflictFixture(sandbox: string): Promise<Fiber[]> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  // Pre-existing service: plugin activation must fail loud, not silently
  // overwrite another owner. The fake provider is explicitly removed after
  // the failure so the same context/durable root can be reused cleanly.
  const unprovideConflict = ctx.provide('agentSwarmPermission', { fake: true } as never)
  await expect(ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, lazyMemberStart: false })).rejects.toThrow()
  unprovideConflict()
  return fibers
}

function registerProbe(ctx: Context, executed: { count: number }): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: PROBE_TOOL,
    description: 'Probe for lifecycle composition tests.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    },
    execute: async () => {
      executed.count += 1
      return { ok: true }
    },
  })), 'agent-swarm: lifecycle test probe')
}

function errorCode(error: unknown): string | undefined {
  const candidate = error as { info?: { code?: string }; code?: string }
  return candidate.info?.code ?? candidate.code
}

describe('permission surface provide conflict and reload', () => {
  it('pre-existing agentSwarmPermission fails activation loud and the same durable root reloads after conflict removal', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-conflict-'))
    roots.push(sandbox)
    const conflictFibers = await mountConflictFixture(sandbox)
    for (const fiber of conflictFibers.toReversed()) await fiber.dispose()

    const stack = await mount(sandbox)
    expect(stack.ctx.agentSwarmPermission).toBeDefined()
    expect(stack.teamId).toBeDefined()
    await disposeStack(stack)
  }, 30_000)

  it('normal dispose unprovides the service, clears registrations, and reload can re-register', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-dispose-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    const surface = stack.ctx.agentSwarmPermission
    const unregisterVerifier = surface.registerHumanPrincipalVerifier({
      kind: 'human-principal-verifier',
      name: 'dispose-host',
      verify: async () => false,
    })
    const unregisterReviewer = surface.registerReviewerAgentProvider({
      kind: 'reviewer-agent',
      name: 'dispose-reviewer',
      review: async () => ({ kind: 'evidence', evidenceIds: [], diagnostic: 'x', recommendation: 'reject' }),
    })

    await disposeStack(stack)

    // After dispose the service is unprovided and host registrations are gone.
    const after = stack.ctx as Context & { agentSwarmPermission?: unknown }
    expect(after.agentSwarmPermission).toBeUndefined()

    // Same durable root reload: a fresh mount must expose a fresh surface and
    // accept host registrations again.
    const reloaded = await mount(sandbox)
    expect(reloaded.ctx.agentSwarmPermission).toBeDefined()
    const unregisterAgain = reloaded.ctx.agentSwarmPermission.registerHumanPrincipalVerifier({
      kind: 'human-principal-verifier',
      name: 'reload-host',
      verify: async () => true,
    })
    expect(unregisterAgain).toBeTypeOf('function')
    unregisterVerifier()
    unregisterReviewer()
    unregisterAgain()
    await disposeStack(reloaded)
  }, 30_000)
})

describe('Team identity resolution storage fault', () => {
  it('domain/storage throw fails loud/closed (probe execute 0) while unrelated agents stay untouched', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-fault-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    const executed = { count: 0 }
    registerProbe(stack.ctx, executed)

    const domain = stack.ctx.agentSwarm.domain
    const spy = vi.spyOn(domain, 'findMembership').mockImplementation(async (_scope, sessionId) => {
      // The Team captain's identity resolution hits the storage fault; every
      // non-Team/unrelated resolution keeps returning undefined so the policy
      // pipeline can still tell truly unrelated callers from failures.
      if (String(sessionId) === String(stack.lead.id)) throw new Error('storage down')
      return undefined
    })

    const captainResult = await callTool(stack.ctx, stack.lead, 'lc-fault-captain', PROBE_TOOL)
    expect(captainResult.isError).toBe(true)
    expect(errorCode(captainResult.error)).toBe('TEAM_PERMISSION_RESOLUTION_FAILED')
    expect(executed.count).toBe(0)

    const unrelatedId = `lifecycle-unrelated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const unrelated = {
      id: unrelatedId as unknown as ReturnType<Context['agentLoop']['create']>['id'],
      session: { id: SessionId(unrelatedId), header: { cwd: join(sandbox, 'unrelated-workspace') } },
    } as unknown as ReturnType<Context['agentLoop']['create']>
    const unrelatedResult = await callTool(stack.ctx, unrelated, 'lc-fault-unrelated', PROBE_TOOL)
    expect(unrelatedResult.isError).toBe(false)
    expect(unrelatedResult.value).toEqual({ ok: true })
    expect(executed.count).toBe(1)

    spy.mockRestore()
    await disposeStack(stack)
  }, 30_000)
})
