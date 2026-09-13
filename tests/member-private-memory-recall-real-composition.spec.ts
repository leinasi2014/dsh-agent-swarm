/**
 * M2 private-memory AUTO RECALL (active-task) — tests-only slice (task-6).
 * Contract: docs/04-core-protocol.md §7.1 lines 196-202 at pinned commit
 * 32884365c65251fea3b17cbf5d63129898016593. The first slice is bounded
 * lexical selection over the SAME folded history, granted ONLY by the Host
 * config `privateMemoryRecall: disabled | active-task` (omitted = disabled),
 * and every official model call must re-verify at the public `llm/stream`
 * delegation boundary before reaching the adapter.
 *
 * Member follow-up turns use the minimal causal setup proven by the official
 * sources: the resume passes an explicit ready mock route via the public
 * `agentOptions` (a bare resume defaults to `{}` and `prepareRequest`
 * rejects an empty provider/model BEFORE any stream), the live identity is
 * asserted through the public registry, and each turn is an
 * `agent.followup(...)` settled by `await agent.whenIdle()` (the real
 * AgentLoop path). Baselines are taken only after the official
 * `drainContinuableChildren` idle point. Requests are attributed CAUSALLY by
 * `GenerateOptions.sessionId`; assertions read the official message
 * `content` text blocks directly (no JSON escaping artifacts). The outer
 * `llm/stream` gate binds ONLY to a request for the armed member Session
 * issued AFTER arming.
 *
 * If the CONTROL case fails, it throws with PUBLIC diagnostics only: live
 * status, the durable mail phase from the official Team snapshot, adapter
 * counts, member roster phase, and the member Session's last event TYPES
 * (plus short payloads for `*error*` events) — no thinking content, no full
 * request headers or tool blobs.
 *
 * Contribution format is fixed by this test contract: the private section is
 * wrapped in `<private-memory-recall` and carries `data-memory-id="<id>"`
 * and `data-head-seq="<n>"` per selected note.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  PassiveAdapter, RECALL_MARKER, boundSetup, claimRecallTask, dispose, invalidateNote, memberAgent,
  memberRequests, mount, pollUntil, reentryOnce, requestText, runMemberTurn, setupActiveMember,
  tool, writeMatchingNote, type CaptureState, type Mounted, type Setup,
} from './helpers/private-memory-composition.js'
import * as AgentSwarm from '../src/index.js'

/** PUBLIC, diagnosis-only snapshot: event TYPES and short error payloads. */
async function diagnose(ctx: Context, setup: Setup, adapter: PassiveAdapter, before: number): Promise<string> {
  const agent = ctx.agents.get(SessionId(setup.memberId))
  let events: string[] = []
  if (agent !== undefined) {
    events = agent.session.snapshotEvents().slice(-12).map(event =>
      event.type.includes('error')
        ? `${event.type}:${JSON.stringify((event as { data?: unknown }).data).slice(0, 160)}`
        : event.type)
  }
  const snap = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(setup.lead), AgentSwarm.TeamId(setup.teamId), setup.lead.id)
  const mail = snap.team.messages.filter(message => message.targetSessionId === setup.memberId).at(-1)
  return JSON.stringify({
    live: agent !== undefined,
    memberRequestCount: memberRequests(adapter, setup.memberId).length,
    baseline: before,
    totalRequests: adapter.requests.length,
    mailPhase: mail?.phase ?? 'none',
    memberPhase: snap.team.members.find(member => member.sessionId === setup.memberId)?.phase ?? 'missing',
    lastEventTypes: events,
  })
}

interface GateState {
  targetSessionId: string
  armed: boolean
  targetBoundaryHits: number
  targetChainCompleted: boolean
  hold: (() => Promise<void>) | undefined
  holdExecuted: number
}

describe('private memory auto recall over the real llm/stream delegation boundary', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('CONTROL: without the Host grant, the routed follow-up member turn proceeds and carries no recall contribution', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-control-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox)
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const setup = await setupActiveMember(first, 'recallaa', join(sandbox, 'workspace'))
      const before = memberRequests(adapter, setup.memberId).length
      expect(before, 'activation settled exactly one real member request').toBe(1)
      const resolved = await memberAgent(first.ctx, setup.memberId, { provider: 'mock', model: 'mock' })
      try {
        // Live identity is the exact registered handle the route was minted for.
        expect(first.ctx.agents.get(SessionId(setup.memberId))).toBe(resolved.agent)
        await claimRecallTask(first, setup)
        await writeMatchingNote(first, resolved.agent)
        await runMemberTurn(resolved.agent, 'recallprobe follow-up turn')
        try {
          await pollUntil(() => memberRequests(adapter, setup.memberId).length >= before + 1, 10_000)
        } catch (error) {
          throw new Error(`${String(error)} — diagnostics: ${await diagnose(first.ctx, setup, adapter, before)}`, { cause: error })
        }
        expect(requestText(memberRequests(adapter, setup.memberId).at(-1)!)).not.toContain(RECALL_MARKER)
      } finally {
        await resolved.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('RED: with the Host grant and full eligibility, the routed member turn carries the private contribution with memoryId AND headSeq', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-inject-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, { privateMemoryRecall: 'active-task' })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const setup = await setupActiveMember(first, 'recallbb', join(sandbox, 'workspace'))
      const before = memberRequests(adapter, setup.memberId).length
      expect(before, 'activation settled exactly one real member request').toBe(1)
      const resolved = await memberAgent(first.ctx, setup.memberId, { provider: 'mock', model: 'mock' })
      try {
        expect(first.ctx.agents.get(SessionId(setup.memberId))).toBe(resolved.agent)
        await claimRecallTask(first, setup)
        const note = await writeMatchingNote(first, resolved.agent)
        await runMemberTurn(resolved.agent, 'recallprobe follow-up turn')
        expect(memberRequests(adapter, setup.memberId).length).toBe(before + 1)
        const text = requestText(memberRequests(adapter, setup.memberId).at(-1)!)
        // Fixed contribution format (this test IS the contract for rendering):
        // wrapper marker + data-memory-id + data-head-seq + the matched word.
        expect(text).toContain(RECALL_MARKER)
        expect(text).toContain(`data-memory-id="${note.memoryId}"`)
        expect(text).toContain(`data-head-seq="${note.headSeq}"`)
        expect(text).toContain('recallprobe')
      } finally {
        await resolved.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('RED: a durable invalidation applied INSIDE the armed target boundary vetoes the adapter delegation for that turn', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-veto-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    const gate: GateState = { targetSessionId: '', armed: false, targetBoundaryHits: 0, targetChainCompleted: false, hold: undefined, holdExecuted: 0 }
    try {
      first = await mount(sandbox, {
        privateMemoryRecall: 'active-task',
        // Registered BEFORE the plugin: OUTER listener (cordis waterfall
        // composes dispatch order outermost-first); plugin recall runs INNER.
        // Binds EXACTLY: armed requests for the TARGET session only.
        llmStreamOuterGate: (options, next) => {
          const isTarget = gate.armed && String(options.sessionId ?? '') === gate.targetSessionId
          if (!isTarget) return next()
          gate.targetBoundaryHits += 1
          return (async function * (): AsyncIterable<StreamChunk> {
            try {
              const hold = gate.hold
              if (hold !== undefined) {
                gate.hold = undefined
                await hold()
                gate.holdExecuted += 1
              }
              yield * next()
            } finally {
              gate.targetChainCompleted = true
            }
          })()
        },
      })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const setup = await setupActiveMember(first, 'recallcc', join(sandbox, 'workspace'))
      const before = memberRequests(adapter, setup.memberId).length
      expect(before, 'activation settled exactly one real member request').toBe(1)
      const resolved = await memberAgent(first.ctx, setup.memberId, { provider: 'mock', model: 'mock' })
      try {
        expect(first.ctx.agents.get(SessionId(setup.memberId))).toBe(resolved.agent)
        await claimRecallTask(first, setup)
        const note = await writeMatchingNote(first, resolved.agent)
        gate.targetSessionId = setup.memberId
        gate.hold = async () => {
          // A REAL durable maintenance write through the member's own live
          // turn handle, verified successful BEFORE the chain may continue.
          const liveMember = first!.ctx.agents.get(SessionId(setup.memberId))
          expect(liveMember, 'member must be live during its armed turn').toBeDefined()
          const invalidated = await tool(first!.ctx, liveMember!, 'rc-invalidate', 'agent_swarm_maintain_private_memory', {
            operation: 'invalidate', operation_id: 'op-recall-invalidate', target_memory_id: note.memoryId, expected_head_seq: note.headSeq,
          })
          expect(invalidated.isError, 'the durable invalidation must succeed').toBe(false)
          // Read back through the official list face: the selected note is
          // terminally invalidated BEFORE the delegation chain continues.
          const listed = await tool(first!.ctx, liveMember!, 'rc-list', 'agent_swarm_list_private_memory', {})
          const rows = (listed.value as { memories: Array<{ memory_id: string; status: string }> }).memories
          expect(rows.find(row => row.memory_id === note.memoryId)?.status).toBe('invalidated')
        }
        gate.armed = true
        await runMemberTurn(resolved.agent, 'recallprobe vetoed turn')
        expect(gate.targetBoundaryHits, 'exactly the armed member request reached the boundary').toBe(1)
        expect(gate.holdExecuted, 'the late invalidation ran exactly once').toBe(1)
        expect(gate.targetChainCompleted).toBe(true)
        // The vetoed turn must never reach the adapter (old builds reach it
        // → the member request count grows and this fails on behavior).
        expect(memberRequests(adapter, setup.memberId).length).toBe(before)
      } finally {
        await resolved.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('BOUND CONTROL: a NEW public llm/stream dispatch of the still-eligible frozen request is delegated normally (measurement works)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-bound-ctl-'))
    roots.push(sandbox)
    const cap: CaptureState = { targetSessionId: '', entries: 0, frozen: undefined }
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, {
        privateMemoryRecall: 'active-task',
        llmStreamOuterGate: (options, next) => {
          if (cap.targetSessionId !== '' && String(options.sessionId ?? '') === cap.targetSessionId) {
            cap.entries += 1
            cap.frozen ??= options
          }
          return next()
        },
      })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved } = await boundSetup(first, 'recalldd', join(sandbox, 'workspace'))
      const before = memberRequests(adapter, setup.memberId).length
      expect(before).toBe(1)
      cap.targetSessionId = setup.memberId
      await runMemberTurn(resolved.agent, 'recallprobe bound turn')
      expect(memberRequests(adapter, setup.memberId).length).toBe(before + 1)
      expect(cap.frozen, 'the gate captured the frozen member request').toBeDefined()
      expect(requestText({ options: cap.frozen! })).toContain(RECALL_MARKER)
      const count = memberRequests(adapter, setup.memberId).length
      const again = await reentryOnce(first.ctx, cap.frozen!)
      expect(again.threw, 'a still-eligible request may be re-delegated').toBe(false)
      expect(memberRequests(adapter, setup.memberId).length, 'the re-entry reached the adapter once').toBe(count + 1)
      expect(cap.entries, 'gate proves the turn plus the public re-entry each ran the waterfall').toBe(2)
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('RED: after a durable invalidation, every NEW public dispatch of the same frozen request is refused observably and never reaches the adapter', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-bound-inv-'))
    roots.push(sandbox)
    const cap: CaptureState = { targetSessionId: '', entries: 0, frozen: undefined }
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, {
        privateMemoryRecall: 'active-task',
        llmStreamOuterGate: (options, next) => {
          if (cap.targetSessionId !== '' && String(options.sessionId ?? '') === cap.targetSessionId) {
            cap.entries += 1
            cap.frozen ??= options
          }
          return next()
        },
      })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(first, 'recallee', join(sandbox, 'workspace'))
      cap.targetSessionId = setup.memberId
      await runMemberTurn(resolved.agent, 'recallprobe bound delegation')
      expect(cap.frozen, 'the gate captured the frozen member request').toBeDefined()
      // The frozen body CARRIES the contribution that later goes stale.
      expect(requestText({ options: cap.frozen! })).toContain(`data-memory-id="${note.memoryId}"`)
      const count = memberRequests(adapter, setup.memberId).length
      await invalidateNote(first, resolved.agent, note)
      // Execute BOTH re-entries fully BEFORE concluding, so a first-refusal
      // assertion failure can never short-circuit the second leak check.
      const refused = await reentryOnce(first.ctx, cap.frozen!)
      const again = await reentryOnce(first.ctx, cap.frozen!)
      // Leak check FIRST: the adapter NEVER grew — neither the refusal nor
      // the same stale request (whose body still carries the invalidated
      // contribution) may reach it. Admission binds to THIS REQUEST, not to
      // a cache entry the first refusal deleted (old builds pass re-entry #2
      // through → the growth is an independently visible RED).
      expect(memberRequests(adapter, setup.memberId).length, 'a refusal and the same stale request must NEVER reach the adapter').toBe(count)
      // Observable-failure shape (official contract keeps middleware
      // failures THROWN; old builds fabricate a successful empty stop).
      expect(refused.threw, 're-entry #1 refusal must surface as an observable failure, not a fabricated success').toBe(true)
      expect(again.threw, 're-entry #2 of the same stale request must also be refused').toBe(true)
      expect(cap.entries, 'gate proves every re-entry re-ran the guards').toBe(3)
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('RED: a newer real assembly does not launder the old frozen request after its note was invalidated', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-bound-new-'))
    roots.push(sandbox)
    const cap: CaptureState = { targetSessionId: '', entries: 0, frozen: undefined }
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, {
        privateMemoryRecall: 'active-task',
        llmStreamOuterGate: (options, next) => {
          if (cap.targetSessionId !== '' && String(options.sessionId ?? '') === cap.targetSessionId) {
            cap.entries += 1
            cap.frozen ??= options
          }
          return next()
        },
      })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(first, 'recallff', join(sandbox, 'workspace'))
      cap.targetSessionId = setup.memberId
      await runMemberTurn(resolved.agent, 'recallprobe old delegation')
      expect(cap.frozen, 'the gate captured the frozen member request').toBeDefined()
      expect(requestText({ options: cap.frozen! })).toContain(`data-memory-id="${note.memoryId}"`)
      await invalidateNote(first, resolved.agent, note)
      // A NEWER assembly through a real official turn (selects nothing now).
      const countAfterOld = memberRequests(adapter, setup.memberId).length
      await runMemberTurn(resolved.agent, 'recallprobe newer assembly')
      expect(memberRequests(adapter, setup.memberId).length).toBe(countAfterOld + 1)
      // Re-entry of the OLD frozen request: consume fully, then check the
      // leak FIRST so any adapter growth is an independently visible RED.
      const count = memberRequests(adapter, setup.memberId).length
      const again = await reentryOnce(first.ctx, cap.frozen!)
      expect(memberRequests(adapter, setup.memberId).length, 'the newer cache must not launder the old request to the adapter').toBe(count)
      expect(again.threw, 'the old request must be refused observably').toBe(true)
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('RED: with the exact Session unregistered at the public store face, the public assembly entry must not carry the private contribution', async () => {
    // HONEST LAYER (Root ruling): a public-interface negative in the exact
    // precedent shape of tests/identity-context.spec.ts:38-45 — a controlled
    // MISSING ctx.sessions.get for the exact Agent (unregistered/stand-in
    // exact Agent+Session behind the same Session ID), asserted through the
    // SAME public assembly entry the correct instance uses. It does NOT
    // claim to cover the normal dispose/resume recovery path: host evidence
    // (m2-gap2-diagnostic-attempt1.log) proved public dispose/resume rotates
    // the attempt, where the existing attempt-authority refusal already
    // refuses old requests (pre-rotation probe delegated; post-rotation
    // refused). The earlier same-attempt recovery experiment is retired as
    // unreachable through public API — no Domain/history/attempt fabrication.
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-assembly-neg-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, { privateMemoryRecall: 'active-task' })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(first, 'recallhh', join(sandbox, 'workspace'))
      const agent = resolved.agent
      const read = () => first!.ctx.systemPrompt.assemble(assembleContextFor(agent))
      // The named contribution may live in raw sections (today) OR come back
      // through the OFFICIAL renderContextSections output (GREEN: the context
      // may be a variable-indirected template — the official renderer yields
      // the model-facing text; the test never expands variables itself).
      // Eligibility-withdrawal semantics unchanged across RED→GREEN.
      const hasNote = async () => {
        const assembled = await read()
        return [...assembled.sections, ...renderContextSections(assembled)].some(section => section.name === 'agent-swarm:private-memory-recall' && section.text.includes(`data-memory-id="${note.memoryId}"`))
      }
      // ELIGIBILITY PRELUDE: the correct instance contributes via the same
      // public entry (proves eligibility AND the entry's sensitivity).
      expect(await hasNote(), 'the correct instance assembles its contribution at the public entry').toBe(true)
      const getSession = first.ctx.sessions.get.bind(first.ctx.sessions)
      const sessions = vi.spyOn(first.ctx.sessions, 'get').mockImplementation(id => id === agent.id ? undefined : getSession(id))
      try {
        // RED: exact Session unregistered → the plugin must withdraw this
        // member's private contribution entirely (old builds never consult
        // ctx.sessions.get → still contribute → behavior RED).
        expect(await hasNote(), 'an unregistered exact Session must withdraw the private contribution').toBe(false)
      } finally {
        sessions.mockRestore()
      }
      expect(await hasNote(), 'restoration must bring the contribution back').toBe(true)
      expect(setup.memberId, 'boundSetup completed').toBeTruthy()
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)
})
