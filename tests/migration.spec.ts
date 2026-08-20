import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyTeamStore } from '../src/migration/migrate-legacy-store.js'
import { TaskId, TeamId, type TeamState } from '../src/domain/types.js'
import { FaultableBackend, openFaultableStack, openStorageStack, type StorageStack } from './helpers/storage-stack.js'

function legacyTeam(id: string, captain = 'captain-session'): TeamState {
  const timestamp = 41
  return {
    schemaVersion: 1,
    id: TeamId(id),
    revision: 3,
    name: `Legacy ${id}`,
    description: 'Pre-M1A workspace aggregate',
    captainSessionId: captain,
    phase: 'active',
    members: [{
      name: 'worker',
      role: 'impl',
      sessionId: 'member-1',
      provider: 'spawn',
      phase: 'active',
      createdAt: timestamp,
    }],
    tasks: [{
      id: TaskId('task-1'),
      revision: 2,
      subject: 'legacy work',
      description: 'Carried across the migration',
      acceptanceCriteria: ['receipt retained'],
      status: 'completed',
      blockedBy: [],
      writeScopes: [],
      priority: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    attempts: [],
    messages: [],
    budget: { usedTokens: 120, usedRequests: 4, usedRetries: 1 },
    usageCursors: { 'captain-session': 8, 'member-1': 3 },
    memory: [],
    nextTaskNumber: 2,
    nextMemoryNumber: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/** Write one legacy `<stateRoot>/<teamId>/team.json` fixture exactly as the pre-M1A runtime did. */
async function writeLegacyState(stateRoot: string, team: TeamState): Promise<void> {
  const dir = join(stateRoot, team.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'team.json'), `${JSON.stringify(team, null, 2)}\n`, 'utf8')
}

describe('explicit one-way legacy migration', () => {
  let sandbox: string
  let stateRoot: string
  let scope: string
  let tick: number
  let stack: StorageStack

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-migrate-'))
    stateRoot = join(sandbox, 'workspace', '.dsh-agent-swarm')
    scope = join(sandbox, 'workspace')
    tick = 10_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('migrates validated aggregates, verifies read-back, retains receipts and never touches sources', async () => {
    const first = legacyTeam('team-migrate-one-0001')
    const second = legacyTeam('team-migrate-two-0002', 'captain-two')
    await writeLegacyState(stateRoot, first)
    await writeLegacyState(stateRoot, second)

    const firstPath = join(stateRoot, first.id, 'team.json')
    const sourceHashBefore = createHash('sha256').update(await readFile(firstPath, 'utf8'), 'utf8').digest('hex')

    const report = await migrateLegacyTeamStore({ store: stack.store, scope, stateRoot, now: () => tick++ })
    expect(report.outcomes).toEqual([
      { teamId: first.id, status: 'migrated', revision: first.revision },
      { teamId: second.id, status: 'migrated', revision: second.revision },
    ])

    for (const team of [first, second]) {
      const migrated = await stack.store.read(scope, team.id)
      expect(migrated).toEqual(team)
      const receipt = await stack.store.readMigrationReceipt(team.id)
      expect(receipt).toMatchObject({
        teamId: team.id,
        scope,
        sourcePath: join(stateRoot, team.id, 'team.json'),
        revision: team.revision,
      })
      expect(receipt?.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    }

    // The legacy source stays byte-identical (rollback evidence).
    const sourceHashAfter = createHash('sha256').update(await readFile(firstPath, 'utf8'), 'utf8').digest('hex')
    expect(sourceHashAfter).toBe(sourceHashBefore)

    // Re-running is an idempotent skip, never a second write.
    const rerun = await migrateLegacyTeamStore({ store: stack.store, scope, stateRoot, now: () => tick++ })
    expect(rerun.outcomes.every(outcome => outcome.status === 'already-migrated')).toBe(true)

    // The records are durable: they survive a full storage reopen.
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    expect(await stack.store.read(scope, first.id)).toEqual(first)
    expect(await stack.store.readMigrationReceipt(first.id)).toBeDefined()
  })

  it('requires an empty destination and aborts on captain conflicts', async () => {
    const team = legacyTeam('team-migrate-used-000003')
    await writeLegacyState(stateRoot, team)

    // Same team id already at the destination.
    await stack.store.importAggregate(scope, { ...team, name: 'Occupying copy' })
    await expect(migrateLegacyTeamStore({ store: stack.store, scope, stateRoot }))
      .rejects.toMatchObject({ code: 'TEAM_ALREADY_EXISTS' })
    expect(await stack.store.readMigrationReceipt(team.id)).toBeUndefined()

    // Fresh destination root, but the captain already owns an active team in
    // the destination scope.
    const clean = await openStorageStack(join(sandbox, 'storage-clean'), () => tick++)
    try {
      await clean.store.createUniqueForCaptain(scope, legacyTeam('team-migrate-live-0004'))
      await expect(migrateLegacyTeamStore({ store: clean.store, scope, stateRoot }))
        .rejects.toMatchObject({ code: 'TEAM_ALREADY_ACTIVE' })
    } finally {
      await clean.close()
    }
  })

  it('rejects an invalid legacy source without writing the destination', async () => {
    const team = legacyTeam('team-migrate-bad-000005')
    await writeLegacyState(stateRoot, team)
    const path = join(stateRoot, team.id, 'team.json')
    const stored = JSON.parse(await readFile(path, 'utf8')) as { revision: unknown }
    stored.revision = 'not-an-integer'
    await writeFile(path, JSON.stringify(stored), 'utf8')

    await expect(migrateLegacyTeamStore({ store: stack.store, scope, stateRoot }))
      .rejects.toMatchObject({ code: 'TEAM_STATE_CORRUPT' })
    expect(await stack.store.read(scope, team.id)).toBeUndefined()
    expect(await stack.store.readMigrationReceipt(team.id)).toBeUndefined()

    // A named legacy team that does not exist is an explicit miss.
    await expect(migrateLegacyTeamStore({
      store: stack.store, scope, stateRoot, onlyTeamId: TeamId('team-migrate-none-000006'),
    })).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })
  })

  it('fails loud when the durable destination write fails, then succeeds after recovery', async () => {
    const team = legacyTeam('team-migrate-flaky-0007')
    await writeLegacyState(stateRoot, team)

    const backend = new FaultableBackend()
    const faulted = await openFaultableStack(backend, () => tick++)
    try {
      backend.failNextWrites = 1
      await expect(migrateLegacyTeamStore({ store: faulted.store, scope, stateRoot }))
        .rejects.toThrowError('injected write failure')
      expect(await faulted.store.readMigrationReceipt(team.id)).toBeUndefined()

      const report = await migrateLegacyTeamStore({ store: faulted.store, scope, stateRoot, now: () => tick++ })
      expect(report.outcomes).toEqual([{ teamId: team.id, status: 'migrated', revision: team.revision }])
      expect(await faulted.store.readMigrationReceipt(team.id)).toBeDefined()
    } finally {
      await faulted.close()
    }
  })

  it('aborts on a receipt whose record is missing (inconsistent destination)', async () => {
    const team = legacyTeam('team-migrate-ghost-0008')
    await writeLegacyState(stateRoot, team)
    await stack.store.recordMigrationReceipt({
      teamId: team.id,
      scope,
      sourcePath: join(stateRoot, team.id, 'team.json'),
      sourceSha256: '0'.repeat(64),
      revision: team.revision,
      migratedAt: 1,
    })
    await expect(migrateLegacyTeamStore({ store: stack.store, scope, stateRoot }))
      .rejects.toMatchObject({ code: 'TEAM_MIGRATION_INCONSISTENT' })
  })
})
