/**
 * Issue #52 / D1: waking (wakeup) mail must never be acknowledged as
 * delivered before the frame is model-visible at the target.
 *
 * The M1D-2 real-Profile evidence (docs/development/2026-08-20-m1d2-
 * reload-recovery.md §7.1) caught a wakeup whose frame was durably inserted
 * into the target's pending inbox and acknowledged (`phase: delivered`),
 * then discarded unread by an official turn-lifecycle path — an aborted
 * turn's teardown and an Activation disposal drain both clear unclaimed
 * inbox work — leaving the store permanently "delivered" over a frame the
 * member never saw. Pending-inbox acceptance is TRANSIENT; the claimed
 * `user/message` history form is the only stable visibility fact.
 *
 * These tests compose the real services a deployment composes — AgentLoop
 * with the in-process spawn provider (real continuable members), JSONL
 * session persistence and the storage stack harness — and drive the exact
 * loss shape deterministically by holding the member's turns open.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

/**
 * Holds every member model turn open until `open()` (same contract as the
 * official-compat suite): a held turn keeps the member deterministically
 * `running` and any waking frame parked pending behind it, which is exactly
 * the D1 window. The hold is abortable, so an interrupt or drain rejects the
 * stream like a cancelled network call and disposal never waits on the gate.
 */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private gate: Promise<void>
  private releaseCurrent!: () => void

  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const held = this.gate
    const signal = options.signal
    if (signal !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
        const admit = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        void held.then(admit, admit)
      })
    } else {
      await held
    }
    const text = 'Held turn released.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Release the currently held turns; later turns are held again. */
  open(): void {
    const release = this.releaseCurrent
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
    release()
  }
}

type UserMessageLike = { content: Array<{ type: string, text?: string }> }

function carriesFrame(message: UserMessageLike, frame: string): boolean {
  return message.content.some(block => block.type === 'text' && block.text === frame)
}

/**
 * Count how often the exact framed text is model-visibly present for the
 * target: once per `user/message` history row plus once per still-pending
 * inbox projection entry (the same fold the runtime reconciles with).
 */
function acceptedFrames(events: readonly { type: string, data: any }[], frame: string): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'user/message' && carriesFrame(event.data, frame)) count += 1
  }
  const inbox: Record<'next-turn' | 'next-step', UserMessageLike[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const target = event.data.target as 'next-turn' | 'next-step'
    inbox[target].splice(event.data.start, event.data.removedCount ?? 0, ...(event.data.inserted as UserMessageLike[]))
  }
  for (const message of [...inbox['next-turn'], ...inbox['next-step']]) {
    if (carriesFrame(message, frame)) count += 1
  }
  return count
}

async function toolCall(ctx: Context, agent: { } & any, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

describe('wakeup delivery visibility (issue #52 / D1)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * The exact D1 shape, deterministically: the member's initial turn is held
   * open, so the wakeup frame parks PENDING in the durable inbox. The old
   * contract acknowledged on that transient form; the discard below (an
   * Activation disposal drain — the same official teardown a plugin reload,
   * removeMember or archive runs) then destroyed the only copy while the
   * store said delivered. The visibility gate keeps the message queued
   * through the discard and lets the next rescan redeliver exactly once.
   */
  it('never acknowledges a wakeup before its frame is claimed, and recovers a discarded pending frame exactly once', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-wakeup-visibility-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []
    const adapter = new GatedAdapter()

    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions') })
      await mountStorageStackOn(ctx, join(sandbox, 'storage'))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
      ctx.llm.registerAdapter(['mock'], adapter)
      const lead = ctx.agentLoop.create(
        SessionId('d1-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )

      const created = await toolCall(ctx, lead, 'create', 'agent_swarm_create', {
        name: 'D1 visibility team', description: 'Prove delivered never precedes model visibility.',
      })
      expect(created.isError).toBe(false)
      const teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
      const added = await toolCall(ctx, lead, 'add', 'agent_swarm_add_member', {
        name: 'parked-worker', role: 'Hold the waking frame pending.',
      })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      await vi.waitFor(() => {
        expect(adapter.requests.length).toBe(1)
        expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      }, { timeout: 5_000 })

      // The wakeup lands while the initial turn is held: the frame parks
      // pending in the durable inbox. The visibility gate must NOT
      // acknowledge on this transient form.
      const sent = await toolCall(ctx, lead, 'send', 'agent_swarm_send_message', {
        target: 'parked-worker', content: 'Visible exactly once or not delivered.', delivery: 'wakeup',
      })
      expect(sent.isError).toBe(false)
      const messageId = (sent.value as { message_id: string }).message_id
      expect((sent.value as { phase: string }).phase).toBe('queued')

      const scope = ctx.agentSwarm.scopeOf(lead)
      const frameOf = async (): Promise<string> => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
        return messageFrame(snapshot.team.messages.find(candidate => candidate.id === messageId)!)
      }
      const frame = await frameOf()

      // The pending acceptance is durable, but the message stays queued (the
      // delivery debt is unsettled) and is never resent while pending.
      await vi.waitFor(async () => {
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        expect(acceptedFrames(stored.events, frame)).toBe(1)
      }, { timeout: 5_000 })
      await ctx.agentSwarm.recoverAgent(lead)
      let snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      expect(snapshot.team.messages.find(candidate => candidate.id === messageId)?.phase).toBe('queued')

      // The official teardown discard: an Activation disposal drain clears
      // the unclaimed inbox (the same path a plugin reload, removeMember or
      // archive drives). The pending frame — the only copy — is destroyed.
      ctx.subagents.interrupt(SessionId(memberId), { kind: 'ancestor', agent: lead })
      await ctx.subagents.drainContinuableChildren(lead, [SessionId(memberId)])
      await vi.waitFor(async () => {
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        expect(acceptedFrames(stored.events, frame)).toBe(0)
      }, { timeout: 5_000 })

      // The rescan observes neither claimed nor pending acceptance and
      // redelivers: the cold-resumed member claims the fresh frame into
      // model-visible history (its turn holds open again), and ONLY THEN the
      // acknowledgement commits — delivered can no longer precede visibility.
      await ctx.agentSwarm.recoverAgent(lead)
      await vi.waitFor(async () => {
        snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
        expect(snapshot.team.messages.find(candidate => candidate.id === messageId)?.phase).toBe('delivered')
      }, { timeout: 25_000 })
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(acceptedFrames(stored.events, frame)).toBe(1)

      // Release the gate: the claimed turn completes; still exactly one
      // model-visible copy of the frame.
      adapter.open()
      await vi.waitFor(async () => {
        const settled = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        expect(acceptedFrames(settled.events, frame)).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 45_000)

  /**
   * The healthy fast path stays fast: a wakeup to an idle member is claimed
   * within its first pre-step, so the send itself still acknowledges
   * `delivered` without waiting for the member's (possibly long) turn to
   * complete.
   */
  it('acknowledges a wakeup promptly once the idle target claims the frame mid-turn', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-wakeup-prompt-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []
    const adapter = new GatedAdapter()

    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions') })
      await mountStorageStackOn(ctx, join(sandbox, 'storage'))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
      ctx.llm.registerAdapter(['mock'], adapter)
      const lead = ctx.agentLoop.create(
        SessionId('d1-prompt-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )

      const created = await toolCall(ctx, lead, 'create', 'agent_swarm_create', {
        name: 'D1 prompt team', description: 'The claimed form acknowledges in-send.',
      })
      expect(created.isError).toBe(false)
      const teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
      const added = await toolCall(ctx, lead, 'add', 'agent_swarm_add_member', {
        name: 'fresh-worker', role: 'Claim the waking frame immediately.',
      })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id

      // The member's initial turn is held; release it so the member settles
      // quiet before the wakeup (an idle-live member, or cold after the
      // activation settles — both are wakeup-resumable targets).
      adapter.open()
      await vi.waitFor(() => {
        const member = ctx.agents.get(SessionId(memberId))
        expect(member === undefined || member.status === 'idle').toBe(true)
      }, { timeout: 5_000 })
      await new Promise(resolve => setTimeout(resolve, 200))

      const sent = await toolCall(ctx, lead, 'send', 'agent_swarm_send_message', {
        target: 'fresh-worker', content: 'Claimed before acknowledged.', delivery: 'wakeup',
      })
      expect(sent.isError).toBe(false)
      // The resumed member claims the frame at its first pre-step (before the
      // held model request), so the acknowledgement completes in-send.
      expect((sent.value as { phase: string }).phase).toBe('delivered')
      const messageId = (sent.value as { message_id: string }).message_id
      const snapshot = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), teamId, lead.id)
      const frame = messageFrame(snapshot.team.messages.find(candidate => candidate.id === messageId)!)
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(acceptedFrames(stored.events, frame)).toBeGreaterThanOrEqual(1)
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
