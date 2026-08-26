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
 * @module dsh-agent-swarm/storage/member-private-memory
 */

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import { nonEmpty } from '../domain/team-domain-shared.js'
import { CommitSequence } from '../util/commit-sequence.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const PRIVATE_MEMORY_DOMAIN_NAME = 'agent_swarm_member_private_memory'
/** Domain format version; a medium stamped differently rejects at open. */
export const PRIVATE_MEMORY_DOMAIN_VERSION = 1

/** Bound a private-memory evidence reference list when it reaches the model. */
export const PRIVATE_MEMORY_EVIDENCE_TRUNCATE = 32

const timestamp = z.number().int().min(0)
const bounded = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)

const privateMemoryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  memberSessionId: bounded(256),
  seq: z.number().int().min(1),
  memoryId: bounded(128),
  content: bounded(16_384),
  evidenceRefs: z.array(bounded(2_048)),
  createdAt: timestamp,
}).strict()

/** One durable private-memory record; its precise in-memory projection. */
export interface MemberPrivateMemoryRecord {
  readonly schemaVersion: 1
  readonly scope: string
  readonly teamId: string
  readonly memberSessionId: string
  readonly seq: number
  readonly memoryId: string
  readonly content: string
  readonly evidenceRefs: string[]
  readonly createdAt: number
}

// Single contained type-erasure: the zod object owns runtime validation at the
// durable boundary; `MemberPrivateMemoryRecord` is its precise projection
// (the team-spec/workflow-overlay pattern).
const storedPrivateMemoryRecordSchema = privateMemoryRecordSchema as unknown as z.ZodType<MemberPrivateMemoryRecord>

/** The `agent_swarm_member_private_memory` domain spec opened through `ctx.storageDomain`. */
export const privateMemoryDomainSpec = defineDomain({
  name: PRIVATE_MEMORY_DOMAIN_NAME,
  version: PRIVATE_MEMORY_DOMAIN_VERSION,
  tables: {
    memories: domainTable<string, MemberPrivateMemoryRecord>(storedPrivateMemoryRecordSchema),
  },
})

/** One durable record key: the scope + Team + member isolation tuple plus local seq. */
function memoryKey(scope: string, teamId: string, memberSessionId: string, seq: number): string {
  return JSON.stringify([scope, teamId, memberSessionId, seq])
}

/** One page of private-memory rows in member-local creation order. */
export interface PrivateMemoryPage {
  readonly rows: MemberPrivateMemoryRecord[]
  readonly nextCursor?: number
}

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
    _ctx: Context,
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

  /** Existing records of one scope + Team + member, in member-local seq order. */
  private memberRecords(scope: string, teamId: string, memberSessionId: string): MemberPrivateMemoryRecord[] {
    const rows: MemberPrivateMemoryRecord[] = []
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

  /**
   * Durably append one private-memory record for one owning member. The member
   * partition seq is the record's stable creation index (id = `private-memory-<seq>`).
   * The stored, returned and caller-supplied graphs are deep-copied so a caller
   * mutating its input (or a returned list row) cannot reach the authority memory.
   * @returns the committed record's detached deep copy.
   * @throws `TEAM_PRIVATE_MEMORY_STORE_CLOSED` when closed, or the shared
   *   `TEAM_INPUT_INVALID`/`TEAM_INPUT_LIMIT` vocabulary on invalid content.
   */
  append(scope: string, teamId: string, memberSessionId: string, content: string, evidenceRefs: readonly string[]): Promise<MemberPrivateMemoryRecord> {
    this.assertOpen()
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const validatedContent = nonEmpty(content, 'private memory content', 16_384)
      const validatedRefs = evidenceRefs.map(reference => nonEmpty(reference, 'private memory evidence reference', 2_048))
      const existing = this.memberRecords(scope, teamId, memberSessionId)
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
      await this.memories.put(memoryKey(scope, teamId, memberSessionId, seq), structuredClone(record))
      return structuredClone(record)
    })
  }

  /**
   * Read one bounded page of one owning member's private memory in creation
   * order. Explicit read only — no semantic search, no prompt injection, and no
   * LLM extraction. Returned rows are detached deep copies, so caller mutation
   * never reaches the stored authority.
   */
  listPage(scope: string, teamId: string, memberSessionId: string, cursor: number, limit: number): PrivateMemoryPage {
    this.assertOpen()
    const records = this.memberRecords(scope, teamId, memberSessionId)
    const rows = records.slice(cursor, cursor + limit).map(record => structuredClone(record))
    return { rows, ...(cursor + limit < records.length ? { nextCursor: cursor + limit } : {}) }
  }

  /** Requested-row shape with the model-facing evidence-reference bound applied. */
  static row(record: MemberPrivateMemoryRecord): {
    memory_id: string
    content: string
    evidence_refs: string[]
    evidence_refs_truncated: boolean
    created_at: number
    seq: number
  } {
    const evidenceRefs = record.evidenceRefs.slice(0, PRIVATE_MEMORY_EVIDENCE_TRUNCATE)
    return {
      memory_id: record.memoryId,
      content: record.content,
      evidence_refs: evidenceRefs,
      evidence_refs_truncated: evidenceRefs.length < record.evidenceRefs.length,
      created_at: record.createdAt,
      seq: record.seq,
    }
  }

  /** Stop accepting operations (the domain handle itself is closed by the owner). */
  close(): void {
    this.storeClosed = true
  }
}
