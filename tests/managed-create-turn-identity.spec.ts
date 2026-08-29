/**
 * Turn-scoped managed-Team identity (real Session-log turns).
 *
 * The managed create idempotency key MUST NOT be the bare callId. The durable
 * key is MainBrainSessionId + turn, taken from the OFFICIAL Session log's
 * `tool/call` events (their `data.turn`); `rootCallId` only groups code-mode
 * sub-calls and is not the turn.
 *
 * These tests drive the Main Brain through REAL AgentLoop turns
 * (`lead.followup(createUserMessage(...))` + `lead.whenIdle()`), so each
 * create_managed call really carries a Session-log turn — the test asserts:
 *   A) two create_managed calls in the SAME turn but with DIFFERENT callIds
 *      resolve to ONE Team (a bare-callId key would wrongly stack duplicates);
 *   B) a create_managed call in a DIFFERENT turn resolves to an INDEPENDENT
 *      Team.
 *
 * The session-context adapter is session-scoped: only the Main Brain's session
 * emits create_managed; the spawned Captain's own turn plain-stops so it never
 * re-enters creation.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

type ToolCallEvent = Extract<import('@deepseek-ai/dsh-session').SessionEvent, { type: 'tool/call' }>

/** Build one generation's stream chunks: the given tool calls, then usage + finish. */
function toolTurn(...calls: Array<{ callId: string; name: string; args: unknown }>): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    const args = JSON.stringify(call.args)
    const id = CallId(call.callId)
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args })
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } })
  })
  chunks.push({ type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
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

/**
 * Session-scoped scripted adapter: a scripted queue drives ONLY the Main Brain
 * session's generations; every other session (the spawned Captain's own turn)
 * answer a plain stop so provisioning never re-enters managed creation.
 */
class MainBrainTurnAdapter extends LlmAdapter {
  leadCalls = 0
  /** Main Brain session id; bound after the lead Agent is created. */
  mainBrainId = ''
  constructor(private readonly script: StreamChunk[][]) {
    super()
  }
  /** Refill the scripted queue so each `driveTurn` advances exactly ONE real
   *  Session turn (`lead.followup` would otherwise consume the whole queue in a
   *  single drive, running both turns inside the first driveTurn). */
  append(...entries: StreamChunk[][]): void {
    this.script.push(...entries)
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.mainBrainId) {
      for (const chunk of textChunks('Provisioning ack.')) yield chunk
      return
    }
    this.leadCalls += 1
    const response = this.script.shift() ?? textChunks('Done.')
    for (const chunk of response) yield chunk
  }
}

async function mountMainBrain(sandbox: string, adapter: MainBrainTurnAdapter) {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn', memberMaxDepth: 1, captainLlmProvider: 'mock', captainModel: 'mock',
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`turn-lead-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  return { ctx, fibers, lead }
}

async function driveTurn(lead: Agent, adapter: MainBrainTurnAdapter, text: string): Promise<void> {
  const before = adapter.leadCalls
  lead.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await vi.waitFor(() => expect(adapter.leadCalls).toBeGreaterThan(before), { timeout: 15_000 })
  await lead.whenIdle()
}

async function managedCalls(ctx: Context, leadId: SessionId): Promise<ToolCallEvent[]> {
  const live = ctx.sessions.get(leadId)
  if (live !== undefined) await ctx.sessions.flush(live)
  const stored = await ctx.sessionPersistence.inspect(leadId, SIGNAL)
  return stored.events.filter((event): event is ToolCallEvent =>
    event.type === 'tool/call' && (event.data as { name: string }).name === 'agent_swarm_create_managed')
}

async function activeTeamCount(ctx: Context, lead: Agent): Promise<number> {
  const teams = await ctx.agentSwarm.listTeamAggregates(ctx.agentSwarm.scopeOf(lead))
  return teams.filter(team => team.phase === 'active').length
}

describe('managed create durable key = MainBrainSessionId + turn (not callId)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('A: two create_managed calls in the SAME turn with DIFFERENT callIds resolve to ONE Team', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-turn-same-'))
    roots.push(sandbox)
    // Turn 1 gen 1 → two create_managed calls (different callId) in one turn;
    // turn 1 gen 2 → plain stop (agent continues/returns). No second turn.
    const adapter = new MainBrainTurnAdapter([
      toolTurn(
        { callId: 'turn-same-a', name: 'agent_swarm_create_managed', args: { name: 'Same A', description: 'Same turn.' } },
        { callId: 'turn-same-b', name: 'agent_swarm_create_managed', args: { name: 'Same B', description: 'Same turn.' } },
      ),
      textChunks('Both created.'),
    ])
    const mounted = await mountMainBrain(sandbox, adapter)
    adapter.mainBrainId = mounted.lead.id
    const fibers = mounted.fibers
    try {
      // Capture BOTH create_managed return values through the real tool result
      // channel and assert (beyond the Team count) that both calls succeed and
      // resolve to the IDENTICAL Captain/Team.
      const results = new Map<string, { team_id?: string; captain_session_id?: string }>()
      mounted.ctx.on('tools/result', (exec, result) => {
        if (exec.name !== 'agent_swarm_create_managed') return
        const value = result.isError ? undefined : result.value as { team_id: string; captain_session_id: string }
        results.set(String(exec.callId), value === undefined
          ? {}
          : { team_id: value.team_id, captain_session_id: value.captain_session_id })
      })

      await driveTurn(mounted.lead, adapter, 'Create two Teams in one turn.')

      // Same turn, different callId — proven from the OFFICIAL Session log.
      const calls = await managedCalls(mounted.ctx, mounted.lead.id)
      expect(calls).toHaveLength(2)
      expect(calls[0]!.data.turn).toBe(calls[1]!.data.turn)
      expect(calls[0]!.data.callId).not.toBe(calls[1]!.data.callId)

      // The durable key is the same (same mainSessionId + same turn), so a
      // single Team must result — both calls resolve to that same Captain/Team.
      expect(await activeTeamCount(mounted.ctx, mounted.lead)).toBe(1)

      // Both tool calls SUCCEED and return the IDENTICAL team_id + captain id.
      const left = results.get('turn-same-a')
      const right = results.get('turn-same-b')
      expect(left?.team_id).toBeDefined()
      expect(right?.team_id).toBeDefined()
      expect(left?.team_id).toBe(right?.team_id)
      expect(left?.captain_session_id).toBe(right?.captain_session_id)
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  })

  it('B: a create_managed call in a DIFFERENT turn resolves to an INDEPENDENT Team', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-turn-diff-'))
    roots.push(sandbox)
    // Turn 1 → one create_managed; continuation stop. Turn 2's script is fed
    // after the first `driveTurn` settles, so each driveTurn is exactly one
    // real Session turn (lead.followup otherwise drains the whole queue in a
    // single drive and runs both turns inside the first driveTurn).
    const adapter = new MainBrainTurnAdapter([
      toolTurn({ callId: 'turn-one', name: 'agent_swarm_create_managed', args: { name: 'Turn One', description: 'First turn.' } }),
      textChunks('First turn done.'),
    ])
    const mounted = await mountMainBrain(sandbox, adapter)
    adapter.mainBrainId = mounted.lead.id
    const fibers = mounted.fibers
    try {
      await driveTurn(mounted.lead, adapter, 'Create one Team.')
      expect(await activeTeamCount(mounted.ctx, mounted.lead)).toBe(1)

      adapter.append(
        toolTurn({ callId: 'turn-two', name: 'agent_swarm_create_managed', args: { name: 'Turn Two', description: 'Second turn.' } }),
        textChunks('Second turn done.'),
      )
      await driveTurn(mounted.lead, adapter, 'Create another Team in a new turn.')

      // Two distinct turns in the OFFICIAL Session log → two independent Teams.
      const calls = await managedCalls(mounted.ctx, mounted.lead.id)
      expect(calls).toHaveLength(2)
      expect(calls[0]!.data.turn).not.toBe(calls[1]!.data.turn)
      expect(await activeTeamCount(mounted.ctx, mounted.lead)).toBe(2)
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  })
})
