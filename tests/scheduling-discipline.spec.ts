/**
 * M1C scheduling discipline (issue #12 / F10), runtime half over the real
 * official composition: live-status candidate filtering, mailbox-before-
 * assignment ordering, and the currentAttemptId CAS guard on dispatch
 * rollback. Stranded-ownership self-healing lives in the companion
 * `stranded-ownership.spec.ts`.
 *
 * All tests compose the real services a deployment composes — AgentLoop with
 * the in-process spawn provider (real continuable members), JSONL session
 * persistence and the storage stack harness — so availability filtering and
 * rollback guards are evidenced against actual Agent lifecycle machinery,
 * never a mock.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import {
  addMember,
  driveRecoveryPasses,
  mount,
  settleCaptain,
  snapshotOf,
  spyFollowup,
  toolCall,
} from './helpers/gated-composition.js'

describe('live-status scheduling discipline over the real composition (issue #12)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * F10 candidate filtering: a member whose live Agent status is `running`
   * is never selected for a new assignment — the task waits until an idle
   * edge frees the member — while an idle/cold member receives work in the
   * same pass. The `agent/status → idle` wake remains the trigger that
   * re-runs the deferred assignment.
   */
  it('never schedules a running member and routes new work to the idle one', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-live-filter-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, adapter } = composition
    try {
      const alphaId = await addMember(composition, 'alpha-worker')
      await vi.waitFor(() => {
        expect(adapter.requests.length).toBe(1)
        expect(ctx.agents.get(SessionId(alphaId))?.status).toBe('running')
      }, { timeout: 15_000 })
      const betaId = await addMember(composition, 'beta-worker')
      await vi.waitFor(() => {
        expect(adapter.requests.length).toBe(2)
        expect(ctx.agents.get(SessionId(betaId))?.status).toBe('running')
      }, { timeout: 15_000 })

      const followup = spyFollowup(composition)
      const task = await toolCall(ctx, composition.lead, 'task-running', 'agent_swarm_create_task', {
        subject: 'Must wait for the targeted idle member', description: 'Created while both members are running.',
        target_member: 'beta-worker',
      })
      expect(task.isError).toBe(false)
      // Both members are live and running: the pass must not claim for either.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      const deferred = await snapshotOf(composition)
      expect(deferred.team.tasks[0]).toMatchObject({ status: 'pending' })
      expect(followup.records.filter(record => record.text.includes('Team assignment'))).toHaveLength(0)

      // The idle edge after the initial turns settle is what assigns work.
      adapter.open()
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.tasks[0]).toMatchObject({
          status: 'in_progress', ownerSessionId: betaId, targetMemberSessionId: betaId,
        })
      }, { timeout: 15_000 })

      // The targeted owner now runs its held assignment turn; an untargeted
      // second task routes to the remaining idle member.
      const second = await toolCall(ctx, composition.lead, 'task-idle', 'agent_swarm_create_task', {
        subject: 'Routes to the idle member', description: 'The running owner is excluded by ownership and status.',
      })
      expect(second.isError).toBe(false)
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.tasks[1]).toMatchObject({ status: 'in_progress', ownerSessionId: alphaId })
      }, { timeout: 15_000 })

      followup.restore()
      await composition.pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * F10 mailbox-first discipline: one scheduler pass delivers the queued
   * backlog before any new assignment, and the new assignment for the member
   * that just received waking mail defers to its NEXT idle edge (reference
   * scheduler semantics: the mailbox turn is this turn's work).
   */
  it('delivers queued mail before assigning, and the assignment waits for the mail turn to finish', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-mailbox-first-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, adapter } = composition
    try {
      const workerId = await addMember(composition, 'mail-worker')
      await vi.waitFor(() => {
        expect(adapter.requests.length).toBe(1)
      }, { timeout: 15_000 })
      // Settle the member's initial turn and the captain's settlement
      // notice, then make the member cold exactly like a reloaded process.
      adapter.open()
      await vi.waitFor(() => {
        expect(composition.lead.status).toBe('running')
      }, { timeout: 15_000 })
      adapter.open()
      await vi.waitFor(() => {
        expect(composition.lead.status).toBe('idle')
      }, { timeout: 15_000 })
      ctx.subagents.interrupt(SessionId(workerId), { kind: 'ancestor', agent: composition.lead })
      await ctx.subagents.drainContinuableChildren(composition.lead, [SessionId(workerId)])
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(workerId))).toBeUndefined()
      }, { timeout: 15_000 })

      // Stage through the authoritative domain only (no runtime scheduling
      // trigger): one ready task plus one queued wakeup message.
      const { domain } = ctx.agentSwarm
      await domain.createTask(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id, {
        subject: 'Queued behind the backlog', description: 'Assignment must follow the mailbox delivery.',
      })
      const message = await domain.queueMessage(
        composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id,
        'mail-worker', 'Backlog delivers before assignment.', 'wakeup',
      )

      const followup = spyFollowup(composition)
      // Settle any drain-settlement notice still holding the captain before
      // the single recovery drive (a `running` captain would no-op the
      // drive). No gate opening after this point: the member's mail turn
      // must stay held through the negative window below.
      await settleCaptain(composition.adapter, composition.lead)
      await ctx.agentSwarm.recoverAgent(composition.lead)
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.messages.find(candidate => candidate.id === message.id)?.phase).toBe('delivered')
      }, { timeout: 15_000 })
      // The woken member is running its mail turn: the new assignment waits.
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const duringMailTurn = await snapshotOf(composition)
      expect(duringMailTurn.team.tasks[0]).toMatchObject({ status: 'pending' })
      expect(followup.records.filter(record => record.text.includes('Team assignment'))).toHaveLength(0)

      // The mail turn's idle edge assigns; the backlog frame stays first.
      adapter.open()
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: workerId })
      }, { timeout: 15_000 })
      const mailIndex = followup.records.findIndex(record => record.text.includes('Backlog delivers before assignment.'))
      const assignmentIndex = followup.records.findIndex(record => record.text.includes('Team assignment'))
      expect(mailIndex).toBeGreaterThanOrEqual(0)
      expect(assignmentIndex).toBeGreaterThan(mailIndex)
      // The assignment is dispatched only once the member is free again —
      // never while it still runs the mailbox turn (it may since have gone
      // cold and been cold-resumed, which is equally available).
      expect(followup.records[assignmentIndex]!.targetStatus).not.toBe('running')

      followup.restore()
      await composition.pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * F10 CAS-guarded rollback: when an assignment dispatch fails but a
   * concurrent captain handoff already fenced the attempt (the task now
   * references a different currentAttemptId), the rollback must not touch
   * authoritative state at all — no doomed cancelAttempt call, and the
   * handoff's new owner keeps its reserved attempt for delivery.
   */
  it('skips the dispatch rollback when a concurrent handoff already fenced the attempt', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-cas-rollback-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx } = composition
    try {
      await addMember(composition, 'alpha-worker')
      const betaId = await addMember(composition, 'beta-worker')
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const { domain } = ctx.agentSwarm
      const rawCancel = domain.cancelAttempt.bind(domain)
      const rawClaim = domain.claimTask.bind(domain)
      const rawFollowup = ctx.subagents.followup.bind(ctx.subagents)
      let sabotaged = false
      const followupSpy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        const assignment = content.some(block => block.type === 'text' && block.text.includes('Team assignment'))
        if (assignment && !sabotaged) {
          sabotaged = true
          // The concurrent captain handoff: fence this dispatch's attempt and
          // re-reserve the task for the other member, then fail the delivery.
          const snapshot = await domain.snapshot(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id)
          const task = snapshot.team.tasks[0]!
          const released = await rawCancel(
            composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id,
            task.id, task.revision, 'concurrent captain handoff won the race',
          )
          await rawClaim(
            composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id,
            task.id, released.revision, betaId,
          )
          throw new Error('simulated assignment delivery failure')
        }
        return await rawFollowup(parent, childId, content, options)
      })
      const cancelSpy = vi.spyOn(domain, 'cancelAttempt')

      // Stage the ready task through the authoritative domain (no scheduling
      // trigger), then drive passes from the captain's recovery path until
      // the sabotaged dispatch happens. The re-driving poll is required: a
      // settlement notice that lands after `settleCaptain`'s exit window
      // holds the captain `running` on a gated turn, and `recoverAgent` only
      // requests a pass while the captain is idle.
      await domain.createTask(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id, {
        subject: 'CAS rollback proof', description: 'The failed dispatch must not double-write.',
      })
      await settleCaptain(composition.adapter, composition.lead)
      await driveRecoveryPasses(composition, () => {
        expect(sabotaged).toBe(true)
      })
      await new Promise(resolve => setTimeout(resolve, 1_000))

      // The guarded rollback never called cancelAttempt: the handoff's
      // reservation survives untouched for the reserved-delivery path.
      expect(cancelSpy).not.toHaveBeenCalled()
      const afterRace = await snapshotOf(composition)
      const task = afterRace.team.tasks[0]!
      expect(task).toMatchObject({ status: 'in_progress', ownerSessionId: betaId })
      const fenced = afterRace.team.attempts.find(attempt => attempt.memberSessionId !== betaId)
      expect(fenced?.phase).toBe('stale')

      // The next pass delivers the handoff's reserved attempt normally. A
      // premature gate release during the poll is harmless here: the attempt
      // stays reserved and every re-driven pass re-dispatches the same
      // fenced attempt until the delivery acknowledgement commits.
      await driveRecoveryPasses(composition, async () => {
        const snapshot = await snapshotOf(composition)
        const delivered = snapshot.team.attempts.find(attempt => attempt.id === snapshot.team.tasks[0]?.currentAttemptId)
        expect(delivered?.assignmentPhase).toBe('delivered')
      })
      expect(cancelSpy).not.toHaveBeenCalled()

      idle.mockRestore()
      followupSpy.mockRestore()
      cancelSpy.mockRestore()
      await composition.pluginFiber.dispose()
    } finally {
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
