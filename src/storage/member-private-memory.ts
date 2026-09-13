/**
 * The `agent_swarm_member_private_memory` Storage Domain (member-private-memory
 * feature, 2026-08-26): the plugin-owned, append-only durable truth behind
 * `agent_swarm_add_private_memory` and `agent_swarm_list_private_memory`.
 *
 * Official API boundary (controller ruling, 2026-08-26): the persisted event
 * vocabulary (`KNOWN_SESSION_EVENT_TYPES`) is first-party only — the official
 * note states downstream plugin events are outside it by construction and no
 * registration surface is provided, and the public `Session.append()` does not
 * accept an `ignorable` marker. A plugin therefore cannot add its own durable
 * Session event type without patching DSH. This domain is the necessary
 * persistence adaptation. It is deliberately NOT TeamState and NOT a second Team
 * state machine: the authoritative `agent_swarm` aggregate — Team
 * snapshot/revision, roster, tasks, budget and shared memory — is untouched.
 *
 * The explicit list/submission tool surface still proceeds through the member's
 * official Session log as ordinary `tool/call` + `tool/result` surface events,
 * so the exact content the model read and wrote is naturally replayable from
 * that member's own Session; nothing is injected into any prompt.
 *
 * Records are isolated by the workspace scope plus the durable Team identity and
 * the member's durable Session identity (the composite table key). Only the owning
 * active member — resolved through the existing runtime membership/owning-agent
 * authority — may append to or read its own records; there is deliberately no
 * target-member parameter, so no caller can address another member's private memory.
 *
 * M1 compat-reader contract (Root-confirmed, 2026-09): the unit (name,
 * `version: 1`, default single) is frozen. The durable table accepts a STRICT
 * v1|v2 record union — v1 note rows keep their historical shape (legacy legal
 * many-evidenceRef rows are never retro-bound by any future writer threshold),
 * while v2 maintenance rows (add/revise/invalidate/replace) are READ-ONLY here:
 * production writers in this slice still emit ONLY schemaVersion 1 rows. The
 * store folds through the pure `foldHistory` operation-index engine in
 * `member-private-memory-operations.ts` (types, schemas and the fold live
 * there; this file owns the domain handle, the store and the write fence).
 * Every forged history fails closed on BOTH the list fold and the append
 * admission, never only at list time. A legacy v1 payload's origin is UNKNOWN:
 * it is represented by an ABSENT provenance on the note view — never projected
 * as an explicitly recorded `{kind:'unattributed'}` — while durable v2
 * provenance keeps the two Root-confirmed branches.
 *
 * @module dsh-agent-swarm/storage/member-private-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import { nonEmpty } from '../domain/team-domain-shared.js'
import { CommitSequence } from '../util/commit-sequence.js'
import { assertTeamWritable } from './team-retirement-store.js'
import {
  foldHistory,
  memoryKey,
  storedPrivateMemoryRecordSchema,
  type MemberPrivateMemoryRecord,
  type PrivateMemoryNote,
  type PrivateMemoryOperationIndexEntry,
  type PrivateMemoryPage,
  type PrivateMemoryReceipt,
  type StoredPrivateMemoryRecord,
} from './member-private-memory-operations.js'

// Only re-exports with real consumers stay public to the module. Module-internal
// vocabulary (the Root-confirmed format bounds, the provenance/operation-row/
// normalized-request helper types, and the payload component that had no
// consumer at all) stays internal until a consumer exists — knip-verified
// 2026-09; the frozen public contract lives in public-api.ts, not here.
export type {
  MemberPrivateMemoryRecord,
  PrivateMemoryNote,
  PrivateMemoryOperationIndexEntry,
  PrivateMemoryPage,
  PrivateMemoryReceipt,
  StoredPrivateMemoryRecord,
} from './member-private-memory-operations.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const PRIVATE_MEMORY_DOMAIN_NAME = 'agent_swarm_member_private_memory'
/** Domain format version; a medium stamped differently rejects at open. */
export const PRIVATE_MEMORY_DOMAIN_VERSION = 1

/** Bound a private-memory evidence reference list when it reaches the model. */
export const PRIVATE_MEMORY_EVIDENCE_TRUNCATE = 32

/** The `agent_swarm_member_private_memory` domain spec opened through `ctx.storageDomain`. */
export const privateMemoryDomainSpec = defineDomain({
  name: PRIVATE_MEMORY_DOMAIN_NAME,
  version: PRIVATE_MEMORY_DOMAIN_VERSION,
  tables: {
    memories: domainTable<string, StoredPrivateMemoryRecord>(storedPrivateMemoryRecordSchema),
  },
})

/**
 * The overlay store over one open private-memory domain handle. Writes reach
 * backend durability through the domain's write chain before `put` resolves, so
 * a committed record is observable after a crash. Process-local serialization
 * is explicit and never a cross-process claim.
 */
export class MemberPrivateMemoryStore {
  private readonly memories: ReturnType<Domain<typeof privateMemoryDomainSpec>['table']>
  private readonly commitSequence = new CommitSequence()
  private storeClosed = false

  constructor(
    private readonly ctx: Context,
    domain: Domain<typeof privateMemoryDomainSpec>,
    private readonly now: () => number = Date.now,
  ) {
    this.memories = domain.table('memories')
  }

  private assertOpen(): void {
    if (this.storeClosed) {
      throw new TeamDomainError('member private memory store is closed', 'TEAM_PRIVATE_MEMORY_STORE_CLOSED')
    }
  }

  /** All physical rows (v1 notes + v2 operations) of one partition, in seq order. */
  private partitionRecords(scope: string, teamId: string, memberSessionId: string): StoredPrivateMemoryRecord[] {
    const rows: StoredPrivateMemoryRecord[] = []
    // Two-way durable identity check at the read boundary: the table key must
    // equal the tuple THIS record's fields declare (and vice versa). The official
    // Storage Domain stores records by reference, so an attacker who smuggles a
    // record under a member's key with forged identity fields, or a record whose
    // own fields disagree with its key, is indistinguishable from a corrupt medium —
    // fail loud with `TEAM_PRIVATE_MEMORY_TAMPERED` so it never surfaces in ANY
    // member's view. A conforming record is then isolated to its partition by the
    // authoritative fields (scope + Team + member).
    for (const [key, record] of this.memories.entries()) {
      if (key !== memoryKey(record.scope, record.teamId, record.memberSessionId, record.seq)) {
        throw new TeamDomainError('a private-memory record key does not match its durable identity tuple', 'TEAM_PRIVATE_MEMORY_TAMPERED')
      }
      if (record.scope === scope && record.teamId === teamId && record.memberSessionId === memberSessionId) rows.push(record)
    }
    return rows.toSorted((left, right) => left.seq - right.seq)
  }

  /** Validate + fold one partition through the pure history engine. */
  private foldPartition(scope: string, teamId: string, memberSessionId: string): {
    notes: PrivateMemoryNote[]
    index: PrivateMemoryOperationIndexEntry[]
  } {
    return foldHistory(this.partitionRecords(scope, teamId, memberSessionId), scope, teamId, memberSessionId)
  }

  /**
   * INTERNAL read (no public tool, no durable table): rebuild the partition's
   * full operation index — one entry per operation holding (a) the minimal
   * receipt computed AT that operation's own history prefix and (b) the
   * COMPLETE normalized model request (operation branch, target/head, branch
   * payload; Host metadata excluded), the future retry-comparison basis. Later
   * operations cannot alter an earlier entry, and the returned graph is a
   * detached deep copy. Fails closed on a forged history, exactly like the fold.
   */
  operationIndex(scope: string, teamId: string, memberSessionId: string): PrivateMemoryOperationIndexEntry[] {
    this.assertOpen()
    return structuredClone(this.foldPartition(scope, teamId, memberSessionId).index)
  }

  /** Convenience minimal-receipt view over `operationIndex`. */
  operationReceipts(scope: string, teamId: string, memberSessionId: string): PrivateMemoryReceipt[] {
    return this.operationIndex(scope, teamId, memberSessionId).map(entry => entry.receipt)
  }

  /**
   * Durably append one private-memory record for one owning member. The member
   * partition seq is the record's stable creation index (id = `private-memory-<seq>`).
   * The stored, returned and caller-supplied graphs are deep-copied so a caller
   * mutating its input (or a returned list row) cannot reach the authority memory.
   * A logically forged partition history FAILS CLOSED here too — never only at
   * list time — before any write is admitted.
   * @returns the committed record's detached deep copy.
   * @throws `TEAM_PRIVATE_MEMORY_STORE_CLOSED` when closed,
   *   `TEAM_PRIVATE_MEMORY_TAMPERED` on a forged partition history, or the shared
   *   `TEAM_INPUT_INVALID`/`TEAM_INPUT_LIMIT` vocabulary on invalid content.
   */
  append(scope: string, teamId: string, memberSessionId: string, content: string, evidenceRefs: readonly string[]): Promise<MemberPrivateMemoryRecord> {
    this.assertOpen()
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const validatedContent = nonEmpty(content, 'private memory content', 16_384)
      const validatedRefs = evidenceRefs.map(reference => nonEmpty(reference, 'private memory evidence reference', 2_048))
      // Full-history fold validation FIRST (fail closed on forged head/terminal/
      // operationId history before appending), then the next partition seq spans
      // ALL physical rows (v1 notes AND v2 maintenance operations), so a legacy
      // append can never collide with a v2 maintenance record. Production writes
      // still emit only v1 rows.
      this.foldPartition(scope, teamId, memberSessionId)
      const existing = this.partitionRecords(scope, teamId, memberSessionId)
      const seq = (existing.at(-1)?.seq ?? 0) + 1
      const record: MemberPrivateMemoryRecord = {
        schemaVersion: 1,
        scope,
        teamId,
        memberSessionId,
        seq,
        memoryId: `private-memory-${seq}`,
        content: validatedContent,
        evidenceRefs: validatedRefs,
        createdAt: this.now(),
      }
      assertTeamWritable(this.ctx, scope, teamId)
      await this.memories.put(memoryKey(scope, teamId, memberSessionId, seq), structuredClone(record))
      return structuredClone(record)
    })
  }

  /**
   * Read one bounded page of one owning member's private memory in creation
   * order. Explicit read only — no semantic search, no prompt injection, and no
   * LLM extraction. The partition's full operation history is folded first
   * (v2 maintenance never surfaces as extra notes), so pagination offsets are
   * stable across the folded view. Returned rows are detached deep copies, so
   * caller mutation never reaches the stored authority or any derived receipt.
   * @throws `TEAM_PRIVATE_MEMORY_TAMPERED` (fail closed) on a forged history.
   */
  listPage(scope: string, teamId: string, memberSessionId: string, cursor: number, limit: number): PrivateMemoryPage {
    this.assertOpen()
    const notes = this.foldPartition(scope, teamId, memberSessionId).notes
    const rows = notes.slice(cursor, cursor + limit).map(note => structuredClone(note))
    return { rows, ...(cursor + limit < notes.length ? { nextCursor: cursor + limit } : {}) }
  }

  /** Requested-row shape with the model-facing evidence-reference bound applied. */
  static row(record: MemberPrivateMemoryRecord | PrivateMemoryNote): {
    memory_id: string
    content: string
    evidence_refs: string[]
    evidence_refs_truncated: boolean
    created_at: number
    seq: number
    status?: 'active' | 'invalidated' | 'superseded'
    head_seq?: number
    superseded_by?: string
    provenance?: { kind: 'unattributed' } | { kind: 'task'; task_id: string; attempt_id?: string; team_revision: number; observed_at: number }
    tags?: string[]
    applicability?: string
    created_via?: { operation_id: string; operation: 'add' | 'replace'; seq: number }
  } {
    const evidenceRefs = record.evidenceRefs.slice(0, PRIVATE_MEMORY_EVIDENCE_TRUNCATE)
    const base = {
      memory_id: record.memoryId,
      content: record.content,
      evidence_refs: evidenceRefs,
      evidence_refs_truncated: evidenceRefs.length < record.evidenceRefs.length,
      created_at: record.createdAt,
      seq: record.seq,
    }
    // Legacy untouched v1 notes keep the exact historical row shape. A note is
    // "extended" when maintenance touched it OR it was created BY a v2
    // operation — explicitly via createdVia, never inferred from status/headSeq,
    // so a v2 add note whose headSeq equals seq still keeps its metadata.
    if (!('headSeq' in record)) return base
    const extended = record.status !== 'active' || record.headSeq !== record.seq || record.createdVia !== undefined
    if (!extended) return base
    return {
      ...base,
      status: record.status,
      head_seq: record.headSeq,
      ...(record.supersededBy === undefined ? {} : { superseded_by: record.supersededBy }),
      // ABSENT provenance stays absent: the legacy v1 payload origin is unknown
      // and is never invented as either durable branch.
      ...(record.provenance === undefined ? {} : {
        provenance: record.provenance.kind === 'task'
          ? {
              kind: 'task' as const,
              task_id: record.provenance.taskId,
              ...(record.provenance.attemptId === undefined ? {} : { attempt_id: record.provenance.attemptId }),
              team_revision: record.provenance.teamRevision,
              observed_at: record.provenance.observedAt,
            }
          : { kind: 'unattributed' as const },
      }),
      ...(record.tags === undefined ? {} : { tags: [...record.tags] }),
      ...(record.applicability === undefined ? {} : { applicability: record.applicability }),
      ...(record.createdVia === undefined ? {} : {
        created_via: { operation_id: record.createdVia.operationId, operation: record.createdVia.operation, seq: record.createdVia.seq },
      }),
    }
  }

  countTeam(scope: string, teamId: string): number {
    this.assertOpen()
    return [...this.memories.entries()].filter(([, row]) => row.scope === scope && row.teamId === teamId).length
  }

  async purgeTeam(scope: string, teamId: string): Promise<void> {
    await this.commitSequence.run(async () => {
      this.assertOpen()
      for (const [key, row] of this.memories.entries()) if (row.scope === scope && row.teamId === teamId) await this.memories.delete(key)
    })
    if (this.countTeam(scope, teamId) !== 0) throw new TeamDomainError('Private memory purge did not verify', 'TEAM_RETIREMENT_VERIFY_FAILED')
  }

  /** Stop accepting operations (the domain handle itself is closed by the owner). */
  close(): void {
    this.storeClosed = true
  }
}
