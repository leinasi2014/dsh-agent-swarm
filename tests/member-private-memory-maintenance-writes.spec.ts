/**
 * M1 self-maintenance WRITES contract spec (task-4). The owning member writes
 * durable v2 maintenance operations through the REAL
 * `MemberPrivateMemoryService.maintain` capability under the Root-frozen
 * docs/04-core-protocol.md §7.1 contract (public-admission copy, protocol
 * version pinned cced2c181c25b04fcd832c0415ec722e78677b3a...). This slice
 * first went tests-only RED on the host (work/m1-writes-red.log: CONTROL PASS,
 * both maintenance cases failed on the then-missing capability); GREEN now
 * implements the product contracts.
 *
 * Everything runs over the REAL official stack (openStorageStack: hub + JSON
 * backend + domain form on a shared root, with REAL cold reopens) and the
 * deterministic official TeamDomain port; the exact live member handle is the
 * SAME registered Agent object the service resolves, and the durable team id
 * is the real generated id.
 *
 * Covered contract surface: CONTROL v1 write; CAS revise appending exactly ONE
 * strict v2 row; legal retry idempotence (original prefix receipt, zero new
 * rows, stable across a real cold reopen, `replayed` is call-time-only); the
 * retry read-back running BEFORE capacity/head checks; same-operationId
 * different-content conflict; stale head; terminal target; unknown target;
 * atomic single-put replace (superseded IN PLACE + tail-appended result); v2
 * add coexisting with v1-only production writes; forged handle; abort of a
 * queued maintenance (zero durable rows); concurrent same-id single append;
 * concurrent CAS conflict; partition capacity over ALL rows with loud
 * rejection and no reclaim; write-admission thresholds and canonicalization;
 * Host-derived provenance (unique running task observation vs unattributed)
 * that the model can never supply; receipt/request rebuild from the durable
 * prefix on cold recovery.
 *
 * Exact runner command (external M host; in-sandbox vitest hits the known
 * piped-spawn EPERM boundary):
 *   pnpm exec vitest run tests/member-private-memory-maintenance-writes.spec.ts
 */
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemberPrivateMemoryService, type MemberPrivateMemoryServiceDeps } from '../src/runtime/member-private-memory-service.js'
import type { ToolExecutionAuthority } from '../src/runtime/orchestrator-runtime.js'
import type { TeamDomainPort } from '../src/domain/team-domain-port.js'
import {
  MemberPrivateMemoryStore,
  PRIVATE_MEMORY_DOMAIN_NAME,
  privateMemoryDomainSpec,
} from '../src/storage/member-private-memory.js'
import {
  PRIVATE_MEMORY_MAINTENANCE_MAX_ROWS,
  PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS,
} from '../src/storage/member-private-memory-operations.js'
import type { PrivateMemoryMaintenanceInput, PrivateMemoryNote, PrivateMemoryProvenance, PrivateMemoryReceipt } from '../src/storage/member-private-memory-operations.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'
import type { TeamId } from '../src/domain/types.js'

const SIGNAL = new AbortController().signal
const SCOPE = 'private-memory-maintenance-writes'
const CAPTAIN = 'captain-maintenance-writes'
const MEMBER = 'member-maintenance-writer'

function fakeAgent(id: string): Agent {
  return { id } as unknown as Agent
}

interface Mount {
  readonly service: MemberPrivateMemoryService
  readonly store: MemberPrivateMemoryStore
  readonly port: TeamDomainPort
  readonly memories: { put(key: string, value: unknown): Promise<void> }
  /** The SAME registered live member handle this mount's service resolves. */
  readonly agent: Agent
  close(): Promise<void>
}

interface WriterFixture {
  readonly root: string
  readonly teamId: TeamId
  /** Close the current mount and open the NEXT one over the same roots (real cold reopen). */
  remount(): Promise<Mount>
  current(): Mount
}

const fixtures: WriterFixture[] = []
const sandboxRoots: string[] = []

async function openMount(root: string): Promise<Mount> {
  const stack: StorageStack = await openStorageStack(root)
  const privateDomain = await stack.ctx.storageDomain.open(privateMemoryDomainSpec)
  const store = new MemberPrivateMemoryStore(stack.ctx, privateDomain)
  // The exact live registered member handle for THIS mount.
  const agent = fakeAgent(MEMBER)
  const live = new Map<string, Agent>([[MEMBER, agent]])
  const service = new MemberPrivateMemoryService({
    domain: () => stack.port,
    store: () => store,
    scopeOf: () => SCOPE,
    liveAgent: (id: string) => live.get(id),
  } as unknown as MemberPrivateMemoryServiceDeps)
  return {
    service,
    store,
    port: stack.port,
    memories: privateDomain.table('memories') as unknown as Mount['memories'],
    agent,
    async close() {
      store.close()
      await privateDomain.close()
      await stack.close()
    },
  }
}

/** One dedicated cold mount establishes the durable Team + active member (persisted for reopens). */
async function writerFixture(): Promise<WriterFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pm-writes-'))
  sandboxRoots.push(root)
  const setup = await openStorageStack(root)
  let teamId: TeamId
  try {
    const team = await setup.port.createTeam(SCOPE, CAPTAIN, 'Writes', 'maintenance writer slice')
    teamId = team.id
    await setup.port.provisionMember(SCOPE, team.id, CAPTAIN, { name: 'writer', role: 'Maintains own notes', sessionId: MEMBER, provider: 'test' })
    await setup.port.settleMember(SCOPE, team.id, MEMBER, { active: true })
  } finally {
    await setup.close()
  }
  let currentMount = await openMount(root)
  const fixture: WriterFixture = {
    root,
    teamId,
    current: () => currentMount,
    async remount() {
      await currentMount.close()
      currentMount = await openMount(root)
      return currentMount
    },
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => { await fixture.current().close().catch(() => {}) }))
  await Promise.all(sandboxRoots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function durableRows(root: string): Promise<Record<string, Record<string, unknown>>> {
  const doc = JSON.parse(await readFile(join(root, `${PRIVATE_MEMORY_DOMAIN_NAME}.json`), 'utf8')) as { tables: { memories: Record<string, Record<string, unknown>> } }
  return doc.tables.memories
}

function rowKey(fixture: WriterFixture, seq: number): string {
  return JSON.stringify([SCOPE, fixture.teamId, MEMBER, seq])
}

async function countRows(fixture: WriterFixture): Promise<number> {
  return Object.keys(await durableRows(fixture.root)).length
}

function execOf(mount: Mount, signal: AbortSignal = SIGNAL): ToolExecutionAuthority {
  return { agent: mount.agent, signal }
}

const wide = (bytes: number): string => '界'.repeat(Math.ceil(bytes / 3))
const refs = (count: number): string[] => Array.from({ length: count }, (_, index) => `ref-${index}`)

/** Seed one legacy v1 note through the REAL current production write path. */
async function seedV1(fixture: WriterFixture, content: string) {
  const mount = fixture.current()
  return await mount.service.add(execOf(mount), content, [`ref-${content}`])
}

function fold(fixture: WriterFixture, mount: Mount): PrivateMemoryNote[] {
  return mount.store.listPage(SCOPE, fixture.teamId, MEMBER, 0, 300).rows
}

describe('M1 self-maintenance writes', () => {
  it('CONTROL: the legacy v1 seed path works on this exact fixture and durable medium today', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    const seeded = await seedV1(fixture, 'original note')
    expect(seeded).toMatchObject({ schemaVersion: 1, seq: 1, memoryId: 'private-memory-1' })
    const durable = (await durableRows(fixture.root))[rowKey(fixture, 1)]
    expect(durable).toMatchObject({ schemaVersion: 1, content: 'original note' })
    expect(fold(fixture, mount).map(row => [row.memoryId, row.content])).toEqual([['private-memory-1', 'original note']])
    const reopened = await fixture.remount()
    expect(reopened.store.listPage(SCOPE, fixture.teamId, MEMBER, 0, 50).rows.map(row => row.content)).toEqual(['original note'])
  })

  it('revises with CAS head and appends exactly ONE strict v2 operation row with Host-derived provenance', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    const seeded = await seedV1(fixture, 'original note')
    expect(seeded).toMatchObject({ schemaVersion: 1, seq: 1 })
    const outcome = await mount.service.maintain(execOf(mount), {
      operation: 'revise', operationId: 'op-revise-1', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'revised note', evidenceRefs: ['ref-r'], tags: ['keep'], applicability: 'when reading',
    })
    expect(outcome).toEqual({
      replayed: false,
      receipt: {
        operationId: 'op-revise-1', operation: 'revise', operationSeq: 2,
        resultMemoryId: 'private-memory-1', headSeq: 2, status: 'active',
      },
    })
    const durable = (await durableRows(fixture.root))[rowKey(fixture, 2)]
    expect(durable).toMatchObject({
      schemaVersion: 2, operation: 'revise', operationId: 'op-revise-1',
      targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'revised note', tags: ['keep'], applicability: 'when reading',
    })
    // No task context exists here: the Host derives the explicit unattributed branch.
    expect(durable!.provenance).toEqual({ kind: 'unattributed' })
    const notes = fold(fixture, mount)
    expect(notes[0]).toMatchObject({ content: 'revised note', tags: ['keep'], applicability: 'when reading', headSeq: 2, status: 'active' })
    expect(notes).toHaveLength(1)
  })

  it('replays a legal retry idempotently: original prefix receipt, zero new rows, stable across a REAL cold reopen', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const retryInput: PrivateMemoryMaintenanceInput = {
      operation: 'revise', operationId: 'op-retry', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'first revision', evidenceRefs: ['ref-a'], tags: [], applicability: '',
    }
    const original = await mount.service.maintain(execOf(mount), retryInput)
    expect(original.receipt).toMatchObject({ operationId: 'op-retry', operationSeq: 2, headSeq: 2, status: 'active' })
    // History advances past the retry with a NEW operation on the same note...
    await mount.service.maintain(execOf(mount), {
      operation: 'revise', operationId: 'op-newer', targetMemoryId: 'private-memory-1', expectedHeadSeq: 2,
      content: 'newer revision', evidenceRefs: ['ref-b'], tags: [], applicability: '',
    })
    // ...so a legal retry of the OLDER operation must answer with the ORIGINAL
    // prefix receipt (old head 2, status AT THE TIME) and append nothing.
    const replay = await mount.service.maintain(execOf(mount), retryInput)
    expect(replay).toEqual({ replayed: true, receipt: original.receipt })
    expect(await countRows(fixture)).toBe(3)
    // A true cold reopen with a fresh Host observation: the retry stays
    // identical (provenance/time/assigned seq are not retry inputs).
    const reopened = await fixture.remount()
    const replayAgain = await reopened.service.maintain(execOf(reopened), retryInput)
    expect(replayAgain).toEqual({ replayed: true, receipt: original.receipt })
    expect(await countRows(fixture)).toBe(3)
    expect(fold(fixture, reopened)[0]).toMatchObject({ content: 'newer revision', headSeq: 3, status: 'active' })
  })

  it('rejects the same operationId carrying different content and leaves zero side effects', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    await mount.service.maintain(execOf(mount), {
      operation: 'revise', operationId: 'op-conflict', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'first revision', evidenceRefs: [], tags: [], applicability: '',
    })
    await expect(mount.service.maintain(execOf(mount), {
      operation: 'revise', operationId: 'op-conflict', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'DIFFERENT content', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_OPERATION_CONFLICT' })
    expect(await countRows(fixture)).toBe(2)
    // The comparison covers the COMPLETE normalized input: the same id with the
    // same content but a different target head is a DIFFERENT logical operation.
    await expect(mount.service.maintain(execOf(mount), {
      operation: 'revise', operationId: 'op-conflict', targetMemoryId: 'private-memory-1', expectedHeadSeq: 99,
      content: 'first revision', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_OPERATION_CONFLICT' })
    expect(await countRows(fixture)).toBe(2)
  })

  it('rejects stale heads, terminal targets and unknown targets with zero side effects', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const exec = execOf(mount)
    await mount.service.maintain(exec, {
      operation: 'revise', operationId: 'op-advance', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'revision one', evidenceRefs: [], tags: [], applicability: '',
    })
    // Same target, stale head (1 is no longer the newest-operation seq; it is 2).
    await expect(mount.service.maintain(exec, {
      operation: 'revise', operationId: 'op-stale', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'lost update', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_HEAD_CONFLICT' })
    // Unknown targets (including ids from another partition/Team) are invisible here.
    await expect(mount.service.maintain(exec, {
      operation: 'revise', operationId: 'op-unknown', targetMemoryId: 'private-memory-99', expectedHeadSeq: 1,
      content: 'nowhere', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_NOT_FOUND' })
    // Terminal notes accept no further operation even with the correct head.
    await mount.service.maintain(exec, { operation: 'invalidate', operationId: 'op-inval', targetMemoryId: 'private-memory-1', expectedHeadSeq: 2 })
    await expect(mount.service.maintain(exec, {
      operation: 'revise', operationId: 'op-after-terminal', targetMemoryId: 'private-memory-1', expectedHeadSeq: 3,
      content: 'revive attempt', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_TERMINAL' })
    expect(await countRows(fixture)).toBe(3) // v1 + advance + invalidate only
    const notes = fold(fixture, mount)
    expect(notes[0]).toMatchObject({ memoryId: 'private-memory-1', seq: 1, status: 'invalidated', headSeq: 3 })
  })

  it('replaces atomically in ONE row: single put, old note superseded IN PLACE, replacement tail-appended', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const putSpy = vi.spyOn(mount.memories, 'put')
    const outcome = await mount.service.maintain(execOf(mount), {
      operation: 'replace', operationId: 'op-replace-1', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'replacement note', evidenceRefs: ['ref-new'], tags: ['replacement'], applicability: 'when replacing',
    })
    expect(outcome.receipt).toMatchObject({
      operationId: 'op-replace-1', operation: 'replace', operationSeq: 2,
      resultMemoryId: 'private-memory-2', headSeq: 2, status: 'active', replacedMemoryId: 'private-memory-1',
    })
    // ONE durable put for the whole logical replace — never two puts pretending atomicity.
    expect(putSpy).toHaveBeenCalledTimes(1)
    putSpy.mockRestore()
    expect(await countRows(fixture)).toBe(2)
    expect((await durableRows(fixture.root))[rowKey(fixture, 2)]).toMatchObject({
      schemaVersion: 2, operation: 'replace',
      targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'replacement note', tags: ['replacement'], applicability: 'when replacing',
    })
    const notes = fold(fixture, mount)
    expect(notes[0]).toMatchObject({ memoryId: 'private-memory-1', seq: 1, status: 'superseded', headSeq: 2, supersededBy: 'private-memory-2' })
    expect(notes[1]).toMatchObject({ memoryId: 'private-memory-2', seq: 2, status: 'active', createdVia: { operation: 'replace', seq: 2 } })
    // The replacement's creation identity and the old note's offset stay stable across reopen.
    const reopened = await fixture.remount()
    expect(fold(fixture, reopened).map(note => [note.memoryId, note.status, note.seq])).toEqual([
      ['private-memory-1', 'superseded', 1],
      ['private-memory-2', 'active', 2],
    ])
  })

  it('keeps legacy production writes v1-only while maintenance add writes one v2 row at max-seq+1', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    const legacy = await seedV1(fixture, 'legacy note')
    expect(legacy).toMatchObject({ schemaVersion: 1, seq: 1 })
    await mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-add-2', content: 'maintained note', evidenceRefs: ['ref-m'], tags: ['m1'], applicability: '',
    })
    // A legacy tool append after maintenance must not collide and stays v1.
    const after = await mount.service.add(execOf(mount), 'later legacy note', [])
    expect(after).toMatchObject({ schemaVersion: 1, seq: 3, memoryId: 'private-memory-3' })
    const rows = await durableRows(fixture.root)
    expect(rows[rowKey(fixture, 2)]).toMatchObject({ schemaVersion: 2, operation: 'add', content: 'maintained note', tags: ['m1'] })
    expect(rows[rowKey(fixture, 3)]!.schemaVersion).toBe(1)
    expect(fold(fixture, mount).map(row => [row.memoryId, row.content])).toEqual([
      ['private-memory-1', 'legacy note'],
      ['private-memory-2', 'maintained note'],
      ['private-memory-3', 'later legacy note'],
    ])
  })

  it('rejects a forged handle carrying the valid member id before any durable effect', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    // A forged handle carrying the valid member id is NOT the registered live Agent.
    await expect(mount.service.maintain({ agent: fakeAgent(MEMBER), signal: SIGNAL }, {
      operation: 'revise', operationId: 'op-forged', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'nope', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    expect(await countRows(fixture)).toBe(1)
  })

  it('aborts a maintenance queued behind the Team fence before its durable side effect (zero rows)', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    const put = mount.memories.put.bind(mount.memories)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const putSpy = vi.spyOn(mount.memories, 'put').mockImplementationOnce(async (key, value) => {
      entered()
      await held
      return put(key, value)
    })
    // An earlier admitted write holds the Team fence; the maintenance queues behind it.
    const predecessor = mount.service.add(execOf(mount), 'committed predecessor', [])
    await started
    const cancellation = new AbortController()
    const queued = mount.service.maintain({ agent: mount.agent, signal: cancellation.signal }, {
      operation: 'add', operationId: 'op-queued', content: 'must not persist', evidenceRefs: [], tags: [], applicability: '',
    }).then(value => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined as unknown, error }))
    try {
      cancellation.abort(new Error('cancel queued maintenance'))
      release()
      await predecessor
      const result = await queued
      expect(result.error).toBeDefined()
      expect(result.value).toBeUndefined()
      expect(putSpy).toHaveBeenCalledTimes(1) // only the predecessor persisted
      expect(mount.store.listPage(SCOPE, fixture.teamId, MEMBER, 0, 50).rows.map(row => row.content)).toEqual(['committed predecessor'])
    } finally {
      release()
      await Promise.allSettled([predecessor, queued])
      putSpy.mockRestore()
    }
  })

  it('appends ONCE for two concurrent legal retries of the same operationId', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const putSpy = vi.spyOn(mount.memories, 'put')
    const input: PrivateMemoryMaintenanceInput = {
      operation: 'revise', operationId: 'op-concurrent', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'one logical write', evidenceRefs: [], tags: [], applicability: '',
    }
    const [first, second] = await Promise.all([
      mount.service.maintain(execOf(mount), input),
      mount.service.maintain(execOf(mount), input),
    ])
    expect(putSpy).toHaveBeenCalledTimes(1) // ONE durable append for the logical operation
    putSpy.mockRestore()
    const fresh = first.replayed ? second : first
    const other = first.replayed ? first : second
    expect(other).toEqual({ replayed: true, receipt: fresh.receipt })
    expect(await countRows(fixture)).toBe(2)
  })

  it('conflicts exactly one of two concurrent CAS attempts on the same head', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const settled = await Promise.allSettled([
      mount.service.maintain(execOf(mount), {
        operation: 'revise', operationId: 'op-race-a', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
        content: 'winner or loser A', evidenceRefs: [], tags: [], applicability: '',
      }),
      mount.service.maintain(execOf(mount), {
        operation: 'revise', operationId: 'op-race-b', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
        content: 'winner or loser B', evidenceRefs: [], tags: [], applicability: '',
      }),
    ])
    const fulfilled = settled.filter(entry => entry.status === 'fulfilled')
    const rejected = settled.filter(entry => entry.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_HEAD_CONFLICT' })
    expect(await countRows(fixture)).toBe(2) // exactly the winner appended
  })

  it('counts ALL historical rows toward capacity, rejects loudly when full, and still replays legal retries first', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    // Fill the partition with legacy rows, then ONE maintenance row reaches the bound.
    for (let index = 1; index <= PRIVATE_MEMORY_MAINTENANCE_MAX_ROWS - 1; index += 1) {
      await mount.store.append(SCOPE, fixture.teamId, MEMBER, `historical note ${index}`, [])
    }
    const last = await mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-last', content: 'final maintenance note', evidenceRefs: [], tags: [], applicability: '',
    })
    expect(await countRows(fixture)).toBe(PRIVATE_MEMORY_MAINTENANCE_MAX_ROWS)
    // Capacity is FULL — yet a legal retry is read back BEFORE the capacity check.
    const replay = await mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-last', content: 'final maintenance note', evidenceRefs: [], tags: [], applicability: '',
    })
    expect(replay).toEqual({ replayed: true, receipt: last.receipt })
    await expect(mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-over-capacity', content: 'one too many', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_CAPACITY' })
    // The capacity is SHARED: the legacy v1 write path is rejected too...
    await expect(mount.service.add(execOf(mount), 'legacy over capacity', [])).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_CAPACITY' })
    // ...and rejection reclaims NOTHING and drifts no seq/offset: the folded
    // history still ends at the maintenance row at the bound.
    expect(await countRows(fixture)).toBe(PRIVATE_MEMORY_MAINTENANCE_MAX_ROWS)
    const notes = fold(fixture, mount)
    expect(notes.at(-1)).toMatchObject({ memoryId: `private-memory-${PRIVATE_MEMORY_MAINTENANCE_MAX_ROWS}`, content: 'final maintenance note' })
  })

  it('admits exactly 64 evidence refs on both write paths, rejects 65 with zero durable effect, and keeps history readable', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    const legacy = await mount.service.add(execOf(mount), 'legacy with full refs', refs(PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS))
    expect(legacy).toMatchObject({ schemaVersion: 1, seq: 1 })
    await mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-full-refs', content: 'maintenance with full refs',
      evidenceRefs: refs(PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS), tags: [], applicability: '',
    })
    await expect(mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-refs-over', content: 'one ref too many',
      evidenceRefs: refs(PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS + 1), tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(mount.service.add(execOf(mount), 'legacy with one ref too many', refs(PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS + 1)))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    expect(await countRows(fixture)).toBe(2)
    expect(fold(fixture, mount)[0]!.evidenceRefs).toHaveLength(PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS)
  })

  it('enforces write-admission thresholds and canonicalizes input without ever touching the medium on rejection', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const exec = execOf(mount)
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: `op-${'x'.repeat(126)}Ω`, content: 'id too long', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: 'op-tags-count', content: 'too many tags', evidenceRefs: [],
      tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`), applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: 'op-tag-bytes', content: 'fat tag', evidenceRefs: [], tags: [wide(129)], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: 'op-applicability', content: 'fat applicability', evidenceRefs: [], tags: [], applicability: wide(2_049),
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: 'op-refs', content: 'too many refs', evidenceRefs: Array.from({ length: PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS + 1 }, (_, index) => `ref-${index}`), tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: 'op-empty-ref', content: 'empty ref', evidenceRefs: ['   '], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })
    expect(await countRows(fixture)).toBe(1) // NOTHING of the above reached the medium
    // Boundary-legal input persists, canonicalized (trim, dedupe, stable order).
    // The operationId bound is EXACTLY 128 UTF-8 bytes, byte-pinned here:
    // 'op-'(3) + 123 ASCII(123) + 'Ω'(2) = 128.
    const boundaryId = `op-${'y'.repeat(123)}Ω`
    const overId = `op-${'y'.repeat(124)}Ω`
    expect(Buffer.byteLength(boundaryId, 'utf8')).toBe(128)
    expect(Buffer.byteLength(overId, 'utf8')).toBe(129)
    await expect(mount.service.maintain(exec, {
      operation: 'add', operationId: overId, content: 'one byte over the id bound', evidenceRefs: [], tags: [], applicability: '',
    })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    expect(await countRows(fixture)).toBe(1)
    await mount.service.maintain(exec, {
      operation: 'add', operationId: boundaryId, content: '  padded  ', evidenceRefs: [' ref '],
      tags: ['β', 'α', 'β'], applicability: '  when folding  ',
    })
    const durable = (await durableRows(fixture.root))[rowKey(fixture, 2)]
    expect(durable).toMatchObject({
      content: 'padded', evidenceRefs: ['ref'], tags: ['α', 'β'], applicability: 'when folding',
    })
  })

  it('derives provenance from the Host Team snapshot: unique running task attributes, the model cannot', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    // No task context yet: explicit unattributed (never an invented task).
    await mount.service.maintain(execOf(mount), {
      operation: 'add', operationId: 'op-no-task', content: 'outside task work', evidenceRefs: [], tags: [], applicability: '',
    })
    // The captain assigns one in-progress task with a running attempt to the member.
    const created = await mount.port.createTask(SCOPE, fixture.teamId, CAPTAIN, {
      subject: 'provenance probe', description: 'attribute one maintenance write', acceptanceCriteria: [],
    })
    const { task: claimed } = await mount.port.claimTask(SCOPE, fixture.teamId, CAPTAIN, created.id, created.revision, MEMBER)
    expect(claimed.currentAttemptId).toBeDefined()
    // A fresh mount observes the durable task facts through membership resolution only.
    const reopened = await fixture.remount()
    const outcome = await reopened.service.maintain(execOf(reopened), {
      operation: 'add', operationId: 'op-in-task', content: 'during task work', evidenceRefs: [], tags: [], applicability: '',
    })
    const inTask = (await durableRows(fixture.root))[rowKey(fixture, 3)]
    const observed = inTask!.provenance as PrivateMemoryProvenance
    expect(observed.kind).toBe('task')
    if (observed.kind === 'task') {
      expect(observed.taskId).toBe(created.id)
      expect(observed.attemptId).toBe(claimed.currentAttemptId)
      expect(observed.teamRevision).toBeGreaterThan(0)
    }
    expect(outcome.receipt.operationSeq).toBe(3)
    // The model CANNOT supply provenance: an extra field is not part of the
    // normalized input and can never reach the durable row.
    const smuggled = {
      operation: 'add', operationId: 'op-smuggle', content: 'smuggled attempt', evidenceRefs: [], tags: [], applicability: '',
      provenance: { kind: 'task', taskId: 'task-forged', teamRevision: 999, observedAt: 1 },
    } as unknown as PrivateMemoryMaintenanceInput
    await reopened.service.maintain(execOf(reopened), smuggled)
    const smuggledRow = (await durableRows(fixture.root))[rowKey(fixture, 4)]
    expect((smuggledRow!.provenance as { taskId?: string }).taskId).not.toBe('task-forged')
  })

  it('rebuilds receipts and normalized requests from the durable prefix on official cold recovery', async () => {
    const fixture = await writerFixture()
    const mount = fixture.current()
    await seedV1(fixture, 'original note')
    const outcome = await mount.service.maintain(execOf(mount), {
      operation: 'replace', operationId: 'op-cold', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'cold replacement', evidenceRefs: ['ref-c'], tags: ['cold'], applicability: '',
    })
    const reopened = await fixture.remount()
    const receipts = reopened.store.operationReceipts(SCOPE, fixture.teamId, MEMBER)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toEqual<PrivateMemoryReceipt>(outcome.receipt)
    const index = reopened.store.operationIndex(SCOPE, fixture.teamId, MEMBER)
    expect(index[0]!.request).toMatchObject({
      operation: 'replace', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'cold replacement', evidenceRefs: ['ref-c'], tags: ['cold'], applicability: '',
    })
  })
})
