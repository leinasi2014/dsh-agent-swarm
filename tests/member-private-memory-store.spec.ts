/**
 * Store-level contract tests for `MemberPrivateMemoryStore` (2026-08-26):
 * schema, member-local ordering/id monotonicity, pagination, scope isolation,
 * cross-member isolation, evidence truncation, invalid input, flush/write-failure
 * non-pollution, close behavior, and tamper resistance. These run directly over
 * the real official storage-domain stack with an injected medium — no LLM, no
 * Team aggregate, no agents.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemberPrivateMemoryStore,
  PRIVATE_MEMORY_EVIDENCE_TRUNCATE,
  type MemberPrivateMemoryRecord,
} from '../src/storage/member-private-memory.js'
import { privateMemoryDomainSpec } from '../src/storage/member-private-memory.js'
import { FaultableBackend } from './helpers/storage-stack.js'

const SCOPE_A = 'scope-a'
const SCOPE_B = 'scope-b'
const TEAM = 'team-isolated'
const TEAM_2 = 'team-other'
const MEMBER = 'member-session-abc'
const MEMBER_2 = 'member-session-def'

interface Mounted {
  readonly ctx: Context
  readonly domain: Domain<typeof privateMemoryDomainSpec>
  readonly store: MemberPrivateMemoryStore
  readonly backend: FaultableBackend
  close(): Promise<void>
}

async function mount(failNextWrites = 0): Promise<Mounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const backend = new FaultableBackend()
  backend.failNextWrites = failNextWrites
  fibers.push(await ctx.plugin(Storage))
  ctx.storage.backend.register('faultable', backend)
  ctx.provide(storageBackendServiceKey('faultable'), backend)
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'faultable' }))
  const domain = await ctx.storageDomain.open(privateMemoryDomainSpec)
  const store = new MemberPrivateMemoryStore(ctx, domain)
  return {
    ctx,
    domain,
    store,
    backend,
    async close() {
      store.close()
      await domain.close()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    },
  }
}

const mounted: Mounted[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map(instance => instance.close()))
})

describe('MemberPrivateMemoryStore contract', () => {
  it('appends records in member-local creation order with monotonic seq and id', async () => {
    const instance = await mount()
    mounted.push(instance)
    const a = await instance.store.append(SCOPE_A, TEAM, MEMBER, 'first note', ['ref-1'])
    const b = await instance.store.append(SCOPE_A, TEAM, MEMBER, 'second note', [])
    expect(a).toMatchObject({ seq: 1, memoryId: 'private-memory-1', content: 'first note', teamId: TEAM, memberSessionId: MEMBER, scope: SCOPE_A, schemaVersion: 1 })
    expect(b).toMatchObject({ seq: 2, memoryId: 'private-memory-2', content: 'second note' })
    const page = instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50)
    expect(page.rows.map(row => row.memoryId)).toEqual(['private-memory-1', 'private-memory-2'])
    expect(page.nextCursor).toBeUndefined()
  })

  it('paginates by stable creation offset with next_cursor', async () => {
    const instance = await mount()
    mounted.push(instance)
    for (let index = 1; index <= 5; index += 1) {
      await instance.store.append(SCOPE_A, TEAM, MEMBER, `note-${index}`, [])
    }
    const first = instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 2)
    expect(first.rows.map(row => row.memoryId)).toEqual(['private-memory-1', 'private-memory-2'])
    expect(first.nextCursor).toBe(2)
    const second = instance.store.listPage(SCOPE_A, TEAM, MEMBER, first.nextCursor!, 2)
    expect(second.rows.map(row => row.memoryId)).toEqual(['private-memory-3', 'private-memory-4'])
    expect(second.nextCursor).toBe(4)
    const third = instance.store.listPage(SCOPE_A, TEAM, MEMBER, second.nextCursor!, 2)
    expect(third.rows.map(row => row.memoryId)).toEqual(['private-memory-5'])
    expect(third.nextCursor).toBeUndefined()
  })

  it('isolates by workspace scope even for identical Team + member ids', async () => {
    const instance = await mount()
    mounted.push(instance)
    // Same durable Team + member identity in two different scopes must not mix.
    await instance.store.append(SCOPE_A, TEAM, MEMBER, 'scope-a note', [])
    await instance.store.append(SCOPE_B, TEAM, MEMBER, 'scope-b note', [])
    await instance.store.append(SCOPE_A, TEAM, MEMBER, 'scope-a second', [])
    const onlyA = instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50)
    const onlyB = instance.store.listPage(SCOPE_B, TEAM, MEMBER, 0, 50)
    expect(onlyA.rows.map(row => row.content)).toEqual(['scope-a note', 'scope-a second'])
    expect(onlyB.rows.map(row => row.content)).toEqual(['scope-b note'])
    // Member-local seq restarts independently per scope partition.
    expect(onlyA.rows.map(row => row.seq)).toEqual([1, 2])
    expect(onlyB.rows.map(row => row.seq)).toEqual([1])
  })

  it('isolates different members and different Teams within one scope', async () => {
    const instance = await mount()
    mounted.push(instance)
    await instance.store.append(SCOPE_A, TEAM, MEMBER, 'member-1 note', [])
    await instance.store.append(SCOPE_A, TEAM, MEMBER_2, 'member-2 note', [])
    await instance.store.append(SCOPE_A, TEAM_2, MEMBER, 'other-team note', [])
    expect(instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50).rows.map(row => row.content)).toEqual(['member-1 note'])
    expect(instance.store.listPage(SCOPE_A, TEAM, MEMBER_2, 0, 50).rows.map(row => row.content)).toEqual(['member-2 note'])
    expect(instance.store.listPage(SCOPE_A, TEAM_2, MEMBER, 0, 50).rows.map(row => row.content)).toEqual(['other-team note'])
  })

  it('truncates the evidence-reference list to the contractual bound on the model face', async () => {
    const instance = await mount()
    mounted.push(instance)
    const refs = Array.from({ length: PRIVATE_MEMORY_EVIDENCE_TRUNCATE + 5 }, (_value, index) => `ref-${index + 1}`)
    const record = await instance.store.append(SCOPE_A, TEAM, MEMBER, 'note', refs)
    const row = MemberPrivateMemoryStore.row(record)
    expect(row.evidence_refs).toHaveLength(PRIVATE_MEMORY_EVIDENCE_TRUNCATE)
    expect(row.evidence_refs_truncated).toBe(true)
    expect(row.evidence_refs[0]).toBe('ref-1')
    expect(row.evidence_refs.at(-1)).toBe(`ref-${PRIVATE_MEMORY_EVIDENCE_TRUNCATE}`)
    // Untruncated refs stay untruncated on the model face.
    const small = await instance.store.append(SCOPE_A, TEAM, MEMBER, 'small', ['one'])
    expect(MemberPrivateMemoryStore.row(small).evidence_refs_truncated).toBe(false)
  })

  it('rejects empty content and over-long content at the shared input-vocabulary boundary', async () => {
    const instance = await mount()
    mounted.push(instance)
    await expect(instance.store.append(SCOPE_A, TEAM, MEMBER, '   ', []))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })
    await expect(instance.store.append(SCOPE_A, TEAM, MEMBER, 'x'.repeat(16_385), []))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(instance.store.append(SCOPE_A, TEAM, MEMBER, 'note', ['']))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })
    await expect(instance.store.append(SCOPE_A, TEAM, MEMBER, 'note', ['r'.repeat(2_049)]))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    // A rejected append must not pollute the partition: still empty.
    expect(instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50).rows).toEqual([])
  })

  it('fails a flush/append loudly when the medium rejects the write, leaving no partial state', async () => {
    const instance = await mount(1) // fail the next durable write
    mounted.push(instance)
    // The put is queued on the domain write chain and awaits backend durability
    // BEFORE mutating memory, so a rejected medium write leaves the record absent.
    await expect(instance.store.append(SCOPE_A, TEAM, MEMBER, 'will fail', []))
      .rejects.toThrow()
    expect(instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50).rows).toEqual([])
    // A subsequent healthy append still lands as seq 1 (no gap or ghost record).
    const ok = await instance.store.append(SCOPE_A, TEAM, MEMBER, 'healthy', [])
    expect(ok).toMatchObject({ seq: 1, memoryId: 'private-memory-1' })
  })

  it('rejects every operation once closed', async () => {
    const instance = await mount()
    mounted.push(instance)
    await instance.store.append(SCOPE_A, TEAM, MEMBER, 'kept', [])
    instance.store.close()
    // append/listPage assert open synchronously (the HumanInteractionOverlayStore
    // convention), so both throw rather than reject.
    expect(() => instance.store.append(SCOPE_A, TEAM, MEMBER, 'late', []))
      .toThrow(expect.objectContaining({ code: 'TEAM_PRIVATE_MEMORY_STORE_CLOSED' }))
    expect(() => instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50))
      .toThrow(expect.objectContaining({ code: 'TEAM_PRIVATE_MEMORY_STORE_CLOSED' }))
  })

  it('resists a tampered record that reuses a member key with mismatched identity fields', async () => {
    const instance = await mount()
    mounted.push(instance)
    await instance.store.append(SCOPE_A, TEAM, MEMBER, 'genuine', [])
    // An attacker writes a record UNDER the member's plausible next key but
    // with forged identity fields naming a DIFFERENT scope/team/member. The
    // forged record coexists at seq 2 on the medium. Isolation is decided by the
    // authoritative record fields (and strict zod at load), so the forged record
    // must NOT surface in this member's view.
    const forged: MemberPrivateMemoryRecord = {
      schemaVersion: 1, scope: 'forged-scope', teamId: 'forged-team', memberSessionId: 'forged-member',
      seq: 2, memoryId: 'private-memory-2', content: 'INJECTED', evidenceRefs: [], createdAt: 1,
    }
    await instance.domain.table('memories').put(
      JSON.stringify([SCOPE_A, TEAM, MEMBER, 2]),
      { ...forged },
    )
    const page = instance.store.listPage(SCOPE_A, TEAM, MEMBER, 0, 50)
    expect(page.rows.map(row => row.content)).toEqual(['genuine'])
    expect(page.rows.map(row => row.memoryId)).toEqual(['private-memory-1'])
  })
})
