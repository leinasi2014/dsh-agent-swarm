import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HumanInteractionOverlayStore,
  humanInteractionDomainSpec,
  TeamId,
  type HumanInteractionRecord,
} from '../src/index.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

function record(
  scope: string,
  teamId: ReturnType<typeof TeamId>,
  status: 'pending' | 'cancelled',
): HumanInteractionRecord {
  const requestId = 'human-cross-scope-00000001'
  return {
    schemaVersion: 1,
    scope,
    request: {
      schemaVersion: 1,
      requestId,
      teamId,
      source: { kind: 'captain-mediated', captainSessionId: `captain-${scope}` },
      target: { kind: 'member', memberName: 'worker' },
      intent: 'wake-member',
      expectedTeamRevision: 1,
      createdAt: 1,
    },
    receipt: {
      requestId,
      teamId,
      status,
      ...(status === 'cancelled' ? { code: 'TEAM_INTERACTION_CANCELLED' } : {}),
      updatedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('SW-I1a interaction scope ownership', () => {
  let sandbox: string
  let stack: StorageStack
  let domain: Domain<typeof humanInteractionDomainSpec>
  let overlay: HumanInteractionOverlayStore

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-human-scope-'))
    stack = await openStorageStack(join(sandbox, 'storage'))
    domain = await stack.ctx.storageDomain.open(humanInteractionDomainSpec)
    overlay = new HumanInteractionOverlayStore(stack.ctx, domain)
  })

  afterEach(async () => {
    overlay.close()
    await domain.close()
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('same request id is independent across scopes and one scope cannot read or overwrite the other', async () => {
    const scopeA = 'workspace-a'
    const scopeB = 'workspace-b'
    const teamA = TeamId('team-a')
    const teamB = TeamId('team-b')
    const pendingB = record(scopeB, teamB, 'pending')
    await expect(overlay.commitIfAbsent(pendingB)).resolves.toBeUndefined()
    expect(overlay.get(scopeA, teamA, pendingB.request.requestId)).toBeUndefined()

    // This is the store-level shape of cancel-unknown in A. It creates an A
    // tombstone under A's authority tuple and leaves B's pending request intact.
    const cancelledA = record(scopeA, teamA, 'cancelled')
    await expect(overlay.commitIfAbsent(cancelledA)).resolves.toBeUndefined()
    expect(overlay.get(scopeA, teamA, cancelledA.request.requestId)?.receipt.status).toBe('cancelled')
    expect(overlay.get(scopeB, teamB, pendingB.request.requestId)?.receipt.status).toBe('pending')
    expect(overlay.list(scopeA, teamA)).toHaveLength(1)
    expect(overlay.list(scopeB, teamB)).toHaveLength(1)

    const updatedA = {
      ...cancelledA,
      receipt: { ...cancelledA.receipt, diagnostic: 'A only', updatedAt: 2 },
      updatedAt: 2,
    }
    await overlay.update(updatedA, 1)
    expect(overlay.get(scopeA, teamA, cancelledA.request.requestId)?.receipt.diagnostic).toBe('A only')
    expect(overlay.get(scopeB, teamB, pendingB.request.requestId)?.receipt.diagnostic).toBeUndefined()
  })

  it('strictly rejects unknown or malformed fields before any durable write or update', async () => {
    const scope = 'workspace-strict'
    const teamId = TeamId('team-strict')
    const valid = record(scope, teamId, 'pending')
    const injectedMarker = 'C:\\private\\medium token=secret-marker'
    const invalidRecords: HumanInteractionRecord[] = [
      { ...valid, injectedMarker } as unknown as HumanInteractionRecord,
      {
        ...valid,
        request: { ...valid.request, source: { ...valid.request.source, injectedMarker } },
      } as unknown as HumanInteractionRecord,
      {
        ...valid,
        request: { ...valid.request, target: { kind: 'member', memberName: { injectedMarker } } },
      } as unknown as HumanInteractionRecord,
    ]
    for (const invalid of invalidRecords) {
      await expect(overlay.commitIfAbsent(invalid)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_INVALID' })
    }
    expect(overlay.list(scope, teamId)).toEqual([])
    expect([...domain.table('interactions').entries()]).toEqual([])

    await overlay.commitIfAbsent(valid)
    const invalidUpdate = {
      ...valid,
      receipt: { ...valid.receipt, diagnostic: 'safe', updatedAt: 2, injectedMarker },
      updatedAt: 2,
    } as unknown as HumanInteractionRecord
    await expect(overlay.update(invalidUpdate, 1)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_INVALID' })
    const stored = overlay.get(scope, teamId, valid.request.requestId)
    expect(stored?.receipt.diagnostic).toBeUndefined()
    expect(JSON.stringify([...domain.table('interactions').entries()])).not.toContain('secret-marker')
  })

  it('same request id is independent across Teams in one scope and cannot be read, cancelled or updated across Team authority', async () => {
    const scope = 'workspace-shared'
    const teamA = TeamId('team-a')
    const teamB = TeamId('team-b')
    const pendingB = record(scope, teamB, 'pending')
    await expect(overlay.commitIfAbsent(pendingB)).resolves.toBeUndefined()
    expect(overlay.get(scope, teamA, pendingB.request.requestId)).toBeUndefined()

    const cancelledA = record(scope, teamA, 'cancelled')
    await expect(overlay.commitIfAbsent(cancelledA)).resolves.toBeUndefined()
    expect(overlay.get(scope, teamA, cancelledA.request.requestId)?.receipt.status).toBe('cancelled')
    expect(overlay.get(scope, teamB, pendingB.request.requestId)?.receipt.status).toBe('pending')

    await overlay.update({
      ...cancelledA,
      receipt: { ...cancelledA.receipt, diagnostic: 'team A only', updatedAt: 2 },
      updatedAt: 2,
    }, 1)
    expect(overlay.get(scope, teamA, cancelledA.request.requestId)?.receipt.diagnostic).toBe('team A only')
    expect(overlay.get(scope, teamB, pendingB.request.requestId)?.receipt.diagnostic).toBeUndefined()
  })

  it('rejects a legacy two-part durable key loud instead of guessing a Team migration', async () => {
    const scope = 'workspace-legacy'
    const teamId = TeamId('team-legacy')
    const pending = record(scope, teamId, 'pending')
    await domain.table('interactions').put(JSON.stringify([scope, pending.request.requestId]), pending)
    expect(() => overlay.get(scope, teamId, pending.request.requestId))
      .toThrowError(expect.objectContaining({ code: 'TEAM_INTERACTION_LEGACY_KEY_UNSUPPORTED' }))
    expect(() => overlay.list(scope, teamId))
      .toThrowError(expect.objectContaining({ code: 'TEAM_INTERACTION_LEGACY_KEY_UNSUPPORTED' }))
    const otherTeam = TeamId('team-legacy-other')
    expect(overlay.get(scope, otherTeam, pending.request.requestId)).toBeUndefined()
    expect(overlay.list(scope, otherTeam)).toEqual([])
  })

  it('stop-admission drains admitted work before close and rejects every new operation', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const admitted = overlay.runAdmitted(async () => await blocked)
    const draining = overlay.stopAdmissionAndDrain(1_000)
    await expect(overlay.runAdmitted(async () => undefined)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_STOPPING' })
    release()
    await expect(admitted).resolves.toBeUndefined()
    await expect(draining).resolves.toBeUndefined()
  })

  it('drain timeout fails loud without closing the overlay or losing outcome-unknown quarantine', async () => {
    const scope = 'workspace-timeout'
    const teamId = TeamId('team-timeout')
    const pending = record(scope, teamId, 'pending')
    let release!: () => void
    let ready!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const quarantined = new Promise<void>(resolve => { ready = resolve })
    const admitted = overlay.runAdmitted(async () => {
      await overlay.commitIfAbsent(pending)
      overlay.quarantine(scope, teamId, pending.request.requestId)
      ready()
      await blocked
    })
    await quarantined
    await expect(overlay.stopAdmissionAndDrain(1)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_DISPOSAL_TIMEOUT' })
    expect(overlay.get(scope, teamId, pending.request.requestId)?.receipt.status).toBe('pending')
    expect(overlay.isOutcomeUnknown(scope, teamId, pending.request.requestId)).toBe(true)
    release()
    await admitted
    await expect(overlay.stopAdmissionAndDrain(100)).resolves.toBeUndefined()
  })
})
