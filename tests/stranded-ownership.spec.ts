/**
 * M1C stranded-ownership self-healing (issue #12 / F10, decisions in
 * docs/04 §8c) over the real official composition: a live-and-idle member
 * holding an open in_progress task retries under a fresh fenced attempt
 * past the configured grace; a not-live owner is evidence-only, with
 * reassignment staying a captain decision. Also carries scenario 2 of the
 * docs/08 §3 matrix (reassign while the old member is running).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import {
  addMember,
  mount,
  settleCaptain,
  SIGNAL,
  snapshotOf,
  toolCall,
  type Composition,
} from './helpers/gated-composition.js'

/**
 * Drive one worker to a held RUNNING assignment turn: the task is created
 * while the worker still runs its gated initial turn (so the live-status
 * filter defers the claim), then the gate releases that initial turn and the
 * resulting idle edge assigns the task, whose turn is held again.
 */
async function holdAssignedTask(composition: Composition, subject: string): Promise<void> {
  const created = await toolCall(composition.ctx, composition.lead, `task-${subject}`, 'agent_swarm_create_task', {
    subject, description: `${subject}: executed under a held turn.`,
  })
  if (created.isError) throw new Error(`create_task failed: ${JSON.stringify(created.error)}`)
  composition.adapter.open()
  await vi.waitFor(async () => {
    const snapshot = await snapshotOf(composition)
    expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress' })
  }, { timeout: 5_000 })
  await vi.waitFor(async () => {
    const snapshot = await snapshotOf(composition)
    const task = snapshot.team.tasks[0]!
    const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
    expect(attempt?.assignmentPhase).toBe('delivered')
  }, { timeout: 5_000 })
}

describe('stranded-ownership self-healing over the real composition (issue #12)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * F10 stranded self-healing, live-idle holder: a member that went idle
   * (here: keepInbox interrupt settlement) while still holding an open
   * in_progress task is retried under a fresh fenced attempt once the
   * configured grace elapses — same owner, stale attempt keeps the evidence.
   */
  it('retries an idle member\'s stranded task under a fresh attempt after the grace bound', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-stranded-idle-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 200)
    const { ctx } = composition
    try {
      const workerId = await addMember(composition, 'stranded-worker')
      await holdAssignedTask(composition, 'Will be stranded')

      const before = await snapshotOf(composition)
      const taskBefore = before.team.tasks[0]!
      expect(ctx.agents.get(SessionId(workerId))?.status).toBe('running')

      // Park a wakeup message behind the running turn first: pending
      // next-turn work keeps the Activation resident after the interrupt
      // (an empty inbox would let the spawn provider auto-settle the member
      // cold within the grace window, which is the evidence-only path of
      // the next test instead).
      const parked = await toolCall(ctx, composition.lead, 'send-wakeup', 'agent_swarm_send_message', {
        target: 'stranded-worker', content: 'Parked work across the stranding window.', delivery: 'wakeup',
      })
      expect(parked.isError).toBe(false)
      expect((parked.value as { phase: string }).phase).toBe('delivered')

      // The captain interrupts the running turn (keepInbox): the member
      // converges live-and-idle while the task stays in_progress.
      const interrupted = await toolCall(ctx, composition.lead, 'interrupt', 'agent_swarm_interrupt_member', {
        name: 'stranded-worker',
      })
      expect(interrupted.isError).toBe(false)
      expect((interrupted.value as { previous_status: string }).previous_status).toBe('running')
      await vi.waitFor(() => {
        const member = ctx.agents.get(SessionId(workerId))
        expect(member).toBeDefined()
        expect(member?.status).toBe('idle')
      }, { timeout: 5_000 })

      // Inside the grace bound nothing moves: the parked owner keeps its
      // exact attempt (the keepInbox semantics of issue #19 stay intact).
      const withinGrace = await snapshotOf(composition)
      expect(withinGrace.team.tasks[0]?.currentAttemptId).toBe(taskBefore.currentAttemptId)

      // Past the grace bound the re-kick pass retries the SAME owner under a
      // fresh fenced attempt; the old attempt is stale with the evidence.
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: workerId })
        expect(snapshot.team.tasks[0]?.currentAttemptId).not.toBe(taskBefore.currentAttemptId)
      }, { timeout: 5_000 })
      const healed = await snapshotOf(composition)
      const oldAttempt = healed.team.attempts.find(attempt => attempt.id === taskBefore.currentAttemptId)
      expect(oldAttempt?.phase).toBe('stale')
      expect(oldAttempt?.diagnostic).toContain('stranded')
      const freshAttempt = healed.team.attempts.find(
        attempt => attempt.id === healed.team.tasks[0]?.currentAttemptId,
      )
      expect(freshAttempt?.memberSessionId).toBe(workerId)
      // The fresh dispatch re-wakes the member onto the new attempt.
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(workerId))?.status).toBe('running')
      }, { timeout: 5_000 })

      await composition.pluginFiber.dispose()
    } finally {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * F10 stranded self-healing, not-live owner: evidence only. A cold owner's
   * in_progress task is never auto-released across grace-elapsed passes — it
   * stays wakeup-resumable and reassignment stays a captain decision, with
   * the `stranded=owner-not-live` hint surfacing the fact in the status
   * projection.
   */
  it('exposes a not-live owner\'s stranded task as evidence without auto-releasing it', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-stranded-cold-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 200)
    const { ctx } = composition
    try {
      const workerId = await addMember(composition, 'cold-worker')
      await holdAssignedTask(composition, 'Owner went cold')

      const before = await snapshotOf(composition)
      const taskBefore = before.team.tasks[0]!

      // Drain the member cold (interrupt + drain) while it holds the task.
      ctx.subagents.interrupt(SessionId(workerId), { kind: 'ancestor', agent: composition.lead })
      await ctx.subagents.drainContinuableChildren(composition.lead, [SessionId(workerId)])
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(workerId))).toBeUndefined()
      }, { timeout: 5_000 })

      // Evidence surfaces in the status projection; nothing else moves.
      const status = await toolCall(ctx, composition.lead, 'status', 'agent_swarm_status', {})
      expect(status.isError).toBe(false)
      expect((status.value as { task_summary: string }).task_summary).toContain('stranded=owner-not-live')

      // Past the grace bound, repeated passes still never auto-release the
      // cold owner's task: reassignment stays with the captain. (Settle the
      // captain's held notice turn first so its recovery path really runs.)
      await settleCaptain(composition.adapter, composition.lead)
      await new Promise(resolve => setTimeout(resolve, 400))
      await ctx.agentSwarm.recoverAgent(composition.lead)
      await new Promise(resolve => setTimeout(resolve, 200))
      await ctx.agentSwarm.recoverAgent(composition.lead)
      const untouched = await snapshotOf(composition)
      expect(untouched.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: workerId })
      expect(untouched.team.tasks[0]?.currentAttemptId).toBe(taskBefore.currentAttemptId)

      // The captain-decision path reassigns explicitly and the scheduler
      // revives the task under a fresh attempt (the cold member is
      // schedulable, so the claim cold-resumes it).
      const reassigned = await ctx.agentSwarm.reassignTask(
        { agent: composition.lead, signal: SIGNAL }, taskBefore.id, untouched.team.tasks[0]!.revision,
        'captain decision: the cold owner was drained',
      )
      expect(reassigned.status).toBe('pending')
      await ctx.agentSwarm.recoverAgent(composition.lead)
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: workerId })
        expect(snapshot.team.tasks[0]?.currentAttemptId).not.toBe(taskBefore.currentAttemptId)
      }, { timeout: 5_000 })

      await composition.pluginFiber.dispose()
    } finally {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Scenario 2 of the docs/08 §3 protocol matrix: the captain reassigns a
   * task while the old member is still running its turn — the old attempt is
   * fenced stale, the old member's late submission with that attempt is
   * rejected with `TEAM_ATTEMPT_STALE`, and the task continues under a fresh
   * fenced attempt.
   */
  it('scenario 2: reassign while the old member is running fences the late write and retries fresh', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-reassign-running-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'scenario2-scheduler')
    const { ctx } = composition
    try {
      // Controllable provider: assignment selection can be suspended so the
      // released task deterministically stays pending across the late-write
      // check (no interleaved re-claim can move the revision).
      let allowAssignments = true
      const unregister = ctx.agentSwarm.registerSchedulerProvider('scenario2-scheduler', {
        select: ({ availableMembers, readyTasks }) => {
          if (!allowAssignments) return []
          const member = availableMembers[0]
          const task = readyTasks[0]
          return member === undefined || task === undefined ? [] : [{ memberSessionId: member.sessionId, taskId: task.id }]
        },
      })
      const workerId = await addMember(composition, 'old-worker')
      await holdAssignedTask(composition, 'Reassigned mid-flight')
      expect(ctx.agents.get(SessionId(workerId))?.status).toBe('running')

      const before = await snapshotOf(composition)
      const taskBefore = before.team.tasks[0]!
      const oldAttemptId = taskBefore.currentAttemptId!

      // Determinism for the late-write check: suspend assignment selection so
      // no scheduling pass may re-claim the released task before the fenced
      // submission is attempted.
      allowAssignments = false

      // Captain-initiated reassign while the owner runs: the attempt is
      // fenced and the running turn is interrupted (keepInbox).
      const released = await ctx.agentSwarm.reassignTask(
        { agent: composition.lead, signal: SIGNAL }, taskBefore.id, taskBefore.revision,
        'scenario 2: superseded while the owner runs',
      )
      expect(released.status).toBe('pending')

      // The old member's late write with the fenced attempt is rejected
      // while the task is deterministically still pending.
      const current = (await snapshotOf(composition)).team.tasks[0]!
      expect(current.status).toBe('pending')
      await expect(ctx.agentSwarm.domain.submitTask(
        composition.scope, AgentSwarm.TeamId(composition.teamId), workerId,
        taskBefore.id, current.revision, oldAttemptId, 'late write from the old turn', [],
      )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })

      // The task continues under a fresh fenced attempt for the member. The
      // interrupted member is live-and-idle, so its recovery path re-runs the
      // scheduling pass (the captain's own notice turn is still held).
      allowAssignments = true
      const memberAgent = ctx.agents.get(SessionId(workerId))
      if (memberAgent !== undefined) await ctx.agentSwarm.recoverAgent(memberAgent)
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: workerId })
        expect(snapshot.team.tasks[0]?.currentAttemptId).not.toBe(oldAttemptId)
      }, { timeout: 5_000 })
      const after = await snapshotOf(composition)
      const oldAttempt = after.team.attempts.find(attempt => attempt.id === oldAttemptId)
      expect(oldAttempt?.phase).toBe('stale')
      unregister()

      await composition.pluginFiber.dispose()
    } finally {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
