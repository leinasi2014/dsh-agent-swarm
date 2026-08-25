import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import { assertTeamStateV2 } from '../domain/state-validation-v2.js'
import type { FreshV2AuthorityRecord, TeamStateV2 } from '../domain/team-state-v2.js'
import type { TeamId } from '../domain/types.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import { legacyManifestSetDigest } from '../protocol/canonical-v2.js'
import {
  TEAM_V2_AUTHORITY_KEY,
  teamDomainSpecV2,
  teamRecordV2Of,
} from './team-spec-v2.js'

export type TeamV2Transaction<T> = (draft: TeamStateV2) => T | Promise<T>

function withLock<T>(locks: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key)
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = (previous ?? Promise.resolve()).then(() => current)
  locks.set(key, tail)
  return (async () => {
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (locks.get(key) === tail) locks.delete(key)
    }
  })()
}

function closed(): TeamDomainError {
  return new TeamDomainError('Team v2 aggregate store is closed', 'TEAM_STORE_CLOSED')
}

/** Build the only authority record permitted by the fresh/empty A1 path. */
function freshV2AuthorityRecord(input: {
  readonly artifactContract: string
  readonly legacyManifestCapacity: number
  readonly createdAt: number
}): FreshV2AuthorityRecord {
  if (input.artifactContract.trim() === '') throw new TeamDomainError('v2 artifact contract is empty', 'TEAM_INPUT_INVALID')
  if (!Number.isSafeInteger(input.legacyManifestCapacity) || input.legacyManifestCapacity < 0) {
    throw new TeamDomainError('v2 legacy manifest capacity is invalid', 'TEAM_INPUT_INVALID')
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new TeamDomainError('v2 authority timestamp is invalid', 'TEAM_INPUT_INVALID')
  }
  return {
    schemaVersion: 1,
    authorityEpoch: 2,
    origin: 'fresh',
    teamSchemaVersion: 2,
    artifactContract: input.artifactContract,
    legacyManifest: {
      capacity: input.legacyManifestCapacity,
      count: 0,
      digests: [],
      setDigest: legacyManifestSetDigest([]),
    },
    createdAt: input.createdAt,
  }
}

/**
 * A1-only fresh-v2 authority store. It never opens `agent_swarm` v1 and is
 * not wired into the production runtime until the A1b candidate switches
 * one isolated Profile to this sole authority.
 */
export class StorageDomainTeamStoreV2 {
  readonly backend = 'storage-domain-v2'

  private readonly authority: ReturnType<Domain<typeof teamDomainSpecV2>['table']>
  private readonly teams: ReturnType<Domain<typeof teamDomainSpecV2>['table']>
  private readonly locks = new Map<string, Promise<void>>()
  private readonly stopListening: () => void
  private ready = false
  private storeClosed = false

  constructor(
    ctx: Context,
    domain: Domain<typeof teamDomainSpecV2>,
    private readonly binding: { readonly artifactContract: string; readonly legacyManifestCapacity: number },
    private readonly now: () => number = Date.now,
  ) {
    this.authority = domain.table('authority')
    this.teams = domain.table('teams')
    this.stopListening = ctx.on('domain/changed', () => undefined)
  }

  /** Expected-absent create plus authoritative read-back; exact reopen is idempotent. */
  async initializeFreshAuthority(): Promise<FreshV2AuthorityRecord> {
    if (this.storeClosed) throw closed()
    return await withLock(this.locks, '\0authority', async () => {
      const existing = this.authority.get(TEAM_V2_AUTHORITY_KEY)
      if (existing !== undefined) {
        this.assertAuthorityBinding(existing)
        this.ready = true
        return structuredClone(existing)
      }
      const candidate = freshV2AuthorityRecord({ ...this.binding, createdAt: this.now() })
      await this.authority.put(TEAM_V2_AUTHORITY_KEY, candidate)
      const readBack = this.authority.get(TEAM_V2_AUTHORITY_KEY)
      if (readBack === undefined || !isDeepStrictEqual(readBack, candidate)) {
        throw new TeamDomainError('fresh v2 authority read-back verification failed', 'TEAM_MIGRATION_VERIFY_FAILED')
      }
      this.ready = true
      return structuredClone(readBack)
    })
  }

  readAuthority(): FreshV2AuthorityRecord | undefined {
    if (this.storeClosed) throw closed()
    const record = this.authority.get(TEAM_V2_AUTHORITY_KEY)
    return record === undefined ? undefined : structuredClone(record)
  }

  async createUniqueForCaptain(scope: TeamScope, state: TeamStateV2): Promise<void> {
    this.requireAuthority()
    assertTeamStateV2(state, `${state.id}/create`)
    await withLock(this.locks, `scope:${scope}`, async () => {
      for (const [, record] of this.teams.entries()) {
        if (record.workspace === scope && record.team.phase === 'active'
          && record.team.captainSessionId === state.captainSessionId) {
          throw new TeamDomainError('captain already owns an active v2 team', 'TEAM_ALREADY_ACTIVE')
        }
      }
      if (this.teams.get(state.id) !== undefined) throw new TeamDomainError(`team "${state.id}" already exists`, 'TEAM_ALREADY_EXISTS')
      await this.putAndVerify(scope, state)
    })
  }

  read(scope: TeamScope, teamId: TeamId): TeamStateV2 | undefined {
    this.requireAuthority()
    const record = this.teams.get(teamId)
    if (record === undefined || record.workspace !== scope) return undefined
    assertTeamStateV2(record.team, `${teamId}/read`)
    return structuredClone(record.team)
  }

  list(scope: TeamScope): TeamStateV2[] {
    this.requireAuthority()
    const result: TeamStateV2[] = []
    for (const [teamId, record] of [...this.teams.entries()].toSorted((left, right) => left[0].localeCompare(right[0]))) {
      if (record.workspace !== scope) continue
      assertTeamStateV2(record.team, `${teamId}/list`)
      result.push(structuredClone(record.team))
    }
    return result
  }

  transact<T>(scope: TeamScope, teamId: TeamId, operation: TeamV2Transaction<T>): Promise<T> {
    this.requireAuthority()
    return withLock(this.locks, `team:${teamId}`, async () => {
      const current = this.read(scope, teamId)
      if (current === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
      const draft = structuredClone(current)
      const result = await operation(draft)
      if (isDeepStrictEqual(draft, current)) return result
      const next: TeamStateV2 = { ...draft, revision: current.revision + 1, updatedAt: this.now() }
      assertTeamStateV2(next, `${teamId}/transaction`)
      await this.putAndVerify(scope, next)
      return result
    })
  }

  async close(): Promise<void> {
    if (this.storeClosed) return
    this.storeClosed = true
    this.ready = false
    this.stopListening()
    await Promise.allSettled(this.locks.values())
    this.locks.clear()
  }

  private requireAuthority(): void {
    if (this.storeClosed) throw closed()
    if (!this.ready) throw new TeamDomainError('fresh v2 authority has not been initialized', 'TEAM_RUNTIME_NOT_STARTED')
    const current = this.authority.get(TEAM_V2_AUTHORITY_KEY)
    if (current === undefined) throw new TeamDomainError('fresh v2 authority record is missing', 'TEAM_STATE_CORRUPT')
    this.assertAuthorityBinding(current)
  }

  private assertAuthorityBinding(record: FreshV2AuthorityRecord): void {
    if (record.artifactContract !== this.binding.artifactContract
      || record.legacyManifest.capacity !== this.binding.legacyManifestCapacity
      || record.legacyManifest.count !== 0
      || record.legacyManifest.digests.length !== 0
      || record.legacyManifest.setDigest !== legacyManifestSetDigest([])) {
      throw new TeamDomainError('fresh v2 authority binding conflicts with this artifact', 'TEAM_STATE_VERSION_UNSUPPORTED')
    }
  }

  private async putAndVerify(scope: TeamScope, team: TeamStateV2): Promise<void> {
    await this.teams.put(team.id, teamRecordV2Of(scope, team))
    const readBack = this.teams.get(team.id)
    if (readBack === undefined || !isDeepStrictEqual(readBack, teamRecordV2Of(scope, team))) {
      throw new TeamDomainError(`v2 read-back verification failed for team "${team.id}"`, 'TEAM_MIGRATION_VERIFY_FAILED')
    }
  }
}
