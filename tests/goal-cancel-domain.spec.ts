import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { FaultableBackend, openFaultableStack, type StorageStack } from './helpers/storage-stack.js'
import type { CancelTaskGuards } from '../src/domain/goal-lifecycle.js'

const stacks: StorageStack[] = []
afterEach(async () => { for (const stack of stacks.splice(0).toReversed()) await stack.close() })
async function fixture(submit = false) {
  const backend = new FaultableBackend(), open = backend.kv.open.bind(backend.kv)
  let unit!: KvUnit
  const opening = vi.spyOn(backend.kv, 'open').mockImplementation(async descriptor => {
    const result = await open(descriptor)
    if (descriptor.name === 'agent_swarm') unit = result
    return result
  })
  const stack = await openFaultableStack(backend, () => 12_345)
  opening.mockRestore()
  stacks.push(stack)
  const scope = join(tmpdir(), 'goal-cancel-domain'), port = stack.port
  const team = await port.createTeam(scope, 'captain', 'Cancel', 'Explicit durable cancellation')
  await port.provisionMember(scope, team.id, 'captain', { name: 'alice', role: 'worker', sessionId: 'alice', provider: 'spawn' })
  await port.settleMember(scope, team.id, 'alice', { active: true })
  const task = await port.createTask(scope, team.id, 'captain', { subject: 'Obsolete work', description: 'Retain original facts' })
  const claim = await port.claimTask(scope, team.id, 'captain', task.id, task.revision, 'alice')
  const current = submit ? await port.submitTask(scope, team.id, 'alice', task.id, claim.task.revision, claim.attempt.id, 'Original output', ['evidence://original']) : claim.task
  const input = { requestId: 'cancel-once', taskId: task.id, expectedTaskRevision: current.revision, reason: 'The operator replaced this requirement' }
  return { backend, unit, stack, scope, port, team, task: current, claim, input, read: async () => (await stack.store.read(scope, team.id))! }
}

it('durably cancels submitted work without erasing evidence, refunding usage, or interrupting twice on replay', async () => {
  const f = await fixture(true), before = await f.read(), effect = vi.fn()
  const capture: NonNullable<CancelTaskGuards['captureInterruption']> = (team, task, attempt) => {
    expect(team.id).toBe(f.team.id)
    expect(task).toMatchObject({ id: f.task.id, status: 'submitted', currentAttemptId: f.claim.attempt.id })
    expect(attempt).toMatchObject({ id: f.claim.attempt.id, phase: 'submitted' })
    return effect
  }
  const captureSpy = vi.fn(capture)
  const cancelled = await f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: captureSpy })
  expect(cancelled).toMatchObject({ replayed: false, task: { status: 'cancelled', output: 'Original output',
    cancellation: { requestId: f.input.requestId, expectedTaskRevision: f.task.revision, actorSessionId: 'captain', at: 12_345,
      reason: f.input.reason, attemptId: f.claim.attempt.id } } })
  expect(cancelled.task.ownerSessionId).toBeUndefined()
  expect(cancelled.task.currentAttemptId).toBeUndefined()
  expect(effect).toHaveBeenCalledOnce()
  const saved = await f.read()
  expect(saved.budget).toEqual(before.budget)
  expect(saved.attempts.find(attempt => attempt.id === f.claim.attempt.id)).toMatchObject({ phase: 'stale', output: 'Original output', evidence: ['evidence://original'] })
  await expect(f.port.submitTask(f.scope, f.team.id, 'alice', f.task.id, cancelled.task.revision, f.claim.attempt.id, 'Late overwrite')).rejects.toBeDefined()
  expect(await f.read()).toEqual(saved)
  expect(await f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: captureSpy })).toMatchObject({ replayed: true, task: cancelled.task })
  expect(effect).toHaveBeenCalledOnce()
  expect(captureSpy).toHaveBeenCalledOnce()
  await expect(f.port.cancelTask(f.scope, f.team.id, 'captain', { ...f.input, reason: 'Changed retry payload' })).rejects.toBeDefined()
  expect(await f.read()).toEqual(saved)
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend); stacks.push(reopened)
  expect(await reopened.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: captureSpy })).toMatchObject({ replayed: true, task: cancelled.task })
  expect(effect).toHaveBeenCalledOnce()
})

it('a failed actual put retains the current attempt and never invokes the captured interruption', async () => {
  const f = await fixture(), before = await f.read(), effect = vi.fn(), capture = vi.fn(() => effect)
  f.backend.failNextWrites = 1
  await expect(f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: capture })).rejects.toThrow('injected write failure')
  expect(effect).not.toHaveBeenCalled()
  expect(await f.read()).toEqual(before)
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend); stacks.push(reopened)
  expect(await reopened.store.read(f.scope, f.team.id)).toEqual(before)
  await reopened.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: capture })
  expect(effect).toHaveBeenCalledOnce()
})

it('a post-commit interruption failure never rolls the cancellation back or repeats it on retry', async () => {
  const f = await fixture(), effect = vi.fn(() => { throw new Error('unable to interrupt exact old execution') })
  await expect(f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: () => effect }))
    .rejects.toMatchObject({ code: 'TEAM_AFTER_COMMIT_FAILED' })
  const saved = await f.read()
  expect(saved.tasks.find(task => task.id === f.task.id)?.status).toBe('cancelled')
  expect(effect).toHaveBeenCalledOnce()
  await f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { captureInterruption: () => effect })
  expect(effect).toHaveBeenCalledOnce()
  expect(await f.read()).toEqual(saved)
})

it('checks actual authority and stale task CAS before capturing an interruption', async () => {
  const f = await fixture(), capture = vi.fn(), before = await f.read()
  await expect(f.port.cancelTask(f.scope, f.team.id, 'alice', f.input, { captureInterruption: capture })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
  await expect(f.port.cancelTask(f.scope, f.team.id, 'captain', { ...f.input, expectedTaskRevision: f.input.expectedTaskRevision - 1 }, { captureInterruption: capture })).rejects.toBeDefined()
  await expect(f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, { assertExecution: () => { throw new Error('execution replaced') }, captureInterruption: capture })).rejects.toThrow('execution replaced')
  expect(capture).not.toHaveBeenCalled()
  expect(await f.read()).toEqual(before)
})

it('invalidates an already queued self-claim under the same cancellation transaction lock', async () => {
  const f = await fixture(), abort = new AbortController()
  const next = await f.port.createTask(f.scope, f.team.id, 'captain', { subject: 'Next task', description: 'Old cancelled execution must not claim', assignmentMode: 'open-claim' })
  let release!: () => void, entered!: () => void, checked = false
  const held = new Promise<void>(resolve => { release = resolve }), writing = new Promise<void>(resolve => { entered = resolve })
  const put = f.unit.putRecord.bind(f.unit)
  const writeGate = vi.spyOn(f.unit, 'putRecord').mockImplementationOnce(async (...args) => { entered(); await held; return await put(...args) })
  const cancelled = f.port.cancelTask(f.scope, f.team.id, 'captain', f.input, {
    captureInterruption: (_team, _task, attempt) => {
      expect(attempt?.id).toBe(f.claim.attempt.id)
      return () => abort.abort(new Error('exact old turn was cancelled'))
    },
  })
  try {
    await writing
    const queued = f.port.claimTask(f.scope, f.team.id, 'alice', next.id, next.revision, 'alice', () => {
      checked = true
      if (abort.signal.aborted) throw abort.signal.reason
    })
    const outcome = queued.then(value => ({ state: 'accepted' as const, value }), error => ({ state: 'rejected' as const, error }))
    expect(checked).toBe(false)
    release(); await cancelled
    expect(await outcome).toMatchObject({ state: 'rejected', error: { message: 'exact old turn was cancelled' } })
    expect(checked).toBe(true)
    const saved = await f.read()
    expect(saved.tasks.find(task => task.id === next.id)).toMatchObject({ status: 'pending', revision: next.revision })
    expect(saved.attempts).toHaveLength(1)
    expect(saved.budget.usedRequests).toBe(1)
  } finally { release(); writeGate.mockRestore() }
})
