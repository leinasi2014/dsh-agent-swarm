import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamId, type TeamState } from '../src/domain/types.js'
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

describe('issue #193 real json-backend publish seam', () => {
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

  function hitRealPublish(n: number, errorFactory: () => Error) {
    const unit = (stack as unknown as { domain: { unit: { publish: () => Promise<void> } } }).domain.unit
    const orig = unit.publish.bind(unit)
    let calls = 0
    unit.publish = async () => {
      calls += 1
      if (calls <= n) throw errorFactory()
      return await orig()
    }
    return () => calls
  }

  it('REAL publish seam: one-time transient EPERM is retried, the real file persists, close+reopen reads it back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-seam-'))
    stack = await open(dir)
    const calls = hitRealPublish(1, EPERM)
    await stack.store.createUniqueForCaptain(SCOPE, team('team-seam-0001'))
    expect(calls()).toBeGreaterThanOrEqual(2)
    expect(stack.domain.table('teams').get(TeamId('team-seam-0001'))?.team).toMatchObject({ id: 'team-seam-0001', revision: 1 })
    await stack.close(); stack = await open(dir)
    expect(stack.domain.table('teams').get(TeamId('team-seam-0001'))?.team).toMatchObject({ id: 'team-seam-0001', revision: 1 })
    await stack.close(); stack = undefined
  })

  it('REAL publish seam: concurrent Promise.all of two Team writes both persist, each notifies once, revision advanced once', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-seam-conc-'))
    stack = await open(dir)
    const calls = hitRealPublish(1, EPERM)
    let notified = 0
    stack.ctx.on('domain/changed', (c: { operation?: string }) => { if (c.operation === 'put') notified += 1 })
    await Promise.all([
      stack.store.createUniqueForCaptain(SCOPE, team('team-seam-conc0001', 'ca')),
      stack.store.createUniqueForCaptain(SCOPE, team('team-seam-conc0002', 'cb')),
    ])
    expect(calls()).toBeGreaterThanOrEqual(2)
    expect(stack.domain.table('teams').get(TeamId('team-seam-conc0001'))?.team).toMatchObject({ id: 'team-seam-conc0001', revision: 1 })
    expect(stack.domain.table('teams').get(TeamId('team-seam-conc0002'))?.team).toMatchObject({ id: 'team-seam-conc0002', revision: 1 })
    expect(notified).toBe(2)
    await stack.close(); stack = await open(dir)
    expect(stack.domain.table('teams').get(TeamId('team-seam-conc0002'))?.team).toMatchObject({ id: 'team-seam-conc0002', revision: 1 })
    await stack.close(); stack = undefined
  })

  it('REAL publish seam: persistent transient EPERM exhausts 6 attempts, rethrows the SAME Error object with no false commit; reopen has no record', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-seam-exhaust-'))
    stack = await open(dir)
    const ep = EPERM('persistent-rename-contention')
    const calls = hitRealPublish(1_000_000, () => ep)
    const caught = await stack.store.createUniqueForCaptain(SCOPE, team('team-seam-exh0001')).catch((e: unknown) => e)
    expect(caught).toBe(ep)
    expect(calls()).toBe(6)
    expect(stack.domain.table('teams').get(TeamId('team-seam-exh0001'))).toBeUndefined()
    await stack.close(); stack = await open(dir)
    expect(stack.domain.table('teams').get(TeamId('team-seam-exh0001'))).toBeUndefined()
    await stack.close(); stack = undefined
  })

  it('REAL publish seam: a non-transient publish error is NOT retried and rethrows the SAME Error object', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-seam-nt-'))
    stack = await open(dir)
    const permanent = new Error('real permanent rename failure')
    const calls = hitRealPublish(1_000_000, () => permanent)
    const caught = await stack.store.createUniqueForCaptain(SCOPE, team('team-seam-nt0001')).catch((e: unknown) => e)
    expect(caught).toBe(permanent)
    expect(calls()).toBe(1)
    await stack.close(); stack = undefined
  })
})

// Public put-retry unit test (NOT a real rename proof): a table-level put wrapper faults
// before the official domain enqueue, proving the store retries a transient put error.
describe('issue #193 public put-retry unit test', () => {
  let dir: string | undefined
  let stack: StorageStack | undefined
  afterEach(async () => {
    await stack?.close().catch(() => {})
    stack = undefined
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })
  it('retries a transient table-put EPERM (unit-level, not disk proof)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-193-putretry-'))
    stack = await openStorageStack(dir, (() => { let t = 1000; return () => t++ })())
    const table = stack.domain.table('teams')
    const orig = table.put.bind(table)
    let faults = 1
    table.put = async (key: TeamId, value: unknown) => { if (faults > 0) { faults -= 1; throw EPERM() } return await orig(key, value as never) }
    await stack.store.createUniqueForCaptain(SCOPE, team('team-putretry-0001'))
    expect(faults).toBe(0)
    expect(stack.domain.table('teams').get(TeamId('team-putretry-0001'))?.team).toMatchObject({ id: 'team-putretry-0001' })
    await stack.close(); stack = undefined
  })
})
