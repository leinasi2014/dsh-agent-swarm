import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamId, type TeamState } from '../src/domain/types.js'
import type { TeamRecord } from '../src/storage/team-spec.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const SCOPE = 'shared-workspace'

function team(id: string, captain = 'captain-a'): TeamState {
  return {
    schemaVersion: 2, id: TeamId(id), revision: 1, name: 'T', description: 'd',
    captainSessionId: captain, phase: 'active', members: [], tasks: [], attempts: [],
    messages: [], interactionEffects: [], budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: { [captain]: -1 }, memory: [], nextTaskNumber: 1, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
  }
}

const EPERM = (msg = 'injected transient rename contention') => Object.assign(new Error(msg), { code: 'EPERM' })

// Issue #193 real json-backend boundary RED: on the base (no bounded transient retry) a
// one-time transient EPERM at the unit publish seam surfaces to the caller; with the
// retry the same write re-publishes to the REAL official json backend and the file
// persists (verified by close + reopen). A persistent transient EPERM exhausts the
// bounded retries and rethrows the ORIGINAL error with no false commit; a non-transient
// error is rethrown immediately and never retried.
describe('issue #193 real json-backend transient publish boundary', () => {
  let dir: string | undefined
  let stack: StorageStack | undefined
  afterEach(async () => {
    await stack?.close().catch(() => {})
    stack = undefined
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function open(root: string): Promise<StorageStack> {
    const now = (() => { let t = 1000; return () => t++ })()
    return await openStorageStack(root, now)
  }

  it('a legal live unit: a one-time transient EPERM is retried, the file persists, and close+reopen reads it back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-real-'))
    stack = await open(dir)
    const table = stack.domain.table('teams')
    const orig = table.put.bind(table)
    let faults = 1
    // Narrow seam injection: the FIRST publish-issued put is rejected once with
    // EPERM (a transient atomic rename conflict), then delegates to the REAL json
    // backend (writeAtomic -> actual file).
    table.put = async (key: TeamId, value: TeamRecord) => {
      if (faults > 0) { faults -= 1; throw EPERM() }
      return await orig(key, value)
    }
    await stack.store.createUniqueForCaptain(SCOPE, team('team-real-0001'))
    expect(faults).toBe(0)
    expect(stack.domain.table('teams').get(TeamId('team-real-0001'))?.team).toMatchObject({ id: 'team-real-0001' })
    await stack.close(); stack = await open(dir)
    expect(stack.domain.table('teams').get(TeamId('team-real-0001'))?.team).toMatchObject({ id: 'team-real-0001' })
    await stack.close(); stack = undefined
  })

  it('multiple Team writes are preserved and the domain notification only fires on success', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-real-multi-'))
    stack = await open(dir)
    const table = stack.domain.table('teams')
    const orig = table.put.bind(table)
    let faults = 1
    let notified = 0
    stack.ctx.on('domain/changed', (c: unknown) => { if ((c as { operation?: string })?.operation === 'put') notified += 1 })
    table.put = async (key: TeamId, value: TeamRecord) => {
      if (faults > 0) { faults -= 1; throw EPERM() }
      return await orig(key, value)
    }
    await stack.store.createUniqueForCaptain(SCOPE, team('team-real-m0001', 'ca'))
    await stack.store.createUniqueForCaptain(SCOPE, team('team-real-m0002', 'cb'))
    expect(stack.domain.table('teams').get(TeamId('team-real-m0001'))?.team).toMatchObject({ id: 'team-real-m0001' })
    expect(stack.domain.table('teams').get(TeamId('team-real-m0002'))?.team).toMatchObject({ id: 'team-real-m0002' })
    // Exactly two succeeds notified (the faulted put never notified), and both persisted.
    expect(notified).toBe(2)
    await stack.close(); stack = await open(dir)
    expect(stack.domain.table('teams').get(TeamId('team-real-m0002'))?.team).toMatchObject({ id: 'team-real-m0002' })
    await stack.close(); stack = undefined
  })

  it('exhausting the transient retries rethrows the ORIGINAL transient error with no false commit; a non-transient error is not retried', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-real-exhaust-'))
    stack = await open(dir)
    const table = stack.domain.table('teams')
    let puts = 0
    table.put = async (_key: TeamId, _value: TeamRecord) => { puts += 1; throw EPERM('persistent') }
    await expect(stack.store.createUniqueForCaptain(SCOPE, team('team-real-x0001'))).rejects.toMatchObject({ code: 'EPERM' })
    expect(puts).toBe(6)
    expect(stack.domain.table('teams').get(TeamId('team-real-x0001'))).toBeUndefined()
    let nonTransientPuts = 0
    table.put = async (_key: TeamId, _value: TeamRecord) => { nonTransientPuts += 1; throw new Error('real permanent failure') }
    await expect(stack.store.createUniqueForCaptain(SCOPE, team('team-real-x0002'))).rejects.toThrow('real permanent failure')
    expect(nonTransientPuts).toBe(1)
    await stack.close(); stack = undefined
  })
})
