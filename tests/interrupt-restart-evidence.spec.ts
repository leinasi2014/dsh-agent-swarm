import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal
const HANG = 'test_model_interrupt_restart_hang'
const TIMEOUT = 75

class HangingLatch {
  private releaseFn!: () => void
  private readonly released = new Promise<void>(resolve => { this.releaseFn = resolve })
  starts = 0

  release(): void { this.releaseFn() }

  async wait(signal: AbortSignal): Promise<void> {
    this.starts += 1
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      if (signal.aborted) return abort()
      const done = (): void => { signal.removeEventListener('abort', abort); resolve() }
      signal.addEventListener('abort', abort, { once: true })
      void this.released.then(done, done)
    })
  }
}

/** Emits a real ToolRuntime call only for the named post-join follow-up. */
class HangingAdapter extends LlmAdapter {
  constructor(private readonly trigger: string, private readonly callId: string) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  private latestText(options: GenerateOptions): string {
    const latest = [...options.messages].reverse().find(message => message.role === 'user')
    return latest?.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n') ?? ''
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.latestText(options).includes(this.trigger)) {
      const id = CallId(this.callId)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: HANG, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: HANG, arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Ready.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type Stack = {
  ctx: Context
  fibers: Fiber[]
  lead: ReturnType<Context['agentLoop']['create']>
  latch: HangingLatch
  tool: (callId: string, name: string, args?: Record<string, unknown>) => Promise<Awaited<ReturnType<Context['tools']['execute']>>>
  teamId: AgentSwarm.TeamId
}

const roots: string[] = []
const stacks: Stack[] = []

async function dispose(stack: Stack): Promise<void> {
  const index = stacks.indexOf(stack)
  if (index >= 0) stacks.splice(index, 1)
  stack.latch.release()
  for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
}

afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) await dispose(stack)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)

async function mount(root: string, leadId: string, adapter: HangingAdapter, existingTeamId?: AgentSwarm.TeamId): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const latch = new HangingLatch()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(root, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: HANG,
    description: 'Test-only hanging tool with a Host-owned timeout.',
    parameters: {},
    timeoutMs: TIMEOUT,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { released: { type: 'boolean', required: true } } },
      render: () => [],
    },
    execute: async (_args, exec) => {
      await latch.wait(exec.signal)
      return { released: true }
    },
  })), 'restart evidence hanging tool')
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId(leadId), { provider: 'mock', model: 'mock' }, { cwd: join(root, 'workspace') })
  const tool = async (callId: string, name: string, args: Record<string, unknown> = {}) => await ctx.tools.execute({
    signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent: lead,
  })
  let teamId = existingTeamId
  if (teamId === undefined) {
    const created = await tool('create', 'agent_swarm_create', {
      name: 'Restart interruption evidence', description: 'Prove durable history cannot authorize a model interrupt after restart.',
    })
    if (created.isError) throw new Error(JSON.stringify(created.error))
    teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
  }
  const stack = { ctx, fibers, lead, latch, tool, teamId }
  stacks.push(stack)
  return stack
}

function source() {
  return { source: { kind: 'plugin' as const, plugin: 'dsh-agent-swarm' }, signal: SIGNAL }
}

function openCall(agent: NonNullable<ReturnType<Context['agents']['get']>>, afterSeq = 0): Extract<SessionEvent, { type: 'tool/call' }> | undefined {
  const suffix = agent.session.events.filter(event => event.seq >= afterSeq)
  return suffix.find((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call'
    && event.data.name === HANG
    && !suffix.some(result => result.type === 'tool/result'
      && result.seq > event.seq
      && result.data.turn === event.data.turn
      && result.data.step === event.data.step
      && result.data.message.source.callId === event.data.callId))
}

describe('restart isolation for model interrupt evidence', () => {
  it('ignores a real persisted pre-restart hanging call and admits only the resumed live suffix call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-interrupt-restart-'))
    roots.push(root)
    const leadId = 'interrupt-restart-captain'
    const first = await mount(root, leadId, new HangingAdapter('old-crash-seed', 'old-crash-call'))
    const added = await first.tool('add', 'agent_swarm_add_member', { name: 'worker', role: 'Restart evidence worker' })
    expect(added.isError).toBe(false)
    const memberId = SessionId((added.value as { session_id: string }).session_id)

    // First Context: establish a real Team/member, then let the official
    // continuable transport dispatch an actual ToolRuntime call. This is the
    // durable crash point; the inspection below proves the call is still open.
    await first.ctx.subagents.followup(first.lead, memberId, [{ type: 'text', text: 'old-crash-seed' }], source())
    let oldCall!: Extract<SessionEvent, { type: 'tool/call' }>
    await vi.waitFor(async () => {
      const live = first.ctx.agents.get(memberId)
      if (live === undefined) throw new Error('old member is not resident')
      const call = openCall(live)
      if (call === undefined) throw new Error('old hanging call absent')
      oldCall = call
      expect(first.latch.starts).toBe(1)
      const stored = await first.ctx.sessionPersistence.inspect(memberId, SIGNAL)
      expect(stored.events.some(event => event.type === 'tool/call' && event.data.callId === oldCall.data.callId)).toBe(true)
    }, { timeout: 8_000, interval: 10 })

    // Dispose Context 1 only after recording the open durable call. The latch
    // is released for controlled test teardown; Context 2 receives the same
    // SQLite and storage roots, never copied fixture events.
    await dispose(first)

    const second = await mount(root, leadId, new HangingAdapter('new-live-suffix', 'new-resumed-call'), first.teamId)
    const restored = await second.ctx.agentSwarm.domain.snapshot(
      second.ctx.agentSwarm.scopeOf(second.lead), second.teamId, second.lead.id,
    )
    expect(restored.team.members).toEqual([expect.objectContaining({ name: 'worker', sessionId: memberId, phase: 'active' })])
    expect(second.ctx.agents.get(memberId)).toBeUndefined()

    const realInterrupt = second.ctx.subagents.interrupt.bind(second.ctx.subagents)
    const interrupt = vi.spyOn(second.ctx.subagents, 'interrupt').mockImplementation((id, authority) => realInterrupt(id, authority))
    const realResume = second.ctx.agents.resume.bind(second.ctx.agents)
    const resume = vi.spyOn(second.ctx.agents, 'resume').mockImplementation(options => realResume(options))
    try {
      // A cold member has only persisted pre-restart history. Even though that
      // history contained an open tool at the crash point, it has no live
      // suffix evidence and cannot request a cancellation.
      expect(await second.tool('old-history-only', 'agent_swarm_interrupt_member', { name: 'worker' })).toMatchObject({
        isError: true, error: { info: { code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' } },
      })
      expect(interrupt).not.toHaveBeenCalled()

      // This is the official continuable cold-resume path. It internally
      // resumes the exact persisted child through ctx.agents.resume(), then
      // delivers the first post-restart message. The resumed Session's seed
      // boundary must exclude every prior Context event from model-interrupt
      // evidence.
      await second.ctx.subagents.followup(second.lead, memberId, [{ type: 'text', text: 'new-live-suffix' }], source())
      expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: memberId }))
      let resumedCall!: Extract<SessionEvent, { type: 'tool/call' }>
      await vi.waitFor(() => {
        const live = second.ctx.agents.get(memberId)
        if (live === undefined) throw new Error('resumed member is not resident')
        expect(oldCall.seq).toBeLessThan(live.session.firstLiveSeq)
        const call = openCall(live, live.session.firstLiveSeq)
        if (call === undefined) throw new Error('resumed suffix hanging call absent')
        resumedCall = call
        expect(second.latch.starts).toBe(1)
      }, { timeout: 8_000, interval: 10 })

      // The first call occurs after the cold resume, but before the exact
      // Host-declared timeout. The old durable call cannot help it pass.
      expect(await second.tool('too-early', 'agent_swarm_interrupt_member', { name: 'worker' })).toMatchObject({
        isError: true, error: { info: { code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' } },
      })
      expect(interrupt).not.toHaveBeenCalled()

      await vi.waitFor(() => expect(Date.now() - resumedCall.time).toBeGreaterThanOrEqual(TIMEOUT), { timeout: 8_000, interval: 10 })
      const admitted = await second.tool('overdue', 'agent_swarm_interrupt_member', { name: 'worker' })
      expect(admitted.value).toEqual({
        name: 'worker', previous_status: 'running', evidence_kind: 'host-confirmed-tool-timeout',
      })
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(interrupt).toHaveBeenCalledWith(memberId, { kind: 'ancestor', agent: second.lead })
    } finally {
      second.latch.release()
      resume.mockRestore()
      interrupt.mockRestore()
    }
  }, 40_000)
})
