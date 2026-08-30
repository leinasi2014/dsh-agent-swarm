/**
 * Dual-owner adversarial tests (M2-3, issue #77 — the core deliverable):
 * two faces simultaneously driving the SAME Team while the revision CAS and
 * attempt fencing decide. Real composition (adaptive mode with the bridge
 * co-enabled — the permissive coexistence face), a run parked mid-assignment
 * (the workflow face holds the wheel), and a second face attacking through
 * both the authoritative domain port (late stale claims, foreign submits,
 * bogus attempt ids) and a REAL operation-triggered scheduling pass racing
 * the parked run. The latecomer must be rejected on every path, the state
 * must stay exactly single-owner-shaped, and the shared budget face must
 * count once (planning-note trap 2: one request charge per seated attempt,
 * per-seq usage cursors make replays free).
 *
 * Red→green evidence for the docs/04 ownership contract:
 * with `taskRevision`/`assertCurrentAttempt` in team-domain-board.ts
 * temporarily disabled, the late-claim attack corrupts the board and this
 * suite fails; with the fences in place it is green. Scenario 31 of the
 * docs/08 §3 matrix is proven here.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { TeamDomainPort, TeamScope } from '../src/domain/team-domain-port.js'
import {
  billedTokensOf,
  captureDomainError,
  mountModesComposition,
  spyFollowupText,
  toolCall,
  type ModesComposition,
} from './helpers/modes-composition.js'

const META = {
  name: 'dual-owner-proof',
  description: 'Prove the fences reject the second driver of one Team.',
} as const

/** Assert one domain-port call rejects with the exact structured code. */
async function expectDomainCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => { throw new Error(`expected a TeamDomainError with code ${code}, got a resolution`) },
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(AgentSwarm.TeamDomainError)
  expect((error as AgentSwarm.TeamDomainError).code).toBe(code)
}

describe('dual-owner fencing over the real composition (M2-3, issue #77)', () => {
  const sandboxes: string[] = []
  const compositions: ModesComposition[] = []

  afterEach(async () => {
    for (const composition of compositions.splice(0)) {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('scenario 31: the fences reject the late driver while the workflow run holds the Team', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-dual-owner-attack-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const spy = spyFollowupText(composition)
    try {
      const bridge = ctx.agentSwarm.workflowBridge!
      const run = bridge.start({
        script: `const out = await agent('Hold this assignment turn open.')
return { out }`,
        meta: { ...META },
        parent: lead,
      })
      const scope: TeamScope = ctx.agentSwarm.scopeOf(lead)
      const domain: TeamDomainPort = ctx.agentSwarm.domain

      // Park: task pending at revision 1 while the join turn is held.
      await vi.waitFor(async () => {
        const overlay = bridge.overlay.get(run.id)
        expect(overlay).toMatchObject({ state: 'running' })
        const snapshot = await domain.snapshot(scope, AgentSwarm.TeamId(overlay!.teamId), lead.id)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'pending', revision: 1 })
      }, { timeout: 15_000 })
      const overlay = bridge.overlay.get(run.id)!
      const teamId = AgentSwarm.TeamId(overlay.teamId)

      // The run's own driver claims and delivers; the member parks on the
      // assignment turn (in_progress, delivered, owner set, revision 2).
      adapter.open()
      await vi.waitFor(async () => {
        const snapshot = await domain.snapshot(scope, teamId, lead.id)
        const task = snapshot.team.tasks[0]!
        const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
        expect(task).toMatchObject({ status: 'in_progress', revision: 2 })
        expect(attempt?.assignmentPhase).toBe('delivered')
      }, { timeout: 15_000 })
      const parked = await domain.snapshot(scope, teamId, lead.id)
      const task = parked.team.tasks[0]!
      const attemptId = task.currentAttemptId!
      const memberSessionId = task.ownerSessionId!
      const member = ctx.agents.get(SessionId(memberSessionId))
      expect(member?.status).toBe('running')

      // === The second face attacks the SAME task through the authoritative
      // port while the workflow face is mid-flight. Every latecomer path is
      // fenced; none of these calls changes a single durable field. ===
      // 1. A claim carrying the pre-claim revision (the classic late driver).
      await expectDomainCode(
        domain.claimTask(scope, teamId, lead.id, AgentSwarm.TaskId(task.id), 1, memberSessionId),
        'TEAM_TASK_STALE_REVISION',
      )
      // 2. A claim with the CURRENT revision: the attempt fence on the claim
      //    path — an in_progress task is not ready for any second seat.
      await expectDomainCode(
        domain.claimTask(scope, teamId, lead.id, AgentSwarm.TaskId(task.id), 2, memberSessionId),
        'TEAM_TASK_NOT_READY',
      )
      // 3. A foreign submit (captain session, current revision and attempt):
      //    only the current owner may submit.
      await expectDomainCode(
        domain.submitTask(scope, teamId, lead.id, AgentSwarm.TaskId(task.id), 2, AgentSwarm.AttemptId(attemptId), 'forged output'),
        'TEAM_TASK_OWNER_REQUIRED',
      )
      // 4. The owner's session with a bogus attempt id: the attempt fence.
      await expectDomainCode(
        domain.submitTask(scope, teamId, memberSessionId, AgentSwarm.TaskId(task.id), 2, AgentSwarm.AttemptId('attempt-never-existed'), 'forged output'),
        'TEAM_ATTEMPT_STALE',
      )

      // === A REAL concurrent scheduling pass: the captain drives the same
      // Team through the operation face while the run is parked. The pass
      // folds nothing new (single delivered attempt), delivers nothing new
      // (one assignment frame total — no double wake), and cannot seat the
      // second task onto the busy owner. ===
      const second = await toolCall(ctx, lead, 'second-face', 'agent_swarm_create_task', {
        subject: 'Second-face task', description: 'Created by the concurrent operation face mid-run.',
      })
      expect(second.isError).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 400))

      // === Zero corruption: exactly the run's own transitions. ===
      const frozen = await domain.snapshot(scope, teamId, lead.id)
      const fenced = frozen.team.tasks.find(candidate => candidate.id === task.id)!
      expect(fenced).toMatchObject({
        status: 'in_progress',
        revision: 2,
        ownerSessionId: memberSessionId,
        currentAttemptId: attemptId,
      })
      expect(frozen.team.attempts).toHaveLength(1)
      expect(frozen.team.attempts[0]).toMatchObject({ id: attemptId, memberSessionId, phase: 'running', assignmentPhase: 'delivered' })
      const secondTask = frozen.team.tasks.find(candidate => candidate.subject === 'Second-face task')!
      expect(secondTask).toMatchObject({ status: 'pending' })
      expect(secondTask.ownerSessionId).toBeUndefined()
      // One assignment frame ever delivered to the member (single wake).
      expect(spy.records.filter(record => record.text.includes('Team assignment from captain'))).toHaveLength(1)
      // === Zero double count (trap 2): ONE request charge for the ONE
      // seated attempt; the token face equals the participants' billed
      // events exactly once. ===
      expect(frozen.team.budget.usedRequests).toBe(1)
      await vi.waitFor(async () => {
        const snapshot = await domain.snapshot(scope, teamId, lead.id)
        expect(snapshot.team.budget.usedTokens).toBe(billedTokensOf(member) + billedTokensOf(lead))
      }, { timeout: 5_000 })

      // === A second run on the same captain is structurally rejected before
      // any publication (createUniqueForCaptain is the first mutual
      // exclusion); the registry names any explicit conflict. ===
      const run2 = bridge.start({ script: 'return 1', meta: { ...META, name: 'second-run' }, parent: lead })
      const settled2 = await vi.waitFor(() => run2.result, { timeout: 15_000 })
      expect(settled2.stopReason).toBe('error')
      expect(settled2.error).toContain('could not establish the run')
      expect(bridge.overlay.get(run2.id)).toBeUndefined()
      expect(ctx.agentSwarm.orchestration.ownerOf(scope, teamId)).toBe(run.id)

      // === The fenced Team still runs to green: arm submissions and release
      // the parked assignment turn once; the run completes, reviews and
      // archives over the exact state the attacks failed to touch. ===
      adapter.submit = true
      adapter.open()
      const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
      expect(settled).toMatchObject({ stopReason: 'completed' })
      expect(settled.value).toEqual({ out: 'Modes member output for task-1.' })
      expect(bridge.overlay.get(run.id)).toMatchObject({ state: 'completed', stopReason: 'completed' })
      await vi.waitFor(async () => {
        const snapshot = await domain.snapshot(scope, teamId, lead.id)
        expect(snapshot.team.phase).toBe('archived')
        expect(snapshot.team.tasks.find(candidate => candidate.id === task.id)).toMatchObject({ status: 'completed' })
        // The board never seated a second attempt for the attacked task.
        expect(snapshot.team.budget.usedRequests).toBe(1)
      }, { timeout: 15_000 })
    } finally {
      spy.restore()
    }
  })

  it('scenario 31: releases the ownership only through the owning run id', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-dual-owner-registry-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true })
    compositions.push(composition)
    const { ctx, lead } = composition
    const bridge = ctx.agentSwarm.workflowBridge!
    const run = bridge.start({
      script: `await agent('Park the registry proof.')`,
      meta: { ...META, name: 'registry-proof' },
      parent: lead,
    })
    const scope = ctx.agentSwarm.scopeOf(lead)
    await vi.waitFor(async () => {
      const overlay = bridge.overlay.get(run.id)
      expect(overlay).toMatchObject({ state: 'running' })
      expect(ctx.agentSwarm.orchestration.ownerOf(scope, AgentSwarm.TeamId(overlay!.teamId))).toBe(run.id)
    }, { timeout: 15_000 })
    const teamId = AgentSwarm.TeamId(bridge.overlay.get(run.id)!.teamId)

    // A foreign run id cannot release what it never owned.
    ctx.agentSwarm.orchestration.release(scope, teamId, 'foreign-run')
    expect(ctx.agentSwarm.orchestration.ownerOf(scope, teamId)).toBe(run.id)
    // The owning id can (the disposer path), and re-release stays a no-op;
    // after the release even the owning run cannot drive any more — the
    // single-owner contract is symmetric.
    ctx.agentSwarm.orchestration.release(scope, teamId, run.id)
    expect(ctx.agentSwarm.orchestration.ownerOf(scope, teamId)).toBeUndefined()
    ctx.agentSwarm.orchestration.release(scope, teamId, run.id)
    expect(captureDomainError(() => ctx.agentSwarm.orchestration.drive(scope, teamId, run.id, lead)).code)
      .toBe('TEAM_ORCHESTRATION_OWNER_CONFLICT')

    run.cancel('registry proof done')
    const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
    expect(settled).toMatchObject({ stopReason: 'cancelled' })
    await run.dispose()
  })
})
