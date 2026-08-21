/**
 * Real-composition budget-across-runs tests (M2-5, issue #79): one Team
 * budget ledger consumed by sequential workflow runs of the same captain,
 * wake deliveries of BOTH orchestration faces charging that single ledger
 * exactly once, budget exhaustion converging a run to a bounded terminal
 * state, and the ledger staying consistent across a full storage reload.
 *
 * Tree: the M2-3 modes composition (AgentLoop + official durable stack +
 * continuable subagents + the swarm plugin with the workflow bridge), with a
 * gated content-aware member adapter. Lessons 28/29 discipline: `vi.waitFor`
 * timeouts are 15s and every case carries an explicit budget of at least
 * 60s.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { TeamDomainPort, TeamScope } from '../src/domain/team-domain-port.js'
import type { TeamState } from '../src/domain/types.js'
import {
  billedTokensOf,
  mountModesComposition,
  type ModesComposition,
} from './helpers/modes-composition.js'

const META = {
  name: 'budget-runs-proof',
  description: 'Prove one Team budget ledger spans runs, wakes and reloads.',
} as const

/** One recorded `workflow/*` dispatch (pairing proofs on terminal paths). */
interface WorkflowEventRecord { readonly name: string; readonly detail: unknown }

/** Record every `workflow/*` event dispatched on one tree's global bus. */
function recordWorkflowEvents(ctx: Context): WorkflowEventRecord[] {
  const events: WorkflowEventRecord[] = []
  ctx.on('internal/dispatch', (_mode, name, args) => {
    if (typeof name !== 'string' || !name.startsWith('workflow/')) return
    events.push({ name, detail: args[1] })
  })
  return events
}

/** One captain-side budget configuration over the real runtime. */
async function setBudget(composition: ModesComposition, limits: { requestLimit?: number; tokenLimit?: number }) {
  return await composition.ctx.agentSwarm.setBudget({ agent: composition.lead, signal: AbortSignal.timeout(30_000) }, limits)
}

/** The billed tokens of one session's assistant events after an event seq. */
function billedTokensAfter(agent: Agent | undefined, afterSeq: number): number {
  if (agent === undefined) return 0
  let tokens = 0
  for (const event of agent.session.events) {
    if (event.seq <= afterSeq) continue
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    tokens += event.data.usage.inputTokens + event.data.usage.outputTokens
      + (event.data.usage.cacheReadTokens ?? 0) + (event.data.usage.cacheWriteTokens ?? 0)
  }
  return tokens
}

/** Read one run Team's snapshot through the authoritative port. */
async function teamOf(composition: ModesComposition, domain: TeamDomainPort, scope: TeamScope, teamId: string) {
  const snapshot = await domain.snapshot(scope, AgentSwarm.TeamId(teamId), composition.lead.id)
  return snapshot.team
}

/** Wait until a run's Team aggregate is durably archived. */
async function waitForArchive(composition: ModesComposition, domain: TeamDomainPort, scope: TeamScope, teamId: string): Promise<TeamState> {
  return await vi.waitFor(async () => {
    const team = await teamOf(composition, domain, scope, teamId)
    expect(team.phase).toBe('archived')
    return team
  }, { timeout: 15_000 })
}

/**
 * Parked-run flow shared by the continuity/exhaustion cases: start the run,
 * wait for its pending task AND the member's parked join turn (the gate
 * release must not race past a turn that has not started yet), release the
 * join turn (the member goes idle, the run's own driver claims and delivers,
 * and the member parks again on the assignment turn), then wait for the
 * in_progress delivery with the assignment turn parked.
 */
async function parkRunOnAssignment(
  composition: ModesComposition,
  script: string,
  name: string,
): Promise<{ runId: string; teamId: string }> {
  const { ctx, lead } = composition
  const bridge = ctx.agentSwarm.workflowBridge!
  const run = bridge.start({ script, meta: { ...META, name }, parent: lead })
  const domain: TeamDomainPort = ctx.agentSwarm.domain
  const scope: TeamScope = ctx.agentSwarm.scopeOf(lead)
  const memberParked = async (index: number): Promise<string> => {
    const team = await teamOf(composition, domain, scope, bridge.overlay.get(run.id)!.teamId)
    const sessionId = team.members[index]!.sessionId
    expect(ctx.agents.get(SessionId(sessionId))?.status).toBe('running')
    return sessionId
  }
  await vi.waitFor(async () => {
    const overlay = bridge.overlay.get(run.id)
    expect(overlay).toMatchObject({ state: 'running' })
    expect((await teamOf(composition, domain, scope, overlay!.teamId)).tasks[0]).toMatchObject({ status: 'pending' })
    await memberParked(0)
  }, { timeout: 15_000 })
  const teamId = bridge.overlay.get(run.id)!.teamId
  composition.adapter.open()
  await vi.waitFor(async () => {
    const team = await teamOf(composition, domain, scope, teamId)
    expect(team.tasks[0]).toMatchObject({ status: 'in_progress' })
    // The claim alone does not mean the assignment turn is parked yet: the
    // waking delivery resumes the member asynchronously. Wait until the
    // member is RUNNING again (its assignment turn started) so the next gate
    // release cannot race past the turn.
    expect(ctx.agents.get(SessionId(team.members[0]!.sessionId))?.status).toBe('running')
  }, { timeout: 15_000 })
  return { runId: run.id, teamId }
}

describe('Team budget across workflow runs (M2-5, issue #79)', () => {
  const sandboxes: string[] = []
  const compositions: ModesComposition[] = []

  afterEach(async () => {
    for (const composition of compositions.splice(0)) {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) {
        await Promise.resolve(fiber.dispose?.()).catch(() => undefined)
      }
    }
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('scenario 33: continues one budget ledger across sequential runs of the same captain (set_budget once, many runs consume)', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-budget-runs-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const bridge = ctx.agentSwarm.workflowBridge!
    const domain: TeamDomainPort = ctx.agentSwarm.domain
    const scope: TeamScope = ctx.agentSwarm.scopeOf(lead)

    // Run 1: park on the assignment turn, configure the budget mid-run (the
    // only moment a run Team is mutable), then complete.
    const run1 = await parkRunOnAssignment(composition, `const out = await agent('Run one work.')\nreturn { out }`, 'carry-run-1')
    const before = await teamOf(composition, domain, scope, run1.teamId)
    expect(before.budget.usedRequests).toBe(1)
    await setBudget(composition, { requestLimit: 10 })
    adapter.submit = true
    adapter.open()
    await vi.waitFor(async () => {
      expect(bridge.overlay.get(run1.runId)).toMatchObject({ state: 'completed' })
    }, { timeout: 15_000 })
    const team1 = await waitForArchive(composition, domain, scope, run1.teamId)
    expect(team1.budget).toMatchObject({ requestLimit: 10, usedRequests: 1 })
    expect(team1.budget.usedTokens).toBeGreaterThan(0)
    const run1Tokens = team1.budget.usedTokens

    // Run 2 (same captain, fresh Team): the carried ledger — the limit set
    // once on run 1 plus its consumed counters — is where run 2 starts, and
    // run 2's own claims consume the SAME allowance.
    const run2 = await parkRunOnAssignment(composition, `const out = await agent('Run two work.')\nreturn { out }`, 'carry-run-2')
    const carried = (await teamOf(composition, domain, scope, run2.teamId)).budget
    expect(carried).toMatchObject({ requestLimit: 10, usedRequests: 2 })
    adapter.open()
    await vi.waitFor(async () => {
      expect(bridge.overlay.get(run2.runId)).toMatchObject({ state: 'completed' })
    }, { timeout: 15_000 })
    expect(run2.teamId).not.toBe(run1.teamId)
    const team2 = await waitForArchive(composition, domain, scope, run2.teamId)
    expect(team2.budget.requestLimit).toBe(10)
    expect(team2.budget.usedRequests).toBe(2)
    expect(team2.budget.usedTokens).toBeGreaterThan(run1Tokens)
  })

  it('scenario 33: counts wake deliveries of BOTH faces into the single Team ledger exactly once', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-budget-wakes-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const bridge = ctx.agentSwarm.workflowBridge!
    const domain: TeamDomainPort = ctx.agentSwarm.domain
    const scope: TeamScope = ctx.agentSwarm.scopeOf(lead)

    // Face 1 — run-driven wakes: two assignment dispatches through the run's
    // own scheduling passes. The ledger counts exactly the seated attempts;
    // provisioning, review, overlay writes, events and the jobs projection
    // add nothing (the bridge keeps no second counter: the official
    // event-pairing count `agentsStarted` equals the request charge).
    adapter.submit = true
    const run = bridge.start({
      script: `const a = await agent('Wake one.')\nconst b = await agent('Wake two.')\nreturn { a, b }`,
      meta: { ...META },
      parent: lead,
    })
    const runTeamIdOf = (): string => bridge.overlay.get(run.id)!.teamId
    // Two sequential wake cycles (the claim charge is per seated attempt, so
    // sequential agents prove the same single-ledger arithmetic without
    // depending on the host's executor concurrency slots). Each member parks
    // on its join turn first; the gate release must not race past it.
    for (let index = 0; index < 2; index += 1) {
      await vi.waitFor(async () => {
        const team = await teamOf(composition, domain, scope, runTeamIdOf())
        expect(bridge.overlay.get(run.id)).toMatchObject({ state: 'running' })
        expect(team.tasks).toHaveLength(index + 1)
        expect(team.tasks[index]).toMatchObject({ status: 'pending' })
        // This cycle's member parks on its join turn; the release must not
        // race past a turn that has not started yet.
        expect(ctx.agents.get(SessionId(team.members[index]!.sessionId))?.status).toBe('running')
      }, { timeout: 15_000 })
      adapter.open()
      await vi.waitFor(async () => {
        const team = await teamOf(composition, domain, scope, runTeamIdOf())
        const task = team.tasks[index]!
        expect(task).toMatchObject({ status: 'in_progress' })
        // The scheduler may seat the claim on ANY available member (the prior
        // cycles' members are idle again) — the wake's recipient is the
        // seated owner, and its assignment turn must be parked (running)
        // before the next release.
        expect(task.ownerSessionId).toBeDefined()
        expect(ctx.agents.get(SessionId(task.ownerSessionId!))?.status).toBe('running')
        expect(team.budget.usedRequests).toBe(index + 1)
      }, { timeout: 15_000 })
      adapter.open()
    }
    const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
    expect(settled).toMatchObject({ stopReason: 'completed', agentsStarted: 2 })
    const runTeamId = runTeamIdOf()
    // The request face IS the wake charge: one charge per wake-delivered
    // seated attempt, on BOTH faces the same single ledger — and the bridge's
    // official event-pairing count equals it exactly (no second counter:
    // provisioning, review, overlay, events and the jobs projection add
    // nothing). The exact per-event token fold is proven by the reload case
    // and scenario 31 (post-archive member sessions go cold, so the live
    // session sums are only meaningful pre-archive).
    const runTeam = await waitForArchive(composition, domain, scope, runTeamId)
    expect(runTeam.budget.usedRequests).toBe(2)
    expect(runTeam.budget.usedTokens).toBeGreaterThan(0)

    // Face 2 — adaptive-driven wakes: the same claim→dispatch path through
    // the event face on a non-run Team of the same captain (run Teams are
    // archived, so the captain may found an adaptive one). The captain's
    // usage cursor is seeded at this Team's creation, so only the lead's
    // LATER events can fold here (its earlier turns belong to the run Teams).
    const exec = { agent: lead, signal: AbortSignal.timeout(30_000) }
    const leadSeqAtCreate = lead.session.events.at(-1)?.seq ?? -1
    const adaptive = await ctx.agentSwarm.create(exec, 'Adaptive team', 'Event-face wake accounting.')
    const member = await ctx.agentSwarm.addMember(exec, { name: 'awake-worker', role: 'worker' })
    const created = await ctx.agentSwarm.createTask(exec, {
      subject: 'Adaptive wake', description: 'One event-face assignment wake.',
    })
    // The member parks on its join turn; releasing it idles the member, the
    // ADAPTIVE idle-edge pass claims (one request charge) and delivers the
    // waking assignment, and the member parks again on the assignment turn.
    // (The join turn must be parked before the release — same barrier rule.)
    await vi.waitFor(() => {
      expect(ctx.agents.get(SessionId(member.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    adapter.open()
    await vi.waitFor(async () => {
      const team = await teamOf(composition, domain, scope, adaptive.id)
      expect(team.tasks.find(task => task.id === created.id)).toMatchObject({ status: 'in_progress' })
      expect(ctx.agents.get(SessionId(member.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    const claimed = await teamOf(composition, domain, scope, adaptive.id)
    expect(claimed.budget.usedRequests).toBe(1)
    // Release the member's assignment turn: it submits, the captain accepts.
    adapter.open()
    await vi.waitFor(async () => {
      const team = await teamOf(composition, domain, scope, adaptive.id)
      const task = team.tasks.find(candidate => candidate.id === created.id)!
      expect(['submitted', 'verifying', 'completed']).toContain(task.status)
    }, { timeout: 15_000 })
    // Review-accept completes the task without a second charge; the token
    // face folds the member's billed events exactly once.
    const submitted = await teamOf(composition, domain, scope, adaptive.id)
    const task = submitted.tasks.find(candidate => candidate.id === created.id)!
    if (task.status !== 'completed') {
      await ctx.agentSwarm.reviewTask(exec, {
        taskId: task.id, expectedRevision: task.revision, attemptId: task.currentAttemptId!, decision: 'accept',
      })
    }
    await vi.waitFor(async () => {
      const team = await teamOf(composition, domain, scope, adaptive.id)
      expect(team.tasks.find(candidate => candidate.id === created.id)).toMatchObject({ status: 'completed' })
      expect(team.budget.usedTokens).toBe(
        billedTokensOf(ctx.agents.get(SessionId(member.sessionId))) + billedTokensAfter(lead, leadSeqAtCreate),
      )
      // ONE request charge for the ONE seated attempt — the same single
      // ledger both faces consume; passes, heals and review add nothing.
      expect(team.budget.usedRequests).toBe(1)
    }, { timeout: 15_000 })
  })

  it('scenario 33: converges a run to a bounded error terminal when the carried budget is exhausted (no hang)', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-budget-exhaust-'))
    sandboxes.push(sandbox)
    const composition = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true })
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const bridge = ctx.agentSwarm.workflowBridge!
    const domain: TeamDomainPort = ctx.agentSwarm.domain
    const scope: TeamScope = ctx.agentSwarm.scopeOf(lead)
    const events = recordWorkflowEvents(ctx)

    // Run 1 exhausts its one-request limit and settles normally.
    const run1 = await parkRunOnAssignment(composition, `await agent('Consume the single admitted request.')`, 'exhaust-run-1')
    await setBudget(composition, { requestLimit: 1 })
    adapter.submit = true
    adapter.open()
    await vi.waitFor(async () => {
      expect(bridge.overlay.get(run1.runId)).toMatchObject({ state: 'completed' })
    }, { timeout: 15_000 })
    await waitForArchive(composition, domain, scope, run1.teamId)

    // Run 2 inherits the exhausted ledger: its first claim is rejected by the
    // admission gate. The run must converge to a terminal error carrying the
    // structured code — never park on the unseatable claim.
    events.length = 0
    const run2 = bridge.start({
      script: `await agent('Can never be seated: the budget is exhausted.')`,
      meta: { ...META },
      parent: lead,
    })
    await vi.waitFor(async () => {
      const overlay = bridge.overlay.get(run2.id)
      expect(overlay).toMatchObject({ state: 'running' })
      const team = await teamOf(composition, domain, scope, overlay!.teamId)
      expect(team.tasks[0]).toMatchObject({ status: 'pending' })
      // The member's join turn must be parked before the release.
      expect(ctx.agents.get(SessionId(team.members[0]!.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    const team2Id = bridge.overlay.get(run2.id)!.teamId
    // Releasing the join turn idles the member; the run's own driver runs the
    // pass whose claim the budget gate rejects → structured convergence.
    adapter.open()
    const settled2 = await vi.waitFor(async () => {
      const overlay = bridge.overlay.get(run2.id)
      expect(overlay).toMatchObject({ state: 'error', stopReason: 'error' })
      expect(overlay!.error).toContain('TEAM_BUDGET_REQUESTS')
      return overlay!
    }, { timeout: 15_000 })
    void settled2
    const team2 = await waitForArchive(composition, domain, scope, team2Id)
    expect(team2.budget).toMatchObject({ requestLimit: 1, usedRequests: 1 })
    // The published stream stays paired: the started agent ended exactly
    // once as a failure, before the run's terminal `workflow/end`.
    const names = events.map(event => event.name)
    expect(names).toEqual(['workflow/start', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'])
    expect(events[2]!.detail).toMatchObject({ seq: 1, outcome: 'failed' })
    const end = events[3]!.detail as { stopReason: string; error?: string; agentsStarted: number }
    expect(end).toMatchObject({ stopReason: 'error', agentsStarted: 1 })
    expect(end.error).toContain('TEAM_BUDGET_REQUESTS')
  })

  it('scenario 33: keeps the carried ledger consistent across a full storage reload (durable carry, refold never double-counts)', { timeout: 150_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-budget-reload-'))
    sandboxes.push(sandbox)
    const leadId = 'budget-reload-lead'
    const treeA = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true, leadSessionId: leadId })
    compositions.push(treeA)
    const bridgeA = treeA.ctx.agentSwarm.workflowBridge!
    const domainA: TeamDomainPort = treeA.ctx.agentSwarm.domain
    const scopeA: TeamScope = treeA.ctx.agentSwarm.scopeOf(treeA.lead)

    // Tree A: run 1 with a configured limit and real usage. The member parks
    // on its join turn; release it so the run's driver seats the claim, park
    // again on the assignment turn, configure the budget, then release the
    // submission.
    treeA.adapter.submit = true
    const run1 = bridgeA.start({
      script: `await agent('Record usage before the process boundary.')`,
      meta: { ...META },
      parent: treeA.lead,
    })
    await vi.waitFor(async () => {
      const overlay = bridgeA.overlay.get(run1.id)
      expect(overlay).toMatchObject({ state: 'running' })
      const team = await teamOf(treeA, domainA, scopeA, overlay!.teamId)
      expect(team.tasks[0]).toMatchObject({ status: 'pending' })
      expect(treeA.ctx.agents.get(SessionId(team.members[0]!.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    const team1Id = bridgeA.overlay.get(run1.id)!.teamId
    treeA.adapter.open()
    await vi.waitFor(async () => {
      const team = await teamOf(treeA, domainA, scopeA, team1Id)
      expect(team.tasks[0]).toMatchObject({ status: 'in_progress' })
      expect(treeA.ctx.agents.get(SessionId(team.members[0]!.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    await setBudget(treeA, { requestLimit: 5 })
    treeA.adapter.open()
    expect((await vi.waitFor(() => run1.result, { timeout: 15_000 })).stopReason).toBe('completed')
    const team1 = await waitForArchive(treeA, domainA, scopeA, team1Id)
    const durableBudget = structuredClone(team1.budget)
    expect(durableBudget).toMatchObject({ requestLimit: 5, usedRequests: 1 })
    expect(durableBudget.usedTokens).toBeGreaterThan(0)
    // Graceful teardown of tree A (the run is settled; nothing is live).
    treeA.adapter.open()
    for (const fiber of treeA.fibers.toReversed()) await fiber.dispose()

    // Tree B over the SAME storage root, SAME durable captain identity.
    const treeB = await mountModesComposition(sandbox, { orchestrationMode: 'adaptive', workflowBridge: true, leadSessionId: leadId })
    compositions.push(treeB)
    const bridgeB = treeB.ctx.agentSwarm.workflowBridge!
    const domainB: TeamDomainPort = treeB.ctx.agentSwarm.domain
    const scopeB: TeamScope = treeB.ctx.agentSwarm.scopeOf(treeB.lead)
    expect(scopeB).toBe(scopeA)
    // The durable run truth and the archived ledger survived the boundary.
    expect(bridgeB.overlay.get(run1.id)).toMatchObject({ state: 'completed', teamId: team1Id })
    expect((await teamOf(treeB, domainB, scopeB, team1Id)).budget).toEqual(durableBudget)

    // Run 2 in tree B continues FROM that durable ledger (same two-phase
    // member flow as tree A).
    treeB.adapter.submit = true
    const run2 = bridgeB.start({
      script: `await agent('Continue the ledger after the reload.')`,
      meta: { ...META },
      parent: treeB.lead,
    })
    await vi.waitFor(async () => {
      const overlay = bridgeB.overlay.get(run2.id)
      expect(overlay).toMatchObject({ state: 'running' })
      const team = await teamOf(treeB, domainB, scopeB, overlay!.teamId)
      expect(team.tasks[0]).toMatchObject({ status: 'pending' })
      expect(treeB.ctx.agents.get(SessionId(team.members[0]!.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    const team2Id = bridgeB.overlay.get(run2.id)!.teamId
    treeB.adapter.open()
    await vi.waitFor(async () => {
      const team = await teamOf(treeB, domainB, scopeB, team2Id)
      expect(team.tasks[0]).toMatchObject({ status: 'in_progress' })
      expect(treeB.ctx.agents.get(SessionId(team.members[0]!.sessionId))?.status).toBe('running')
    }, { timeout: 15_000 })
    const carried = (await teamOf(treeB, domainB, scopeB, team2Id)).budget
    expect(carried.requestLimit).toBe(5)
    expect(carried.usedRequests).toBe(2)

    // Cursor refold across the run boundary: replaying run 2's member usage
    // events through the authoritative fold changes nothing (per-seq cursors
    // — the M1B idempotency the carry extends, verified not reimplemented).
    const owner = (await teamOf(treeB, domainB, scopeB, team2Id)).members[0]!.sessionId
    const memberAgent = treeB.ctx.agents.get(SessionId(owner))
    expect(memberAgent).toBeDefined()
    const entries: Array<{ eventSeq: number; tokens: number }> = []
    for (const event of memberAgent!.session.events) {
      if (event.type !== 'assistant/message') continue
      const usage = event.data.usage
      if (usage === undefined) continue
      entries.push({
        eventSeq: event.seq,
        tokens: usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      })
    }
    expect(entries.length).toBeGreaterThan(0)
    const beforeReplay = (await teamOf(treeB, domainB, scopeB, team2Id)).budget.usedTokens
    await domainB.recordSessionUsageBatch(scopeB, AgentSwarm.TeamId(team2Id), owner, entries)
    expect((await teamOf(treeB, domainB, scopeB, team2Id)).budget.usedTokens).toBe(beforeReplay)

    // Release the parked assignment turn: the member submits, the run
    // reviews and settles, and the ledger accumulates exactly run 2's own
    // usage on top of the carried face.
    treeB.adapter.open()
    expect((await vi.waitFor(() => run2.result, { timeout: 15_000 })).stopReason).toBe('completed')
    const team2 = await waitForArchive(treeB, domainB, scopeB, team2Id)
    expect(team2.budget).toMatchObject({ requestLimit: 5, usedRequests: 2 })
    expect(team2.budget.usedTokens).toBeGreaterThan(durableBudget.usedTokens)
  })
})
