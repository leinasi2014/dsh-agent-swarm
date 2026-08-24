/**
 * Budget capability family tests (M4-3, issue #129; decisions in docs/04
 * §8n, design note docs/development/2026-08-22-m4c-budget-family.md):
 *
 * - scenario 37 — retry economics: a failed attempt's folded tokens stay
 *   attributed to the one Team ledger (no refund, no re-windowing) while
 *   every failure-driven re-execution generation charges the retry face, so
 *   `retryLimit` actually bounds in-place retries and the charged face
 *   carries across `adoptBudget`;
 * - scenario 38 — reservation admission: a declared reservation floor
 *   postpones claims that do not fit the remaining budget headroom
 *   (domain refusal + scheduler pre-selection), holds release at settlement,
 *   and the declaration (with the #101/#83 metadata fields) survives a full
 *   storage reload through the fixed durable-boundary schema;
 * - scenario 39 — degraded continuation: budget exhaustion holds an
 *   in_progress task without stranded-heal retries (not the same "stuck"),
 *   the captain's budget recovery re-drives continuation through the
 *   existing lanes, and a carried #79 face is the admission basis of the
 *   next run's reservations.
 *
 * Domain halves run over the real official storage stack; scheduler halves
 * over the real gated composition (AgentLoop + official durable stack +
 * continuable subagents + the swarm plugin).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as AgentSwarm from '../src/index.js'
import { TeamDomainError } from '../src/domain/error.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'
import {
  addMember,
  driveRecoveryPasses,
  mount,
  snapshotOf,
  toolCall,
  type Composition,
} from './helpers/gated-composition.js'

/** Tear one mounted composition down in reverse fiber order (gates open). */
async function disposeComposition(composition: Composition): Promise<void> {
  composition.adapter.open()
  for (const fiber of composition.fibers.toReversed()) {
    await Promise.resolve(fiber.dispose?.()).catch(() => undefined)
  }
}

/** The `hold` field of one task row through the real list tool. */
async function holdOf(composition: Composition, taskId: string): Promise<string | undefined> {
  const rows = await toolCall(composition.ctx, composition.lead, `list-${taskId}`, 'agent_swarm_list_tasks', {})
  expect(rows.isError).toBeFalsy()
  const row = (rows.value as { tasks: { task_id: string, hold?: string }[] }).tasks
    .find(task => task.task_id === taskId)
  return row?.hold
}

describe('Budget family: retry economics (M4-3, real storage stack)', () => {
  let sandbox: string
  let stack: StorageStack

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  /** One fresh captained Team with the given number of active members. */
  async function teamWithMembers(captain: string, count: number) {
    const scope = join(sandbox, 'workspace')
    const team = await stack.port.createTeam(scope, captain, 'Retry economics', 'Ledger truth')
    for (let index = 1; index <= count; index += 1) {
      await stack.port.provisionMember(scope, team.id, captain, {
        name: `worker-${index}`, role: 'worker', sessionId: `${team.id}-member-${index}`, provider: 'spawn',
      })
      await stack.port.settleMember(scope, team.id, `${team.id}-member-${index}`, { active: true })
    }
    return { scope, team }
  }

  it('scenario 37: failed-attempt tokens stay on the one ledger while every re-execution generation charges the retry face', { timeout: 60_000 }, async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-m4c-37-'))
    let tick = 0
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000 * ++tick)
    const { scope, team } = await teamWithMembers('captain-session', 2)
    const first = `${team.id}-member-1`
    const second = `${team.id}-member-2`
    const budgetOf = async () => (await stack.port.snapshot(scope, team.id, 'captain-session')).team.budget

    await stack.port.setBudget(scope, team.id, 'captain-session', { tokenLimit: 1_000, retryLimit: 2 })

    // First generation of task A: one request seat, zero retries, and the
    // member's billed usage folds onto the single ledger.
    const taskA = await stack.port.createTask(scope, team.id, 'captain-session', {
      subject: 'retry economics target', description: 'Folds usage, then fails in place.',
    })
    const claimA = await stack.port.claimTask(scope, team.id, first, taskA.id, taskA.revision)
    expect(claimA.attempt.generation).toBe(1)
    await stack.port.recordSessionUsageBatch(scope, team.id, first, [
      { eventSeq: 3, tokens: 120 }, { eventSeq: 7, tokens: 80 },
    ])
    expect(await budgetOf()).toMatchObject({ usedTokens: 200, usedRequests: 1, usedRetries: 0 })

    // Review rework (task B) keeps its existing retry charge (docs/04 §5).
    const taskB = await stack.port.createTask(scope, team.id, 'captain-session', {
      subject: 'rework target', description: 'Rejected once.',
    })
    const claimB = await stack.port.claimTask(scope, team.id, second, taskB.id, taskB.revision)
    const submittedB = await stack.port.submitTask(scope, team.id, second, taskB.id, claimB.task.revision, claimB.attempt.id, 'partial work')
    await stack.port.reviewTask(scope, team.id, 'captain-session', taskB.id, submittedB.revision, claimB.attempt.id, 'reject', 'needs rework')
    expect((await budgetOf()).usedRetries).toBe(1)

    // In-place retry of A (issue #83): a failure-driven re-execution
    // generation now charges the retry face (M4-3) — while the failed
    // attempt's folded tokens stay attributed to the same ledger, un-refunded
    // and un-rewindowed. Three requests seat so far (A's first generation,
    // B's rework claim, A's retry).
    const retriedA = await stack.port.retryAttempt(scope, team.id, 'captain-session', taskA.id, claimA.task.revision, first, 'stranded ownership self-heal probe')
    expect(retriedA.attempt).toMatchObject({ generation: 2, memberSessionId: first })
    expect(retriedA.attempt.replacesAttemptId).toBe(claimA.attempt.id)
    expect(await budgetOf()).toMatchObject({ usedTokens: 200, usedRequests: 3, usedRetries: 2 })

    // Usage of the retry generation folds into the SAME ledger — usage
    // attribution stays per session event seq (M1B/#92), never per attempt.
    await stack.port.recordSessionUsageBatch(scope, team.id, first, [{ eventSeq: 11, tokens: 60 }])
    expect((await budgetOf()).usedTokens).toBe(260)

    // retryLimit now actually bounds the in-place retry: the third
    // re-execution generation is refused (pre-M4-3 this succeeded — the
    // retry face was checked but never consumed).
    await expect(stack.port.retryAttempt(
      scope, team.id, 'captain-session', taskA.id, retriedA.task.revision, first, 'one retry too many',
    )).rejects.toMatchObject({ code: 'TEAM_BUDGET_RETRIES' })

    // #79 interaction: the charged face carries. The exhausted retry face
    // survives adoption onto a fresh Team and gates its claims exactly like
    // the live face did.
    await stack.port.archiveTeam(scope, team.id, 'captain-session', 'run settled')
    const carried = (await stack.port.snapshot(scope, team.id, 'captain-session')).team.budget
    expect(carried).toMatchObject({ tokenLimit: 1_000, usedTokens: 260, usedRequests: 3, usedRetries: 2, retryLimit: 2 })
    const next = await stack.port.createTeam(scope, 'captain-session', 'Run two', 'Carried retry economics')
    await stack.port.provisionMember(scope, next.id, 'captain-session', {
      name: 'worker-1', role: 'worker', sessionId: `${next.id}-member-1`, provider: 'spawn',
    })
    await stack.port.settleMember(scope, next.id, `${next.id}-member-1`, { active: true })
    const adopted = await stack.port.adoptBudget(scope, next.id, 'captain-session', carried)
    expect(adopted).toMatchObject({ usedRetries: 2, retryLimit: 2 })
    const carriedTask = await stack.port.createTask(scope, next.id, 'captain-session', {
      subject: 'carried face', description: 'Admission computed against the carried ledger.',
    })
    await expect(stack.port.claimTask(scope, next.id, `${next.id}-member-1`, carriedTask.id, carriedTask.revision))
      .rejects.toMatchObject({ code: 'TEAM_BUDGET_RETRIES' })
  })
})

describe('Budget family: reservation admission (M4-3, real storage stack)', () => {
  let sandbox: string
  let stack: StorageStack

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('scenario 38: a reservation floor postpones insufficient claims, releases at settlement and survives reload', { timeout: 60_000 }, async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-m4c-38-'))
    let tick = 0
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000 * ++tick)
    const scope = join(sandbox, 'workspace')
    const captain = 'captain-session'
    const team = await stack.port.createTeam(scope, captain, 'Reservation floor', 'Admission discipline')
    const members: string[] = []
    for (let index = 1; index <= 3; index += 1) {
      const sessionId = `${team.id}-member-${index}`
      await stack.port.provisionMember(scope, team.id, captain, {
        name: `worker-${index}`, role: 'worker', sessionId, provider: 'spawn',
      })
      await stack.port.settleMember(scope, team.id, sessionId, { active: true })
      members.push(sessionId)
    }

    await stack.port.setBudget(scope, team.id, captain, { tokenLimit: 1_000 })

    // Declaration validation: the floor is a positive safe integer.
    await expect(stack.port.createTask(scope, team.id, captain, {
      subject: 'zero floor', description: 'invalid', reservationTokens: 0,
    })).rejects.toMatchObject({ code: 'TEAM_BUDGET_INVALID' })

    // Sufficient floor passes: 0 used + 0 outstanding + 600 <= 1000.
    const holder = await stack.port.createTask(scope, team.id, captain, {
      subject: 'holder', description: 'Holds 600 of headroom while in_progress.', reservationTokens: 600,
    })
    const holderClaim = await stack.port.claimTask(scope, team.id, members[0]!, holder.id, holder.revision)
    expect(holderClaim.task.status).toBe('in_progress')

    // Insufficient floor is postponed by the domain: 600 outstanding + 500
    // floor exceeds the remaining headroom — admission-postpone, never an
    // exhaustion code (it must not converge a run-owned Team).
    const big = await stack.port.createTask(scope, team.id, captain, {
      subject: 'big floor', description: 'Waits for headroom.', reservationTokens: 500,
    })
    const refusal = await stack.port.claimTask(scope, team.id, members[1]!, big.id, big.revision)
      .then(() => undefined, error => error as TeamDomainError)
    expect(refusal).toBeInstanceOf(TeamDomainError)
    expect(refusal?.code).toBe('TEAM_BUDGET_RESERVATION')

    // Unreserved work never blocks on the predicate: 600 + 0 <= 1000.
    const filler = await stack.port.createTask(scope, team.id, captain, {
      subject: 'filler', description: 'No floor declared.',
    })
    await stack.port.claimTask(scope, team.id, members[1]!, filler.id, filler.revision)

    // Settlement releases the hold: submitting the holder frees its 600, so
    // the postponed floor becomes admissible for the third member.
    const submitted = await stack.port.submitTask(
      scope, team.id, members[0]!, holder.id, holderClaim.task.revision, holderClaim.attempt.id, 'holder output',
    )
    expect(submitted.status).toBe('submitted')
    const bigClaim = await stack.port.claimTask(scope, team.id, members[2]!, big.id, big.revision)
    expect(bigClaim.task.status).toBe('in_progress')

    // Durable boundary: the declaration (and, since the M4-3 schema fix,
    // the #101 verification list and the #83 retry linkage) survives a full
    // storage reload — the official load path parses through the table
    // schema, which now declares every additive optional field.
    const bigRetry = await stack.port.retryAttempt(
      scope, team.id, captain, big.id, bigClaim.task.revision, members[2]!, 'reload probe',
    )
    const verified = await stack.port.createTask(scope, team.id, captain, {
      subject: 'verified', description: 'Carries a frozen verification list.', verification: [{ command: 'echo ok' }],
    })
    expect(verified.verification).toEqual([{ command: 'echo ok' }])
    await stack.close()

    stack = await openStorageStack(join(sandbox, 'storage'), () => 10_000_000)
    const reopened = await stack.port.snapshot(scope, team.id, captain)
    const tasks = new Map(reopened.team.tasks.map(task => [task.id, task]))
    expect(tasks.get(holder.id)?.reservationTokens).toBe(600)
    expect(tasks.get(big.id)?.reservationTokens).toBe(500)
    expect(tasks.get(verified.id)?.verification).toEqual([{ command: 'echo ok' }])
    const reopenedBigAttempt = reopened.team.attempts.find(attempt => attempt.id === bigRetry.attempt.id)
    expect(reopenedBigAttempt?.replacesAttemptId).toBe(bigClaim.attempt.id)
  })
})

describe('Budget family: reservation-aware scheduling (M4-3, real composition)', () => {
  const sandboxes: string[] = []
  const compositions: Composition[] = []

  afterEach(async () => {
    for (const composition of compositions.splice(0)) await disposeComposition(composition)
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('scenario 38: the scheduler postpones reservation-insufficient tasks and claims them once headroom frees', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-m4c-38c-'))
    sandboxes.push(sandbox)
    // Long grace: the stranded heal stays out of this test's way.
    const composition = await mount(sandbox, 60_000)
    compositions.push(composition)
    const { ctx, lead } = composition
    const domain = ctx.agentSwarm.domain
    const teamId = AgentSwarm.TeamId(composition.teamId)
    const scope = ctx.agentSwarm.scopeOf(lead)

    // Two members; the budget leaves exactly 1000 tokens of headroom after
    // usage (the composition's real turns bill small real usage first — the
    // limit is sized relative to it, the consumption is absolute).
    await addMember(composition, 'floor-holder')
    await addMember(composition, 'floor-waiter')
    const usedBefore = (await snapshotOf(composition)).team.budget.usedTokens
    const limit = usedBefore + 10_000
    await ctx.agentSwarm.setBudget({ agent: lead, signal: AbortSignal.timeout(30_000) }, { tokenLimit: limit })
    await domain.consumeTokens(scope, teamId, 9_000)

    const big = await toolCall(ctx, lead, 'create-big', 'agent_swarm_create_task', {
      subject: 'reservation too big for the headroom',
      description: 'Declares a 1500-token floor against 1000 remaining.',
      reservation_tokens: 1_500,
    })
    expect(big.isError).toBeFalsy()
    const filler = await toolCall(ctx, lead, 'create-filler', 'agent_swarm_create_task', {
      subject: 'unreserved filler',
      description: 'Claims through the same remaining budget without a floor.',
    })
    expect(filler.isError).toBeFalsy()
    const bigId = (big.value as { task_id: string }).task_id
    const fillerId = (filler.value as { task_id: string }).task_id

    // Both members drain their join turns; the pass that follows offers ONLY
    // the admissible filler to the Provider — the floor task is postponed,
    // never claimed, and surfaces hold=reservation evidence.
    await driveRecoveryPasses(composition, async () => {
      const snapshot = await snapshotOf(composition)
      expect(snapshot.team.tasks.find(task => task.id === fillerId)?.status).toBe('in_progress')
    })
    let snapshot = await snapshotOf(composition)
    expect(snapshot.team.tasks.find(task => task.id === bigId)?.status).toBe('pending')
    expect(snapshot.team.budget.usedRequests).toBe(1)
    expect(await holdOf(composition, bigId)).toBe('reservation')

    // Budget release (set_budget raising the limit) is the scheduling event
    // that re-offers the postponed floor; the freed member claims it.
    await ctx.agentSwarm.setBudget({ agent: lead, signal: AbortSignal.timeout(30_000) }, { tokenLimit: limit + 5_000 })
    await driveRecoveryPasses(composition, async () => {
      snapshot = await snapshotOf(composition)
      expect(snapshot.team.tasks.find(task => task.id === bigId)?.status).toBe('in_progress')
    })
    expect(snapshot.team.budget.usedRequests).toBe(2)
    expect(await holdOf(composition, bigId)).toBeUndefined()
  })
})

describe('Budget family: degraded continuation (M4-3, real composition)', () => {
  const sandboxes: string[] = []
  const compositions: Composition[] = []

  afterEach(async () => {
    for (const composition of compositions.splice(0)) await disposeComposition(composition)
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('scenario 39: exhaustion holds in_progress work without stranded retries and budget recovery continues it', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-m4c-39-'))
    sandboxes.push(sandbox)
    // Short grace: without the budget-hold gate the stranded heal would fire
    // almost immediately once the owner goes idle.
    const composition = await mount(sandbox, 200)
    compositions.push(composition)
    const { ctx, adapter, lead } = composition
    const domain = ctx.agentSwarm.domain
    const teamId = AgentSwarm.TeamId(composition.teamId)
    const scope = ctx.agentSwarm.scopeOf(lead)

    const workerId = await addMember(composition, 'degraded-holder')

    // Drive to a real delivered assignment: the task is created while the
    // worker still runs its gated join turn (the live-status filter defers
    // the claim), then the gate release's idle edge assigns it and the
    // worker parks RUNNING on the assignment turn (stranded-ownership
    // choreography). No limit yet — the claim admits trivially.
    const created = await toolCall(ctx, lead, 'create-degraded', 'agent_swarm_create_task', {
      subject: 'degraded continuation target',
      description: 'Held mid-execution when the budget exhausts.',
    })
    expect(created.isError).toBeFalsy()
    const taskId = (created.value as { task_id: string }).task_id
    adapter.open()
    await vi.waitFor(async () => {
      const snapshot = await snapshotOf(composition)
      const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
      expect(task).toMatchObject({ status: 'in_progress' })
      expect(ctx.agents.get(SessionId(task!.ownerSessionId!))?.status).toBe('running')
    }, { timeout: 15_000 })
    let snapshot = await snapshotOf(composition)
    const firstAttemptId = snapshot.team.tasks.find(task => task.id === taskId)!.currentAttemptId!
    expect(snapshot.team.budget.usedRequests).toBe(1)

    // Exhaust the budget WHILE the member still runs its assignment turn:
    // the limit is sized relative to the real usage so far, the consumption
    // lands exactly on it, and any later turn-end usage overshoots it (the
    // ledger records real spend) — exhausted either way, deterministically.
    const usedSoFar = snapshot.team.budget.usedTokens
    const limit = usedSoFar + 10_000
    await ctx.agentSwarm.setBudget({ agent: lead, signal: AbortSignal.timeout(30_000) }, { tokenLimit: limit })
    await domain.consumeTokens(scope, teamId, 10_000)
    snapshot = await snapshotOf(composition)
    expect(snapshot.team.budget.tokenLimit).toBe(limit)
    expect(snapshot.team.budget.usedTokens).toBeGreaterThanOrEqual(limit)

    // Park a wakeup message behind the running assignment turn first:
    // pending next-turn work keeps the Activation resident after the
    // interrupt below (an empty inbox would let the spawn provider
    // auto-settle the member cold, which is the evidence-only owner path —
    // this test needs the live-idle owner the heal drives). Issue #52: the
    // still-pending frame reports `queued` and is never resent.
    const parked = await toolCall(ctx, lead, 'send-wakeup', 'agent_swarm_send_message', {
      target: 'degraded-holder', content: 'Parked work across the exhaustion window.', delivery: 'wakeup',
    })
    expect(parked.isError).toBeFalsy()
    expect((parked.value as { phase: string }).phase).toBe('queued')

    // The captain interrupts the assignment turn (keepInbox): the member
    // converges live-and-idle holding an open in_progress task — the exact
    // stranded-heal trigger shape — while the budget face is exhausted.
    const interrupted = await ctx.agentSwarm.interruptMember(
      { agent: lead, signal: AbortSignal.timeout(30_000) }, 'degraded-holder',
    )
    expect(interrupted.previousStatus).toBe('running')
    await vi.waitFor(() => {
      const member = ctx.agents.get(SessionId(workerId))
      expect(member).toBeDefined()
      expect(member?.status).toBe('idle')
    }, { timeout: 5_000 })

    // Past the 200ms grace the heal WOULD retry — but the budget-hold gate
    // keeps it off: exhaustion is team economics, not an owner-liveness
    // defect. No new attempt, no charges, hold=budget evidence.
    await driveRecoveryPasses(composition, async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    snapshot = await snapshotOf(composition)
    const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)!
    expect(task.status).toBe('in_progress')
    expect(snapshot.team.attempts.filter(attempt => attempt.taskId === task.id)).toHaveLength(1)
    expect(snapshot.team.budget).toMatchObject({ usedRequests: 1, usedRetries: 0 })
    expect(await holdOf(composition, taskId)).toBe('budget')

    // Recovery: raising the limit is the §7 budget-release event; the
    // triggered pass re-drives the held task through the EXISTING lanes —
    // the same-owner in-place retry (grace long past) — and the hold
    // evidence clears.
    await ctx.agentSwarm.setBudget({ agent: lead, signal: AbortSignal.timeout(30_000) }, { tokenLimit: limit + 1_000_000 })
    await driveRecoveryPasses(composition, async () => {
      snapshot = await snapshotOf(composition)
      expect(snapshot.team.attempts.filter(attempt => attempt.taskId === task.id).length).toBeGreaterThan(1)
    })
    snapshot = await snapshotOf(composition)
    expect(task.status).toBe('in_progress')
    expect(task.ownerSessionId).toBe(workerId)
    const successor = snapshot.team.attempts.filter(attempt => attempt.taskId === task.id).at(-1)!
    expect(successor).toMatchObject({ generation: 2, memberSessionId: workerId })
    expect(successor.replacesAttemptId).toBe(firstAttemptId)
    expect(snapshot.team.budget).toMatchObject({ usedRequests: 2, usedRetries: 1 })
    expect(await holdOf(composition, taskId)).toBeUndefined()
  })
})

describe('Budget family: carried reservation basis (M4-3, real storage stack)', () => {
  let sandbox: string
  let stack: StorageStack

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('scenario 39: a carried #79 face is the admission basis of the next run\'s reservations', { timeout: 60_000 }, async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-m4c-39d-'))
    let tick = 0
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000 * ++tick)
    const scope = join(sandbox, 'workspace')
    const captain = 'captain-session'

    // Run 1's Team: nearly-exhausted face (900 of 1000 spent, NOT exhausted)
    // archived with its ledger as the carry source.
    const first = await stack.port.createTeam(scope, captain, 'Run one', 'Reservation carry')
    await stack.port.provisionMember(scope, first.id, captain, {
      name: 'worker-1', role: 'worker', sessionId: `${first.id}-member-1`, provider: 'spawn',
    })
    await stack.port.settleMember(scope, first.id, `${first.id}-member-1`, { active: true })
    await stack.port.setBudget(scope, first.id, captain, { tokenLimit: 1_000 })
    await stack.port.consumeTokens(scope, first.id, 900)
    await stack.port.archiveTeam(scope, first.id, captain, 'run settled')
    const carried = (await stack.port.snapshot(scope, first.id, captain)).team.budget
    expect(carried).toMatchObject({ tokenLimit: 1_000, usedTokens: 900 })

    // Run 2's fresh Team adopts the face; its reservations never carry
    // (holds are per-Team derived state, tasks never cross runs), but the
    // CARRIED face decides admission: a 200-token floor does not fit the
    // carried 100-token headroom — the reservation code, not exhaustion.
    const second = await stack.port.createTeam(scope, captain, 'Run two', 'Carried admission basis')
    await stack.port.provisionMember(scope, second.id, captain, {
      name: 'worker-1', role: 'worker', sessionId: `${second.id}-member-1`, provider: 'spawn',
    })
    await stack.port.settleMember(scope, second.id, `${second.id}-member-1`, { active: true })
    await stack.port.adoptBudget(scope, second.id, captain, carried)
    const reserved = await stack.port.createTask(scope, second.id, captain, {
      subject: 'carried-basis floor', description: 'Admission against the carried face.', reservationTokens: 200,
    })
    await expect(stack.port.claimTask(scope, second.id, `${second.id}-member-1`, reserved.id, reserved.revision))
      .rejects.toMatchObject({ code: 'TEAM_BUDGET_RESERVATION' })

    // Recovery on the live Team admits it: the raised limit recomputes the
    // same floor against the same carried usage.
    await stack.port.setBudget(scope, second.id, captain, { tokenLimit: 2_000 })
    const claimed = await stack.port.claimTask(scope, second.id, `${second.id}-member-1`, reserved.id, reserved.revision)
    expect(claimed.task).toMatchObject({ status: 'in_progress' })
  })
})
