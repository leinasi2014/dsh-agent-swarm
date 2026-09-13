/**
 * Public contract types and pure projections of the skills-management module:
 * the Captain-facing receipts/views, the manager's batch pages/ack receipts,
 * evidence-reference parsing, and canonical intake payloads. Pure code only —
 * no state, no IO; the module owns every decision.
 *
 * @module dsh-agent-swarm/skills/contracts
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import {
  skillsRequestPayloadSchema,
  type SkillsConsumerBatchRef,
  type SkillsConsumerRecord,
  type SkillsEvidenceEntry,
  type SkillsRequestPayload,
  type SkillsRequestRecord,
} from '../storage/skills-management.js'

/** Tool-execution authority accepted by every module face. */
export interface SkillsCallAuthority {
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** One canonical intake payload as provided by the Captain. */
export interface SkillsRequestInput {
  readonly requestId: string
  readonly revision: number
  readonly question: string
  readonly goal?: string
  readonly taskId?: string
  readonly attemptId?: string
  readonly evidenceRefs?: readonly string[]
}

export interface SkillsReceipt {
  readonly request_id: string
  readonly revision: number
  readonly received: boolean
  readonly replayed: boolean
  readonly state: SkillsRequestRecord['state']
  readonly accepted_at: number
  readonly updated_at: number
}

export interface SkillsStatusView {
  readonly request_id: string
  readonly revision: number
  readonly state: SkillsRequestRecord['state']
  readonly reason?: string
  readonly result?: SkillsRequestRecord['result']
  readonly payload: SkillsRequestPayload
  readonly created_at: number
  readonly updated_at: number
}

export interface SkillsSyncPage {
  readonly sourceState: SkillsConsumerRecord['sourceState']
  readonly needsResync: boolean
  readonly cursorSequence: number
  readonly throughSequence: number
  readonly retainedFromSequence?: number
  readonly hasMore: boolean
  /** True when this call RE-SERVED the un-acked batch (no capture, no write). */
  readonly reServed: boolean
  /** A pending un-acked batch is backpressure: nothing else may be captured. */
  readonly pending: boolean
  readonly batchId?: string
  readonly legacyNoWorkActivity: boolean
  readonly gaps: readonly SkillsConsumerRecord['gaps'][number][]
  readonly gapsTruncated: boolean
  readonly conflicts: readonly SkillsConsumerRecord['conflicts'][number][]
  readonly conflictsTruncated: boolean
  readonly entries: readonly SkillsConsumerBatchRef[]
}

/** Explicit batch acknowledgement receipt (contract ①). */
export interface SkillsAckReceipt {
  readonly batch_id: string
  readonly replayed: boolean
  readonly acked_at: number
}

const FILE_REF_PREFIX = 'file:'
const FILE_REF_HASH = '#sha256:'

/** Parse one Captain evidence reference into its durable entry shape. */
function parseEvidenceRef(ref: string): SkillsEvidenceEntry {
  if (!ref.startsWith(FILE_REF_PREFIX)) return { ref, external: false }
  const body = ref.slice(FILE_REF_PREFIX.length)
  const hashAt = body.lastIndexOf(FILE_REF_HASH)
  if (hashAt < 0) return { ref: body, external: true }
  const path = body.slice(0, hashAt)
  const hash = body.slice(hashAt + FILE_REF_HASH.length)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TeamDomainError('an external evidence reference carries a malformed sha256', 'SKILLS_INPUT_INVALID')
  return { ref: path, external: true, sha256: hash }
}

/** Validate and canonicalize one intake payload (identity of a revision). */
export function toCanonicalPayload(input: SkillsRequestInput): SkillsRequestPayload {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new TeamDomainError('revision must be a positive integer', 'SKILLS_INPUT_INVALID')
  return skillsRequestPayloadSchema.parse({
    question: input.question,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    evidence: (input.evidenceRefs ?? []).map(ref => parseEvidenceRef(ref)),
  })
}

/** The durable status projection of one request record. */
export function statusViewOf(record: SkillsRequestRecord): SkillsStatusView {
  return {
    request_id: record.requestId,
    revision: record.revision,
    state: record.state,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.result === undefined ? {} : { result: record.result }),
    payload: record.payload,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}
