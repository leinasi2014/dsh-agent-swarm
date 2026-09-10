import { expect, it } from 'vitest'
import { goalDefinitionSchema, goalLifecycleSchema } from '../src/shared/goal-lifecycle.js'
import { goalSaveRequestSchema, goalRequestResultRequestSchema } from '../src/rpc/goal-rpc-contract.js'

const goal = { text: '完成核对', acceptanceCriteria: '全部通过', constraints: '', mode: 'finite' as const }
it('requires a bounded maintenance interval and rejects an interval on finite goals', () => {
  expect(goalDefinitionSchema.safeParse({ ...goal, mode: 'maintenance' }).success).toBe(false)
  expect(goalDefinitionSchema.safeParse({ ...goal, intervalMs: 60_000 }).success).toBe(false)
  expect(goalDefinitionSchema.safeParse({ ...goal, mode: 'maintenance', intervalMs: 60_000 }).success).toBe(true)
  expect(goalDefinitionSchema.safeParse({ ...goal, mode: 'maintenance', intervalMs: 604_800_001 }).success).toBe(false)
})
it('keeps expected budget and operation identity explicit without accepting caller actors', () => {
  const request = { schemaVersion: 1, target: { rootSessionId: 'captain', teamId: 'team' }, requestId: 'original', expectedLifecycleRevision: 0, goal, start: true,
    tokenBudget: { expectedTokenLimit: null, tokenLimit: 100 } }
  expect(goalSaveRequestSchema.parse(request)).toEqual(request)
  expect(goalSaveRequestSchema.safeParse({ ...request, actor: { kind: 'captain' } }).success).toBe(false)
  expect(goalSaveRequestSchema.safeParse({ ...request, tokenBudget: { tokenLimit: 100 } }).success).toBe(false)
  expect(goalRequestResultRequestSchema.safeParse({ schemaVersion: 1, target: request.target, requestId: 'original' }).success).toBe(false)
})
it('does not expose a duplicate goal body or private receipts in the public lifecycle', () => {
  const lifecycle = { schemaVersion: 1, revision: 1, goalRevision: 1, acceptanceCriteria: '', constraints: '', mode: 'finite', phase: 'draft',
    resultSequence: 0, coordinatedResultSequence: 0, coordinatedGoalRevision: 0 }
  expect(goalLifecycleSchema.parse(lifecycle)).toEqual(lifecycle)
  expect(goalLifecycleSchema.safeParse({ ...lifecycle, text: 'private copy' }).success).toBe(false)
  expect(goalLifecycleSchema.safeParse({ ...lifecycle, receipts: [] }).success).toBe(false)
})
