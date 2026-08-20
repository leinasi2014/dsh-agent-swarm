/**
 * Explicit one-way migration of pre-M1A workspace `FileTeamStore` state into
 * the authoritative Storage Domain (ADR-0007, M1A).
 *
 * Rules enforced here and covered by tests:
 * 1. the legacy aggregate is validated (`assertTeamState`) before anything is
 *    written;
 * 2. the destination must be empty for the Team id AND free of an active team
 *    of the same captain in the destination scope;
 * 3. the aggregate is written durably through the aggregate store and read
 *    back for deep verification before a receipt exists;
 * 4. a migration receipt is retained durably; re-running against a migrated
 *    Team is an idempotent skip, never a second write;
 * 5. the legacy source is only ever read — it remains rollback evidence;
 * 6. there is no runtime dual-write, no automatic migration and no fallback.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TeamDomainError } from '../domain/error.js'
import { assertTeamState } from '../domain/state-validation.js'
import type { TeamAggregateStore, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState } from '../domain/types.js'
import { FileTeamStore } from '../storage/team-store.js'

/** Outcome of one Team inside a migration run. */
export interface MigrationTeamOutcome {
  readonly teamId: TeamId
  readonly status: 'migrated' | 'already-migrated'
  readonly revision: number
}

/** Result of one migration run over one legacy state root. */
export interface MigrationReport {
  readonly scope: TeamScope
  readonly stateRoot: string
  readonly outcomes: readonly MigrationTeamOutcome[]
}

/** Options of one migration run. */
export interface MigrationOptions {
  /** Destination aggregate store (the production Storage Domain store). */
  readonly store: TeamAggregateStore
  /** Workspace scope the legacy teams are imported into. */
  readonly scope: TeamScope
  /** Legacy workspace state root, e.g. `<workspace>/.dsh-agent-swarm`. */
  readonly stateRoot: string
  /** Restrict the run to one Team id; default migrates every listed Team. */
  readonly onlyTeamId?: TeamId
  /** Clock used for receipt timestamps (tests). */
  readonly now?: () => number
}

/**
 * Migrate every (or one) legacy Team aggregate under `stateRoot` into the
 * destination scope. The first failure throws and aborts the run — migration
 * is explicit and one-way; partial runs resume as idempotent skips.
 */
export async function migrateLegacyTeamStore(options: MigrationOptions): Promise<MigrationReport> {
  const { store, scope, stateRoot } = options
  const now = options.now ?? Date.now
  const legacy = new FileTeamStore()
  const selected = options.onlyTeamId === undefined
    ? await legacy.list(stateRoot)
    : [await readOneLegacyTeam(legacy, stateRoot, options.onlyTeamId)]

  const outcomes: MigrationTeamOutcome[] = []
  for (const team of selected) {
    outcomes.push(await migrateOneTeam({ store, scope, stateRoot, team, now }))
  }
  return { scope, stateRoot, outcomes }
}

async function readOneLegacyTeam(legacy: FileTeamStore, stateRoot: string, teamId: TeamId): Promise<TeamState> {
  const team = await legacy.read(stateRoot, teamId)
  if (team === undefined) {
    throw new TeamDomainError(`legacy team "${teamId}" not found under the state root`, 'TEAM_NOT_FOUND')
  }
  return team
}

async function migrateOneTeam(input: {
  store: TeamAggregateStore
  scope: TeamScope
  stateRoot: string
  team: TeamState
  now: () => number
}): Promise<MigrationTeamOutcome> {
  const { store, scope, stateRoot, team, now } = input
  // Rule 1: validate the complete legacy aggregate before any write.
  assertTeamState(team, `${team.id}/legacy`)

  const sourcePath = new FileTeamStore().pathOf(stateRoot, team.id)
  const sourceBytes = await readFile(sourcePath, 'utf8')
  const sourceSha256 = createHash('sha256').update(sourceBytes, 'utf8').digest('hex')

  // Rule 4: an existing receipt plus an existing record is an idempotent skip.
  const receipt = await store.readMigrationReceipt(team.id)
  if (receipt !== undefined) {
    const record = await store.read(receipt.scope, team.id)
    if (record === undefined) {
      throw new TeamDomainError(
        `migration receipt for team "${team.id}" exists without its record; destination is inconsistent`,
        'TEAM_MIGRATION_INCONSISTENT',
      )
    }
    return { teamId: team.id, status: 'already-migrated', revision: record.revision }
  }

  // Rule 2: destination must be empty for this Team and conflict-free for the
  // captain's active-team invariant in the destination scope.
  const existing = await store.read(scope, team.id)
  if (existing !== undefined) {
    throw new TeamDomainError(`team "${team.id}" already exists at the destination`, 'TEAM_ALREADY_EXISTS')
  }
  if (team.phase === 'active') {
    for (const other of await store.list(scope)) {
      if (other.id !== team.id && other.phase === 'active' && other.captainSessionId === team.captainSessionId) {
        throw new TeamDomainError(
          `destination scope already has an active team of captain "${team.captainSessionId}"`,
          'TEAM_ALREADY_ACTIVE',
        )
      }
    }
  }

  // Rule 3: durable write followed by an authoritative read-back verification.
  await store.importAggregate(scope, team)
  const verified = await store.read(scope, team.id)
  if (verified === undefined || verified.revision !== team.revision || verified.id !== team.id) {
    throw new TeamDomainError(
      `migration read-back verification failed for team "${team.id}"`,
      'TEAM_MIGRATION_VERIFY_FAILED',
    )
  }

  // Rule 4 (receipt) and rule 5 (source stays untouched; its hash is proof).
  await store.recordMigrationReceipt({
    teamId: team.id,
    scope,
    sourcePath,
    sourceSha256,
    revision: verified.revision,
    migratedAt: now(),
  })
  return { teamId: team.id, status: 'migrated', revision: verified.revision }
}
