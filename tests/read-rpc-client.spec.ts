/** Browser-safe R2 client has no import/mount I/O and owns physical abort. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalSwarmReadRpcJson,
  assertSwarmReadRpcValue,
  SWARM_READ_RPC_CONTRACT_DIGEST_V1,
  SWARM_READ_RPC_CONTRACT_V1,
  SWARM_READ_RPC_FIXTURES_V1,
  SwarmReadClient,
} from '../src/client/index.js'

async function expectRejectedCapabilities(value: unknown): Promise<void> {
  const client = new SwarmReadClient(async () => ({
    ok: true, status: 200, json: async () => ({ schemaVersion: 1, ok: true, value }),
  }) as Response)
  await expect(client.request({ schemaVersion: 1, method: 'capabilities' })).rejects.toThrow()
}

const taskRowFixture = {
  id: 'task-fixture', revision: 1, subject: 'Fixture', status: 'pending',
  blockedBy: [], priority: 1, createdAt: 1, updatedAt: 1,
}
const attemptRowFixture = {
  id: 'attempt-fixture', taskId: 'task-fixture', generation: 1,
  phase: 'running', assignmentPhase: 'reserved', createdAt: 1, updatedAt: 1,
}
const interactionRowFixture = {
  requestId: 'request-fixture', intent: 'question', targetKind: 'captain',
  status: 'pending', createdAt: 1, updatedAt: 1,
}

describe('R2 browser client', () => {
  it('freezes one independently verifiable schema and semantic-fixture digest', () => {
    const digest = createHash('sha256').update(canonicalSwarmReadRpcJson({
      contract: SWARM_READ_RPC_CONTRACT_V1,
      fixtures: SWARM_READ_RPC_FIXTURES_V1,
    })).digest('hex')
    expect(digest).toBe(SWARM_READ_RPC_CONTRACT_DIGEST_V1)
    expect(Object.isFrozen(SWARM_READ_RPC_CONTRACT_V1)).toBe(true)
    expect(Object.isFrozen(SWARM_READ_RPC_FIXTURES_V1.requests)).toBe(true)
    expect(SWARM_READ_RPC_CONTRACT_V1.schemas.request.oneOf).toHaveLength(9)
    expect(SWARM_READ_RPC_FIXTURES_V1.values.capabilities.capabilities).toHaveLength(11)
    expect(() => assertSwarmReadRpcValue('page', {
      ...SWARM_READ_RPC_FIXTURES_V1.values.page,
      entries: [taskRowFixture],
      visibleTotal: 1, authoritativeTotal: 1,
    })).not.toThrow()
    expect(() => assertSwarmReadRpcValue('page', {
      ...SWARM_READ_RPC_FIXTURES_V1.values.page,
      entries: [{ id: 'task-fixture', unknown: true }], visibleTotal: 1, authoritativeTotal: 1,
    })).toThrow()
    for (const invalidPage of [
      { kind: 'tasks', entries: [attemptRowFixture] },
      { kind: 'attempts', entries: [taskRowFixture] },
      { kind: 'pendingInteractions', entries: [attemptRowFixture] },
      { kind: 'tasks', entries: [taskRowFixture, interactionRowFixture] },
    ]) expect(() => assertSwarmReadRpcValue('page', {
      ...SWARM_READ_RPC_FIXTURES_V1.values.page,
      ...invalidPage,
      visibleTotal: invalidPage.entries.length,
      authoritativeTotal: invalidPage.entries.length,
    })).toThrow()
    const partialPage = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.page,
      entries: [taskRowFixture],
      visibleTotal: 2, authoritativeTotal: 2,
    }
    expect(() => assertSwarmReadRpcValue('page', partialPage)).toThrow() // remaining page omitted nextOffset
    expect(() => assertSwarmReadRpcValue('page', { ...partialPage, nextOffset: 2 })).toThrow() // skipped index 1
    expect(() => assertSwarmReadRpcValue('page', {
      ...partialPage, visibleTotal: 1, authoritativeTotal: 1, nextOffset: 1,
    })).toThrow() // terminal page advertised a continuation
    expect(() => assertSwarmReadRpcValue('status', {
      ...SWARM_READ_RPC_FIXTURES_V1.values.status,
      capabilities: SWARM_READ_RPC_FIXTURES_V1.values.status.capabilities.map((entry, index) => index === 2
        ? { ...entry, state: 'available', blocker: undefined }
        : entry),
    })).toThrow()
  })

  it('does no work before a request and sends only the versioned JSON envelope', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1, ok: true, value: SWARM_READ_RPC_FIXTURES_V1.values.capabilities,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const mount = new SwarmReadClient(fetcher).mount()
    expect(fetcher).not.toHaveBeenCalled()
    await expect(mount.request({ schemaVersion: 1, method: 'capabilities' })).resolves.toMatchObject({ ok: true })
    expect(fetcher).toHaveBeenCalledWith('/swarm/v1', expect.objectContaining({ method: 'POST' }))
  })

  it('rejects unknown, cyclic, accessor, oversized and contradictory result objects', async () => {
    await expectRejectedCapabilities({ ...SWARM_READ_RPC_FIXTURES_V1.values.capabilities, extra: true })
    const cyclic = { ...SWARM_READ_RPC_FIXTURES_V1.values.capabilities } as Record<string, unknown>
    cyclic.capabilities = [cyclic]
    await expectRejectedCapabilities(cyclic)
    await expectRejectedCapabilities(Object.defineProperty({}, 'protocol', { enumerable: true, get: () => 'bad' }))
    await expectRejectedCapabilities({
      ...SWARM_READ_RPC_FIXTURES_V1.values.capabilities,
      capabilities: Array.from({ length: 8 }, () => ({})),
    })
    await expectRejectedCapabilities({
      ...SWARM_READ_RPC_FIXTURES_V1.values.capabilities,
      capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities.capabilities.map((entry, index) => index === 0
        ? { ...entry, state: 'unavailable', blocker: 'i1b-effect-correlation' }
        : entry),
    })
  })

  it('admits real member roles beyond the legacy 256 bound and rejects an unbounded one', () => {
    const longRole = '开发 writer（仅负责本 P0）：修复 SWARM_UI_READ_FAILED。在受管 lane p0-swarm-ui-read-v2（pnpm isolation open，owner terra-p0）内实施：契约一致（role 上限有界提升并同步 CONTRACT_DIGEST）'.repeat(6) // 391+ codepoints
    expect(longRole.length).toBeGreaterThan(256)
    const snapshotWithLongRole = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: longRole, phase: 'active', createdAt: 1_700_000_000_000 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 },
    }
    // The frozen consumer schema must admit authoritative long role text.
    expect(() => assertSwarmReadRpcValue('snapshot', snapshotWithLongRole)).not.toThrow()
    // The same long role must be delivered to the consumer un-truncated.
    const admitted = snapshotWithLongRole.roster[0]!.role
    expect(admitted).toBe(longRole)
    // The bound is still bounded: an explicit 2049-codepoint role must fail loud.
    const tooLong = 'r'.repeat(2049)
    expect(() => assertSwarmReadRpcValue('snapshot', {
      ...snapshotWithLongRole,
      roster: [{ name: 'worker', role: tooLong, phase: 'active', createdAt: 1_700_000_000_000 }],
    })).toThrow()
  })

  it('aborts admitted work on unmount and forbids later requests', async () => {
    let observedSignal: AbortSignal | undefined
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined
      observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true })
    }))
    const mount = new SwarmReadClient(fetcher).mount()
    const pending = mount.request({ schemaVersion: 1, method: 'capabilities' })
    mount.dispose()
    await expect(pending).rejects.toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
    await expect(mount.request({ schemaVersion: 1, method: 'capabilities' })).rejects.toThrow('disposed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
