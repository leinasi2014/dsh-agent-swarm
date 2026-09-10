import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FaultableBackend, openFaultableStack, type StorageStack } from './helpers/storage-stack.js'
import type { TeamAggregateStore } from '../src/domain/team-domain-port.js'
import type { TeamGoalLifecycle } from '../src/domain/goal-lifecycle.js'

const stacks: StorageStack[] = []
afterEach(async () => { for (const stack of stacks.splice(0).toReversed()) await stack.close() })
async function fixture() {
  const backend = new FaultableBackend(), stack = await openFaultableStack(backend)
  stacks.push(stack)
  const scope = join(tmpdir(), 'goal-lifecycle-storage'), team = await stack.port.createTeam(scope, 'captain', 'Goal storage', 'Original')
  const store: TeamAggregateStore = stack.store
  return { stack, backend, scope, team, store }
}

it('runs synchronous post-commit cleanup after durable publish and before the next locked transaction', async () => {
  const f = await fixture(), abort = new AbortController(), order: string[] = []
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.backend.mutateOnPut = (_table, _key, value) => { order.push('durable-write'); return value }
  const first = f.store.transact(f.scope, f.team.id, async draft => {
    Object.assign(draft, { description: 'Committed cancellation' }); entered(); await held
  }, { afterCommit: () => { order.push('cleanup'); abort.abort(new Error('old execution ended')) } })
  await started
  const queued = f.store.transact(f.scope, f.team.id, draft => {
    order.push('next-admission')
    if (abort.signal.aborted) throw abort.signal.reason
    Object.assign(draft, { description: 'Old execution acquired new work' })
  })
  const queuedResult = queued.then(() => ({ state: 'accepted' as const }), error => ({ state: 'rejected' as const, error }))
  release(); await first
  expect(await queuedResult).toMatchObject({ state: 'rejected', error: { message: 'old execution ended' } })
  expect(order).toEqual(['durable-write', 'cleanup', 'next-admission'])
  expect((await f.store.read(f.scope, f.team.id))?.description).toBe('Committed cancellation')
})

it('does not invoke post-commit cleanup on a no-op or a rejected actual backend write', async () => {
  const f = await fixture(), cleanup = vi.fn(), before = await f.store.read(f.scope, f.team.id)
  await f.store.transact(f.scope, f.team.id, () => undefined, { afterCommit: cleanup })
  expect(cleanup).not.toHaveBeenCalled()
  f.backend.failNextWrites = 1
  await expect(f.store.transact(f.scope, f.team.id, draft => { Object.assign(draft, { description: 'Must not publish' }) }, { afterCommit: cleanup })).rejects.toThrow('injected write failure')
  expect(cleanup).not.toHaveBeenCalled()
  expect(await f.store.read(f.scope, f.team.id)).toEqual(before)
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend); stacks.push(reopened)
  expect(await reopened.store.read(f.scope, f.team.id)).toEqual(before)
})

it('reports a cleanup exception as committed and retains the durable result after reopen', async () => {
  const f = await fixture(), cleanup = vi.fn(() => { throw new Error('interruption failed') })
  await expect(f.store.transact(f.scope, f.team.id, draft => { Object.assign(draft, { description: 'Already committed' }) }, { afterCommit: cleanup }))
    .rejects.toMatchObject({ code: 'TEAM_AFTER_COMMIT_FAILED', cause: { message: 'interruption failed' } })
  expect(cleanup).toHaveBeenCalledOnce()
  expect((await f.store.read(f.scope, f.team.id))?.description).toBe('Already committed')
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend); stacks.push(reopened)
  expect((await reopened.store.read(f.scope, f.team.id))?.description).toBe('Already committed')
})

function savedDraft(): TeamGoalLifecycle {
  return { schemaVersion: 1, revision: 1, goalRevision: 1, phase: 'draft', mode: 'finite', acceptanceCriteria: 'Checked evidence', constraints: 'Keep source',
    resultSequence: 0, coordinatedResultSequence: 0, coordinatedGoalRevision: 0, operationFloorRevision: 0,
    operations: [{ origin: { kind: 'local-operator' }, requestId: 'saved-before-shutdown', expectedLifecycleRevision: 0,
      contentDigest: 'a'.repeat(64), operationRevision: 1, at: 1_000 }] }
}

it('preserves the optional lifecycle and private recovery receipts through the real storage schema and reopen', async () => {
  const f = await fixture(), goal = savedDraft()
  await f.store.transact(f.scope, f.team.id, draft => { Object.assign(draft, { publicGoal: 'The sole goal body', goalLifecycle: goal }) })
  expect((await f.store.read(f.scope, f.team.id))?.goalLifecycle).toEqual(goal)
  await f.stack.close(); stacks.splice(stacks.indexOf(f.stack), 1)
  const reopened = await openFaultableStack(f.backend); stacks.push(reopened)
  const stored = await reopened.store.read(f.scope, f.team.id)
  expect(stored?.publicGoal).toBe('The sole goal body')
  expect(stored?.goalLifecycle).toEqual(goal)
  expect(stored?.goalLifecycle).not.toHaveProperty('text')
})

it.each(['schema', 'revision', 'watermark', 'interval', 'receipts'] as const)('rejects malformed persisted goal %s without publishing any partial aggregate', async invalid => {
  const f = await fixture(), before = await f.store.read(f.scope, f.team.id), goal = savedDraft()
  if (invalid === 'schema') Object.assign(goal, { schemaVersion: 2 })
  if (invalid === 'revision') Object.assign(goal, { revision: -1 })
  if (invalid === 'watermark') Object.assign(goal, { coordinatedResultSequence: 1 })
  if (invalid === 'interval') Object.assign(goal, { mode: 'maintenance', intervalMs: 59_999 })
  if (invalid === 'receipts') goal.operations.push(...Array.from({ length: 256 }, (_, index) => ({ ...goal.operations[0]!, requestId: `excess-${index}` })))
  await expect(f.store.transact(f.scope, f.team.id, draft => { Object.assign(draft, { publicGoal: 'Bad persisted state', goalLifecycle: goal }) })).rejects.toBeDefined()
  expect(await f.store.read(f.scope, f.team.id)).toEqual(before)
})
