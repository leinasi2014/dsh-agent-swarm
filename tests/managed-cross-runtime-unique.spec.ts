/**
 * Cross-runtime managed-origin atomic uniqueness (QA FAIL item 1) + lifecycle
 * P1 fixes: only the winner publishes (no transient duplicate / no crash-orphan,
 * no schema-rejecting sentinel) and a retry after a failed/archived Captain
 * provisions a FRESH active Team (no stale claim returning the archived one).
 *
 * Two INDEPENDENTLY-constructed `StorageDomainTeamStore` instances share ONE
 * durable Storage Domain handle (same persistent root). Races under the SAME
 * managed origin are arbitrated by the shared per-scope lock seam (reused from
 * the project; one lock chain per scope across every store instance over the
 * same domain) — NOT per-instance `scopeLocks` and not a new persistence layer.
 * Only the winning store ever publishes its Team; the other reads the winner
 * back by origin. Restart reuse relies on the persisted `managedOrigin`.
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
    const storageRoot = join(sandbox, 'storage')
    const stack = await openStorageStack(storageRoot)
    let storeB: StorageDomainTeamStore | undefined
    try {
      const scope = join(sandbox, 'workspace')
      const origin = `managed:${scope}:turn:7`

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

      // Exactly ONE active Team survives (only the winner published).
      const active = (await stack.store.list(scope)).filter(team => team.phase === 'active')
      expect(active).toHaveLength(1)
      expect(active[0]?.id).toBe(left.id)

      // A later same-origin create still reads the same winner back (idempotent).
      const later = await portA.createTeam(scope, String(SessionId(`cross-captain-C-${Math.random().toString(36).slice(2, 8)}`)), 'Cross C', 'Concurrent same origin again.', -1, origin)
      expect(later.id).toBe(left.id)
      expect(later.captainSessionId).toBe(left.captainSessionId)
      expect((await stack.store.list(scope)).filter(team => team.phase === 'active')).toHaveLength(1)

      // P1 hygiene: reopening the same durable root must succeed (no leftover
      // schema-rejecting sentinel claim) and still see exactly one active Team.
      await stack.close()
      await storeB.close().catch(() => undefined)
      storeB = undefined
      const reopened = await openStorageStack(storageRoot)
      try {
        const reloaded = (await reopened.store.list(scope)).filter(team => team.phase === 'active')
        expect(reloaded).toHaveLength(1)
        expect(reloaded[0]?.id).toBe(left.id)
      } finally {
        await reopened.close()
      }
    } finally {
      if (storeB !== undefined) await storeB.close().catch(() => undefined)
      await stack.close().catch(() => undefined)
    }
  })

  it('retry after an archived managed Team provisions a FRESH active Team + Captain (no stale claim returns the archived Team)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-cross-retry-'))
    roots.push(sandbox)
    const stack = await openStorageStack(join(sandbox, 'storage'))
    try {
      const scope = join(sandbox, 'workspace')
      const origin = `managed:${scope}:turn:9`
      const captain = SessionId(`cross-retry-cap-${Math.random().toString(36).slice(2, 8)}`)

      // A managed Team is created, then the dedicated Captain "fails" — modelled
      // by archiving the Team (the startup-failure cleanup path).
      const first = await stack.port.createTeam(scope, String(captain), 'Retry One', 'First attempt.', -1, origin)
      expect(first.phase).toBe('active')
      await stack.port.archiveTeam(scope, first.id, String(captain), 'dedicated Captain failed')

      // A retry of the SAME managed origin must NOT yield the archived Team (and
      // no Captain): it provisions a NEW active Team with a NEW Captain.
      const retryCaptain = SessionId(`cross-retry-cap2-${Math.random().toString(36).slice(2, 8)}`)
      const retried = await stack.port.createTeam(scope, String(retryCaptain), 'Retry Two', 'Fresh after failure.', -1, origin)
      expect(retried.phase).toBe('active')
      expect(retried.id).not.toBe(first.id)
      expect(retried.captainSessionId).not.toBe(first.captainSessionId)

      const active = (await stack.store.list(scope)).filter(team => team.phase === 'active')
      expect(active).toHaveLength(1)
      expect(active[0]?.id).toBe(retried.id)
    } finally {
      await stack.close()
    }
  })
})
