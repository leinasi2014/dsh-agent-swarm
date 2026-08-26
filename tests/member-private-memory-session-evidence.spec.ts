/**
 * Real Session evidence for member private memory (2026-08-26): a REAL model
 * adapter, gated like the node-mapping suite, emits actual
 * `agent_swarm_add_private_memory` + `agent_swarm_list_private_memory` tool
 * calls on a genuine member AgentLoop turn (driven by the scheduler assignment).
 * The member's official append-only Session — read through the official
 * `sessionPersistence.inspect` — must contain the exact `tool/call` +
 * `tool/result` events with the durable content replayable, and the private
 * content must never be auto-injected into any `user/message` prompt.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal
const ASSIGNMENT_RE = /Task: (task-[a-z0-9-]+), revision (\d+)/
const PROBE_CONTENT = 'session-proven-note'

function latestUserText(options: GenerateOptions): string {
  const message = options.messages.toReversed().find(candidate => candidate.role === 'user')
  return message?.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n') ?? ''
}

/** Gated real adapter: an assignment turn (on release) emits real add + list tool calls. */
class PrivateMemoryProbeAdapter extends LlmAdapter {
  memberId: string | undefined
  addCalls = 0
  private gate: Promise<void>
  private releaseCurrent!: () => void
  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
  }
  open(): void {
    const release = this.releaseCurrent
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
    release()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { reject(options.signal!.reason instanceof Error ? options.signal!.reason : new Error('aborted')) }
        if (options.signal!.aborted) { abort(); return }
        options.signal!.addEventListener('abort', abort, { once: true })
        void this.gate.then(resolve, resolve)
      })
    } else {
      await this.gate
    }
    if (options.sessionId !== this.memberId || this.addCalls > 0) {
      for (const chunk of textChunks('Member ready.')) yield chunk
      return
    }
    const text = latestUserText(options)
    if (!ASSIGNMENT_RE.test(text)) {
      for (const chunk of textChunks('Member awaiting assignment.')) yield chunk
      return
    }
    this.addCalls += 1
    const addArgs = JSON.stringify({ content: PROBE_CONTENT, evidence_refs: ['ev-1'] })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: CallId('session-probe-add'), name: 'agent_swarm_add_private_memory', argumentsDelta: addArgs }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('session-probe-add'), name: 'agent_swarm_add_private_memory', arguments: addArgs } }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: CallId('session-probe-list'), name: 'agent_swarm_list_private_memory', argumentsDelta: '{}' }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('session-probe-list'), name: 'agent_swarm_list_private_memory', arguments: '{}' } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 9 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function tool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

describe('member private memory real Session evidence', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('drives a real AgentLoop turn emitting add + list, and proves the member Session carries exact tool/call + tool/result with no auto-injection', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-private-memory-session-evidence-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []
    await mountAgentLoopTestDependencies(ctx)
    fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
    await mountStorageStackOn(ctx, join(sandbox, 'storage'))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
    fibers.push(await ctx.plugin(SubagentService))
    fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
    fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs: 0 }))
    const probe = new PrivateMemoryProbeAdapter()
    ctx.llm.registerAdapter(['mock'], probe)
    const lead = ctx.agentLoop.create(
      SessionId(`session-evidence-lead-${Math.random().toString(36).slice(2, 8)}`),
      { provider: 'mock', model: 'mock' },
      { cwd: join(sandbox, 'workspace') },
    )
    try {
      const created = await tool(ctx, lead, 'se-create', 'agent_swarm_create', { name: 'Session evidence', description: 'Prove real Session tool events.' })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(ctx, lead, 'se-add-member', 'agent_swarm_add_member', { name: 'probe', role: 'Probe private memory.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      probe.memberId = memberId
      // First prove the member settled ACTIVE in the authoritative roster, so the
      // scheduler's assignment never lands on the provisioning boundary.
      await vi.waitFor(async () => {
        const snap = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
        expect(snap.team.members.find(member => member.sessionId === memberId)?.phase).toBe('active')
      }, { timeout: 15_000 })
      const task = await tool(ctx, lead, 'se-task', 'agent_swarm_create_task', {
        subject: 'session evidence', description: 'Drive a real member turn.', target_member: 'probe',
      })
      expect(task.isError).toBe(false)

      await vi.waitFor(async () => {
        probe.open()
        await new Promise(resolve => setTimeout(resolve, 150))
        // Flush the live child Session so buffered tool/result events reach the
        // durable medium that `inspect` reads (a cold-resident child keeps its log
        // buffered until a durability checkpoint).
        const live = ctx.sessions.get(SessionId(memberId))
        if (live !== undefined) await ctx.sessions.flush(live)
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        const calls = stored.events.filter(event => event.type === 'tool/call')
        const results = stored.events.filter(event => event.type === 'tool/result')
        expect(calls.some(event => (event.data as { name: string }).name === 'agent_swarm_add_private_memory')).toBe(true)
        expect(calls.some(event => (event.data as { name: string }).name === 'agent_swarm_list_private_memory')).toBe(true)
        expect(results.some(event => JSON.stringify(event.data).includes('private-memory-1'))).toBe(true)
      }, { timeout: 20_000 })

      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      // Pair each tool/result to its EXACT tool/call by callId (AgentLoop runs
      // parallel tool calls under one turn/step, so the durable `message.source.
      // callId` is the precise key, not the step index).
      const callOf = (callId: string) => stored.events.find(event => event.type === 'tool/call' && (event.data as { callId: string }).callId === callId)
      const resultOf = (callId: string) => stored.events.find(event => event.type === 'tool/result'
        && (event.data as { message: { source: { callId: string } } }).message.source.callId === callId)
      const addCall = callOf('session-probe-add')
      const listCall = callOf('session-probe-list')
      expect(addCall).toBeDefined()
      expect(listCall).toBeDefined()
      expect(JSON.parse((addCall!.data as { arguments: string }).arguments)).toMatchObject({ content: PROBE_CONTENT, evidence_refs: ['ev-1'] })
      expect(JSON.parse((listCall!.data as { arguments: string }).arguments)).toEqual({})
      const addResult = resultOf('session-probe-add')
      const listResult = resultOf('session-probe-list')
      expect(addResult).toBeDefined()
      expect(JSON.stringify(addResult!.data)).toContain('private-memory-1')
      expect(listResult).toBeDefined()
      expect(JSON.stringify(listResult!.data)).toContain(PROBE_CONTENT)
      expect(probe.addCalls).toBe(1)
      // No auto-injection: the private content never appears in a user-role prompt.
      const injectedAsPrompt = stored.events.some(event => event.type === 'user/message'
        && JSON.stringify(event.data.content).includes(PROBE_CONTENT))
      expect(injectedAsPrompt).toBe(false)
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 60_000)
})
