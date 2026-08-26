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
      // the next test instead). Issue #52: the parked frame is still
      // pending, so the send reports `queued` — wakeup acknowledgement
      // requires the claimed, model-visible form.
      const parked = await toolCall(ctx, composition.lead, 'send-wakeup', 'agent_swarm_send_message', {
        target: 'stranded-worker', content: 'Parked work across the stranding window.', delivery: 'wakeup',
      })
      expect(parked.isError).toBe(false)
      expect((parked.value as { phase: string }).phase).toBe('queued')

      // The captain interrupts the running turn (keepInbox): the member
      // converges live-and-idle while the task stays in_progress.
      const interrupted = await ctx.agentSwarm.interruptMember({ agent: composition.lead, signal: SIGNAL }, 'stranded-worker')
      expect(interrupted.previousStatus).toBe('running')
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
   * Issue #83 atomicity lock: the stranded self-heal's retry is ONE domain
   * transition. A concurrent reader polling the authoritative store across
   * the whole healing window observes the task `in_progress` throughout —
   * never the transient `pending` the pre-fix cancel-then-reclaim pair
   * exposed between its two transactions (the exact surface the CI failure
   * read: a pending, revision-bumped task that "was auto-requeued").
   */
  it('keeps a healing owner\'s task continuously in_progress for concurrent readers', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-stranded-atomic-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 200)
    const { ctx } = composition
    try {
      const workerId = await addMember(composition, 'atomic-worker')
      await holdAssignedTask(composition, 'Healed under observation')

      const before = await snapshotOf(composition)
      const taskBefore = before.team.tasks[0]!

      // The parked wakeup keeps the interrupted owner live-and-idle (the
      // legitimate heal setup of the first test): the retry is guaranteed to
      // fire from the re-kick timer while the poll below reads the store.
      const parked = await toolCall(ctx, composition.lead, 'send-wakeup', 'agent_swarm_send_message', {
        target: 'atomic-worker', content: 'Parked work across the healing window.', delivery: 'wakeup',
      })
      expect(parked.isError).toBe(false)
      const interrupted = await ctx.agentSwarm.interruptMember({ agent: composition.lead, signal: SIGNAL }, 'atomic-worker')
      expect(interrupted.previousStatus).toBe('running')

      // Poll the authoritative store across the healing window; the grace
      // past, the re-kick timer fires the heal mid-loop. Each iteration
      // yields a macrotask so the timer-driven pass can actually run.
      const observed: string[] = []
      let healed = false
      for (let poll = 0; poll < 400 && !healed; poll += 1) {
        const snapshot = await snapshotOf(composition)
        const task = snapshot.team.tasks[0]!
        observed.push(task.status)
        if (task.currentAttemptId !== taskBefore.currentAttemptId) healed = true
        else await new Promise(resolve => setTimeout(resolve, 1))
      }
      expect(healed).toBe(true)
      expect(observed).not.toContain('pending')

      const healedState = await snapshotOf(composition)
      expect(healedState.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: workerId })
      const oldAttempt = healedState.team.attempts.find(attempt => attempt.id === taskBefore.currentAttemptId)
      expect(oldAttempt?.phase).toBe('stale')
      expect(oldAttempt?.diagnostic).toContain('stranded')

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
   *
   * Issue #83 regression lock: the grace is allowed to elapse while the
   * member still RUNS its held assignment turn (the CI coverage timing —
   * there the claim-to-interrupt latency already exceeded the grace), so the
   * interrupt's fresh idle edge meets a task that is past the task-age
   * grace. Only the owner's own idle-stretch clock holds the self-heal back
   * through the teardown window: firing there would requeue the task behind
   * the captain's back (and, between the pre-fix heal's two domain
   * transitions, expose it as `pending` to any reader).
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

      // Let the grace elapse while the member still runs its held
      // assignment turn (issue #83's CI timing): the task is past the grace
      // the instant the interrupt lands, exactly like a slow coverage run.
      await new Promise(resolve => setTimeout(resolve, 400))

      // Drain the member cold (interrupt + drain) while it holds the task.
      ctx.subagents.interrupt(SessionId(workerId), { kind: 'ancestor', agent: composition.lead })
      await ctx.subagents.drainContinuableChildren(composition.lead, [SessionId(workerId)])
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(workerId))).toBeUndefined()
      }, { timeout: 5_000 })

      // Evidence surfaces in the task-list rows (issue #15: the stranded hint
      // moved from the removed status task_summary into list rows); nothing
      // else moves. The hint appears only after the post-drain scheduling
      // pass observes the cold owner, so settle on it instead of racing the
      // pass (lesson #7 pattern, same settle as PR #33). The drain settles
      // the child with a captain settlement-notice turn — on a slow runner
      // that notice can hold the captain at the model gate, so the observing
      // pass never runs and the hint stays undefined (observed on three CI
      // runs across branches). Release held captain turns and re-drive the
      // recovery path inside each poll (the member is cold; the captain is
      // the root session and never settles).
      await vi.waitFor(async () => {
        composition.adapter.open()
        await ctx.agentSwarm.recoverAgent(composition.lead)
        const listed = await toolCall(ctx, composition.lead, `list-stranded-${Date.now()}`, 'agent_swarm_list_tasks', {})
        expect(listed.isError).toBe(false)
        expect(((listed.value as { tasks: Array<{ stranded?: string }> }).tasks[0]!).stranded).toBe('owner-not-live')
      }, { timeout: 15_000 })

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
      // The STRONG invariants: never auto-released to pending, never
      // reassigned away from the cold owner. The exact attempt id is NOT
      // asserted: docs/04 §8c records the official followup-destruction
      // race's residual (a redelivery cold-resumes the drained member,
      // whose subsequent idle edge may legitimately self-heal a fresh
      // fenced attempt for the SAME owner) — a documented known limit,
      // not a corruption. Either outcome keeps the same owner and the
      // task in_progress; everything else below (explicit captain
      // reassignment fencing) is unaffected.
      const currentAttempt = untouched.team.attempts.find(
        attempt => attempt.id === untouched.team.tasks[0]?.currentAttemptId,
      )
      expect(currentAttempt?.memberSessionId).toBe(workerId)

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
