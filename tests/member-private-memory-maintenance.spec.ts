/**
 * M1 compat-reader contract spec (task-1, Root-confirmed contract, 2026-09): the
 * medium (ONE unit, version 1, default single) must stay openable and foldable
 * after a future writer appended STRICT v2 maintenance operations. Every phase
 * is a REAL cold reopen over the real official stack (Storage + StorageJson
 * root + StorageDomain 'json'), one fresh Context per phase. Contract under
 * test: strict v1|v2 union with FOUR strict branches (add = complete payload
 * without target/head; revise = FULL replacement; invalidate = no payload;
 * replace = tail-appended), canonical format, folding, createdVia explicitly
 * marked, stable offsets, legacy v1 origin UNKNOWN (ABSENT provenance, never an
 * invented unattributed), production writes v1-only at seq max+1, forged
 * history fail-closed on list, receipt query AND append, and per-operation
 * index entries (minimal prefix receipt + COMPLETE normalized request without
 * Host metadata: operation/target/head participate, provenance/time/seq never
 * do) that are detached and immutable under later history, byte-identical
 * durable rows, opId reuse corruption in one partition / legal across
 * partitions. v1 fixtures go through the REAL write path and v2 fixtures are
 * raw medium writes (exact single-layout document) only after a full close, so
 * a v2 failure is the reader gap, never a fixture error.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemberPrivateMemoryStore,
  PRIVATE_MEMORY_DOMAIN_NAME,
  PRIVATE_MEMORY_EVIDENCE_TRUNCATE,
  privateMemoryDomainSpec,
  type MemberPrivateMemoryRecord,
  type PrivateMemoryOperationIndexEntry,
} from '../src/storage/member-private-memory.js'

const SCOPE = 'scope-maintenance'
const TEAM = 'team-maintenance'
const MEMBER = 'member-session-m1'
const MEMBER_B = 'member-session-m1-b'

/** The exact model-row field set of an untouched legacy v1 note. */
const LEGACY_ROW_KEYS = ['content', 'created_at', 'evidence_refs', 'evidence_refs_truncated', 'memory_id', 'seq']

/** Folded note view the compatible reader must surface. */
interface NoteView {
  readonly memoryId: string
  readonly seq: number
  readonly content: string
  readonly evidenceRefs: readonly string[]
  readonly createdAt: number
  readonly status: 'active' | 'invalidated' | 'superseded'
  readonly headSeq: number
  readonly supersededBy?: string
  readonly provenance?: { kind: 'unattributed' } | { kind: 'task'; taskId: string; attemptId?: string; teamRevision: number; observedAt: number }
  readonly tags?: string[]
  readonly applicability?: string
  readonly createdVia?: { operationId: string; operation: 'add' | 'replace'; seq: number }
}

type RawProvenance =
  | { kind: 'unattributed' }
  | { kind: 'task'; taskId: string; attemptId?: string; teamRevision: number; observedAt: number }

/** One raw v2 operation row exactly as a future writer would persist it. */
interface RawOperation {
  readonly schemaVersion: 2
  readonly operation: 'add' | 'revise' | 'invalidate' | 'replace'
  readonly scope: string
  readonly teamId: string
  readonly memberSessionId: string
  readonly seq: number
  readonly operationId: string
  readonly provenance: RawProvenance
  readonly createdAt: number
  readonly targetMemoryId?: string
  readonly expectedHeadSeq?: number
  readonly content?: string
  readonly evidenceRefs?: readonly string[]
  readonly tags?: readonly string[]
  readonly applicability?: string
  // Only for wrong-branch/unknown-field FOREIGN fixtures (spread verbatim).
  readonly [foreign: string]: unknown
}

/** The exact single-layout unit document the JSON backend serializes. */
interface RawUnit {
  unit: { name: string; version: number }
  global: unknown
  tables: { memories: Record<string, unknown> }
}

function unitPath(root: string): string {
  return join(root, `${PRIVATE_MEMORY_DOMAIN_NAME}.json`)
}

async function readUnit(root: string): Promise<RawUnit> {
  return JSON.parse(await readFile(unitPath(root), 'utf8')) as RawUnit
}

async function writeUnit(root: string, doc: RawUnit): Promise<void> {
  await writeFile(unitPath(root), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

function memoryKey(seq: number, member: string = MEMBER): string {
  return JSON.stringify([SCOPE, TEAM, member, seq])
}

function taskProvenance(marker: string): RawProvenance {
  return { kind: 'task', taskId: `task-m1-${marker}`, attemptId: `attempt-m1-${marker}`, teamRevision: 7, observedAt: 900 }
}

interface FixtureMeta extends Record<string, unknown> {
  readonly refs?: readonly string[]
  readonly tags?: readonly string[]
  readonly applicability?: string
  readonly provenance?: RawProvenance
  readonly member?: string
}

/** Canonical defaults: trimmed content, canonical (unique, sorted) tags, unconditional. */
function buildOperation(
  operation: RawOperation['operation'],
  seq: number,
  operationId: string,
  payload: { content: string } | undefined,
  target: { targetMemoryId: string; expectedHeadSeq: number } | undefined,
  meta: FixtureMeta = {},
): [string, RawOperation] {
  const { refs = [`ref-${operationId}`], tags = [], applicability = '', provenance = taskProvenance(operationId), member = MEMBER, ...foreign } = meta
  const row: RawOperation = {
    schemaVersion: 2,
    operation,
    scope: SCOPE,
    teamId: TEAM,
    memberSessionId: member,
    seq,
    operationId,
    provenance,
    createdAt: 100 + seq,
    ...(target === undefined ? {} : target),
    ...(payload === undefined ? {} : {
      content: payload.content,
      evidenceRefs: refs,
      tags,
      applicability,
    }),
    ...foreign,
  }
  return [memoryKey(seq, member), row]
}

const opAdd = (seq: number, id: string, content: string, meta: FixtureMeta = {}) =>
  buildOperation('add', seq, id, { content }, undefined, meta)
const opRevise = (seq: number, id: string, target: string, head: number, content: string, meta: FixtureMeta = {}) =>
  buildOperation('revise', seq, id, { content }, { targetMemoryId: target, expectedHeadSeq: head }, meta)
const opInvalidate = (seq: number, id: string, target: string, head: number, meta: FixtureMeta = {}) =>
  buildOperation('invalidate', seq, id, undefined, { targetMemoryId: target, expectedHeadSeq: head }, meta)
const opReplace = (seq: number, id: string, target: string, head: number, content: string, meta: FixtureMeta = {}) =>
  buildOperation('replace', seq, id, { content }, { targetMemoryId: target, expectedHeadSeq: head }, meta)

interface Session {
  readonly ctx: Context
  readonly root: string
  readonly domain: Domain<typeof privateMemoryDomainSpec>
  readonly store: MemberPrivateMemoryStore
  close(): Promise<void>
}

/** Cold-mount the REAL official stack over `root` and open the store. */
async function coldOpen(root: string): Promise<Session> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  let domain: Domain<typeof privateMemoryDomainSpec> | undefined
  try {
    fibers.push(await ctx.plugin(Storage))
    fibers.push(await ctx.plugin(StorageJson, { root }))
    fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
    domain = await ctx.storageDomain.open(privateMemoryDomainSpec)
  } catch (error) {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    throw error
  }
  const store = new MemberPrivateMemoryStore(ctx, domain)
  return {
    ctx,
    root,
    domain,
    store,
    async close() {
      store.close()
      await domain!.close()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    },
  }
}

const openSessions: Session[] = []
const sandboxes: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-private-memory-m1-'))
  sandboxes.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map(session => session.close()))
  await Promise.all(sandboxes.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

function foldedRows(store: MemberPrivateMemoryStore, member: string = MEMBER, cursor = 0, limit = 50): {
  rows: NoteView[]; nextCursor?: number
} {
  const page = store.listPage(SCOPE, TEAM, member, cursor, limit)
  return { rows: page.rows as unknown as NoteView[], ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
}

const asView = (note: NoteView): MemberPrivateMemoryRecord => note as unknown as MemberPrivateMemoryRecord

/** Seed three legacy v1 notes through the REAL production write path. */
async function seedThreeNotes(session: Session): Promise<void> {
  for (const content of ['note one', 'note two', 'note three']) {
    await session.store.append(SCOPE, TEAM, MEMBER, content, [`ref-${content}`])
  }
}

/** Seed, fully close, then raw-append v2 fixture rows in ONE medium write. */
async function seedThenForge(root: string, first: Session, rows: ReadonlyArray<readonly [string, RawOperation]>): Promise<void> {
  await first.close()
  openSessions.pop()
  const unit = await readUnit(root)
  for (const [key, row] of rows) unit.tables.memories[key] = row
  await writeUnit(root, unit)
}

describe('M1 compat reader over strict v2 maintenance operations (Root-confirmed contract)', () => {
  it('keeps a legacy v1-only medium (incl. 64-ref rows) readable across a real cold reopen in the exact historical row shape', async () => {
    const root = await freshRoot()
    const first = await coldOpen(root)
    openSessions.push(first)
    await seedThreeNotes(first)
    // Legacy legal many-evidenceRef rows go through the REAL write path.
    await first.store.append(SCOPE, TEAM, MEMBER, 'legacy big-evidence note',
      Array.from({ length: 64 }, (_value, index) => `legacy-ref-${index + 1}`))
    const written = await readUnit(root)
    expect(Object.values(written.tables.memories).every(row => (row as MemberPrivateMemoryRecord).schemaVersion === 1)).toBe(true)
    await first.close()
    openSessions.pop()

    const second = await coldOpen(root)
    openSessions.push(second)
    const page = foldedRows(second.store)
    expect(page.rows.map(row => [row.memoryId, row.content, row.seq])).toEqual([
      ['private-memory-1', 'note one', 1],
      ['private-memory-2', 'note two', 2],
      ['private-memory-3', 'note three', 3],
      ['private-memory-4', 'legacy big-evidence note', 4],
    ])
    // Future writer bounds never retro-bind old rows; the model face truncates.
    expect(page.rows[3]!.evidenceRefs).toHaveLength(64)
    expect(Object.keys(MemberPrivateMemoryStore.row(asView(page.rows[0]!))).sort()).toEqual(LEGACY_ROW_KEYS)
    const bigRow = MemberPrivateMemoryStore.row(asView(page.rows[3]!))
    expect(bigRow.evidence_refs).toHaveLength(PRIVATE_MEMORY_EVIDENCE_TRUNCATE)
    expect(bigRow.evidence_refs_truncated).toBe(true)
    expect(Object.keys(bigRow).sort()).toEqual(LEGACY_ROW_KEYS)
  })

  it('folds all four v2 branches with metadata, explicit creation origin, and unknown-vs-unattributed provenance', async () => {
    const root = await freshRoot()
    const first = await coldOpen(root)
    openSessions.push(first)
    await seedThreeNotes(first)
    await seedThenForge(root, first, [
      // An EXPLICIT unattributed v2 add — distinct from the UNKNOWN v1 origin.
      opAdd(4, 'op-add-4', 'added note', { refs: ['ref-add'], tags: ['alpha', 'beta'], applicability: '', provenance: { kind: 'unattributed' } }),
      opRevise(5, 'op-revise-5', 'private-memory-1', 1, 'revised one', { refs: ['ref-note one', 'ref-revision'], tags: ['m1'], applicability: 'when reading' }),
      opInvalidate(6, 'op-inval-6', 'private-memory-2', 2),
      opReplace(7, 'op-replace-7', 'private-memory-3', 3, 'replaced three'),
    ])

    const second = await coldOpen(root)
    openSessions.push(second)
    const page = foldedRows(second.store)
    // Creation order preserved; add/replace notes at their operation position;
    // terminal rows keep offsets; operations are never extra notes.
    expect(page.rows.map(row => [row.memoryId, row.content, row.status])).toEqual([
      ['private-memory-1', 'revised one', 'active'],
      ['private-memory-2', 'note two', 'invalidated'],
      ['private-memory-3', 'note three', 'superseded'],
      ['private-memory-4', 'added note', 'active'],
      ['private-memory-7', 'replaced three', 'active'],
    ])
    expect(page.rows[0]!.headSeq).toBe(5)
    expect(page.rows[1]!.headSeq).toBe(6)
    expect(page.rows[2]!.supersededBy).toBe('private-memory-7')
    // Revise is a FULL replacement: refs/tags/applicability all come from the op.
    expect(page.rows[0]!.tags).toEqual(['m1'])
    expect(page.rows[0]!.applicability).toBe('when reading')
    expect(page.rows[0]!.evidenceRefs).toEqual(['ref-note one', 'ref-revision'])
    // Explicit v2 creation origin — never inferred from status/headSeq.
    expect(page.rows[3]!.createdVia).toEqual({ operationId: 'op-add-4', operation: 'add', seq: 4 })
    expect(page.rows[4]!.createdVia).toEqual({ operationId: 'op-replace-7', operation: 'replace', seq: 7 })
    // UNKNOWN v1 origin stays absent (no invented unattributed), even after the
    // note was later invalidated/superseded; the OLD superseded payload origin
    // is unknown while the NEW replace note keeps its v2 provenance.
    expect(page.rows[1]!.provenance).toBeUndefined()
    expect(page.rows[2]!.provenance).toBeUndefined()
    expect(page.rows[0]!.provenance).toEqual({ kind: 'task', taskId: 'task-m1-op-revise-5', attemptId: 'attempt-m1-op-revise-5', teamRevision: 7, observedAt: 900 })
    expect(page.rows[3]!.provenance).toEqual({ kind: 'unattributed' })
    expect(page.rows[4]!.provenance).toEqual({ kind: 'task', taskId: 'task-m1-op-replace-7', attemptId: 'attempt-m1-op-replace-7', teamRevision: 7, observedAt: 900 })
    // Reading never writes: durable rows are untouched.
    const durableAfterRead = await readUnit(root)
    expect((durableAfterRead.tables.memories[memoryKey(1)] as MemberPrivateMemoryRecord).schemaVersion).toBe(1)

    // Pagination follows the folded creation order with stable offsets.
    const window = second.store.listPage(SCOPE, TEAM, MEMBER, 0, 3)
    expect(window.nextCursor).toBe(3)
    expect((window.rows as unknown as NoteView[]).map(row => row.memoryId)).toEqual([
      'private-memory-1', 'private-memory-2', 'private-memory-3',
    ])
    const rest = second.store.listPage(SCOPE, TEAM, MEMBER, 3, 3)
    expect((rest.rows as unknown as NoteView[]).map(row => row.memoryId)).toEqual(['private-memory-4', 'private-memory-7'])

    // Strict model row: a v2-created ACTIVE note whose headSeq equals seq keeps
    // metadata/provenance; unknown-origin rows fabricate nothing.
    const addRow = MemberPrivateMemoryStore.row(asView(page.rows[3]!))
    expect(addRow).toMatchObject({
      memory_id: 'private-memory-4', status: 'active', head_seq: 4,
      tags: ['alpha', 'beta'], applicability: '',
      created_via: { operation_id: 'op-add-4', operation: 'add', seq: 4 },
      provenance: { kind: 'unattributed' },
    })
    const invalidatedRow = MemberPrivateMemoryStore.row(asView(page.rows[1]!))
    expect(invalidatedRow).toMatchObject({ memory_id: 'private-memory-2', status: 'invalidated', head_seq: 6 })
    expect(invalidatedRow.provenance).toBeUndefined()
    expect(invalidatedRow.tags).toBeUndefined()
    expect(invalidatedRow.applicability).toBeUndefined()
    const supersededRow = MemberPrivateMemoryStore.row(asView(page.rows[2]!))
    expect(supersededRow).toMatchObject({ memory_id: 'private-memory-3', status: 'superseded', head_seq: 7, superseded_by: 'private-memory-7' })
    expect(supersededRow.provenance).toBeUndefined()
    const revisedRow = MemberPrivateMemoryStore.row(asView(page.rows[0]!))
    expect(revisedRow.provenance).toEqual({ kind: 'task', task_id: 'task-m1-op-revise-5', attempt_id: 'attempt-m1-op-revise-5', team_revision: 7, observed_at: 900 })
  })

  it('assigns legacy appends a collision-free seq over all physical operations and still writes only v1', async () => {
    const root = await freshRoot()
    const first = await coldOpen(root)
    openSessions.push(first)
    await seedThreeNotes(first)
    await seedThenForge(root, first, [
      opRevise(4, 'op-revise-4', 'private-memory-1', 1, 'revised one', { tags: ['keep'] }),
    ])

    const second = await coldOpen(root)
    openSessions.push(second)
    // Next seq = max over ALL physical rows (3 notes + op at 4) + 1 = 5, never 4.
    const appended = await second.store.append(SCOPE, TEAM, MEMBER, 'legacy append after maintenance', [])
    expect(appended).toMatchObject({ seq: 5, memoryId: 'private-memory-5', schemaVersion: 1 })
    const durable = await readUnit(root)
    expect(durable.tables.memories[memoryKey(5)]).toMatchObject({ schemaVersion: 1, seq: 5, content: 'legacy append after maintenance' })

    // v1 -> v2 operations -> compat-package v1 append survives ANOTHER cold reopen.
    await second.close()
    openSessions.pop()
    const third = await coldOpen(root)
    openSessions.push(third)
    const page = foldedRows(third.store)
    expect(page.rows.map(row => [row.memoryId, row.content, row.status])).toEqual([
      ['private-memory-1', 'revised one', 'active'],
      ['private-memory-2', 'note two', 'active'],
      ['private-memory-3', 'note three', 'active'],
      ['private-memory-5', 'legacy append after maintenance', 'active'],
    ])
    expect(page.rows[0]!.headSeq).toBe(4)
  })

  it('fails closed on a forged but schema-valid history on list, receipts, AND append (never list-only)', async () => {
    const forgeries: Array<{ label: string; rows: ReadonlyArray<readonly [string, RawOperation]>; pattern: RegExp }> = [
      { label: 'wrong expectedHeadSeq', rows: [opRevise(4, 'op-forged-head', 'private-memory-1', 99, 'forged')], pattern: /private-memory-1|op-forged-head/ },
      { label: 'unknown target', rows: [opInvalidate(4, 'op-forged-target', 'private-memory-77', 1)], pattern: /private-memory-77|op-forged-target/ },
      { label: 'operation on a terminal note', rows: [opInvalidate(4, 'op-term-pre', 'private-memory-2', 2), opRevise(5, 'op-forged-terminal', 'private-memory-2', 4, 'revive')], pattern: /private-memory-2|op-forged-terminal/ },
      // Physical id reuse in one partition is corruption EVEN with identical
      // normalized input and only differing provenance (index = stable id only).
      {
        label: 'reused operationId',
        rows: [
          opRevise(4, 'op-dup', 'private-memory-1', 1, 'same', { provenance: taskProvenance('a') }),
          opRevise(5, 'op-dup', 'private-memory-2', 2, 'same', { provenance: taskProvenance('b') }),
        ],
        pattern: /op-dup/,
      },
      { label: 'non-canonical tags order', rows: [opRevise(4, 'op-forged-tags', 'private-memory-1', 1, 'ok', { tags: ['b', 'a'] })], pattern: /op-forged-tags/ },
      { label: 'non-canonical content', rows: [opRevise(4, 'op-forged-content', 'private-memory-1', 1, ' padded ')], pattern: /op-forged-content/ },
    ]
    for (const forgery of forgeries) {
      const root = await freshRoot()
      const first = await coldOpen(root)
      openSessions.push(first)
      await seedThreeNotes(first)
      await seedThenForge(root, first, forgery.rows)

      const second = await coldOpen(root)
      openSessions.push(second)
      // Fail closed at list: a coded integrity error naming the offending op/note.
      expect(() => second.store.listPage(SCOPE, TEAM, MEMBER, 0, 50), forgery.label)
        .toThrow(expect.objectContaining({ code: 'TEAM_PRIVATE_MEMORY_TAMPERED', message: expect.stringMatching(forgery.pattern) }))
      // Fail closed at the internal receipt query as well.
      expect(() => second.store.operationReceipts(SCOPE, TEAM, MEMBER), forgery.label)
        .toThrow(expect.objectContaining({ code: 'TEAM_PRIVATE_MEMORY_TAMPERED' }))
      // Fail closed at append too — never only at list time.
      await expect(second.store.append(SCOPE, TEAM, MEMBER, 'should never land', []), forgery.label)
        .rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_TAMPERED' })
      // The rejected append left nothing durable.
      const durable = await readUnit(root)
      expect(Object.keys(durable.tables.memories), forgery.label).toHaveLength(3 + forgery.rows.length)
    }
  })

  it('rejects wrong-branch / unknown-field / incomplete-payload rows at domain open, and proves cross-partition ids are legal', async () => {
    const incomplete: [string, RawOperation] = (() => {
      const [key, row] = opRevise(4, 'op-foreign-3', 'private-memory-1', 1, 'x')
      const { applicability: _applicability, ...rest } = row as RawOperation & { applicability?: string }
      return [key, rest as unknown as RawOperation]
    })()
    const foreigns: Array<{ label: string; row: [string, RawOperation] }> = [
      { label: 'add carrying a target', row: opAdd(4, 'op-foreign-1', 'x', { targetMemoryId: 'private-memory-1' }) },
      { label: 'unknown field', row: opRevise(4, 'op-foreign-2', 'private-memory-1', 1, 'x', { modelNotes: 'nope' }) },
      { label: 'incomplete payload', row: incomplete },
      { label: 'unknown provenance kind', row: opAdd(4, 'op-foreign-4', 'x', { provenance: { kind: 'model', model: 'gpt' } as unknown as RawProvenance }) },
    ]
    for (const foreign of foreigns) {
      const root = await freshRoot()
      const first = await coldOpen(root)
      openSessions.push(first)
      await seedThreeNotes(first)
      await seedThenForge(root, first, [foreign.row])
      // The strict union rejects the FOREIGN row at domain open (medium-level
      // rejection — a conforming reader never sees the row at all).
      await expect(coldOpen(root), foreign.label).rejects.toThrow()
    }

    // The SAME operationId in a DIFFERENT member partition is legal and folds
    // independently (normalized-input/provenance separation across partitions).
    const root = await freshRoot()
    const first = await coldOpen(root)
    openSessions.push(first)
    await seedThreeNotes(first)
    await first.store.append(SCOPE, TEAM, MEMBER_B, 'b note', [])
    await seedThenForge(root, first, [
      opRevise(4, 'op-shared', 'private-memory-1', 1, 'shared revise', { provenance: taskProvenance('a') }),
      opRevise(2, 'op-shared', 'private-memory-1', 1, 'shared revise', { member: MEMBER_B, provenance: taskProvenance('b'), createdAt: 999 }),
    ])

    const second = await coldOpen(root)
    openSessions.push(second)
    const rowsA = foldedRows(second.store)
    const rowsB = foldedRows(second.store, MEMBER_B)
    expect(rowsA.rows.map(row => [row.memoryId, row.content])).toEqual([
      ['private-memory-1', 'shared revise'],
      ['private-memory-2', 'note two'],
      ['private-memory-3', 'note three'],
    ])
    expect(rowsB.rows.map(row => [row.memoryId, row.content])).toEqual([['private-memory-1', 'shared revise']])
    // Each partition indexes its OWN op under the shared stable id, folded
    // independently and input-separated.
    const indexA = second.store.operationIndex(SCOPE, TEAM, MEMBER)
    const indexB = second.store.operationIndex(SCOPE, TEAM, MEMBER_B)
    expect(indexA.map(entry => entry.receipt.operationId)).toEqual(['op-shared'])
    expect(indexB.map(entry => entry.receipt.operationId)).toEqual(['op-shared'])
    // Host provenance/time/assigned seq differ per partition...
    expect(indexA[0]!.receipt.operationSeq).toBe(4)
    expect(indexB[0]!.receipt.operationSeq).toBe(2)
    // ...yet the NORMALIZED MODEL REQUEST is identical (identity never follows
    // Host metadata across re-observations).
    expect(indexA[0]!.request).toEqual(indexB[0]!.request)
    expect(indexA[0]!.request).toEqual({
      operation: 'revise', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'shared revise', evidenceRefs: ['ref-op-shared'], tags: [], applicability: '',
    })
  })

  it('derives detached operation index entries (minimal receipts + complete normalized requests) from each operation history prefix', async () => {
    const root = await freshRoot()
    const first = await coldOpen(root)
    openSessions.push(first)
    await seedThreeNotes(first)
    await seedThenForge(root, first, [
      opAdd(4, 'op-add-4', 'added note', { refs: ['ref-add'], tags: ['alpha', 'beta'], provenance: { kind: 'unattributed' } }),
      opRevise(5, 'op-receipt-5', 'private-memory-1', 1, 'revised one', { refs: ['ref-r5'], tags: ['receipt'] }),
      opInvalidate(6, 'op-inval-6', 'private-memory-2', 2),
      opReplace(7, 'op-replace-7', 'private-memory-3', 3, 'replaced three'),
    ])
    const receiptFixture = JSON.parse(JSON.stringify((await readUnit(root)).tables.memories[memoryKey(5)])) as RawOperation

    const second = await coldOpen(root)
    openSessions.push(second)
    const index = second.store.operationIndex(SCOPE, TEAM, MEMBER)
    // One entry per operation: minimal prefix receipt + COMPLETE normalized request.
    expect(index).toEqual([
      {
        receipt: { operationId: 'op-add-4', operation: 'add', operationSeq: 4, resultMemoryId: 'private-memory-4', headSeq: 4, status: 'active' },
        request: { operation: 'add', content: 'added note', evidenceRefs: ['ref-add'], tags: ['alpha', 'beta'], applicability: '' },
      },
      {
        receipt: { operationId: 'op-receipt-5', operation: 'revise', operationSeq: 5, resultMemoryId: 'private-memory-1', headSeq: 5, status: 'active' },
        request: { operation: 'revise', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1, content: 'revised one', evidenceRefs: ['ref-r5'], tags: ['receipt'], applicability: '' },
      },
      {
        receipt: { operationId: 'op-inval-6', operation: 'invalidate', operationSeq: 6, resultMemoryId: 'private-memory-2', headSeq: 6, status: 'invalidated' },
        request: { operation: 'invalidate', targetMemoryId: 'private-memory-2', expectedHeadSeq: 2 },
      },
      {
        receipt: { operationId: 'op-replace-7', operation: 'replace', operationSeq: 7, resultMemoryId: 'private-memory-7', headSeq: 7, status: 'active', replacedMemoryId: 'private-memory-3' },
        request: { operation: 'replace', targetMemoryId: 'private-memory-3', expectedHeadSeq: 3, content: 'replaced three', evidenceRefs: ['ref-op-replace-7'], tags: [], applicability: '' },
      },
    ] satisfies PrivateMemoryOperationIndexEntry[])
    // Host metadata (provenance/time) never leaks into either side of an entry.
    expect(JSON.stringify(index)).not.toContain('provenance')
    expect(JSON.stringify(index)).not.toContain('task-m1-')
    expect(JSON.stringify(index)).not.toContain('observedAt')

    // Caller mutation of a returned entry reaches neither the next query, the
    // fold, nor the durable rows.
    const mutable = index[1]! as unknown as { request: { content: string; evidenceRefs: string[]; tags: string[] } }
    mutable.request.content = 'CALLER-MUTATED'
    mutable.request.evidenceRefs.push('ghost')
    mutable.request.tags.push('ghost-tag')
    const refetched = second.store.operationIndex(SCOPE, TEAM, MEMBER)
    expect(refetched[1]!.request).toEqual({
      operation: 'revise', targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
      content: 'revised one', evidenceRefs: ['ref-r5'], tags: ['receipt'], applicability: '',
    })

    await second.close()
    openSessions.pop()

    // Preserve the prefix medium verbatim, then let history advance PAST it.
    const prefixBytes = await readFile(unitPath(root), 'utf8')
    const prefixUnit = JSON.parse(prefixBytes) as RawUnit
    const advanced = await readUnit(root)
    advanced.tables.memories[memoryKey(8)] = opInvalidate(8, 'op-later-8', 'private-memory-1', 5)[1]
    await writeUnit(root, advanced)

    const third = await coldOpen(root)
    openSessions.push(third)
    const laterIndex = third.store.operationIndex(SCOPE, TEAM, MEMBER)
    // The earlier revise entry is byte-identical to its prefix value: a later
    // invalidate never rewrites an earlier entry (status AT its own prefix).
    expect(laterIndex[1]).toEqual(refetched[1])
    expect(laterIndex[1]!.receipt.status).toBe('active')
    expect(laterIndex[4]!.receipt).toMatchObject({ operationId: 'op-later-8', operation: 'invalidate', resultMemoryId: 'private-memory-1', headSeq: 8, status: 'invalidated' })
    expect(laterIndex[4]!.request).toEqual({ operation: 'invalidate', targetMemoryId: 'private-memory-1', expectedHeadSeq: 5 })
    // The durable operation row itself is byte-identical after later operations.
    expect(JSON.parse(JSON.stringify((await readUnit(root)).tables.memories[memoryKey(5)]))).toEqual(receiptFixture)
    // Fold state agrees: the revised note is now invalidated with head 8.
    expect(foldedRows(third.store).rows[0]).toMatchObject({ content: 'revised one', status: 'invalidated', headSeq: 8 })

    // A true cold reopen of the ORIGINAL PREFIX medium rebuilds the original
    // receipt state exactly: later history cannot change the past.
    const prefixRoot = await freshRoot()
    await writeUnit(prefixRoot, prefixUnit)
    const prefixAgain = await coldOpen(prefixRoot)
    openSessions.push(prefixAgain)
    const rebuilt = prefixAgain.store.operationIndex(SCOPE, TEAM, MEMBER)
    expect(rebuilt[1]!.receipt).toMatchObject({ operationId: 'op-receipt-5', headSeq: 5, status: 'active' })
    expect(rebuilt).toHaveLength(4)
    expect(foldedRows(prefixAgain.store).rows[0]).toMatchObject({ content: 'revised one', headSeq: 5, status: 'active' })
  })

  it('keeps the normalized request complete: branch, target and head are compared; Host metadata never is', async () => {
    const root = await freshRoot()
    const first = await coldOpen(root)
    openSessions.push(first)
    await seedThreeNotes(first)
    await seedThenForge(root, first, [
      opRevise(4, 'op-same-payload-a', 'private-memory-1', 1, 'same', { refs: ['r'] }),
      opRevise(5, 'op-same-payload-b', 'private-memory-2', 2, 'same', { refs: ['r'] }),
      opRevise(6, 'op-same-payload-c', 'private-memory-1', 4, 'same', { refs: ['r'] }),
      opInvalidate(7, 'op-inval-7', 'private-memory-2', 5),
    ])
    const second = await coldOpen(root)
    openSessions.push(second)
    const [reqA, reqB, reqC, reqInv] = second.store.operationIndex(SCOPE, TEAM, MEMBER).map(entry => entry.request)
    // Same payload, different target => different normalized request.
    expect(reqA).not.toEqual(reqB)
    // Same payload AND same target, different expectedHeadSeq => different request.
    expect(reqA).not.toEqual(reqC)
    // invalidate (no payload) stays comparable: exactly operation + target + head.
    expect(Object.keys(reqInv!).sort()).toEqual(['expectedHeadSeq', 'operation', 'targetMemoryId'])
    expect(reqInv).toEqual({ operation: 'invalidate', targetMemoryId: 'private-memory-2', expectedHeadSeq: 5 })
    // The operation branch itself participates in the comparison.
    expect(reqInv).not.toEqual({ ...reqB, operation: 'invalidate' })
  })
})
