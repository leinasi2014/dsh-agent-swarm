/**
 * F2 (M1B): target-side stable message-id de-duplication across the mailbox
 * crash window.
 *
 * Both tests compose the real official services a deployment composes —
 * AgentLoop with the in-process spawn provider (real continuable members),
 * JSONL session persistence (real durable target artifacts) and the storage
 * stack harness (real `agent_swarm` Storage Domain aggregate) — so the
 * acceptance evidence is the target's actual durable Session log, never a
 * mocked inbox.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

/**
 * Holds every member model turn open until `open()` so a delivered message
 * stays un-claimed in the member's durable inbox between the injection and
 * the explicit rescan. The hold is abortable: cancelling the turn's signal
 * (interrupt/drain) rejects the stream like a cancelled network call, so
 * disposal never waits on the gate.
 */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly gate = new Promise<void>(resolve => { this.open = resolve })

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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
        const admit = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        signal.addEventListener('abort', abort, { once: true })
        void this.gate.then(admit, admit)
      })
    } else {
      await this.gate
    }
    const text = 'Held turn released.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Release every held turn (disposal path only). */
  declare open: () => void
}

function carriesFrame(message: UserMessage, frame: string): boolean {
  return message.content.some(block => block.type === 'text' && block.text === frame)
}

/**
 * Count how often the exact framed text is model-visibly present for the
 * target: once per `user/message` history row plus once per still-pending
 * inbox projection entry (the same fold the runtime reconciles with). A
 * claimed message moves from the inbox projection into history, so a healthy
 * delivery counts exactly 1 in every settled state.
 */
function acceptedFrames(events: readonly SessionEvent[], frame: string): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'user/message' && carriesFrame(event.data, frame)) count += 1
  }
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  for (const message of [...inbox['next-turn'], ...inbox['next-step']]) {
    if (carriesFrame(message, frame)) count += 1
  }
  return count
}

/** Read the target's current durable facts: the live Session, or the persisted log once it is cold. */
async function countTargetCopies(ctx: Context, sessionId: string, frame: string): Promise<number> {
  const live = ctx.agents.get(SessionId(sessionId))
  const events = live !== undefined
    ? live.session.events
    : (await ctx.sessionPersistence.inspect(SessionId(sessionId), SIGNAL)).events
  return acceptedFrames(events, frame)
}

describe('target-side message de-duplication (F2)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * Crash-window equivalence argument (kill -9 half-window injection):
   *
   * A process killed after the target durably accepted a message but before
   * the Store's delivered-acknowledgement commit leaves exactly three
   * durable facts: (1) the target Session log already contains the framed
   * message — claimed into `user/message` history once its turn ran, the
   * strongest durable acceptance form; (2) the authoritative aggregate still
   * records phase "queued"; and (3) after the reload the target member is
   * not live until something cold-resumes it. This test reproduces those
   * facts without killing the process: the real `subagents.followup`
   * performs a real durable acceptance and the member's turn checkpoint
   * claims it (1); a one-shot rejected `acknowledgeMessage` write leaves the
   * aggregate queued — byte-identical durable state to an uncommitted ack
   * (2); draining the member after the claim makes the target cold for the
   * rescan, exactly like a reloaded process whose members have not resumed
   * yet (3; draining after the claim cancels no mail, because the frame is
   * already history, not pending inbox). The rescan then enters through the
   * same `recoverAgent` → scheduler pass → `deliverQueuedMessage` path the
   * real reload recovery uses. Before the claim, the pending-inbox
   * acceptance form is also asserted durable (1a) — the fold covers both
   * forms.
   */
  it('scenario 5: crash after target inbox acceptance but before delivered ack folds redelivery into a make-up acknowledgement', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-message-dedup-'))
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
      const pluginFiber = await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })
      fibers.push(pluginFiber)
      ctx.llm.registerAdapter(['mock'], adapter)
      const lead = ctx.agentLoop.create(
        SessionId('dedup-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )

      const created = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('create'),
        name: 'agent_swarm_create',
        arguments: { name: 'Dedup team', description: 'Prove target-side stable-id folding across the crash window.' },
        agent: lead,
      })
      expect(created.isError).toBe(false)
      const teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
      const added = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'inbox-worker', role: 'Receive one durable peer message.' },
        agent: lead,
      })
      expect(added.isError).toBe(false)
      const memberSessionId = (added.value as { session_id: string }).session_id

      // Determinism: suppress event-driven idle rescans so the ONLY delivery
      // triggers are the inline send and the explicit reload-recovery rescan
      // below (the activation-recovery entry the real reload uses).
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})

      // Delivery observer: capture every framed followup text.
      const followupFrames: string[] = []
      const followup = ctx.subagents.followup.bind(ctx.subagents)
      const followupSpy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        for (const block of content) {
          if (block.type === 'text') followupFrames.push(block.text)
        }
        return await followup(parent, childId, content, options)
      })

      // Crash-window injection (2): the first store acknowledgement never commits.
      const acknowledge = vi.spyOn(ctx.agentSwarm.domain, 'acknowledgeMessage')
      acknowledge.mockRejectedValueOnce(new Error('simulated crash before the delivered ack commit'))

      const sent = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('send'),
        name: 'agent_swarm_send_message',
        arguments: { target: 'inbox-worker', content: 'Accept me exactly once across the crash window.', delivery: 'wakeup' },
        agent: lead,
      })
      expect(sent.isError).toBe(true)

      const scope = ctx.agentSwarm.scopeOf(lead)
      const queued = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      const message = queued.team.messages.find(candidate => candidate.content === 'Accept me exactly once across the crash window.')
      expect(message?.phase).toBe('queued')
      const frame = messageFrame(message!)

      // Durable fact (1a): the real followup accepted the real frame, and the
      // delivery path's checkpoint flush made that pending-inbox acceptance
      // durable before the rejected acknowledgement.
      await vi.waitFor(async () => {
        expect(acceptedFrames((await ctx.sessionPersistence.inspect(SessionId(memberSessionId), SIGNAL)).events, frame)).toBe(1)
      }, { timeout: 5_000 })

      // Durable fact (1b): let the member claim the frame into model-visible
      // history (the per-request turn checkpoint persists it) — the strongest
      // durable form of "target already accepted".
      adapter.open()
      await vi.waitFor(async () => {
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberSessionId), SIGNAL)
        expect(stored.events.some(event => event.type === 'user/message' && carriesFrame(event.data, frame))).toBe(true)
      }, { timeout: 5_000 })

      // Durable fact (2): the store still owes the delivered acknowledgement.
      const unacked = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      expect(unacked.team.messages.find(candidate => candidate.id === message?.id)?.phase).toBe('queued')

      // Durable fact (3): the reload leaves the member cold for the rescan.
      // (Draining after the claim cancels nothing: the frame is history.)
      ctx.subagents.interrupt(SessionId(memberSessionId), { kind: 'ancestor', agent: lead })
      await ctx.subagents.drainContinuableChildren(lead, [SessionId(memberSessionId)])
      await vi.waitFor(async () => {
        expect(ctx.agents.get(SessionId(memberSessionId))).toBeUndefined()
        expect(acceptedFrames((await ctx.sessionPersistence.inspect(SessionId(memberSessionId), SIGNAL)).events, frame)).toBe(1)
      }, { timeout: 5_000 })

      // The reload recovery rescan (schedulePass -> deliverQueuedMessage).
      await ctx.agentSwarm.recoverAgent(lead)
      await vi.waitFor(async () => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
        const settled = snapshot.team.messages.find(candidate => candidate.id === message?.id)
        expect(settled?.phase).toBe('delivered')
        expect(settled?.deliveredAt).toBeDefined()
      }, { timeout: 5_000 })

      // Exactly one model-visible copy at the target, one followup, make-up ack.
      expect(await countTargetCopies(ctx, memberSessionId, frame)).toBe(1)
      expect(followupFrames.filter(text => text === frame)).toHaveLength(1)
      expect(acknowledge.mock.calls.length).toBeGreaterThanOrEqual(2)
      idle.mockRestore()
      followupSpy.mockRestore()
      acknowledge.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Idempotent redelivery: repeated reload rescans of one queued message
   * while its acknowledgement keeps failing must leave exactly one copy in
   * the target's history — every retry after the first acceptance folds into
   * an acknowledgement attempt instead of a resend.
   */
  it('repeated deliverQueuedMessage rescans leave exactly one copy in the target history', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-message-idempotent-'))
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
      const pluginFiber = await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })
      fibers.push(pluginFiber)
      ctx.llm.registerAdapter(['mock'], adapter)
      const lead = ctx.agentLoop.create(
        SessionId('idempotent-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )

      const created = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('create'),
        name: 'agent_swarm_create',
        arguments: { name: 'Idempotent team', description: 'Prove repeated rescans stay single-copy.' },
        agent: lead,
      })
      expect(created.isError).toBe(false)
      const teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
      const added = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'steady-worker', role: 'Receive one message through repeated rescans.' },
        agent: lead,
      })
      expect(added.isError).toBe(false)
      const memberSessionId = (added.value as { session_id: string }).session_id

      // Determinism: suppress event-driven idle rescans; both explicit
      // `recoverAgent` calls below stand in for repeated reload recoveries.
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const followupFrames: string[] = []
      const followup = ctx.subagents.followup.bind(ctx.subagents)
      const followupSpy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        for (const block of content) {
          if (block.type === 'text') followupFrames.push(block.text)
        }
        return await followup(parent, childId, content, options)
      })
      const acknowledge = vi.spyOn(ctx.agentSwarm.domain, 'acknowledgeMessage')
      acknowledge.mockRejectedValue(new Error('acknowledge stays down across every rescan'))

      const sent = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('send'),
        name: 'agent_swarm_send_message',
        arguments: { target: 'steady-worker', content: 'Rescans must not duplicate me.', delivery: 'wakeup' },
        agent: lead,
      })
      expect(sent.isError).toBe(true)

      const scope = ctx.agentSwarm.scopeOf(lead)
      const queued = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      const message = queued.team.messages.find(candidate => candidate.content === 'Rescans must not duplicate me.')
      expect(message?.phase).toBe('queued')
      const frame = messageFrame(message!)

      // Durable acceptance, then let the member claim the frame into history
      // (same crash-window facts as scenario 5).
      await vi.waitFor(async () => {
        expect(acceptedFrames((await ctx.sessionPersistence.inspect(SessionId(memberSessionId), SIGNAL)).events, frame)).toBe(1)
      }, { timeout: 5_000 })
      adapter.open()
      await vi.waitFor(async () => {
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberSessionId), SIGNAL)
        expect(stored.events.some(event => event.type === 'user/message' && carriesFrame(event.data, frame))).toBe(true)
      }, { timeout: 5_000 })

      // Two reload-equivalent rescans while the ack store stays down.
      ctx.subagents.interrupt(SessionId(memberSessionId), { kind: 'ancestor', agent: lead })
      await ctx.subagents.drainContinuableChildren(lead, [SessionId(memberSessionId)])
      await ctx.agentSwarm.recoverAgent(lead)
      await ctx.agentSwarm.recoverAgent(lead)
      await vi.waitFor(() => {
        expect(acknowledge.mock.calls.length).toBeGreaterThanOrEqual(3)
      }, { timeout: 5_000 })

      // Every rescan folded into an ack attempt: still one copy, one send.
      expect(await countTargetCopies(ctx, memberSessionId, frame)).toBe(1)
      expect(followupFrames.filter(text => text === frame)).toHaveLength(1)

      // Recovery: once the store accepts again, the pending ack commits.
      acknowledge.mockRestore()
      await ctx.agentSwarm.recoverAgent(lead)
      await vi.waitFor(async () => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
        const settled = snapshot.team.messages.find(candidate => candidate.id === message?.id)
        expect(settled?.phase).toBe('delivered')
      }, { timeout: 5_000 })
      expect(await countTargetCopies(ctx, memberSessionId, frame)).toBe(1)
      expect(followupFrames.filter(text => text === frame)).toHaveLength(1)
      idle.mockRestore()
      followupSpy.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
