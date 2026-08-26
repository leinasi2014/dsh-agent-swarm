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
const HANG = 'test_model_interrupt_hang'
const TIMEOUT = 75
class Latch {
  private releaseFn!: () => void
  private readonly waitForRelease = new Promise<void>(resolve => { this.releaseFn = resolve })
  starts = 0
  release(): void { this.releaseFn() }
  async wait(): Promise<void> { this.starts += 1; await this.waitForRelease }
}
class Adapter extends LlmAdapter {
  private openFn!: () => void
  private readonly join = new Promise<void>(resolve => { this.openFn = resolve })
  private opened = false
  private hung = false
  wakeups = 0
  open(): void { this.opened = true; this.openFn() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
  private text(options: GenerateOptions): string {
    const message = options.messages.toReversed().find(candidate => candidate.role === 'user')
    return message?.content.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n') ?? ''
  }
  private async wait(signal: AbortSignal | undefined): Promise<void> {
    if (this.opened) return
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      if (signal?.aborted) return abort()
      const done = (): void => { signal?.removeEventListener('abort', abort); resolve() }
      signal?.addEventListener('abort', abort, { once: true }); void this.join.then(done, done)
    })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.text(options)
    await this.wait(options.signal)
    if (!this.hung && text.includes('Team assignment from captain.')) {
      this.hung = true
      const id = CallId('member-hanging-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: HANG, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: HANG, arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (text.includes('recover-after-interrupt')) this.wakeups += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Acknowledged.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const roots: string[] = []
const stacks: Array<{ fibers: Fiber[] }> = []
afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)
async function mount(root: string, adapter: Adapter) {
  const ctx = new Context(); const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(root, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService)); fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  const latch = new Latch()
  ctx.effect(() => ctx.tools.register(defineTool({ name: HANG, description: 'Test hanging declared-timeout tool.', parameters: {}, timeoutMs: TIMEOUT,
    output: { schema: { type: 'object', additionalProperties: false, properties: { released: { type: 'boolean', required: true } } }, render: () => [] },
    execute: async () => { await latch.wait(); return { released: true } },
  })), 'test hanging tool')
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId(`interrupt-lead-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(root, 'workspace') })
  const tool = async (callId: string, name: string, args: Record<string, unknown> = {}) => await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent: lead })
  const created = await tool('create', 'agent_swarm_create', { name: 'Interrupt evidence', description: 'Real model tool evidence.' })
  if (created.isError) throw new Error(JSON.stringify(created.error))
  stacks.push({ fibers })
  return { ctx, lead, latch, tool, teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id), scope: ctx.agentSwarm.scopeOf(lead) }
}

describe('model interrupt admission over the real official composition', () => {
  it('rejects a recent call, then interrupts only the overdue live child and recovers by wakeup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-interrupt-real-')); roots.push(root)
    const adapter = new Adapter(); const stack = await mount(root, adapter)
    const add = await stack.tool('add', 'agent_swarm_add_member', { name: 'worker', role: 'interrupt proof worker' })
    expect(add.isError).toBe(false)
    const memberId = (add.value as { session_id: string }).session_id
    await vi.waitFor(() => expect(stack.ctx.agents.get(SessionId(memberId))?.status).toBe('running'), { timeout: 5_000, interval: 5 })
    expect((await stack.tool('task', 'agent_swarm_create_task', { subject: 'Preserve ownership', description: 'Model call hangs.' })).isError).toBe(false)
    adapter.open()
    const snapshot = async () => await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
    await vi.waitFor(async () => expect((await snapshot()).team.tasks[0]).toMatchObject({ ownerSessionId: memberId, status: 'in_progress' }), { timeout: 5_000, interval: 5 })
    let call!: Extract<SessionEvent, { type: 'tool/call' }>
    await vi.waitFor(() => {
      const live = stack.ctx.agents.get(SessionId(memberId)); expect(live).toBeDefined()
      if (live === undefined) throw new Error('member not live')
      const suffix = live.session.events.filter(event => event.seq >= live.session.firstLiveSeq)
      const found = suffix.find((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call' && event.data.name === HANG)
      if (found === undefined) throw new Error('hanging call absent')
      expect(suffix.some(event => event.type === 'tool/result' && event.seq > found.seq && event.data.turn === found.data.turn && event.data.step === found.data.step && event.data.message.source.callId === found.data.callId)).toBe(false)
      call = found
    }, { timeout: 5_000, interval: 5 })
    await vi.waitFor(() => expect(stack.latch.starts).toBe(1), { timeout: 5_000, interval: 5 })
    const realInterrupt = stack.ctx.subagents.interrupt.bind(stack.ctx.subagents)
    const interrupt = vi.spyOn(stack.ctx.subagents, 'interrupt').mockImplementation((id, cause) => realInterrupt(id, cause))
    try {
      const before = await snapshot()
      expect(await stack.tool('recent', 'agent_swarm_interrupt_member', { name: 'worker' })).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' } } })
      expect(interrupt).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before)
      await vi.waitFor(() => expect(Date.now() - call.time).toBeGreaterThanOrEqual(TIMEOUT), { timeout: 5_000, interval: 5 })
      const admitted = await stack.tool('overdue', 'agent_swarm_interrupt_member', { name: 'worker' })
      expect(admitted.value).toEqual({ name: 'worker', previous_status: 'running', evidence_kind: 'host-confirmed-tool-timeout' })
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(interrupt).toHaveBeenCalledWith(SessionId(memberId), { kind: 'ancestor', agent: stack.lead })
      const after = await snapshot()
      expect(after.team.members).toEqual(before.team.members)
      expect(after.team.tasks[0]).toMatchObject({ ownerSessionId: before.team.tasks[0]?.ownerSessionId, currentAttemptId: before.team.tasks[0]?.currentAttemptId })
      expect(after.team.messages).toEqual(before.team.messages)
      stack.latch.release()
      expect((await stack.tool('wakeup', 'agent_swarm_send_message', { target: 'worker', content: 'recover-after-interrupt', delivery: 'wakeup' })).isError).toBe(false)
      await vi.waitFor(() => expect(adapter.wakeups).toBe(1), { timeout: 5_000, interval: 5 })
    } finally { stack.latch.release(); interrupt.mockRestore() }
  }, 30_000)
})
