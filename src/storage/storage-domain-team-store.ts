/**
 * The production Team aggregate Provider over the official Storage Domain
 * form (ADR-0007, M1A). Every write reaches backend durability through the
 * domain's write chain before it becomes visible to reads or waiters; the
 * per-team/per-scope promise chains serialize whole transactions
 * process-locally, and every durable write to the `agent_swarm` JSON unit is
 * additionally serialized per open domain handle with a bounded transient
 * retry so concurrent Team operations cannot surface a transient EPERM from an
 * overlapping atomic rename publish. This store is explicitly single-process:
 * cross-process CAS, leases and change push remain a later Store Provider's
 * work.
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

/**
 * Scope-serialization lock chains SHARED across every store instance that holds
 * the SAME open Storage Domain handle. Keyed weakly by the domain so two
 * independently-constructed `StorageDomainTeamStore` instances over one durable
 * root (same process) serialize managed-origin creation against each other —
 * reusing the project's existing per-scope lock seam, with no new persistence
 * layer and no CAS primitive. Process-local by design (the official Storage
 * Domain backend is explicitly single-process); a cross-process deployment is a
 * later Store Provider's concern, and restart reuse is carried by the persisted
 * `managedOrigin` on the Team aggregate, not by this lock.
 */
const sharedScopeLocks = new WeakMap<Domain<typeof teamDomainSpec>, Map<string, Promise<void>>>()

function scopeLocksFor(domain: Domain<typeof teamDomainSpec>): Map<string, Promise<void>> {
  let locks = sharedScopeLocks.get(domain)
  if (locks === undefined) {
    locks = new Map<string, Promise<void>>()
    sharedScopeLocks.set(domain, locks)
  }
  return locks
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

/**
 * Transient write codes on the atomic whole-file publish of the `agent_swarm`
 * unit (temp write -> fsync -> rename()). The official `@deepseek-ai/dsh-storage-domain`
 * already serializes the domain's write chain (`enqueue`), and the storage-json
 * backend allows exactly one live unit handle, so the transient contention here
 * is a REAL file-system publish/rename conflict (e.g. antivirus, another
 * process, or a share) rather than two store instances overlapping on one open
 * domain. These transient codes are recoverable by re-issuing the identical
 * publish; anything else is a real failure and must fail through immediately.
 */
const TRANSIENT_WRITE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/** Number of retries after the initial attempt for a transient unit write. */
const MAX_WRITE_RETRIES = 5
/** Base exponential-backoff delay for a transient unit-write retry (ms). */
const WRITE_RETRY_BASE_MS = 10
/** Hard cap on a single transient unit-write backoff delay (ms). */
const WRITE_RETRY_MAX_MS = 250

function isTransientWriteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && TRANSIENT_WRITE_CODES.has(code)
}

function writeBackoffMs(retryIndex: number): number {
  return Math.min(WRITE_RETRY_BASE_MS * 2 ** retryIndex, WRITE_RETRY_MAX_MS)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Re-issue a unit write only on a transient code, with a bounded exponential
 * backoff, and propagate the last error once retries are exhausted. A
 * non-transient failure rethrows immediately and is never swallowed.
 */
async function writeWithTransientRetry<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write()
    } catch (error) {
      if (!isTransientWriteError(error) || attempt >= MAX_WRITE_RETRIES) throw error
      await delay(writeBackoffMs(attempt))
    }
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
  private readonly domain: Domain<typeof teamDomainSpec>
  private storeClosed = false

  constructor(
    ctx: Context,
    domain: Domain<typeof teamDomainSpec>,
    private readonly now: () => number = Date.now,
  ) {
    this.domain = domain
    this.teams = domain.table('teams')
    this.receipts = domain.table('migration_receipts')
    this.stopListening = ctx.on('domain/changed', change => this.onChange(change))
  }

  /** Route one durable unit write through the bounded transient-retry path. */
  private writeUnit<T>(write: () => Promise<T>): Promise<T> {
    return writeWithTransientRetry(write)
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
    await this.writeUnit(() => this.teams.put(teamId, this.envelope(scope, upgraded)))
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
        // Per-captain uniqueness (the plain `agent_swarm_create` guarantee).
        if (record[1].team.phase === 'active' && record[1].team.captainSessionId === state.captainSessionId) {
          captainActive = true
          break
        }
      }
      if (captainActive) throw new TeamDomainError('captain already owns an active team', 'TEAM_ALREADY_ACTIVE')
      if (this.teams.get(state.id) !== undefined) {
        throw new TeamDomainError(`team "${state.id}" already exists`, 'TEAM_ALREADY_EXISTS')
      }
      await this.writeUnit(() => this.teams.put(state.id, this.envelope(scope, state)))
      this.notify(state.id)
    })
  }

  /**
   * Atomic managed-Team creation for identity-addressed `agent_swarm_create_managed`.
   *
   * The at-most-one-active-Team-per-managed-origin guarantee is held by the
   * per-SCOPE lock shared across every store instance over the SAME open Storage
   * Domain handle (see `scopeLocksFor`) — the project's existing per-scope lock
   * seam, NOT per-instance `scopeLocks` and NOT a new persistence layer. Inside
   * the lock: an existing ACTIVE Team with this `managedOrigin` is the winner and
   * is read back (never throwing); otherwise this (sole) holder publishes its own
   * Team. Only the winner ever publishes, so there is no transient loser publish
   * and no duplicate on a crash between decision and publish. Restart reuse relies
   * on the persisted `managedOrigin` on the Team, not on this in-process lock.
   *
   * @returns the winning Team — this caller's own (when it won the lock) or an
   *   existing winner read back by origin. Never throws for an origin conflict.
   */
  async createManaged(scope: TeamScope, state: TeamState): Promise<TeamState> {
    if (this.storeClosed) throw closed()
    if (state.managedOrigin === undefined) {
      await this.createUniqueForCaptain(scope, state)
      return state
    }
    return await withLock(scopeLocksFor(this.domain), scope, async () => {
      for (const record of this.teams.entries()) {
        if (record[1].workspace !== scope) continue
        if ((record[1].team.phase === 'active' || record[1].team.phase === 'staged') && record[1].team.managedOrigin === state.managedOrigin) {
          const winner = this.validate(record[1], record[0])
          if (winner !== undefined) return winner
        }
      }
      await this.writeUnit(() => this.teams.put(state.id, this.envelope(scope, state)))
      this.notify(state.id)
      return state
    })
  }

  async read(scope: TeamScope, teamId: TeamId): Promise<TeamState | undefined> {
    if (this.storeClosed) throw closed()
    const team = await withLock(this.teamLocks, teamId, () => this.readAndUpgrade(scope, teamId))
    return team === undefined ? undefined : structuredClone(team)
  }

  async list(scope: TeamScope, participantSessionId?: string): Promise<TeamState[]> {
    if (this.storeClosed) throw closed()
    const teams: TeamState[] = []
    const entries = [...this.teams.entries()].toSorted((left, right) => left[0].localeCompare(right[0]))
    for (const [teamId, record] of entries) {
      if (record.workspace !== scope) continue
      if (participantSessionId !== undefined) {
        // Read current canonical metadata on every lookup: no cache can keep
        // an archived ledger ahead of a newly active one. Uncertain metadata
        // goes through strict validation, never silently excludes a candidate.
        const { captainSessionId, members } = record.team
        if (typeof captainSessionId !== 'string' || !Array.isArray(members)
          || members.some(member => typeof member?.sessionId !== 'string')) {
          this.validate(record, teamId)
        } else if (captainSessionId !== participantSessionId
          && !members.some(member => member.sessionId === participantSessionId)) continue
      }
      const team = await withLock(this.teamLocks, teamId, () => this.readAndUpgrade(scope, teamId))
      if (team !== undefined) teams.push(structuredClone(team))
    }
    return teams
  }

  /**
   * The whole Team record minus the non-transition budget face and the
   * per-session usage cursors. A change confined to those two fields is not a
   * board transition (see team-domain-budget.ts: "budget configuration is not
   * a board transition"): it must still reach durability and keep its notify
   * path, but it must not advance the control-plane revision, so the
   * captain's `expected_revision` compare-and-swap reads stay valid across
   * usage/budget writes instead of going stale every 2 seconds.
   */
  private static boardPayload(state: TeamState): object {
    const { budget: _budget, usageCursors: _usageCursors, ...board } = state
    return board
  }

  async transact<T>(scope: TeamScope, teamId: TeamId, operation: TeamTransaction<T>): Promise<T> {
    if (this.storeClosed) throw closed()
    return await withLock(this.teamLocks, teamId, async () => {
      const current = await this.readAndUpgrade(scope, teamId)
      if (current === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
      const draft = structuredClone(current)
      const result = await operation(draft)
      if (isDeepStrictEqual(draft, current)) return result
      const boardChanged = !isDeepStrictEqual(
        StorageDomainTeamStore.boardPayload(draft),
        StorageDomainTeamStore.boardPayload(current),
      )
      // Non-transition writes (budget limits / per-session usage cursors)
      // persist durability and notifications but keep the current revision;
      // genuine board transitions still advance the revision.
      const next: TeamState = boardChanged
        ? { ...draft, revision: current.revision + 1, updatedAt: this.now() }
        : { ...draft }
      await this.writeUnit(() => this.teams.put(teamId, this.envelope(scope, next)))
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
    await this.writeUnit(() => this.teams.put(team.id, this.envelope(scope, team)))
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
    await this.writeUnit(() => this.receipts.put(receipt.teamId, { ...receipt }))
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

