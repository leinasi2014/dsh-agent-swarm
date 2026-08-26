/**
 * The production Team aggregate Provider over the official Storage Domain
 * form (ADR-0007, M1A). Every write reaches backend durability through the
 * domain's write chain before it becomes visible to reads or waiters; the
 * per-team/per-scope promise chains serialize whole transactions
 * process-locally. This store is explicitly single-process: cross-process
 * CAS, leases and change push remain a later Store Provider's work.
 */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import { assertTeamState } from '../domain/state-validation.js'
import type {
  MigrationReceipt,
  TeamAggregateStore,
  TeamScope,
  TeamTransaction,
} from '../domain/team-domain-port.js'
import type { TeamId, TeamState } from '../domain/types.js'
import { TEAM_DOMAIN_NAME, teamDomainSpec, teamRecordOf } from './team-spec.js'

function closed(): TeamDomainError {
  return new TeamDomainError('Team aggregate store is closed', 'TEAM_STORE_CLOSED')
}

async function withLock<T>(locks: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => current)
  locks.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

/** Official `ctx.storageDomain`-backed authority for the Team aggregate. */
export class StorageDomainTeamStore implements TeamAggregateStore {
  readonly backend = 'storage-domain'

  private readonly teams: ReturnType<Domain<typeof teamDomainSpec>['table']>
  private readonly receipts: ReturnType<Domain<typeof teamDomainSpec>['table']>
  private readonly teamLocks = new Map<string, Promise<void>>()
  private readonly scopeLocks = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly stopListening: () => void
  private storeClosed = false

  constructor(
    ctx: Context,
    domain: Domain<typeof teamDomainSpec>,
    private readonly now: () => number = Date.now,
  ) {
    this.teams = domain.table('teams')
    this.receipts = domain.table('migration_receipts')
    this.stopListening = ctx.on('domain/changed', change => this.onChange(change))
  }

  private onChange(change: DomainChanged): void {
    if (change.domain !== TEAM_DOMAIN_NAME || change.table !== 'teams' || change.operation !== 'put') return
    for (const notify of this.waiters.get(change.key) ?? []) notify()
  }

  private notify(teamId: TeamId): void {
    for (const notify of this.waiters.get(teamId) ?? []) notify()
  }

  private envelope(scope: TeamScope, team: TeamState) {
    return teamRecordOf(scope, team)
  }

  private validate(record: { workspace: TeamScope; team: TeamState } | undefined, teamId: TeamId): TeamState | undefined {
    if (record === undefined) return undefined
    // Records passed the zod boundary at open; this deep semantic pass keeps
    // the domain invariants (attempt/task cross-references, DAG) authoritative
    // on every read.
    assertTeamState(record.team, `${teamId}/aggregate`)
    return record.team
  }

  /**
   * The domain descriptor stays at v1; the aggregate carries its own
   * explicit v1→v2 format.  Upgrade happens under the existing per-Team
   * transaction lock, before a Team escapes through any runtime read.
   */
  private async readAndUpgrade(scope: TeamScope, teamId: TeamId): Promise<TeamState | undefined> {
    const record = this.teams.get(teamId)
    if (record === undefined || record.workspace !== scope) return undefined
    const current = this.validate(record, teamId)
    if (current === undefined || current.schemaVersion === 2) return current
    const upgraded: TeamState = {
      ...current,
      schemaVersion: 2,
      interactionEffects: [],
    }
    assertTeamState(upgraded, `${teamId}/aggregate-upgrade`)
    await this.teams.put(teamId, this.envelope(scope, upgraded))
    const readBack = this.validate(this.teams.get(teamId), teamId)
    if (readBack === undefined || readBack.schemaVersion !== 2 || !isDeepStrictEqual(readBack, upgraded)) {
      throw new TeamDomainError(`Team aggregate v1 to v2 read-back failed for "${teamId}"`, 'TEAM_MIGRATION_VERIFY_FAILED')
    }
    this.notify(teamId)
    return readBack
  }

  async createUniqueForCaptain(scope: TeamScope, state: TeamState): Promise<void> {
    if (this.storeClosed) throw closed()
    await withLock(this.scopeLocks, scope, async () => {
      let captainActive = false
      for (const record of this.teams.entries()) {
        if (record[1].workspace !== scope) continue
        if (record[1].team.phase === 'active' && record[1].team.captainSessionId === state.captainSessionId) {
          captainActive = true
          break
        }
      }
      if (captainActive) throw new TeamDomainError('captain already owns an active team', 'TEAM_ALREADY_ACTIVE')
      if (this.teams.get(state.id) !== undefined) {
        throw new TeamDomainError(`team "${state.id}" already exists`, 'TEAM_ALREADY_EXISTS')
      }
      await this.teams.put(state.id, this.envelope(scope, state))
      this.notify(state.id)
    })
  }

  async read(scope: TeamScope, teamId: TeamId): Promise<TeamState | undefined> {
    if (this.storeClosed) throw closed()
    const team = await withLock(this.teamLocks, teamId, () => this.readAndUpgrade(scope, teamId))
    return team === undefined ? undefined : structuredClone(team)
  }

  async list(scope: TeamScope): Promise<TeamState[]> {
    if (this.storeClosed) throw closed()
    const teams: TeamState[] = []
    const entries = [...this.teams.entries()].toSorted((left, right) => left[0].localeCompare(right[0]))
    for (const [teamId, record] of entries) {
      if (record.workspace !== scope) continue
      const team = await withLock(this.teamLocks, teamId, () => this.readAndUpgrade(scope, teamId))
      if (team !== undefined) teams.push(structuredClone(team))
    }
    return teams
  }

  async transact<T>(scope: TeamScope, teamId: TeamId, operation: TeamTransaction<T>): Promise<T> {
    if (this.storeClosed) throw closed()
    return await withLock(this.teamLocks, teamId, async () => {
      const current = await this.readAndUpgrade(scope, teamId)
      if (current === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
      const draft = structuredClone(current)
      const result = await operation(draft)
      if (isDeepStrictEqual(draft, current)) return result
      const next: TeamState = { ...draft, revision: current.revision + 1, updatedAt: this.now() }
      await this.teams.put(teamId, this.envelope(scope, next))
      this.notify(teamId)
      return result
    })
  }

  async waitForChange(scope: TeamScope, teamId: TeamId, afterRevision: number, signal: AbortSignal): Promise<TeamState> {
    if (this.storeClosed) throw closed()
    const current = await this.read(scope, teamId)
    if (current === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
    if (current.revision > afterRevision) return current
    if (signal.aborted) throw signal.reason

    return await new Promise<TeamState>((resolve, reject) => {
      let checking = false
      let settled = false
      const waiters = this.waiters.get(teamId) ?? new Set<() => void>()
      const cleanup = (): void => {
        waiters.delete(check)
        if (waiters.size === 0) this.waiters.delete(teamId)
        signal.removeEventListener('abort', onAbort)
      }
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        operation()
      }
      const onAbort = (): void => { finish(() => reject(signal.reason)) }
      const check = (): void => {
        if (checking || settled) return
        checking = true
        // A closed store makes this read reject, which settles the waiter.
        void this.read(scope, teamId).then(next => {
          if (next === undefined) {
            finish(() => reject(new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')))
          } else if (next.revision > afterRevision) {
            finish(() => resolve(next))
          }
        }).catch(error => { finish(() => reject(error)) }).finally(() => { checking = false })
      }
      waiters.add(check)
      this.waiters.set(teamId, waiters)
      signal.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }

  async importAggregate(scope: TeamScope, team: TeamState): Promise<void> {
    if (this.storeClosed) throw closed()
    if (this.teams.get(team.id) !== undefined) {
      throw new TeamDomainError(`team "${team.id}" already exists`, 'TEAM_ALREADY_EXISTS')
    }
    await this.teams.put(team.id, this.envelope(scope, team))
    // Read back from the authoritative post-durability state and verify the
    // complete aggregate survived the durable write.
    const stored = this.teams.get(team.id)
    if (stored === undefined || !isDeepStrictEqual(stored, this.envelope(scope, team))) {
      throw new TeamDomainError(
        `migration read-back verification failed for team "${team.id}"`,
        'TEAM_MIGRATION_VERIFY_FAILED',
      )
    }
    this.notify(team.id)
  }

  async readMigrationReceipt(teamId: TeamId): Promise<MigrationReceipt | undefined> {
    if (this.storeClosed) throw closed()
    const receipt = this.receipts.get(teamId)
    return receipt === undefined ? undefined : { ...receipt }
  }

  async recordMigrationReceipt(receipt: MigrationReceipt): Promise<void> {
    if (this.storeClosed) throw closed()
    await this.receipts.put(receipt.teamId, { ...receipt })
  }

  async close(): Promise<void> {
    if (this.storeClosed) return
    this.storeClosed = true
    this.stopListening()
    const pending = [...this.waiters.values()].flatMap(waiters => [...waiters])
    this.waiters.clear()
    for (const notify of pending) notify()
  }
}
