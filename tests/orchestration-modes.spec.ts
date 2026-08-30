/**
 * Explicit orchestration-mode semantics over the real official composition
 * (the ownership and mode decisions are defined in docs/04):
 *
 * - the impossible `workflow`-without-bridge combination fails activation
 *   closed, before any side effect;
 * - in `workflow` mode the autonomous event face is off: a non-run Team's
 *   member idle edge drives nothing (task stays pending, zero deliveries),
 *   and a workflow run drives its own Team end-to-end through its
 *   ownership-gated idle driver (the run is the clock);
 * - in `adaptive` mode a workflow-run-owned Team defers to its run: past the
 *   stranded grace no self-heal fires, and the ownership registry rejects
 *   conflicting drivers with a structured error.
 *
 * Scenario 32 of the docs/08 §3 matrix is proven here.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import {
  billedTokensOf,
  captureDomainError,
  mountModesComposition,
  spyFollowupText,
  toolCall,
  type ModesComposition,
} from './helpers/modes-composition.js'

const META = {
  name: 'modes-proof',
  description: 'Prove the explicit orchestration-mode semantics.',
} as const

describe('explicit orchestration modes (M2-3, issue #77)', () => {
  const sandboxes: string[] = []
  const compositions: ModesComposition[] = []

  afterEach(async () => {
    for (const composition of compositions.splice(0)) {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('fails activation closed when workflow mode has no bridge to drive it', { timeout: 60_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-modes-failclosed-'))
    sandboxes.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []
    try {
      await mountAgentLoopTestDependencies(ctx)
      fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
      fibers.push(await ctx.plugin(Storage))
      fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
      fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      // M2-3 fail-closed combination: no orchestration driver would exist.
      await expect(ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn',
        orchestrationMode: 'workflow',
        workflowBridge: false,
      })).rejects.toThrow('orchestrationMode "workflow" requires workflowBridge')
      // Nothing was constructed: no runtime service registered.
      expect((ctx as unknown as Record<string, unknown>).agentSwarm).toBeUndefined()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('scenario 32: workflow mode drives nothing on a member idle edge for a non-run Team', { timeout: 60_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-modes-idle-off-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'workflow', workflowBridge: true })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const spy = spyFollowupText(composition)
    try {
      const scope = ctx.agentSwarm.scopeOf(lead)
      const created = await toolCall(ctx, lead, 'create', 'agent_swarm_create', {
        name: 'Workflow-mode manual team', description: 'Advance only through explicit operations.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await toolCall(ctx, lead, 'add', 'agent_swarm_add_member', {
        name: 'idle-worker', role: 'Would be scheduled by the event face if it were on.',
      })
      expect(added.isError).toBe(false)
      const workerId = (added.value as { session_id: string }).session_id
      // The join turn is held, so the member is deterministically running
      // when the task-creation operation pass runs: the task stays pending.
      const task = await toolCall(ctx, lead, 'task', 'agent_swarm_create_task', {
        subject: 'Never auto-assigned', description: 'Only an operation or a run may deliver this.',
      })
      expect(task.isError).toBe(false)
      await vi.waitFor(async () => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'pending', revision: 1 })
        expect(ctx.agents.get(SessionId(workerId))?.status).toBe('running')
      }, { timeout: 5_000 })

      // Release the join turn: the member converges idle (or cold — an empty
      // inbox lets the spawn provider settle it) and NOTHING drives a pass
      // for it — no listener is registered in workflow mode, no heal or
      // re-kick exists. The task must stay exactly where it was.
      adapter.open()
      await vi.waitFor(() => {
        const member = ctx.agents.get(SessionId(workerId))
        expect(member === undefined || member.status === 'idle').toBe(true)
      }, { timeout: 5_000 })
      await new Promise(resolve => setTimeout(resolve, 1_500))
      const frozen = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id)
      expect(frozen.team.tasks[0]).toMatchObject({ status: 'pending', revision: 1 })
      expect(frozen.team.tasks[0]?.ownerSessionId).toBeUndefined()
      expect(frozen.team.attempts).toHaveLength(0)
      expect(frozen.team.budget.usedRequests).toBe(0)
      // Zero deliveries of any kind after the idle edge (the join notice is
      // delivered through the provisioning path, not a followup frame).
      expect(spy.records).toEqual([])
    } finally {
      spy.restore()
    }
  })

  it('scenario 32: a workflow run drives its own Team to completion in workflow mode', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-modes-run-driven-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'workflow', workflowBridge: true })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    adapter.submit = true
    const bridge = ctx.agentSwarm.workflowBridge!
    const run = bridge.start({
      script: `const out = await agent('Run the modes proof and submit it.')
return { done: true, out }`,
      meta: { ...META },
      parent: lead,
    })
    const scope = ctx.agentSwarm.scopeOf(lead)
    // Phase 1 — the run's own operation pass meets a running member: the
    // task is durably pending while the join turn is held (no event face
    // exists in workflow mode that could assign it).
    let teamId = ''
    await vi.waitFor(async () => {
      const overlay = bridge.overlay.get(run.id)
      expect(overlay).toMatchObject({ state: 'running' })
      teamId = overlay!.teamId
      const snapshot = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id)
      expect(snapshot.team.tasks[0]).toMatchObject({ status: 'pending' })
    }, { timeout: 15_000 })
    expect(ctx.agentSwarm.orchestration.ownerOf(scope, AgentSwarm.TeamId(teamId))).toBe(run.id)

    // Phase 2 — deterministic single opens: the join turn's release lets the
    // member go idle; the RUN's driver (the only driver left in workflow
    // mode) claims and delivers the assignment, which parks the member's
    // next turn; releasing THAT turn submits and the run reviews + archives.
    adapter.open()
    await vi.waitFor(() => {
      expect(adapter.requests.some(options => JSON.stringify(options.messages).includes('Team assignment from captain'))).toBe(true)
    }, { timeout: 15_000 })
    adapter.open()
    const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
    expect(settled).toMatchObject({ stopReason: 'completed' })
    expect(settled.value).toEqual({ done: true, out: 'Modes member output for task-1.' })
    expect(bridge.overlay.get(run.id)).toMatchObject({ state: 'completed', stopReason: 'completed' })
    // Ownership is released at the terminal edge; the Team archives.
    expect(ctx.agentSwarm.orchestration.ownerOf(scope, AgentSwarm.TeamId(teamId))).toBeUndefined()
    await vi.waitFor(async () => {
      const snapshot = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id)
      expect(snapshot.team.phase).toBe('archived')
      expect(snapshot.team.tasks[0]).toMatchObject({ status: 'completed' })
    }, { timeout: 15_000 })
  })

  it('defers to the run in adaptive mode: no self-heal past the grace, structured owner conflicts', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-modes-no-heal-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, {
      orchestrationMode: 'adaptive',
      workflowBridge: true,
      strandedAfterMs: 250,
    })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const spy = spyFollowupText(composition)
    try {
      const bridge = ctx.agentSwarm.workflowBridge!
      const run = bridge.start({
        script: `await agent('Park on the assignment without submitting.')`,
        meta: { ...META },
        parent: lead,
      })
      const scope = ctx.agentSwarm.scopeOf(lead)
      // Park the assignment: the join turn is released once, the run's idle
      // driver claims and delivers, and the member's assignment turn stays
      // held (in_progress, delivered).
      await vi.waitFor(async () => {
        const overlay = bridge.overlay.get(run.id)
        expect(overlay).toMatchObject({ state: 'running' })
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(overlay!.teamId), lead.id)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'pending', revision: 1 })
      }, { timeout: 15_000 })
      adapter.open()
      await vi.waitFor(() => {
        expect(adapter.requests.some(options => JSON.stringify(options.messages).includes('Team assignment from captain'))).toBe(true)
      }, { timeout: 15_000 })
      await vi.waitFor(async () => {
        const overlay = bridge.overlay.get(run.id)
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(overlay!.teamId), lead.id)
        const task = snapshot.team.tasks[0]!
        const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
        expect(task).toMatchObject({ status: 'in_progress', revision: 2 })
        expect(attempt?.assignmentPhase).toBe('delivered')
      }, { timeout: 15_000 })
      const overlay = bridge.overlay.get(run.id)!
      const teamId = AgentSwarm.TeamId(overlay.teamId)

      // The stranded-heal trigger, constructed exactly like the adaptive
      // suite: park a wakeup behind the running assignment turn, then
      // interrupt the member keepInbox — it converges LIVE-AND-IDLE holding
      // the open in_progress task with the wakeup durably queued.
      const before = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      const taskBefore = before.team.tasks[0]!
      const workerName = before.team.members[0]!.name
      const parked = await toolCall(ctx, lead, 'park-wakeup', 'agent_swarm_send_message', {
        target: workerName, content: 'Parked work across the stranding window.', delivery: 'wakeup',
      })
      expect(parked.isError).toBe(false)
      expect((parked.value as { phase: string }).phase).toBe('queued')
      const interrupted = await ctx.agentSwarm.interruptMember({ agent: lead, signal: new AbortController().signal }, workerName)
      expect(interrupted.previousStatus).toBe('running')
      const member = ctx.agents.get(SessionId(taskBefore.ownerSessionId!))
      await vi.waitFor(() => {
        expect(member).toBeDefined()
        expect(member?.status).toBe('idle')
      }, { timeout: 5_000 })

      // Well past the 250ms grace: a live-and-idle holder of an open task is
      // EXACTLY the heal trigger, and it must NOT fire — the run owns the
      // Team. No retry, no new attempt, no re-delivery, mail still parked.
      await new Promise(resolve => setTimeout(resolve, 1_500))
      const frozen = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      expect(frozen.team.tasks[0]).toMatchObject({
        status: 'in_progress',
        ownerSessionId: taskBefore.ownerSessionId,
        currentAttemptId: taskBefore.currentAttemptId,
        revision: taskBefore.revision,
      })
      expect(frozen.team.attempts).toHaveLength(1)
      expect(frozen.team.messages.filter(message => message.phase === 'queued')).toHaveLength(1)
      expect(spy.records.filter(record => record.text.includes('Team assignment from captain'))).toHaveLength(1)
      expect(ctx.agents.get(SessionId(taskBefore.ownerSessionId!))?.status).toBe('idle')

      // The idle-edge entry itself stays gated: driving the REAL public
      // recovery entry (what the global listener calls) must not even queue
      // a pass for the run-owned Team — still no retry after another window.
      await ctx.agentSwarm.recoverAgent(member!)
      await new Promise(resolve => setTimeout(resolve, 600))
      const afterEntry = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      expect(afterEntry.team.attempts).toHaveLength(1)
      expect(afterEntry.team.tasks[0]?.currentAttemptId).toBe(taskBefore.currentAttemptId)

      // The ownership registry speaks the single-owner contract: a second
      // run id cannot take or drive the Team, and a foreign release cannot
      // steal it (the owning run id is the only key that opens the door).
      expect(ctx.agentSwarm.orchestration.ownerOf(scope, teamId)).toBe(run.id)
      expect(captureDomainError(() => ctx.agentSwarm.orchestration.acquire(scope, teamId, 'another-run')).code)
        .toBe('TEAM_ORCHESTRATION_OWNER_CONFLICT')
      expect(captureDomainError(() => ctx.agentSwarm.orchestration.drive(scope, teamId, 'another-run', lead)).code)
        .toBe('TEAM_ORCHESTRATION_OWNER_CONFLICT')
      ctx.agentSwarm.orchestration.release(scope, teamId, 'another-run')
      expect(ctx.agentSwarm.orchestration.ownerOf(scope, teamId)).toBe(run.id)

      // Budget sanity on the parked window: exactly the participant events
      // folded once (the per-seq cursor makes the fold idempotent across
      // both driving faces; nothing double-counts).
      await vi.waitFor(async () => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
        expect(snapshot.team.budget.usedTokens).toBe(billedTokensOf(member) + billedTokensOf(lead))
      }, { timeout: 5_000 })

      // Cancel converges bounded and releases the ownership at settle.
      run.cancel('modes test done')
      const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
      expect(settled).toMatchObject({ stopReason: 'cancelled' })
      expect(ctx.agentSwarm.orchestration.ownerOf(scope, teamId)).toBeUndefined()
      await run.dispose()
    } finally {
      spy.restore()
    }
  })
})
