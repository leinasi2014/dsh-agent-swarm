/**
 * M2 recall vs official compaction — DIAGNOSTIC-CORRECTION evidence
 * (task-8, tests-only; the product is the UNCHANGED frozen
 * member-private-memory-recall.ts 9661BAD6…).
 *
 * Real Profile blocker re-diagnosed with host causal evidence
 * (attempt6 agent_swarm.json + agent-loop logs): the frozen window's own
 * attempt was fenced STALE by an assignment-delivery failure
 * ("subagent unavailable", occurredAt 13:17:21.847Z — after the legal
 * recall pass at 21.838Z, next to the compaction failure at 21.861Z),
 * provoked by the fixture pattern that manually resumed and held the
 * member outside the official continuable-manager flow. The refusal was
 * therefore the guard CORRECTLY protecting a fenced contribution, not a
 * compaction-boundary product defect — and per Root, a stale/cancelled
 * tuple must never be forwarded for the scenario's sake.
 *
 * Official facts verified read-only against the U runtime
 * (dsh-compaction-basic lib/index.js): compactNow runs ONLY on an idle
 * agent via runMaintenance (:944-965) — it never changes the Team
 * attempt phase — and summarizeWithLlm (:282-302) calls ctx.llm.stream
 * with purpose "compaction", sessionId = agent.session.id and
 * [...window, instruction]. On a healthy member (claimed task
 * in_progress, current attempt RUNNING, notes active) the frozen window
 * still carries the CURRENT legal tuple, so the existing guard passes
 * the official compaction shape. The cases below prove exactly that, and
 * that a stale fence or note invalidation still refuses.
 * Honest layer: these are boundary facts over the public plugin seam, not
 * a reproduction of the full official compaction pipeline (host
 * attempt6: snapshot seq30 → start34 → end35(error) remains that evidence).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PassiveAdapter, boundSetup, dispose, invalidateNote, latestNamedContribution, memberRequests,
  mount, reentryOnce, runMemberTurn, snapshot, tool, type Mounted,
} from './helpers/private-memory-composition.js'

const RECALL_NAME = 'agent-swarm:private-memory-recall'

/** The official summarizeWithLlm request shape (U dsh-compaction-basic
 *  lib/index.js:282-302) over THIS member's frozen window. */
function compactionOptions(frozen: GenerateOptions): GenerateOptions {
  return {
    ...frozen,
    messages: [...(frozen.messages ?? []), createUserMessage({
      content: [{ type: 'text', text: 'Summarize the conversation so far.' }],
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    })],
    maxTokens: 1024,
    purpose: 'compaction',
  } as GenerateOptions
}

async function consume(options: GenerateOptions, ctx: Mounted['ctx']): Promise<'consumed' | 'refused'> {
  try {
    for await (const chunk of ctx.llm.stream(options)) void chunk
    return 'consumed'
  } catch {
    return 'refused'
  }
}

describe('recall vs the official compaction shape (frozen guard unchanged)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('a healthy idle member passes the official compaction shape with its CURRENT legal tuple', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-cmp-ok-'))
    roots.push(sandbox)
    let mounted: Mounted | undefined
    try {
      mounted = await mount(sandbox, { privateMemoryRecall: 'active-task' })
      const adapter = new PassiveAdapter()
      mounted.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(mounted, 'cmpok', join(sandbox, 'workspace'))
      await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
      await resolved.agent.whenIdle() // compactNow's precondition: idle agent
      const frozen = memberRequests(adapter, setup.memberId).at(-1)!.options
      // Causal premise (read back, never inferred from whenIdle): the task
      // is in_progress with its CURRENT attempt RUNNING — the same state
      // compactNow's runMaintenance leaves untouched.
      const board = await snapshot(mounted.ctx, setup.lead, setup.teamId)
      const claimed = board.team.tasks.find(row => row.ownerSessionId === setup.memberId && row.status === 'in_progress')
      expect(claimed, 'premise: member owns the in-progress task').toBeDefined()
      const current = board.team.attempts.find(attempt => attempt.id === claimed!.currentAttemptId)
      expect(current?.phase, 'premise: the current attempt is running').toBe('running')
      expect(current?.memberSessionId, 'premise: the attempt belongs to the member').toBe(setup.memberId)
      const before = memberRequests(adapter, setup.memberId).length
      expect(await consume(compactionOptions(frozen), mounted.ctx), 'the official shape passes with a current legal tuple').toBe('consumed')
      expect(memberRequests(adapter, setup.memberId).length, 'the summary really delegated once').toBe(before + 1)
      const summary = memberRequests(adapter, setup.memberId).at(-1)!.options
      expect(latestNamedContribution(summary, RECALL_NAME), 'the summary input carries the verified named contribution').toContain(`data-memory-id="${note.memoryId}"`)
    } finally {
      if (mounted !== undefined) await dispose(mounted)
    }
  }, 90_000)

  it('a stale assignment fence refuses the compaction shape — the correct protection behind the real blocker', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-cmp-stale-'))
    roots.push(sandbox)
    let mounted: Mounted | undefined
    try {
      mounted = await mount(sandbox, { privateMemoryRecall: 'active-task' })
      const adapter = new PassiveAdapter()
      mounted.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved } = await boundSetup(mounted, 'cmpstale', join(sandbox, 'workspace'))
      await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
      await resolved.agent.whenIdle()
      const frozen = memberRequests(adapter, setup.memberId).at(-1)!.options
      // Fence the attempt stale through the real captain cancel face
      // (the assignment-delivery-failure fence in the real scenario).
      const board = await snapshot(mounted.ctx, setup.lead, setup.teamId)
      const claimed = board.team.tasks.find(row => row.ownerSessionId === setup.memberId && row.status === 'in_progress')
      expect(claimed, 'premise: member owns the in-progress task').toBeDefined()
      const cancelled = await tool(mounted.ctx, setup.lead, 'cmp-cancel', 'agent_swarm_cancel_task', {
        request_id: 'cmp-cancel-1', task_id: claimed!.id, expected_revision: claimed!.revision, reason: 'fixture fence (assignment delivery failure analogue)',
      })
      expect(cancelled.isError, 'the captain cancel itself succeeds').toBe(false)
      const fenced = (await snapshot(mounted.ctx, setup.lead, setup.teamId)).team.attempts.find(attempt => attempt.id === claimed!.currentAttemptId)
      expect(fenced?.phase, 'premise: the attempt is fenced stale').toBe('stale')
      const before = memberRequests(adapter, setup.memberId).length
      expect(await consume(compactionOptions(frozen), mounted.ctx), 'a fenced tuple is never forwarded, compaction included').toBe('refused')
      expect(memberRequests(adapter, setup.memberId).length, 'refusal never reaches the adapter').toBe(before)
    } finally {
      if (mounted !== undefined) await dispose(mounted)
    }
  }, 90_000)

  it('a note invalidated after the frozen window refuses the compaction shape too', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-cmp-note-'))
    roots.push(sandbox)
    let mounted: Mounted | undefined
    try {
      mounted = await mount(sandbox, { privateMemoryRecall: 'active-task' })
      const adapter = new PassiveAdapter()
      mounted.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(mounted, 'cmpnote', join(sandbox, 'workspace'))
      await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
      await resolved.agent.whenIdle()
      const frozen = memberRequests(adapter, setup.memberId).at(-1)!.options
      await invalidateNote(mounted, resolved.agent, note)
      const before = memberRequests(adapter, setup.memberId).length
      expect(await consume(compactionOptions(frozen), mounted.ctx), 'an expired contribution never summarizes').toBe('refused')
      expect(memberRequests(adapter, setup.memberId).length).toBe(before)
    } finally {
      if (mounted !== undefined) await dispose(mounted)
    }
  }, 90_000)

  it('ordinary-request boundary is unchanged: invalidated-note replay still refuses (gap1 semantics)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recall-cmp-ordinary-'))
    roots.push(sandbox)
    let mounted: Mounted | undefined
    try {
      mounted = await mount(sandbox, { privateMemoryRecall: 'active-task' })
      const adapter = new PassiveAdapter()
      mounted.ctx.llm.registerAdapter(['mock'], adapter)
      const { setup, resolved, note } = await boundSetup(mounted, 'cmpord', join(sandbox, 'workspace'))
      await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
      const frozen = memberRequests(adapter, setup.memberId).at(-1)!.options
      await invalidateNote(mounted, resolved.agent, note)
      const before = memberRequests(adapter, setup.memberId).length
      expect((await reentryOnce(mounted.ctx, frozen)).threw, 'stale ordinary replay keeps refusing').toBe(true)
      expect(memberRequests(adapter, setup.memberId).length, 'refusal never reaches the adapter').toBe(before)
    } finally {
      if (mounted !== undefined) await dispose(mounted)
    }
  }, 90_000)
})
