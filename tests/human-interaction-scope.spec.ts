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
    expect(overlay.get(scopeA, pendingB.request.requestId)).toBeUndefined()

    // This is the store-level shape of cancel-unknown in A. It creates an A
    // tombstone under A's authority tuple and leaves B's pending request intact.
    const cancelledA = record(scopeA, teamA, 'cancelled')
    await expect(overlay.commitIfAbsent(cancelledA)).resolves.toBeUndefined()
    expect(overlay.get(scopeA, cancelledA.request.requestId)?.receipt.status).toBe('cancelled')
    expect(overlay.get(scopeB, pendingB.request.requestId)?.receipt.status).toBe('pending')
    expect(overlay.list(scopeA, teamA)).toHaveLength(1)
    expect(overlay.list(scopeB, teamB)).toHaveLength(1)

    const updatedA = {
      ...cancelledA,
      receipt: { ...cancelledA.receipt, diagnostic: 'A only', updatedAt: 2 },
      updatedAt: 2,
    }
    await overlay.update(updatedA, 1)
    expect(overlay.get(scopeA, cancelledA.request.requestId)?.receipt.diagnostic).toBe('A only')
    expect(overlay.get(scopeB, pendingB.request.requestId)?.receipt.diagnostic).toBeUndefined()
  })
})
