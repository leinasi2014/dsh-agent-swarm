/**
 * Failure barriers around initial-turn member provisioning.
 *
 * These exercise the real AgentLoop, subagent provider, persistence and Team
 * domain composition. The injected faults are only the aggregate commits and
 * disposal barriers under test; no alternate Team state is introduced.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

class MatrixAdapter extends LlmAdapter {
  calls = 0
  private readonly outcomesBySession = new Map<string, 'completed' | 'failed'>()
  private releaseInitialTurn!: () => void
  private readonly initialTurnGate = new Promise<void>(resolve => { this.releaseInitialTurn = resolve })

  constructor(private readonly outcomes: Array<'completed' | 'failed'>) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override providerRetryPolicy() {
    return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }

  release(): void { this.releaseInitialTurn() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const sessionKey = options.sessionId ?? `unidentified-${this.calls}`
    const signal = options.signal ?? new AbortController().signal
    let outcome = this.outcomesBySession.get(sessionKey)
    if (outcome === undefined) {
      outcome = this.outcomes.shift()
      if (outcome === undefined) throw new Error('matrix adapter received an unexpected child session')
      this.outcomesBySession.set(sessionKey, outcome)
    }
    if (!signal.aborted) {
      await Promise.race([
        this.initialTurnGate,
        new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }),
      ])
    }
    signal.throwIfAborted()
    if (outcome === 'failed') throw new Error('injected child startup failure')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Initial turn completed.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Initial turn completed.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface CaptainStack {
  readonly ctx: Context
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: string
}

async function mountCaptain(sandbox: string, fibers: Fiber[], leadId: string, teamName: string, adapter: LlmAdapter): Promise<CaptainStack> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SessionProjection))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId(leadId), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
  const created = await ctx.tools.execute({
    signal: SIGNAL, callId: CallId(`create-${leadId}`), name: 'agent_swarm_create',
    arguments: { name: teamName, description: `Fault barrier proof for ${leadId}.` }, agent: lead,
  })
  expect(created.isError).toBe(false)
  return { ctx, lead, teamId: (created.value as { team_id: string }).team_id }
}

describe('member provisioning terminal recovery barriers', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('retries a transient terminal startup-failure write before releasing the admitted operation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-terminal-retry-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const adapter = new MatrixAdapter(['failed'])
      const stack = await mountCaptain(sandbox, fibers, 'terminal-retry-lead', 'Terminal retry team', adapter)
      const idle = vi.spyOn(stack.ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const domain = stack.ctx.agentSwarm.domain
      const original = domain.settleMember.bind(domain)
      let rejectFirstTerminal = true
      const settle = vi.spyOn(domain, 'settleMember').mockImplementation(async (scope, teamId, memberId, outcome) => {
        if (!outcome.active && rejectFirstTerminal) { rejectFirstTerminal = false; throw new Error('injected terminal aggregate write failure') }
        return await original(scope, teamId, memberId, outcome)
      })
      const added = await stack.ctx.tools.execute({
        signal: SIGNAL, callId: CallId('terminal-retry-add'), name: 'agent_swarm_add_member',
        arguments: { name: 'terminal-retry-worker', role: 'Retry the durable failed settlement.' }, agent: stack.lead,
      })
      expect(added).toMatchObject({ isError: false, value: { phase: 'active' } })
      const childId = (added.value as { session_id: string }).session_id
      adapter.release()
      await vi.waitFor(async () => {
        const member = (await domain.snapshot(stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id)).team.members[0]
        expect(member).toMatchObject({ phase: 'failed', error: expect.stringContaining('initial turn ended error') })
      }, { timeout: 5_000 })
      expect(settle.mock.calls.filter(([, , memberId, outcome]) => memberId === childId && !outcome.active)).toHaveLength(2)
      settle.mockRestore(); idle.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('cold recovery retries persisted initial-turn error settlement before tracking children, with zero LLM or continuation starts', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-cold-startup-recovery-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const adapter = new MatrixAdapter([])
      const stack = await mountCaptain(sandbox, fibers, 'cold-recovery-lead', 'Cold startup recovery team', adapter)
      const domain = stack.ctx.agentSwarm.domain
      const scope = stack.ctx.agentSwarm.scopeOf(stack.lead)
      const teamId = AgentSwarm.TeamId(stack.teamId)
      const member = await domain.provisionMember(scope, teamId, stack.lead.id, {
        name: 'cold-failed-worker', role: 'Converge from durable error evidence.', sessionId: 'cold-failed-session', provider: 'spawn',
      })
      await domain.settleMember(scope, teamId, member.sessionId, { active: true })
      const inspect = vi.spyOn(stack.ctx.sessionPersistence, 'inspect').mockImplementation(async sessionId => {
        if (sessionId === SessionId(member.sessionId)) return { events: [{ type: 'turn/end', data: { reason: { kind: 'error' } } }] } as never
        throw new Error(`unexpected persisted session inspection: ${sessionId}`)
      })
      const start = vi.spyOn(stack.ctx.subagents, 'startContinuable')
      const original = domain.settleMember.bind(domain)
      let rejectFirstTerminal = true
      const settle = vi.spyOn(domain, 'settleMember').mockImplementation(async (nextScope, nextTeamId, memberId, outcome) => {
        if (!outcome.active && rejectFirstTerminal) { rejectFirstTerminal = false; throw new Error('injected cold recovery write failure') }
        return await original(nextScope, nextTeamId, memberId, outcome)
      })
      await stack.ctx.agentSwarm.recoverAgent(stack.lead)
      const snapshot = await domain.snapshot(scope, teamId, stack.lead.id)
      expect(snapshot.team.members[0]).toMatchObject({ sessionId: member.sessionId, phase: 'failed' })
      expect(settle.mock.calls.filter(([, , , outcome]) => !outcome.active)).toHaveLength(2)
      expect(start).not.toHaveBeenCalled()
      expect(adapter.calls).toBe(0)
      settle.mockRestore(); start.mockRestore(); inspect.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('does not release activation-failure disposal until fallback settlement and child drain complete', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-activation-dispose-barrier-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const adapter = new MatrixAdapter(['completed'])
      const stack = await mountCaptain(sandbox, fibers, 'activation-dispose-lead', 'Activation disposal barrier team', adapter)
      const domain = stack.ctx.agentSwarm.domain
      const original = domain.settleMember.bind(domain)
      let releaseFallback!: () => void
      const fallbackGate = new Promise<void>(resolve => { releaseFallback = resolve })
      const settle = vi.spyOn(domain, 'settleMember').mockImplementation(async (scope, teamId, memberId, outcome) => {
        if (outcome.active) throw new Error('injected active commit failure')
        await fallbackGate
        return await original(scope, teamId, memberId, outcome)
      })
      const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')
      const pending = stack.ctx.tools.execute({
        signal: SIGNAL, callId: CallId('activation-dispose-add'), name: 'agent_swarm_add_member',
        arguments: { name: 'activation-dispose-worker', role: 'Hold fallback settlement through disposal.' }, agent: stack.lead,
      })
      await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { active: true }), { timeout: 5_000 })
      const pluginFiber = fibers.pop()!
      let disposed = false
      const disposing = pluginFiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(drain).not.toHaveBeenCalled()
      releaseFallback()
      await expect(pending).resolves.toMatchObject({ isError: true })
      await disposing
      expect(drain).toHaveBeenCalled()
      settle.mockRestore(); drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('settles an initial turn error exactly once when it races runtime disposal', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-error-dispose-once-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const adapter = new MatrixAdapter(['failed'])
      const stack = await mountCaptain(sandbox, fibers, 'error-dispose-lead', 'Error disposal once team', adapter)
      const domain = stack.ctx.agentSwarm.domain
      const settled = vi.spyOn(domain, 'settleMember')
      const pending = stack.ctx.tools.execute({
        signal: SIGNAL, callId: CallId('error-dispose-add'), name: 'agent_swarm_add_member',
        arguments: { name: 'error-dispose-worker', role: 'Race error observation and disposer.' }, agent: stack.lead,
      })
      await vi.waitFor(() => expect(adapter.calls).toBe(1), { timeout: 5_000 })
      await expect(pending).resolves.toMatchObject({ isError: false, value: { phase: 'active' } })
      adapter.release()
      const pluginFiber = fibers.pop()!
      await pluginFiber.dispose()
      expect(settled.mock.calls.filter(([, , , outcome]) => !outcome.active)).toHaveLength(1)
      settled.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
