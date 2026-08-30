/**
 * Issue #60 / P2-1: an assignment checkpoint must never record `delivered`
 * before its frame is model-visible at the member — the #52 / D1 claimed-gate
 * generalized from waking mail to the assignment acknowledgement path.
 *
 * The assignment visibility contract in docs/04 caught the D1-same-class
 * window: `dispatchAssignment`
 * acknowledged as soon as the followup returned, but a followup's return only
 * proves inbox ADMISSION — the pending form, which the official teardown a
 * reload, shutdown or removal runs (`finishDisposal` cancels `{kind:'parent'}`
 * without `keepInbox`) durably discards. An assignment parked behind a
 * running member could therefore be recorded delivered, discarded unread, and
 * left permanently unrecoverable: the reserved re-dispatch lane only drives
 * `reserved` attempts, the stranded self-heal only revives live-idle owners,
 * and a cold owner is evidence-only.
 *
 * These tests compose the real services a deployment composes — AgentLoop
 * with the in-process spawn provider (real continuable members), JSONL
 * session persistence and the storage stack harness — and drive the exact
 * loss shape deterministically: the member self-claims (the
 * `agent_swarm_claim_task` surface) while its turn is held, so the next
 * scheduling pass delivers the reserved attempt into the RUNNING member's
 * inbox where the frame parks pending.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { assignmentPrompt } from '../src/runtime/prompts.js'
import type { TeamState, TeamTask } from '../src/domain/types.js'
import {
  addMember,
  driveRecoveryPasses,
  mount,
  settleCaptain,
  SIGNAL,
  snapshotOf,
  spyFollowup,
  toolCall,
} from './helpers/gated-composition.js'

type UserMessageLike = { content: Array<{ type: string, text?: string }> }
type SessionEventLike = { type: string, data: any }

function carriesFrame(message: UserMessageLike, frame: string): boolean {
  return message.content.some(block => block.type === 'text' && block.text === frame)
}

/**
 * How often the exact framed assignment text is model-visibly CLAIMED at the
 * member: one count per `user/message` history row. This is the only form no
 * official turn lifecycle can discard.
 */
function claimedFrames(events: readonly SessionEventLike[], frame: string): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'user/message' && carriesFrame(event.data, frame)) count += 1
  }
  return count
}

/**
 * Claimed rows plus still-pending inbox projection entries (the same fold the
 * runtime reconciles with): the TRANSIENT acceptance form.
 */
function acceptedFrames(events: readonly SessionEventLike[], frame: string): number {
  let count = claimedFrames(events, frame)
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

/** The exact frame identity the scheduler dispatches for one attempt. */
function frameOf(team: TeamState, task: TeamTask, attemptId: string): string {
  return assignmentPrompt(team, task, AgentSwarm.AttemptId(attemptId))
}

describe('assignment delivery visibility (issue #60 / P2-1)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * The exact P2-1 shape, deterministically: the member self-claims a ready
   * task while its initial turn is held open, so the next scheduling pass
   * delivers the reserved assignment frame into the RUNNING member — it parks
   * PENDING behind the held turn. The pre-#60 contract acknowledged on that
   * transient form; the official teardown discard below (the same drain a
   * plugin reload or shutdown drives) then destroyed the only copy while the
   * store said delivered, and the attempt was unrecoverable (never
   * re-dispatched, its cold owner evidence-only). The claimed-gate keeps the
   * attempt `reserved` through the discard and lets the next pass redeliver
   * exactly once.
   */
  it('never acknowledges an assignment before its frame is claimed, and recovers a discarded pending frame exactly once', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-assignment-visibility-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, adapter } = composition
    try {
      const memberId = await addMember(composition, 'parked-worker')
      await vi.waitFor(() => {
        expect(adapter.requests.length).toBe(1)
        expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      }, { timeout: 15_000 })

      // The task is created while the member runs, so the live-status filter
      // defers any new assignment (issue #12 / F10).
      const created = await toolCall(ctx, composition.lead, 'task-park', 'agent_swarm_create_task', {
        subject: 'Parked assignment visibility',
        description: 'The held member never claims the first delivered frame.',
      })
      expect(created.isError).toBe(false)

      // Stage the member's own claim through the authoritative domain — the
      // exact port surface `agent_swarm_claim_task` drives for a member. The
      // attempt is `reserved` while the member still runs its held turn, which
      // is also the real shape a slow-to-dispatch reserved re-drive produces.
      const staged = await snapshotOf(composition)
      const stagedTask = staged.team.tasks.find(task => task.status === 'pending')!
      const claim = await ctx.agentSwarm.domain.claimTask(
        composition.scope, AgentSwarm.TeamId(composition.teamId),
        memberId, stagedTask.id, stagedTask.revision, memberId,
      )
      const attemptId = claim.attempt.id
      // The frame identity embeds the post-claim task revision, so derive it
      // from the committed claim, exactly as the dispatch pass will.
      const frame = frameOf((await snapshotOf(composition)).team, claim.task, attemptId)

      // One scheduling pass (triggered by a second task creation) re-drives
      // the reserved attempt: the followup lands on the RUNNING member and
      // the frame parks pending behind the held turn.
      const followup = spyFollowup(composition)
      const trigger = await toolCall(ctx, composition.lead, 'task-trigger', 'agent_swarm_create_task', {
        subject: 'Pass trigger only',
        description: 'Ownership and live-status keep this task unassigned.',
      })
      expect(trigger.isError).toBe(false)
      await vi.waitFor(async () => {
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        expect(acceptedFrames(stored.events, frame)).toBe(1)
      }, { timeout: 15_000 })

      // The visibility gate: past the claim grace the attempt is still
      // reserved — the pending acceptance is transient and must not be
      // acknowledged (the pre-#60 contract committed `delivered` here).
      await new Promise(resolve => setTimeout(resolve, 6_000))
      const parked = await snapshotOf(composition)
      const parkedAttempt = parked.team.attempts.find(attempt => attempt.id === attemptId)!
      expect(parkedAttempt.assignmentPhase).toBe('reserved')
      const storedParked = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(claimedFrames(storedParked.events, frame)).toBe(0)

      // The official teardown discard: an Activation disposal drain clears the
      // unclaimed inbox (the same path a plugin reload or shutdown drives).
      // The pending frame — the only copy — is destroyed.
      ctx.subagents.interrupt(SessionId(memberId), { kind: 'ancestor', agent: composition.lead })
      await ctx.subagents.drainContinuableChildren(composition.lead, [SessionId(memberId)])
      await vi.waitFor(async () => {
        expect(ctx.agents.get(SessionId(memberId))).toBeUndefined()
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        expect(acceptedFrames(stored.events, frame)).toBe(0)
      }, { timeout: 15_000 })

      // Reload-recovery drive (the captain activation recovery a plugin
      // reload runs): the reserved fold observes neither a claimed nor a
      // pending acceptance and redelivers exactly once. The cold-resumed
      // member claims the fresh frame into model-visible history at its first
      // pre-step — before its next held model request — and ONLY THEN the
      // delivered checkpoint commits, on the same fenced attempt (no
      // generation bump, no ownership change).
      await ctx.agentSwarm.recoverAgent(composition.lead)
      await driveRecoveryPasses(composition, async () => {
        const snapshot = await snapshotOf(composition)
        const attempt = snapshot.team.attempts.find(candidate => candidate.id === attemptId)!
        expect(attempt.assignmentPhase).toBe('delivered')
      })
      const settled = await snapshotOf(composition)
      expect(settled.team.tasks.find(task => task.id === stagedTask.id)).toMatchObject({
        status: 'in_progress', ownerSessionId: memberId, currentAttemptId: attemptId,
      })
      const storedSettled = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(claimedFrames(storedSettled.events, frame)).toBe(1)
      expect(acceptedFrames(storedSettled.events, frame)).toBe(1)
      // Exactly two assignment dispatches ever left the scheduler for this
      // attempt: the parked one and the single redelivery.
      expect(followup.records.filter(record => record.text.includes('Team assignment from captain'))).toHaveLength(2)

      followup.restore()
      await composition.pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 60_000)

  /**
   * The healthy fast path stays fast: an idle or cold member claims the
   * assignment frame at the woken turn's first pre-step (before its first
   * model request), so the scheduler's bounded claim wait still commits the
   * delivered checkpoint without waiting for the member's (possibly long)
   * turn to complete — and `delivered` always implies the claimed form.
   */
  it('acknowledges an assignment promptly once the idle target claims the frame mid-turn', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-assignment-prompt-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, adapter } = composition
    try {
      const memberId = await addMember(composition, 'fresh-worker')
      // Settle the member's initial turn (idle-live or cold — both are
      // schedulable, cold-resume targets) and the captain's notice turns.
      adapter.open()
      await vi.waitFor(() => {
        const member = ctx.agents.get(SessionId(memberId))
        expect(member === undefined || member.status === 'idle').toBe(true)
      }, { timeout: 15_000 })
      await settleCaptain(composition.adapter, composition.lead)

      const created = await toolCall(ctx, composition.lead, 'task-fresh', 'agent_swarm_create_task', {
        subject: 'Claimed before acknowledged',
        description: 'The woken member claims the frame at its first pre-step.',
      })
      expect(created.isError).toBe(false)
      await driveRecoveryPasses(composition, async () => {
        const snapshot = await snapshotOf(composition)
        const task = snapshot.team.tasks[0]!
        expect(task).toMatchObject({ status: 'in_progress', ownerSessionId: memberId })
        const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)!
        expect(attempt.assignmentPhase).toBe('delivered')
      })
      const settled = await snapshotOf(composition)
      const task = settled.team.tasks.find(candidate => candidate.ownerSessionId === memberId)!
      const frame = frameOf(settled.team, task, task.currentAttemptId!)
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(claimedFrames(stored.events, frame)).toBe(1)
      expect(acceptedFrames(stored.events, frame)).toBeGreaterThanOrEqual(1)

      await composition.pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 60_000)
})
