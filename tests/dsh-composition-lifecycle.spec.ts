import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  ToolCallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const SIGNAL = new AbortController().signal

function textResponse(
  text: string,
  cache: Pick<TokenUsage, 'cacheReadTokens' | 'cacheWriteTokens'> = {},
): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length, ...cache } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  billedTokens = 0
  cacheTokens = 0

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift() ?? textResponse('Acknowledged.')
    for (const chunk of response) {
      if (chunk.type === 'usage') {
        this.cacheTokens += (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
        this.billedTokens += chunk.usage.inputTokens
          + chunk.usage.outputTokens
          + (chunk.usage.cacheReadTokens ?? 0)
          + (chunk.usage.cacheWriteTokens ?? 0)
      }
      yield chunk
    }
  }
}

async function successfulTool(
  ctx: Context,
  agent: Agent,
  callId: string,
  name: string,
  args: unknown,
) {
  const result = await ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  }
  return result.value
}

/** Mount the official durable composition: persistence + storage stack + agent services. */
async function mountDurableStack(ctx: Context, storageRoot: string, sessionDbPath: string): Promise<Fiber> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: sessionDbPath })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return persistenceFiber
}

describe('DSH rc.8 composition', () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('scenario 6: retains ownership of a started child when activation commit and immediate drain fail', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-member-failure-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []

    try {
      fibers.push(await mountDurableStack(ctx, join(sandbox, 'storage'), join(sandbox, 'sessions', 'sessions.db')))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      const pluginFiber = await ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn',
        memberMaxDepth: 1,
      })
      fibers.push(pluginFiber)

      ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('Started before commit failure.')]))
      const lead = await ctx.agentLoop.create(
        SessionId('failure-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )
      const created = await successfulTool(ctx, lead, 'failure-create', 'agent_swarm_create', {
        name: 'Failure recovery team',
        description: 'Prove a started child remains owned after two cleanup failures.',
      }) as { team_id: string }

      const settle = vi.spyOn(ctx.agentSwarm.domain, 'settleMember')
      settle.mockRejectedValueOnce(new Error('simulated activation commit failure'))
      const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
      drain.mockRejectedValueOnce(new Error('simulated immediate drain failure'))

      const failedAdd = await ctx.tools.execute({
        signal: SIGNAL,
        callId: ToolCallId('failure-add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'fragile-worker', role: 'Exercise cleanup ownership.' },
        agent: lead,
      })
      expect(failedAdd).toMatchObject({ isError: true, error: { message: 'simulated activation commit failure' } })

      const snapshot = await ctx.agentSwarm.domain.snapshot(
        ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(created.team_id), lead.id,
      )
      const failedMember = snapshot.team.members[0]!
      expect(failedMember.phase).toBe('failed')
      expect(drain).toHaveBeenCalledTimes(1)

      await pluginFiber.dispose()
      expect(drain.mock.calls.length).toBeGreaterThanOrEqual(2)
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(failedMember.sessionId))).toBeUndefined()
      }, { timeout: 15_000 })
      settle.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 60_000)

  it('scenario 9: bounded disposal fails loud when an admitted provider hangs', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-disposal-hang-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []

    try {
      fibers.push(await mountDurableStack(ctx, join(sandbox, 'storage'), join(sandbox, 'sessions', 'sessions.db')))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      const pluginFiber = await ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn',
        memberMaxDepth: 1,
        disposalTimeoutMs: 100,
      })
      fibers.push(pluginFiber)

      ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('Captain ready.')]))
      const lead = await ctx.agentLoop.create(
        SessionId('disposal-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )
      const created = await successfulTool(ctx, lead, 'disposal-create', 'agent_swarm_create', {
        name: 'Bounded disposal team',
        description: 'Prove a hung provider cannot block unload past disposalTimeoutMs.',
      }) as { team_id: string }

      // A registered provider whose continuable preparation never settles is
      // exactly a hung Provider: the admitted addMember operation can never
      // settle, so an unbounded disposal would block unload forever.
      const prepare = vi.fn(() => new Promise<never>(() => {}))
      const unregister = ctx.subagents.registerProvider({
        name: 'hung',
        capabilities: { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('one-shot start must never run here')),
        prepareContinuable: prepare,
      })
      const pendingAdd = ctx.agentSwarm.addMember(
        { agent: lead, signal: SIGNAL },
        { name: 'hung-worker', role: 'Never settles.', provider: 'hung' },
      )
      await vi.waitFor(() => { expect(prepare).toHaveBeenCalled() }, { timeout: 15_000 })

      // The runtime's own disposal contract fails loud within the bound: the
      // bounded step records a diagnostic and surfaces a visible
      // TEAM_DISPOSAL_TIMEOUT error instead of blocking unload forever.
      // (The Cordis effect wrapper additionally logs this rejection at the
      // plugin boundary — that surface belongs to the framework.)
      const startedAt = Date.now()
      const failure: unknown = await ctx.agentSwarm.dispose().then(() => undefined, error => error)
      expect(Date.now() - startedAt).toBeLessThan(3_000)
      expect(failure).toBeInstanceOf(AggregateError)
      const aggregate = failure as AggregateError
      const timeout = aggregate.errors.find(error => (error as { code?: string }).code === 'TEAM_DISPOSAL_TIMEOUT')
      expect(timeout).toBeDefined()
      expect((timeout as Error).message).toContain('member provisioning')

      // Plugin unload itself stays bounded too (the re-entry returns
      // immediately) and the admitted provisioning record stays durable
      // evidence of the hung admission: recovery on the next load owns
      // settling it.
      const unloaded: unknown = await pluginFiber.dispose().then(() => 'resolved', error => error)
      expect(unloaded).toBe('resolved')
      const unitFile = await readFile(join(sandbox, 'storage', 'agent_swarm.json'), 'utf8')
      expect(unitFile).toContain('hung-worker')
      expect(unitFile).toContain(created.team_id)

      unregister()
      void pendingAdd
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 10_000)

  it('recruits expertise, persists a member-authored identity and rejects unsafe avatars', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-identity-'))
    roots.push(sandbox)
    const workspace = join(sandbox, 'workspace')
    const ctx = new Context()
    const fibers: Fiber[] = []
    let releaseMember!: () => void
    const memberGate = new Promise<void>(resolve => { releaseMember = resolve })

    try {
      fibers.push(await mountDurableStack(ctx, join(sandbox, 'storage'), join(sandbox, 'sessions', 'sessions.db')))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      fibers.push(await ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn', memberMaxDepth: 1,
        schedulerProvider: 'test-scheduler', reviewProvider: 'test-review',
      }))
      const adapter = new ScriptedAdapter([textResponse('Member ready.')])
      const stream = adapter.stream.bind(adapter)
      vi.spyOn(adapter, 'stream').mockImplementation(async function* (options) { await memberGate; yield* stream(options) })
      ctx.llm.registerAdapter(['mock'], adapter)
      const lead = await ctx.agentLoop.create(
        SessionId('identity-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: workspace },
      )

      const created = await successfulTool(ctx, lead, 'identity-create', 'agent_swarm_create', {
        name: 'Identity team', description: 'Prove identity persists through the add-member tool.',
      }) as { team_id: string }

      const added = await successfulTool(ctx, lead, 'identity-add', 'agent_swarm_add_member', {
        name: 'painter', role: 'artist',
        profession: 'Avatar artist',
      }) as { session_id: string; phase: string }
      expect(added.phase).toBe('active')

      const painter = ctx.agents.get(SessionId(added.session_id))!
      const initial = await ctx.agentSwarm.domain.snapshot(workspace, AgentSwarm.TeamId(created.team_id), lead.id)
      await successfulTool(ctx, painter, 'identity-self', 'agent_swarm_set_member_profile', {
        name: 'painter', expected_revision: initial.team.revision, display_name: 'Pixel Painter', personality: 'Careful, meticulous', biography: 'Explores color and form.',
      })
      const introduced = await successfulTool(ctx, painter, 'identity-self-read', 'agent_swarm_list_members', {}) as { revision: number }
      await successfulTool(ctx, painter, 'identity-avatar', 'agent_swarm_set_member_profile', {
        name: 'painter', expected_revision: introduced.revision, pixel_avatar_svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>',
      })
      const snapshot = await ctx.agentSwarm.domain.snapshot(workspace, AgentSwarm.TeamId(created.team_id), lead.id)
      expect(snapshot.team.members[0]).toMatchObject({
        name: 'painter', displayName: 'Pixel Painter', profession: 'Avatar artist',
        personality: 'Careful, meticulous',
        pixelAvatarSvg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>',
      })

      // A member added without a profile keeps the honest absent identity.
      await successfulTool(ctx, lead, 'identity-plain', 'agent_swarm_add_member', { name: 'plain', role: 'writer' })
      const updated = await ctx.agentSwarm.domain.snapshot(workspace, AgentSwarm.TeamId(created.team_id), lead.id)
      const plain = updated.team.members.find(member => member.name === 'plain')
      expect(plain?.displayName).toBeUndefined()
      expect(plain?.pixelAvatarSvg).toBeUndefined()
      await successfulTool(ctx, painter, 'identity-backfill', 'agent_swarm_set_member_profile', {
        name: 'painter', expected_revision: updated.team.revision, display_name: 'Revised Painter', biography: 'Checks reference details.',
      })
      const backfilled = await ctx.agentSwarm.domain.snapshot(workspace, AgentSwarm.TeamId(created.team_id), lead.id)
      expect(backfilled.team.members[0]).toMatchObject({ sessionId: added.session_id, displayName: 'Revised Painter', profession: 'Avatar artist', personality: 'Careful, meticulous', biography: 'Checks reference details.' })
      const profiles = await successfulTool(ctx, lead, 'identity-readback', 'agent_swarm_list_members', {}) as { members: Array<{ profile_state: string }> }
      expect(profiles.members[0]).toMatchObject({ profile_state: 'available' })


      // An unsafe avatar is rejected by the tool before provisioning commits.
      await expect(ctx.tools.execute({
        signal: SIGNAL,
        callId: ToolCallId('identity-unsafe'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'evil', role: 'artist', pixel_avatar_svg: '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>' },
        agent: lead,
      })).resolves.toMatchObject({ isError: true })
      const rejected = await ctx.agentSwarm.domain.snapshot(workspace, AgentSwarm.TeamId(created.team_id), lead.id)
      expect(rejected.team.members.find(member => member.name === 'evil')).toBeUndefined()
    } finally {
      releaseMember()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 15_000)

  it('set_captain_profile / publish_announcement are Captain-only via real ctx.tools', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-captain-tools-'))
    roots.push(sandbox)
    const workspace = join(sandbox, 'workspace')
    const ctx = new Context()
    const fibers: Fiber[] = []

    try {
      fibers.push(await mountDurableStack(ctx, join(sandbox, 'storage'), join(sandbox, 'sessions', 'sessions.db')))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      fibers.push(await ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn', memberMaxDepth: 1,
        schedulerProvider: 'test-scheduler', reviewProvider: 'test-review',
      }))
      ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('Member ready.')]))
      const lead = await ctx.agentLoop.create(
        SessionId('captain-tools-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: workspace },
      )
      const intruder = await ctx.agentLoop.create(
        SessionId('captain-tools-intruder'),
        { provider: 'mock', model: 'mock' },
        { cwd: workspace },
      )

      const created = await successfulTool(ctx, lead, 'ct-create', 'agent_swarm_create', {
        name: 'Captain tools team', description: 'Permission proof.',
      }) as { team_id: string }
      const teamId = AgentSwarm.TeamId(created.team_id)

      // Captain sets the profile (expected_revision CAS) and publishes.
      const s0 = await ctx.agentSwarm.domain.snapshot(workspace, teamId, lead.id)
      const introduction = await successfulTool(ctx, lead, 'ct-set', 'agent_swarm_set_captain_profile', {
        expected_revision: s0.team.revision, display_name: 'Cap', profession: 'Coordinator', personality: 'Steady', biography: 'Coordinates reviews.',
      }) as { revision: number }
      const setResult = await successfulTool(ctx, lead, 'ct-avatar', 'agent_swarm_set_captain_profile', {
        expected_revision: introduction.revision,
        pixel_avatar_svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>',
      }) as { revision: number }
      const s1 = await ctx.agentSwarm.domain.snapshot(workspace, teamId, lead.id)
      expect(s1.team.captainProfile?.displayName).toBe('Cap')
      await successfulTool(ctx, lead, 'ct-ann', 'agent_swarm_publish_announcement', {
        expected_revision: setResult.revision,
        text: 'Welcome.',
      })
      const s2 = await ctx.agentSwarm.domain.snapshot(workspace, teamId, lead.id)
      expect(s2.team.announcements?.[0]?.text).toBe('Welcome.')

      // A non-member root is rejected by the tool.
      await expect(ctx.tools.execute({
        signal: SIGNAL, callId: ToolCallId('ct-intrude-set'), name: 'agent_swarm_set_captain_profile',
        arguments: { expected_revision: s2.team.revision, display_name: 'Hack' }, agent: intruder,
      })).resolves.toMatchObject({ isError: true })
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
