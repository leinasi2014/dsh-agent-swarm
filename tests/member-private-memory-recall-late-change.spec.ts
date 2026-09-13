/**
 * M2 recall — QA-readiness late-change evidence (task-6, tests-only).
 * Four PUBLIC-composition cases over the SAME real harness as
 * tests/member-private-memory-recall-real-composition.spec.ts (one helper,
 * no new framework): under the Host `active-task` grant, the list tool's
 * explicit DENY and ASK tiers each keep the automatic path absent while the
 * real member turn still delegates; and two async late windows of the
 * OFFICIAL request pipeline — the `agent/request` waterfall
 * (dsh-agent-loop lib/index.js:1143) and the public adapter
 * `prepareCall(provider, model, signal)` (dsh-llm types/index.d.ts:166-176,
 * invoked at lib/index.js:1153 AFTER the assembly froze) — are invalidated
 * mid-flight with the frozen request still carrying the old note: the
 * existing `llm/stream` re-verification must refuse (observable throw,
 * adapter zero-increment) without rewriting frozen messages.
 * Expected verdict for this slice is EVIDENCE THAT THE LOCKED GREEN
 * ALREADY PASSES; a failed premise is reported as a fixture problem, not a
 * product RED. ASK note: the PassiveAdapter-driven turns never invoke the
 * list tool, so no Approval-surface event is created or claimed here — only
 * the absence of the automatic path is asserted.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  PassiveAdapter, boundSetup, dispose, invalidateNote, latestNamedContribution, memberRequests, mount,
  requestText, runMemberTurn, type Mounted,
} from './helpers/private-memory-composition.js'

const RECALL_MARKER = '<private-memory-recall'

/** Local capture: latest frozen target request + cumulative dispatch count. */
interface LateCapture {
  targetSessionId: string
  entries: number
  last: GenerateOptions | undefined
}

function gateOptions(cap: LateCapture) {
  return {
    llmStreamOuterGate: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      if (cap.targetSessionId !== '' && String(options.sessionId ?? '') === cap.targetSessionId) {
        cap.entries += 1
        cap.last = options
      }
      return next()
    },
  }
}

/** Public adapter that fires a ONE-SHOT hook inside its own prepareCall
 *  await window — bound to ONE exact target route, so it can never fire for
 *  any other route (the Captain's mock/mock included). The prepared call is
 *  returned unchanged. */
class LatePrepareAdapter extends PassiveAdapter {
  readonly preparedRoutes: string[] = []
  lateHook: (() => Promise<void>) | undefined
  readonly targetRoute: string

  constructor(targetRoute: string) {
    super()
    this.targetRoute = targetRoute
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const route = `${provider}/${model}`
    this.preparedRoutes.push(route)
    const call = await super.prepareCall(provider, model, signal)
    if (this.lateHook !== undefined && route === this.targetRoute) {
      const hook = this.lateHook
      this.lateHook = undefined
      await hook()
    }
    return call
  }
}

describe('recall under operator tiers and official late-change windows', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  async function tierSkipsAuto(tier: 'deny' | 'ask'): Promise<void> {
    const sandbox = await mkdtemp(join(tmpdir(), `dsh-recall-${tier}-`))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, {
        privateMemoryRecall: 'active-task',
        ...(tier === 'deny' ? { toolPolicyDeny: ['agent_swarm_list_private_memory'] } : { toolPolicyAsk: ['agent_swarm_list_private_memory'] }),
      })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      // Full eligibility: matching note + own in-progress task really exist.
      const { setup, resolved } = await boundSetup(first, `ctx${tier}`, join(sandbox, 'workspace'))
      const before = memberRequests(adapter, setup.memberId).length
      await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
      const requests = memberRequests(adapter, setup.memberId)
      expect(requests.length, 'the real member turn still delegates under the explicit tier').toBe(before + 1)
      expect(requestText({ options: requests.at(-1)!.options }), 'the automatic contribution is absent under the explicit tier').not.toContain(RECALL_MARKER)
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }

  it('Host active-task + explicit DENY on the list tool: no automatic recall, real member turn still delegates', async () => {
    await tierSkipsAuto('deny')
  }, 90_000)

  it('Host active-task + explicit ASK on the list tool: the automatic path is skipped, real member turn still delegates', async () => {
    // Honest layer: these turns never call the list tool, so no observable
    // Approval surface appears and none is claimed — only the skip of the
    // automatic path plus normal delegation is measured.
    await tierSkipsAuto('ask')
  }, 90_000)

  it('late invalidation inside the official agent/request await window is refused at the final stream', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-agentreq-'))
    roots.push(sandbox)
    const cap: LateCapture = { targetSessionId: '', entries: 0, last: undefined }
    let targetAgent: Agent | undefined
    let note: { memoryId: string; headSeq: number } | undefined
    let mounted: Mounted | undefined
    let armed = false
    let hookHits = 0
    try {
      mounted = await mount(sandbox, {
        privateMemoryRecall: 'active-task',
        ...gateOptions(cap),
        agentRequestHook: async (payload, next) => {
          if (armed && targetAgent !== undefined && payload.agent === targetAgent) {
            armed = false
            hookHits += 1
            await invalidateNote(mounted!, targetAgent, note!)
          }
          return await next()
        },
      })
      const adapter = new PassiveAdapter()
      mounted.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note: created } = await boundSetup(mounted, 'ctxrequest', join(sandbox, 'workspace'))
      targetAgent = resolved.agent
      note = created
      cap.targetSessionId = setup.memberId
      // CONTROL first (same fixture, same config, no invalidation).
      const controlBefore = memberRequests(adapter, setup.memberId).length
      await runMemberTurn(resolved.agent, 'recallprobe request-window control')
      expect(memberRequests(adapter, setup.memberId).length, 'CONTROL delegates with the contribution').toBe(controlBefore + 1)
      expect(requestText({ options: memberRequests(adapter, setup.memberId).at(-1)!.options })).toContain(`data-memory-id="${note.memoryId}"`)
      // Arm: invalidate during THIS step's agent/request await window.
      armed = true
      const before = memberRequests(adapter, setup.memberId).length
      await runMemberTurn(resolved.agent, 'recallprobe request-window late turn')
      expect(hookHits, 'the late window fired exactly once for the target agent').toBe(1)
      expect(cap.entries, 'the request really reached the public llm/stream dispatch').toBe(2)
      expect(cap.last, 'premise: the gate froze the late request').toBeDefined()
      expect(latestNamedContribution(cap.last!, 'agent-swarm:private-memory-recall'), 'the frozen request\'s actual named contribution still carries the old note').toContain(`data-memory-id="${note.memoryId}"`)
      expect(memberRequests(adapter, setup.memberId).length, 'the late-invalidated request must never reach the adapter').toBe(before)
    } finally {
      if (mounted !== undefined) await dispose(mounted)
    }
  }, 90_000)

  it('late invalidation inside the public adapter prepareCall window is refused at the final stream', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-prepare-'))
    roots.push(sandbox)
    const cap: LateCapture = { targetSessionId: '', entries: 0, last: undefined }
    let mounted: Mounted | undefined
    try {
      mounted = await mount(sandbox, { privateMemoryRecall: 'active-task', ...gateOptions(cap) })
      // The member route is uniquely identified by its model id; the
      // one-shot hook is BOUND to that exact route and can never fire for
      // the Captain's mock/mock route.
      const lateModel = 'late-target-model'
      const targetRoute = `mock/${lateModel}`
      const adapter = new LatePrepareAdapter(targetRoute)
      mounted.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(mounted, 'ctxprepare', join(sandbox, 'workspace'), lateModel)
      cap.targetSessionId = setup.memberId
      // CONTROL first (same adapter, hook unarmed).
      const controlBefore = memberRequests(adapter, setup.memberId).length
      await runMemberTurn(resolved.agent, 'recallprobe prepare-window control')
      expect(memberRequests(adapter, setup.memberId).length, 'CONTROL delegates with the contribution').toBe(controlBefore + 1)
      expect(requestText({ options: memberRequests(adapter, setup.memberId).at(-1)!.options })).toContain(`data-memory-id="${note.memoryId}"`)
      // Baseline BEFORE arming: CONTROL (and any earlier assembly) already
      // prepared the target route; the assertion measures the LATE turn's
      // increment, not a cumulative total.
      const prepareBaseline = adapter.preparedRoutes.filter(route => route === targetRoute).length
      // Arm: invalidate INSIDE this step's adapter prepareCall await.
      adapter.lateHook = async () => {
        await invalidateNote(mounted!, resolved.agent, note)
      }
      const before = memberRequests(adapter, setup.memberId).length
      await runMemberTurn(resolved.agent, 'recallprobe prepare-window late turn')
      expect(adapter.preparedRoutes.filter(route => route === targetRoute).length - prepareBaseline, 'the late turn prepared the bound target route exactly once').toBe(1)
      expect(cap.entries, 'the request really reached the public llm/stream dispatch').toBe(2)
      expect(cap.last, 'premise: the gate froze the late request').toBeDefined()
      // The CURRENT official contribution of THIS request (named sections
      // on the latest runtime-context message) still carries the old note —
      // not a whole-history scan.
      expect(latestNamedContribution(cap.last!, 'agent-swarm:private-memory-recall'), 'the frozen request\'s actual named contribution still carries the old note').toContain(`data-memory-id="${note.memoryId}"`)
      expect(memberRequests(adapter, setup.memberId).length, 'the late-invalidated request must never reach the adapter stream').toBe(before)
    } finally {
      if (mounted !== undefined) await dispose(mounted)
    }
  }, 90_000)
})
