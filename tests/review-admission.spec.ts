/** #253: Provider side effects need the same admission facts as the final domain review. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { validateTaskReview } from '../src/domain/team-domain-board.js'
import { TaskId, TeamId } from '../src/domain/types.js'
import { runReviewTransaction, type ReviewTransactionDeps } from '../src/runtime/review-transaction.js'
import type { ReviewProviderResult } from '../src/runtime/providers.js'
import { SIGNAL, toolCall } from './helpers/gated-composition.js'
import { claimAndSubmit, createVerificationTask, executableReviewSnapshot, mountExecutableReview, reviewExecutableTask } from './helpers/executable-review.js'

const fixtures: { sandbox: string; composition: Awaited<ReturnType<typeof mountExecutableReview>> }[] = []
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { sandbox, composition } of fixtures.splice(0)) {
    try { for (const fiber of composition.fibers.toReversed()) await fiber.dispose() }
    finally { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

async function fixture(submit = true, verification?: (sandbox: string) => readonly { command: string }[]) {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-admission-'))
  const composition = await mountExecutableReview(sandbox)
  fixtures.push({ sandbox, composition })
  const created = await createVerificationTask(composition, verification?.(sandbox) ?? [])
  const domain = composition.ctx.agentSwarm.domain, teamId = TeamId(composition.teamId), taskId = TaskId(created.taskId)
  const claimed = await domain.claimTask(composition.scope, teamId, composition.lead.id, taskId, created.revision)
  const task = submit ? await domain.submitTask(composition.scope, teamId, composition.lead.id, taskId, claimed.task.revision, claimed.attempt.id, 'Submitted evidence', []) : claimed.task
  const review = vi.fn(async (): Promise<ReviewProviderResult> => ({ decision: 'accept' })), schedule = vi.fn()
  const deps: ReviewTransactionDeps = { ctx: composition.ctx, domain: () => domain, reviewProvider: () => ({ review }),
    reviewProviderName: () => 'admission-observer', scopeOf: agent => composition.ctx.agentSwarm.scopeOf(agent), requestSchedule: schedule }
  const input = { taskId, expectedRevision: task.revision, attemptId: claimed.attempt.id, decision: 'accept' as const }
  return { sandbox, composition, domain, teamId, taskId, review, schedule, deps, input }
}

it.each(['stale-revision', 'non-captain', 'wrong-attempt', 'not-submitted', 'completed'] as const)('rejects %s before calling the Provider and preserves task, attempt and budget facts', async invalid => {
  const f = await fixture(invalid !== 'not-submitted'), c = f.composition
  let actor = c.lead, input = f.input, code = 'TEAM_TASK_STALE_REVISION'
  if (invalid === 'stale-revision') input = { ...input, expectedRevision: input.expectedRevision - 1 }
  if (invalid === 'non-captain') {
    const added = await toolCall(c.ctx, c.lead, 'admission-member', 'agent_swarm_add_member', { name: 'worker', role: 'Reviewer is Captain only' })
    expect(added.isError, JSON.stringify(added.error)).toBe(false)
    actor = c.ctx.agents.get(SessionId((added.value as { session_id: string }).session_id))!
    expect(actor).toBeDefined(); code = 'TEAM_CAPTAIN_REQUIRED'
  }
  if (invalid === 'wrong-attempt') {
    await f.domain.reviewTask(c.scope, f.teamId, c.lead.id, f.taskId, input.expectedRevision, input.attemptId, 'accept')
    const other = await createVerificationTask(c, [])
    const submitted = await claimAndSubmit(c, other.taskId, other.revision, 'Other task')
    input = { ...input, taskId: TaskId(other.taskId), expectedRevision: submitted.submittedRevision }; code = 'TEAM_ATTEMPT_STALE'
  }
  if (invalid === 'not-submitted') code = 'TEAM_REVIEW_NOT_READY'
  if (invalid === 'completed') {
    const completed = await f.domain.reviewTask(c.scope, f.teamId, c.lead.id, f.taskId, input.expectedRevision, input.attemptId, 'accept')
    input = { ...input, expectedRevision: completed.revision }; code = 'TEAM_REVIEW_NOT_READY'
  }
  const before = (await executableReviewSnapshot(c)).team
  await expect(runReviewTransaction(f.deps, { agent: actor, signal: SIGNAL }, input)).rejects.toMatchObject({ code })
  expect(f.review.mock.calls.length).toBe(0); expect(f.schedule.mock.calls.length).toBe(0)
  const after = (await executableReviewSnapshot(c)).team
  expect({ tasks: after.tasks, attempts: after.attempts, budget: after.budget }).toEqual({ tasks: before.tasks, attempts: before.attempts, budget: before.budget })
})

it('rejects an object carrying the Captain id that is not the official live Agent', async () => {
  const f = await fixture(), c = f.composition
  const detached = { id: c.lead.id, session: c.lead.session } as Agent
  expect(c.ctx.agents.get(c.lead.id)).toBe(c.lead)
  await expect(runReviewTransaction(f.deps, { agent: detached, signal: SIGNAL }, f.input)).rejects.toMatchObject({ code: 'TEAM_AGENT_REQUIRED' })
  expect(f.review.mock.calls.length).toBe(0)
})

it.each(['missing-task', 'missing-attempt', 'attempt-task'] as const)('rejects a %s membership snapshot before Provider admission', async invalid => {
  const f = await fixture(), c = f.composition, membership = await f.domain.requireMembership(c.scope, c.lead.id)
  const before = (await executableReviewSnapshot(c)).team, source = structuredClone(membership.team)
  const team = { ...source, tasks: invalid === 'missing-task' ? [] : source.tasks,
    attempts: invalid === 'missing-attempt' ? [] : invalid === 'attempt-task' ? source.attempts.map(attempt => ({ ...attempt, taskId: TaskId('other-task') })) : source.attempts }
  // Deliberately invalid read result, never written to the validated domain store.
  vi.spyOn(f.domain, 'requireMembership').mockResolvedValueOnce({ ...membership, team })
  const code = invalid === 'missing-task' ? 'TEAM_TASK_NOT_FOUND' : invalid === 'missing-attempt' ? 'TEAM_ATTEMPT_NOT_FOUND' : 'TEAM_ATTEMPT_TASK_MISMATCH'
  await expect(runReviewTransaction(f.deps, { agent: c.lead, signal: SIGNAL }, f.input)).rejects.toMatchObject({ code })
  expect(f.review.mock.calls.length).toBe(0); expect(f.schedule.mock.calls.length).toBe(0)
  expect((await executableReviewSnapshot(c)).team).toEqual(before)
})

it('keeps verifying eligible without mutating the admission snapshot', async () => {
  const f = await fixture(), c = f.composition, source = (await executableReviewSnapshot(c)).team
  const team = { ...source, tasks: source.tasks.map(task => ({ ...task, status: 'verifying' as const })) }
  const before = structuredClone(team)
  expect(validateTaskReview(team, c.lead.id, f.taskId, f.input.expectedRevision, f.input.attemptId)).toMatchObject({ task: { status: 'verifying' }, attempt: { id: f.input.attemptId } })
  expect(team).toEqual(before)
})

it('rejects an already aborted execution before Provider admission', async () => {
  const f = await fixture(), abort = new AbortController(), reason = new Error('Review cancelled before admission')
  abort.abort(reason)
  const before = (await executableReviewSnapshot(f.composition)).team
  await expect(runReviewTransaction(f.deps, { agent: f.composition.lead, signal: abort.signal }, f.input)).rejects.toBe(reason)
  expect(f.review.mock.calls.length).toBe(0); expect(f.schedule.mock.calls.length).toBe(0)
  expect((await executableReviewSnapshot(f.composition)).team).toEqual(before)
})

it.each(['abort', 'agent', 'session', 'scope'] as const)('rechecks %s after the membership read before calling the Provider', async change => {
  const f = await fixture(), c = f.composition, entered = deferred(), release = deferred()
  const abort = new AbortController(), reason = new Error('Review cancelled during membership read'), requireMembership = f.domain.requireMembership.bind(f.domain)
  vi.spyOn(f.domain, 'requireMembership').mockImplementationOnce(async (...args) => {
    const membership = await requireMembership(...args)
    entered.resolve(); await release.promise; return membership
  })
  const before = (await executableReviewSnapshot(c)).team
  const settled = runReviewTransaction(f.deps, { agent: c.lead, signal: abort.signal }, f.input).then(value => ({ value }), error => ({ error }))
  try {
    await entered.promise
    // Inject the public registry result at the await boundary; no claim of a full Host unload.
    if (change === 'abort') abort.abort(reason)
    if (change === 'agent') {
      const get = c.ctx.agents.get.bind(c.ctx.agents)
      vi.spyOn(c.ctx.agents, 'get').mockImplementation(id => id === c.lead.id ? undefined : get(id))
    }
    if (change === 'session') {
      const get = c.ctx.sessions.get.bind(c.ctx.sessions)
      vi.spyOn(c.ctx.sessions, 'get').mockImplementation(id => id === c.lead.id ? undefined : get(id))
    }
    if (change === 'scope') vi.spyOn(f.deps, 'scopeOf').mockReturnValue(`${c.scope}-changed`)
    release.resolve()
    if (change === 'abort') expect(await settled).toEqual({ error: reason })
    else expect(await settled).toMatchObject({ error: { code: 'TEAM_AGENT_REQUIRED' } })
    expect(f.review.mock.calls.length).toBe(0); expect(f.schedule.mock.calls.length).toBe(0)
    expect((await executableReviewSnapshot(c)).team).toEqual(before)
  } finally { release.resolve(); await settled }
})

it('does not execute a real file-writing verification command for a stale review, then runs it for the valid Captain revision', async () => {
  const f = await fixture(true, sandbox => {
    const program = Buffer.from(`require('node:fs').writeFileSync(${JSON.stringify(join(sandbox, 'verification-ran.txt'))}, 'real-verification-executed')`).toString('base64')
    return [{ command: `node -e "eval(Buffer.from('${program}','base64').toString())"` }]
  }), c = f.composition, marker = join(f.sandbox, 'verification-ran.txt')
  const rejected = await reviewExecutableTask(c, f.input.attemptId, f.input.expectedRevision - 1, f.taskId, 'accept')
  expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_TASK_STALE_REVISION' } } })
  const content = await readFile(marker, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  expect(content, 'A stale request must not leave the real verification command marker').toBeUndefined()
  const accepted = await reviewExecutableTask(c, f.input.attemptId, f.input.expectedRevision, f.taskId, 'accept')
  expect(accepted).toMatchObject({ isError: false, value: { status: 'completed', decision: 'accept' } })
  expect(await readFile(marker, 'utf8')).toBe('real-verification-executed')
})

it('keeps the valid reject settlement, retry budget and scheduling behavior', async () => {
  const f = await fixture(), c = f.composition, before = (await executableReviewSnapshot(c)).team
  f.review.mockResolvedValueOnce({ decision: 'reject', diagnostic: 'Evidence needs revision' })
  expect(await runReviewTransaction(f.deps, { agent: c.lead, signal: SIGNAL }, f.input)).toMatchObject({ task: { status: 'pending' }, decision: 'reject' })
  const after = (await executableReviewSnapshot(c)).team
  expect(after.budget).toEqual({ ...before.budget, usedRetries: before.budget.usedRetries + 1 })
  expect(after.attempts.find(attempt => attempt.id === f.input.attemptId)).toMatchObject({ phase: 'rejected', reviewProvider: 'admission-observer' })
  expect(f.review.mock.calls.length).toBe(1); expect(f.schedule.mock.calls.length).toBe(1)
})

it('rejects a cancelled execution when an admitted Provider returns without honoring its signal', async () => {
  const f = await fixture(), c = f.composition, abort = new AbortController(), reason = new Error('Cancelled during Provider')
  const entered = deferred(), release = deferred<ReviewProviderResult>(), before = (await executableReviewSnapshot(c)).team
  f.review.mockImplementationOnce(async () => { entered.resolve(); return await release.promise })
  const settled = runReviewTransaction(f.deps, { agent: c.lead, signal: abort.signal }, f.input).then(value => ({ value }), error => ({ error }))
  try {
    await entered.promise; abort.abort(reason); release.resolve({ decision: 'reject' })
    expect(await settled).toEqual({ error: reason })
    expect((await executableReviewSnapshot(c)).team).toEqual(before)
    expect(f.review.mock.calls.length).toBe(1); expect(f.schedule.mock.calls.length).toBe(0)
  } finally { release.resolve({ decision: 'reject' }); await settled }
})

it.each(['revision', 'attempt', 'authority'] as const)('retains the final domain fence when %s changes after Provider admission', async change => {
  const f = await fixture(), c = f.composition, entered = deferred(), release = deferred<ReviewProviderResult>()
  f.review.mockImplementationOnce(async () => { entered.resolve(); return await release.promise })
  const running = runReviewTransaction(f.deps, { agent: c.lead, signal: SIGNAL }, f.input)
  const settled = running.then(value => ({ value }), error => ({ error }))
  try {
    await entered.promise
    if (change === 'revision') {
      await f.domain.reviewTask(c.scope, f.teamId, c.lead.id, f.taskId, f.input.expectedRevision, f.input.attemptId, 'accept')
    } else if (change === 'attempt') {
      const cancelled = await f.domain.cancelAttempt(c.scope, f.teamId, c.lead.id, f.taskId, f.input.expectedRevision, 'New attempt replaces the reviewed generation')
      const claim = await f.domain.claimTask(c.scope, f.teamId, c.lead.id, f.taskId, cancelled.revision)
      await f.domain.submitTask(c.scope, f.teamId, c.lead.id, f.taskId, claim.task.revision, claim.attempt.id, 'New attempt output', [])
    } else await f.domain.archiveTeam(c.scope, f.teamId, c.lead.id, 'Review authority revoked')
    const before = (await c.ctx.agentSwarm.listTeamAggregates(c.scope))[0]!
    release.resolve({ decision: 'reject', diagnostic: 'Old Provider result must not overwrite newer facts' })
    expect(await settled).toMatchObject({ error: { code: change === 'authority' ? 'TEAM_ARCHIVED' : 'TEAM_TASK_STALE_REVISION' } })
    const after = (await c.ctx.agentSwarm.listTeamAggregates(c.scope))[0]!
    expect(after).toEqual(before)
    expect(f.review.mock.calls.length).toBe(1); expect(f.schedule.mock.calls.length).toBe(0)
  } finally { release.resolve({ decision: 'reject' }); await settled }
})
