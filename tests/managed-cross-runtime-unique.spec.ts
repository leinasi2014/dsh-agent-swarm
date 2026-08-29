/**
 * Cross-runtime managed-origin atomic uniqueness (QA FAIL item 1).
 *
 * Two INDEPENDENTLY-constructed `StorageDomainTeamStore` instances share ONE
 * durable Storage Domain handle (same persistent root and the domain's single
 * write chain). Both race to create a managed Team under the SAME managed
 * origin. The at-most-one guarantee is enforced by the Storage Domain's atomic
 * origin Claim (a `managed_origins` record arbitrated with `update`, serialized
 * on the shared write chain) — NOT by any per-instance `scopeLocks` or
 * single-flight map. Exactly one Team wins; the loser rolls back its transient
 * candidate and reads the winner back by managed origin, so both callers
 * observe the same `team_id` and `captain_session_id` and exactly one active
 * Team remains.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { StorageDomainTeamStore } from '../src/storage/storage-domain-team-store.js'
import { openStorageStack } from './helpers/storage-stack.js'

describe('cross-runtime managed origin atomic uniqueness', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('two independent store instances over one durable Storage Domain create exactly one Team for the same origin; both read back the winner', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-cross-runtime-'))
    roots.push(sandbox)
    const stack = await openStorageStack(join(sandbox, 'storage'))
    let storeB: StorageDomainTeamStore | undefined
    try {
      const scope = join(sandbox, 'workspace')
      const origin = `managed:${scope}:turn:7`

      // Store A comes from the stack; Store B is a second INDEPENDENT store
      // instance over the SAME durable Storage Domain handle. Each gets its own
      // domain port. They share no per-instance lock and no single-flight map.
      const portA = stack.port
      storeB = new StorageDomainTeamStore(stack.ctx, stack.domain)
      const portB = new TeamDomain(storeB)

      const captainA = SessionId(`cross-captain-A-${Math.random().toString(36).slice(2, 8)}`)
      const captainB = SessionId(`cross-captain-B-${Math.random().toString(36).slice(2, 8)}`)

      // Concurrent same-identity create across the two store instances.
      const [left, right] = await Promise.all([
        portA.createTeam(scope, String(captainA), 'Cross A', 'Concurrent same origin.', -1, origin),
        portB.createTeam(scope, String(captainB), 'Cross B', 'Concurrent same origin.', -1, origin),
      ])

      // Both callers observe the SAME winning Team and its SAME Captain.
      expect(left.id).toBe(right.id)
      expect(left.captainSessionId).toBe(right.captainSessionId)

      // Exactly ONE active Team survives (the loser rolled its candidate back).
      const active = (await stack.store.list(scope)).filter(team => team.phase === 'active')
      expect(active).toHaveLength(1)
      expect(active[0]?.id).toBe(left.id)

      // A later same-origin create still reads the same winner back (idempotent).
      const later = await portA.createTeam(scope, String(SessionId(`cross-captain-C-${Math.random().toString(36).slice(2, 8)}`)), 'Cross C', 'Concurrent same origin again.', -1, origin)
      expect(later.id).toBe(left.id)
      expect(later.captainSessionId).toBe(left.captainSessionId)
      expect((await stack.store.list(scope)).filter(team => team.phase === 'active')).toHaveLength(1)
    } finally {
      if (storeB !== undefined) await storeB.close().catch(() => undefined)
      await stack.close()
    }
  })
})
