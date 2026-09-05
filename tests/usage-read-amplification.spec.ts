import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { TaskId } from '../src/domain/types.js'
import { openStorageStack } from './helpers/storage-stack.js'

it('filters canonical billing candidates before deep reads while preserving ledger changes and authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-read-'))
  const stack = await openStorageStack(root)
  const scope = join(root, 'workspace')
  const captain = 'billing-captain'
  const accountant = new UsageAccountant(stack.ctx, {
    domain: () => stack.port, isClosing: () => false, agents: { get: () => undefined }, history: async () => undefined,
  })
  const session = { id: captain, header: { cwd: scope } } as unknown as Session
  const bill = async (seq: number): Promise<void> => {
    accountant.observeSessionEvent(session, { type: 'assistant/message', seq, time: 1, data: { usage: { inputTokens: 3, outputTokens: 2 } } } as SessionEvent)
    await accountant.wait()
  }
  try {
    const owned = await stack.port.createTeam(scope, captain, 'Owned', 'Accounting')
    const others = []
    for (let index = 0; index < 7; index += 1) {
      const team = await stack.port.createTeam(scope, `other-${index}`, `Other ${index}`, 'Unrelated retained history')
      others.push(team)
      await stack.store.transact(scope, team.id, draft => {
        draft.tasks.push(...Array.from({ length: 32 }, (_, task) => ({
          id: TaskId(`task-${task}`), revision: 1, subject: 'retained', description: 'unrelated history',
          acceptanceCriteria: [], status: 'pending' as const, blockedBy: [], writeScopes: [], priority: 0, createdAt: 1, updatedAt: 1,
        })))
      })
    }
    const get = vi.spyOn(stack.domain.table('teams'), 'get')
    const clone = vi.spyOn(globalThis, 'structuredClone')
    try {
      expect((await stack.port.findAccountingMembership(scope, captain))?.team.id).toBe(owned.id)
      console.info('46-USAGE-LOOKUP', JSON.stringify({ teams: 8, unrelatedTasks: 224, deepReads: get.mock.calls.length, clones: clone.mock.calls.length }))
      expect.soft(get.mock.calls.map(call => call[0])).toEqual([owned.id])
      expect.soft(clone.mock.calls).toHaveLength(1)
      get.mockClear()
      clone.mockClear()
      for (let seq = 1; seq <= 3; seq += 1) await bill(seq)
      console.info('46-USAGE-FLUSH', JSON.stringify({ events: 3, reads: get.mock.calls.length, clones: clone.mock.calls.length }))
      expect.soft(get.mock.calls.every(call => call[0] === owned.id)).toBe(true)
    } finally { get.mockRestore(); clone.mockRestore() }
    expect((await stack.port.snapshot(scope, owned.id, captain)).team.budget.usedTokens).toBe(15)
    await stack.port.archiveTeam(scope, owned.id, captain, 'Rotate ledger')
    await bill(4)
    expect((await stack.port.snapshot(scope, owned.id, captain)).team.budget.usedTokens).toBe(20)
    const successor = await stack.port.createTeam(scope, captain, 'Successor', 'Active ledger wins', 4)
    await bill(5)
    expect((await stack.port.snapshot(scope, successor.id, captain)).team.budget.usedTokens).toBe(5)
    expect((await stack.port.snapshot(scope, owned.id, captain)).team.budget.usedTokens).toBe(20)
    await bill(5)
    expect((await stack.port.snapshot(scope, successor.id, captain)).team.budget.usedTokens).toBe(5)
    await expect(stack.port.recordSessionUsageBatch(scope, successor.id, 'outsider', [{ eventSeq: 6, tokens: 99 }]))
      .rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    expect(await stack.port.findAccountingMembership(join(root, 'other-workspace'), captain)).toBeUndefined()
    // A second valid matching active ledger remains ambiguous, never cached away.
    await stack.store.transact(scope, others[0]!.id, draft => { Object.assign(draft, { captainSessionId: captain }) })
    await expect(stack.port.findAccountingMembership(scope, captain)).rejects.toMatchObject({ code: 'TEAM_MEMBERSHIP_AMBIGUOUS' })
    // Ordinary list callers still receive all Teams. A matching candidate
    // bypassing our transaction seam still receives full semantic validation.
    expect(await stack.store.list(scope)).toHaveLength(9)
    const table = stack.domain.table('teams')
    const malformed = table.get(successor.id)!
    Object.assign(malformed.team, { tasks: [{
      id: TaskId('bad-dependency'), revision: 1, subject: 'Bad graph', description: 'Structural schema passes, semantic graph does not',
      acceptanceCriteria: [], status: 'pending', blockedBy: ['missing-task'], writeScopes: [], priority: 0, createdAt: 1, updatedAt: 1,
    }] })
    await table.put(successor.id, malformed)
    await expect(stack.port.findAccountingMembership(scope, captain)).rejects.toMatchObject({ code: 'TEAM_STATE_CORRUPT' })
  } finally {
    await accountant.wait()
    await stack.close()
    await rm(root, { recursive: true, force: true })
  }
})
