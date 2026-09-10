import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FaultableBackend, openFaultableStack, type StorageStack } from './helpers/storage-stack.js'
import type { GoalDefinition, SaveGoalInput } from '../src/shared/goal-lifecycle.js'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'

const stacks: StorageStack[] = []
afterEach(async () => { for (const stack of stacks.splice(0).toReversed()) await stack.close() })
const origin = { kind: 'local-operator' } as const
const definition: GoalDefinition = { text: 'Deliver a checked result', acceptanceCriteria: 'All checks accepted', constraints: 'Keep existing evidence', mode: 'finite' }
const save = (requestId: string, expectedLifecycleRevision: number, extra: Partial<SaveGoalInput> = {}): SaveGoalInput =>
  ({ requestId, expectedLifecycleRevision, goal: definition, start: false, ...extra })

async function fixture() {
  let now = 1_000
  const backend = new FaultableBackend(), stack = await openFaultableStack(backend, () => now)
  stacks.push(stack)
  const scope = join(tmpdir(), 'goal-lifecycle-domain'), port = stack.port
  const team = await port.createTeam(scope, 'captain', 'Goals', 'Lifecycle contract')
  for (const name of ['alice', 'bob']) {
    await port.provisionMember(scope, team.id, 'captain', { name, role: 'worker', sessionId: name, provider: 'spawn' })
    await port.settleMember(scope, team.id, name, { active: true })
  }
  return { stack, backend, scope, port, team, advance: (time: number) => { now = time }, read: async () => (await stack.store.read(scope, team.id))! }
}

it('saving an unstarted goal creates only a draft and does not pause existing task admission', async () => {
  const f = await fixture(), task = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: 'Existing work', description: 'Still eligible' })
  const before = await f.read()
  await f.port.saveGoal(f.scope, f.team.id, origin, save('draft', 0))
  const after = await f.read()
  expect(after.publicGoal).toBe(definition.text)
  expect(after.goalLifecycle).toMatchObject({ revision: 1, goalRevision: 1, phase: 'draft', resultSequence: 0 })
  expect(after.goalLifecycle?.currentTrigger).toBeUndefined()
  expect(after.messages).toEqual(before.messages)
  expect(after.tasks).toEqual(before.tasks)
  await expect(f.port.claimTask(f.scope, f.team.id, 'captain', task.id, task.revision, 'alice')).resolves.toMatchObject({ task: { status: 'in_progress' } })
})

it('starting and accepted no-op controls advance lifecycle CAS while retaining one current notification', async () => {
  const f = await fixture()
  await f.port.saveGoal(f.scope, f.team.id, origin, save('draft', 0))
  await f.port.controlGoal(f.scope, f.team.id, origin, { requestId: 'start', expectedLifecycleRevision: 1, action: 'start' })
  const started = await f.read(), trigger = started.goalLifecycle?.currentTrigger
  expect(started.goalLifecycle).toMatchObject({ revision: 2, phase: 'running', goalRevision: 1 })
  expect(trigger).toMatchObject({ goalRevision: 1, reason: 'start' })
  expect(started.messages.filter(message => message.id === trigger?.notificationMessageId)).toHaveLength(1)
  await f.port.controlGoal(f.scope, f.team.id, origin, { requestId: 'start-again', expectedLifecycleRevision: 2, action: 'start' })
  const second = await f.read()
  expect(second.goalLifecycle?.revision).toBe(3)
  expect(second.goalLifecycle?.currentTrigger).toEqual(trigger)
  expect(second.messages).toEqual(started.messages)
  await f.port.reconcileGoal(f.scope, f.team.id)
  expect(await f.read()).toEqual(second)
})

it('replays original save and control identities without another transition and rejects changed payload', async () => {
  const f = await fixture(), input = save('save-once', 0)
  const first = await f.port.saveGoal(f.scope, f.team.id, origin, input)
  const control = { requestId: 'start-once', expectedLifecycleRevision: 1, action: 'start' as const }
  await f.port.controlGoal(f.scope, f.team.id, origin, control)
  const before = await f.read()
  expect(await f.port.saveGoal(f.scope, f.team.id, origin, input)).toMatchObject({ replayed: true, operationRevision: first.operationRevision })
  expect(await f.port.controlGoal(f.scope, f.team.id, origin, control)).toMatchObject({ replayed: true, operationRevision: 2 })
  expect(await f.read()).toEqual(before)
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, { ...input, goal: { ...definition, text: 'A different goal' } })).rejects.toBeDefined()
  await expect(f.port.controlGoal(f.scope, f.team.id, origin, { ...control, action: 'pause' })).rejects.toBeDefined()
  expect(await f.read()).toEqual(before)
})

it('keeps 256 accepted operation receipts and never reexecutes an expired no-op CAS', async () => {
  const f = await fixture(), first = save('oldest', 0)
  await f.port.saveGoal(f.scope, f.team.id, origin, first)
  for (let revision = 1; revision <= 256; revision++) {
    await f.port.saveGoal(f.scope, f.team.id, origin, save(`same-goal-${revision}`, revision))
  }
  const full = await f.read()
  expect(full.goalLifecycle).toMatchObject({ revision: 257, goalRevision: 1, phase: 'draft' })
  expect(full.messages).toHaveLength(0)
  expect(full.goalLifecycle?.operations).toHaveLength(256)
  expect(await f.port.goalOperationResult(f.scope, f.team.id, origin, { requestId: 'oldest', expectedLifecycleRevision: 0 })).toMatchObject({ state: 'expired' })
  expect(await f.port.goalOperationResult(f.scope, f.team.id, origin, { requestId: 'same-goal-1', expectedLifecycleRevision: 1 })).toMatchObject({ state: 'committed', operationRevision: 2 })
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, first)).rejects.toBeDefined()
  expect(await f.read()).toEqual(full)
  await f.port.saveGoal(f.scope, f.team.id, origin, save('new-after-window', 257))
  expect((await f.read()).goalLifecycle?.revision).toBe(258)
})

it('admits only one concurrent save against an unchanged lifecycle revision', async () => {
  const f = await fixture()
  const outcomes = await Promise.allSettled(['left', 'right'].map(text => f.port.saveGoal(f.scope, f.team.id, origin,
    save(text, 0, { goal: { ...definition, text } }))))
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
  expect((await f.read()).goalLifecycle?.revision).toBe(1)
})

it.each(['accept', 'reject'] as const)('pause blocks fresh claim and retry while allowing reserved submit and review %s', async decision => {
  const f = await fixture()
  const old = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: 'Already seated', description: 'Finish it' })
  const claim = await f.port.claimTask(f.scope, f.team.id, 'captain', old.id, old.revision, 'alice')
  await f.port.saveGoal(f.scope, f.team.id, origin, save('paused-goal', 0))
  await f.port.controlGoal(f.scope, f.team.id, origin, { requestId: 'pause', expectedLifecycleRevision: 1, action: 'pause' })
  const pending = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: 'Future', description: 'Wait', assignmentMode: 'open-claim' })
  const paused = await f.read()
  await expect(f.port.claimTask(f.scope, f.team.id, 'bob', pending.id, pending.revision, 'bob')).rejects.toBeDefined()
  await expect(f.port.retryAttempt(f.scope, f.team.id, 'captain', old.id, claim.task.revision, 'alice', 'No new generation')).rejects.toBeDefined()
  expect(await f.read()).toEqual(paused)
  await f.port.acknowledgeAssignment(f.scope, f.team.id, old.id, claim.attempt.id)
  const submitted = await f.port.submitTask(f.scope, f.team.id, 'alice', old.id, claim.task.revision, claim.attempt.id, 'Retain output', ['proof://original'])
  await f.port.reviewTask(f.scope, f.team.id, 'captain', old.id, submitted.revision, claim.attempt.id, decision)
  const reviewed = await f.read()
  expect(reviewed.goalLifecycle?.phase).toBe('paused')
  expect(reviewed.goalLifecycle?.resultSequence).toBe((paused.goalLifecycle?.resultSequence ?? 0) + 1)
  expect(reviewed.goalLifecycle?.currentTrigger).toBeUndefined()
  expect(reviewed.messages).toEqual(paused.messages)
  expect(reviewed.tasks.find(task => task.id === old.id)?.output).toBe(decision === 'accept' ? 'Retain output' : undefined)
  expect(reviewed.attempts.find(attempt => attempt.id === claim.attempt.id)).toMatchObject({ output: 'Retain output', evidence: ['proof://original'] })
  await f.port.controlGoal(f.scope, f.team.id, origin, { requestId: 'resume', expectedLifecycleRevision: reviewed.goalLifecycle!.revision, action: 'resume' })
  const resumed = await f.read()
  expect(resumed.goalLifecycle?.currentTrigger).toMatchObject({ resultSequence: reviewed.goalLifecycle!.resultSequence, reason: 'resume' })
  expect(resumed.messages).toHaveLength(reviewed.messages.length + 1)
})

it('pause preserves compensation onto an already existing attempt', async () => {
  const f = await fixture(), task = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: 'Retry compensation', description: 'Keep the original attempt' })
  const first = await f.port.claimTask(f.scope, f.team.id, 'captain', task.id, task.revision, 'alice')
  const retry = await f.port.retryAttempt(f.scope, f.team.id, 'captain', task.id, first.task.revision, 'alice', 'Candidate retry')
  await f.port.saveGoal(f.scope, f.team.id, origin, save('goal', 0))
  await f.port.controlGoal(f.scope, f.team.id, origin, { requestId: 'pause', expectedLifecycleRevision: 1, action: 'pause' })
  const restored = await f.port.reinstateAttempt(f.scope, f.team.id, 'captain', task.id, retry.task.revision, retry.attempt.id, 'Resume original delivery')
  expect(restored.currentAttemptId).toBe(first.attempt.id)
  expect((await f.read()).goalLifecycle?.phase).toBe('paused')
})

it('maintenance token-limit CAS and start guards reject atomically without clearing prior usage', async () => {
  const f = await fixture()
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 100, requestLimit: 9, retryLimit: 4 })
  await f.stack.store.transact(f.scope, f.team.id, draft => { Object.assign(draft.budget, { usedTokens: 75, usedRequests: 2, usedRetries: 1 }) })
  const before = await f.read(), input = save('maintenance', 0, { start: true,
    goal: { ...definition, mode: 'maintenance', intervalMs: 60_000 }, tokenBudget: { expectedTokenLimit: 99, tokenLimit: 200 } })
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, input)).rejects.toBeDefined()
  expect(await f.read()).toEqual(before)
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, { ...input, tokenBudget: { expectedTokenLimit: 100, tokenLimit: 75 } })).rejects.toBeDefined()
  expect(await f.read()).toEqual(before)
  await f.port.saveGoal(f.scope, f.team.id, origin, { ...input, tokenBudget: { expectedTokenLimit: 100, tokenLimit: 200 } })
  const after = await f.read()
  expect(after.budget).toEqual({ ...before.budget, tokenLimit: 200 })
  expect(after.goalLifecycle).toMatchObject({ phase: 'running', mode: 'maintenance' })
})

it('changing the goal invalidates a previously received trigger and preserves one current intent', async () => {
  const f = await fixture()
  await f.port.saveGoal(f.scope, f.team.id, origin, save('initial', 0, { start: true }))
  const first = (await f.read()).goalLifecycle!, old = first.currentTrigger!
  await f.port.saveGoal(f.scope, f.team.id, origin, save('edit', first.revision, { goal: { ...definition, constraints: 'Changed constraints' } }))
  const revised = await f.read()
  expect(revised.goalLifecycle?.goalRevision).toBe(first.goalRevision + 1)
  expect(revised.goalLifecycle?.currentTrigger?.goalRevision).toBe(first.goalRevision + 1)
  await expect(f.port.coordinateGoal(f.scope, f.team.id, 'captain', { triggerId: old.id, goalRevision: old.goalRevision,
    resultSequence: old.resultSequence, summary: 'Late response to the old goal', taskIds: [], outcome: 'coordinated' })).rejects.toBeDefined()
  expect(await f.read()).toEqual(revised)
})

it.each(['finite', 'maintenance'] as const)('requires explicit completion and all tasks terminal for %s', async mode => {
  const f = await fixture()
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 1_000 })
  const pending = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: 'Unfinished', description: 'No exclusion list' })
  await f.port.saveGoal(f.scope, f.team.id, origin, save('start', 0, { start: true,
    goal: { ...definition, mode, ...(mode === 'maintenance' ? { intervalMs: 60_000 } : {}) } }))
  const active = await f.read(), trigger = active.goalLifecycle!.currentTrigger!
  const input = { triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
    summary: 'Cannot ignore the remaining task', taskIds: [], outcome: mode === 'finite' ? 'achieved' as const : 'round-finished' as const }
  await expect(f.port.coordinateGoal(f.scope, f.team.id, 'captain', input)).rejects.toBeDefined()
  await expect(f.port.coordinateGoal(f.scope, f.team.id, 'captain', { ...input, taskIds: [pending.id] })).rejects.toBeDefined()
  expect(await f.read()).toEqual(active)
})

it('uses actual round completion plus interval and coalesces missed maintenance periods into one trigger after reopen', async () => {
  const f = await fixture()
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 1_000 })
  await f.port.saveGoal(f.scope, f.team.id, origin, save('maintenance', 0, { start: true,
    goal: { ...definition, mode: 'maintenance', intervalMs: 60_000 } }))
  const started = await f.read(), trigger = started.goalLifecycle!.currentTrigger!
  await f.port.reconcileGoal(f.scope, f.team.id)
  expect((await f.read()).goalLifecycle?.phase).toBe('running')
  f.advance(123_456)
  await f.port.coordinateGoal(f.scope, f.team.id, 'captain', { triggerId: trigger.id, goalRevision: trigger.goalRevision,
    resultSequence: trigger.resultSequence, summary: 'Verified there is no remaining required work in this round', taskIds: [], outcome: 'round-finished' })
  const waiting = await f.read()
  expect(waiting.goalLifecycle).toMatchObject({ phase: 'waiting', nextDueAt: 183_456,
    lastCoordination: { actorSessionId: 'captain', at: 123_456, outcome: 'round-finished' } })
  expect(waiting.goalLifecycle?.currentTrigger).toBeUndefined()
  f.advance(183_455); await f.port.reconcileGoal(f.scope, f.team.id)
  expect(await f.read()).toEqual(waiting)
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend, () => 1_000_000); stacks.push(reopened)
  await reopened.port.reconcileGoal(f.scope, f.team.id)
  const due = (await reopened.store.read(f.scope, f.team.id))!
  expect(due.goalLifecycle).toMatchObject({ phase: 'running', currentTrigger: { reason: 'maintenance-due' } })
  expect(due.messages).toHaveLength(waiting.messages.length + 1)
  await reopened.port.reconcileGoal(f.scope, f.team.id)
  expect(await reopened.store.read(f.scope, f.team.id)).toEqual(due)
})

it('coalesces results that arrive behind a received trigger into one successor and never treats usage as another result', async () => {
  const f = await fixture()
  await f.port.saveGoal(f.scope, f.team.id, origin, save('start', 0, { start: true }))
  const original = (await f.read()).goalLifecycle!.currentTrigger!
  for (const decision of ['accept', 'reject'] as const) {
    const task = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: decision, description: 'Actual review result' })
    const claim = await f.port.claimTask(f.scope, f.team.id, 'captain', task.id, task.revision, decision === 'accept' ? 'alice' : 'bob')
    const submitted = await f.port.submitTask(f.scope, f.team.id, claim.attempt.memberSessionId, task.id, claim.task.revision, claim.attempt.id, 'Actual output')
    await f.port.reviewTask(f.scope, f.team.id, 'captain', task.id, submitted.revision, claim.attempt.id, decision)
  }
  const results = await f.read()
  expect(results.goalLifecycle?.resultSequence).toBe(2)
  expect(results.goalLifecycle?.currentTrigger?.id).toBe(original.id)
  await f.port.coordinateGoal(f.scope, f.team.id, 'captain', { triggerId: original.id, goalRevision: original.goalRevision,
    resultSequence: original.resultSequence, summary: 'Planning response to original start notice', taskIds: [], outcome: 'coordinated' })
  const successor = await f.read()
  expect(successor.goalLifecycle?.coordinatedResultSequence).toBe(0)
  expect(successor.goalLifecycle?.currentTrigger).toMatchObject({ resultSequence: 2, reason: 'task-result' })
  expect(successor.goalLifecycle?.currentTrigger?.id).not.toBe(original.id)
  expect(successor.messages).toHaveLength(results.messages.length + 1)
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 10_000 })
  await f.stack.store.transact(f.scope, f.team.id, draft => { Object.assign(draft.budget, { usedTokens: draft.budget.usedTokens + 100 }) })
  const billed = await f.read()
  await f.port.goalSnapshot(f.scope, f.team.id)
  await f.port.reconcileGoal(f.scope, f.team.id)
  expect((await f.read()).goalLifecycle).toEqual(billed.goalLifecycle)
  expect((await f.read()).messages).toEqual(billed.messages)
})

it('preserves an explicit achieved conclusion across storage reopen and recovery checks', async () => {
  const f = await fixture()
  await f.port.saveGoal(f.scope, f.team.id, origin, save('finite', 0, { start: true }))
  const trigger = (await f.read()).goalLifecycle!.currentTrigger!
  f.advance(9_000)
  await f.port.coordinateGoal(f.scope, f.team.id, 'captain', { triggerId: trigger.id, goalRevision: trigger.goalRevision,
    resultSequence: trigger.resultSequence, summary: 'The declared checks are satisfied without further tasks', taskIds: [], outcome: 'achieved' })
  const achieved = await f.read()
  expect(achieved.goalLifecycle).toMatchObject({ phase: 'achieved', completion: { goalRevision: 1, at: 9_000, taskIds: [] } })
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend, () => 10_000); stacks.push(reopened)
  expect(await reopened.store.read(f.scope, f.team.id)).toEqual(achieved)
  await reopened.port.reconcileGoal(f.scope, f.team.id)
  expect(await reopened.store.read(f.scope, f.team.id)).toEqual(achieved)
})

it.each(['requests', 'retries', 'deadline'] as const)('maintenance start keeps existing %s exhaustion authoritative even when raising token limit', async exhausted => {
  const f = await fixture()
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 100, requestLimit: 1, retryLimit: 1, deadlineAt: 10_000 })
  if (exhausted === 'deadline') f.advance(10_000)
  else await f.stack.store.transact(f.scope, f.team.id, draft => { Object.assign(draft.budget, exhausted === 'requests' ? { usedRequests: 1 } : { usedRetries: 1 }) })
  const before = await f.read()
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, save('cannot-start', 0, { start: true,
    goal: { ...definition, mode: 'maintenance', intervalMs: 60_000 }, tokenBudget: { expectedTokenLimit: 100, tokenLimit: 200 } }))).rejects.toBeDefined()
  expect(await f.read()).toEqual(before)
})

it('rechecks the original execution even on a saved-operation replay and permits no forged Captain or Main', async () => {
  const f = await fixture(), input = save('authorized-save', 0)
  await f.port.saveGoal(f.scope, f.team.id, origin, input)
  const before = await f.read()
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, input, { assertExecution: () => { throw new Error('original execution was replaced') } })).rejects.toThrow('original execution was replaced')
  await expect(f.port.saveGoal(f.scope, f.team.id, { kind: 'captain', sessionId: 'alice' }, save('forged-captain', 1))).rejects.toBeDefined()
  await expect(f.port.saveGoal(f.scope, f.team.id, { kind: 'main', sessionId: 'unrelated-main' }, save('forged-main', 1))).rejects.toBeDefined()
  expect(await f.read()).toEqual(before)
})

it('the legacy Captain setter preserves paused maintenance and invalidates its old coordination without sending new mail', async () => {
  const f = await fixture()
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 1_000 })
  await f.port.saveGoal(f.scope, f.team.id, origin, save('start', 0, { start: true, goal: { ...definition, mode: 'maintenance', intervalMs: 90_000 } }))
  const initial = await f.read(), old = initial.goalLifecycle!.currentTrigger!
  await f.port.controlGoal(f.scope, f.team.id, origin, { requestId: 'pause', expectedLifecycleRevision: initial.goalLifecycle!.revision, action: 'pause' })
  const paused = await f.read(), late = { triggerId: old.id, goalRevision: old.goalRevision, resultSequence: old.resultSequence,
    summary: 'Reply that was already generating when pause happened', taskIds: [], outcome: 'coordinated' as const }
  await expect(f.port.coordinateGoal(f.scope, f.team.id, 'captain', late)).rejects.toBeDefined()
  expect(await f.read()).toEqual(paused)
  await f.port.setPublicGoal(f.scope, f.team.id, 'captain', paused.revision, 'New canonical text through the original tool')
  const edited = await f.read()
  expect(edited.goalLifecycle).toMatchObject({ phase: 'paused', mode: 'maintenance', intervalMs: 90_000,
    goalRevision: old.goalRevision + 1, acceptanceCriteria: definition.acceptanceCriteria, constraints: definition.constraints })
  expect(edited.goalLifecycle?.currentTrigger).toBeUndefined()
  expect(edited.messages).toHaveLength(paused.messages.length)
  expect(edited.messages.find(message => message.id === old.notificationMessageId)?.phase).toBe('obsolete')
  await expect(f.port.coordinateGoal(f.scope, f.team.id, 'captain', late)).rejects.toBeDefined()
  expect(await f.read()).toEqual(edited)
})

it('a full mailbox or failed goal publish cannot commit a goal edit, budget change, receipt or partial trigger', async () => {
  const f = await fixture(), limited = new TeamDomain(f.stack.store, { ...DEFAULT_TEAM_LIMITS, maxPendingMessagesPerMember: 1 })
  await f.port.queueMessage(f.scope, f.team.id, 'alice', 'captain', 'Existing queued work', 'wakeup')
  const before = await f.read(), input = save('atomic-start', 0, { start: true, tokenBudget: { expectedTokenLimit: null, tokenLimit: 1_000 } })
  await expect(limited.saveGoal(f.scope, f.team.id, origin, input)).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
  expect(await f.read()).toEqual(before)
  f.backend.failNextWrites = 1
  await expect(f.port.saveGoal(f.scope, f.team.id, origin, input)).rejects.toThrow('injected write failure')
  expect(await f.read()).toEqual(before)
  await f.port.saveGoal(f.scope, f.team.id, origin, input)
  const committed = await f.read()
  expect(committed.goalLifecycle?.operations).toHaveLength(1)
  expect(committed.goalLifecycle?.currentTrigger).toBeDefined()
  expect(committed.messages).toHaveLength(before.messages.length + 1)
})

it('rechecks the live workflow owner after waiting for the Team transaction and retains due work until release', async () => {
  const f = await fixture()
  await f.port.setBudget(f.scope, f.team.id, 'captain', { tokenLimit: 1_000 })
  await f.port.saveGoal(f.scope, f.team.id, origin, save('maintenance', 0, { start: true,
    goal: { ...definition, mode: 'maintenance', intervalMs: 60_000 } }))
  const trigger = (await f.read()).goalLifecycle!.currentTrigger!
  await f.port.coordinateGoal(f.scope, f.team.id, 'captain', { triggerId: trigger.id, goalRevision: trigger.goalRevision,
    resultSequence: trigger.resultSequence, summary: 'Round complete', taskIds: [], outcome: 'round-finished' })
  const waiting = await f.read()
  f.advance(100_000)
  let release!: () => void, entered!: () => void, allowed = true
  const held = new Promise<void>(resolve => { release = resolve }), locked = new Promise<void>(resolve => { entered = resolve })
  const blocking = f.stack.store.transact(f.scope, f.team.id, async () => { entered(); await held })
  await locked
  const reconcile = f.port.reconcileGoal(f.scope, f.team.id, { autonomousAllowed: () => allowed })
  allowed = false; release(); await blocking; await reconcile
  expect(await f.read()).toEqual(waiting)
  allowed = true
  await f.port.reconcileGoal(f.scope, f.team.id, { autonomousAllowed: () => allowed })
  expect((await f.read()).goalLifecycle?.currentTrigger?.reason).toBe('maintenance-due')
})
