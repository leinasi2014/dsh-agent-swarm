/**
 * M3 first-slice DECLARED quality metadata vocabulary (task-10; structure-gate
 * split of member-private-memory-operations.ts, captain-authorized mechanical
 * ≤600 split under the same harness). NO I/O: the claim schema, its write-side
 * canonicalization and the retry-comparison equivalence. Pure code shared by
 * the durable schema, the maintenance input canonicalizer and the fold.
 *
 * A claim is what the MODEL DECLARES about a note — never a Host-verified
 * conclusion. `reported_*`/`declared_observed`/`hypothesis` are declaration
 * tiers; there is NO confirmed/verified tier here: promotion requires real
 * host-checkable evidence in a directly-following slice. `taskId`/`attemptId`
 * are a model-SUPPLIED citation the Host matches against its OWN observed
 * attribution at write time (mismatch rejects); they are never rendered as
 * Host facts and never invented for legacy notes (absence = quality unknown).
 *
 * @module dsh-agent-swarm/storage/member-private-memory-claim
 */
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { TeamDomainError } from '../domain/error.js'
import { nonEmpty } from '../domain/team-domain-shared.js'

/** Bounded-text helper shared by the claim schema and the durable operations
 *  schema (moved here by the M3 ≤600 mechanical split). */
export const bounded = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)
export const boundedOrEmpty = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)

/**
 * Host-derived provenance (strict durable union; moved by the split): either
 * explicitly unattributed, or a task attribution the Host derives from its
 * OWN Team snapshot after checking task/attempt ownership — never a
 * model-supplied actor or scope, and never a capability score. v1 rows have
 * NO provenance on disk and their origin is UNKNOWN: the note view leaves
 * `provenance` absent rather than inventing either branch.
 */
const PRIVATE_MEMORY_PROVENANCE_ID_BYTES = 256
export const provenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unattributed') }).strict(),
  z.object({
    kind: z.literal('task'),
    taskId: bounded(PRIVATE_MEMORY_PROVENANCE_ID_BYTES),
    attemptId: bounded(PRIVATE_MEMORY_PROVENANCE_ID_BYTES).optional(),
    teamRevision: z.number().int().min(0),
    observedAt: z.number().int().min(0),
  }).strict(),
])

/** Host-derived operation provenance (durable v2 branches only). */
export type PrivateMemoryProvenance =
  | { readonly kind: 'unattributed' }
  | { readonly kind: 'task'; readonly taskId: string; readonly attemptId?: string; readonly teamRevision: number; readonly observedAt: number }

const PRIVATE_MEMORY_CLAIM_FIELD_BYTES = 256

const CLAIM_OUTCOMES = ['reported_pass', 'reported_failure', 'declared_observed', 'hypothesis'] as const

export interface PrivateMemoryClaim {
  readonly environment: string
  readonly version: string
  readonly outcome: 'reported_pass' | 'reported_failure' | 'declared_observed' | 'hypothesis'
  readonly taskId?: string
  readonly attemptId?: string
}

/** Strict durable shape of one declared-quality block. */
export const claimSchema = z.object({
  environment: bounded(PRIVATE_MEMORY_CLAIM_FIELD_BYTES),
  version: bounded(PRIVATE_MEMORY_CLAIM_FIELD_BYTES),
  outcome: z.enum(CLAIM_OUTCOMES),
  taskId: bounded(PRIVATE_MEMORY_CLAIM_FIELD_BYTES).optional(),
  attemptId: bounded(PRIVATE_MEMORY_CLAIM_FIELD_BYTES).optional(),
}).strict()

/** Write-side canonicalization: trimmed bounded text, enum outcome, optional
 *  citations; invalid input fails through the caller's shared invalid-error
 *  factory naming only the offending claim field. */
export function canonicalizeClaim(
  claim: PrivateMemoryClaim | undefined,
  invalid: (field: string) => TeamDomainError,
): PrivateMemoryClaim | undefined {
  if (claim === undefined) return undefined
  const environment = nonEmpty(claim.environment, 'claim environment', PRIVATE_MEMORY_CLAIM_FIELD_BYTES)
  const version = nonEmpty(claim.version, 'claim version', PRIVATE_MEMORY_CLAIM_FIELD_BYTES)
  if (!CLAIM_OUTCOMES.includes(claim.outcome)) throw invalid('claim outcome')
  return {
    environment, version, outcome: claim.outcome,
    ...(claim.taskId === undefined ? {} : { taskId: nonEmpty(claim.taskId, 'claim task id', PRIVATE_MEMORY_CLAIM_FIELD_BYTES) }),
    ...(claim.attemptId === undefined ? {} : { attemptId: nonEmpty(claim.attemptId, 'claim attempt id', PRIVATE_MEMORY_CLAIM_FIELD_BYTES) }),
  }
}

/** Retry-comparison equivalence over the COMPLETE declared block (a claim and
 *  its absence are different normalized inputs; same id with a different
 *  claim is a conflict, never a replay). */
export function sameClaim(left?: PrivateMemoryClaim, right?: PrivateMemoryClaim): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined
  return left.environment === right.environment && left.version === right.version && left.outcome === right.outcome
    && left.taskId === right.taskId && left.attemptId === right.attemptId
}

// ---------------------------------------------------------------------------
// M3 evidence segment: Host-witnessed RESULT observation (task-10).
// The model may only CITE a call id; the tool layer witnesses the ACTUAL
// call/result pair inside the member's CURRENT registered Agent's own
// Session window (never the fork-inherited prefix, never an ambiguous
// multi-pair callId) and produces the bounded core below. The service
// completes it with its own snapshot revision/time; durable rows carry the
// COMPLETE block as schemaVersion 4. What is witnessed is only "the tool
// really returned this result" — never a validated technical conclusion.
// ---------------------------------------------------------------------------

const OBSERVATION_ID_BYTES = 256

/** The bounded witness core the tool layer extracts from the official log. */
export interface PrivateMemoryObservationCore {
  readonly tool: string
  readonly callId: string
  readonly callSeq: number
  readonly resultSeq: number
  readonly isError: boolean
  readonly resultDigest: string
}

/** The complete Host-witnessed block persisted in a durable v4 row. */
export interface PrivateMemoryObservation extends PrivateMemoryObservationCore {
  readonly kind: 'observed_result'
  readonly teamRevision: number
  readonly observedAt: number
}

const DIGEST_PATTERN = /^[0-9a-f]{16,64}$/

/** Strict durable shape of a complete witnessed-result block. */
export const observationSchema = z.object({
  kind: z.literal('observed_result'),
  tool: bounded(OBSERVATION_ID_BYTES),
  callId: bounded(OBSERVATION_ID_BYTES),
  callSeq: z.number().int().min(1),
  resultSeq: z.number().int().min(1),
  isError: z.boolean(),
  resultDigest: z.string().regex(DIGEST_PATTERN),
  teamRevision: z.number().int().min(0),
  observedAt: z.number().int().min(0),
}).strict()

/** Validate the tool-layer witness core (structural invariants only — this
 *  is a defensive re-check at the write gate; the model surface can never
 *  supply these fields, only the call id). */
export function canonicalizeObservationCore(
  core: PrivateMemoryObservationCore,
  invalid: (field: string) => TeamDomainError,
): PrivateMemoryObservationCore {
  const tool = nonEmpty(core.tool, 'observation tool', OBSERVATION_ID_BYTES)
  const callId = nonEmpty(core.callId, 'observation call id', OBSERVATION_ID_BYTES)
  if (!Number.isInteger(core.callSeq) || core.callSeq < 1) throw invalid('observation call seq')
  if (!Number.isInteger(core.resultSeq) || core.resultSeq < 1) throw invalid('observation result seq')
  if (typeof core.isError !== 'boolean') throw invalid('observation result identity')
  if (!DIGEST_PATTERN.test(core.resultDigest)) throw invalid('observation result digest')
  return { tool, callId, callSeq: core.callSeq, resultSeq: core.resultSeq, isError: core.isError, resultDigest: core.resultDigest }
}

/** The service-side completion: ONLY the six core fields survive (a forged
 *  kind/revision/time can never ride through), stamped with the Host's own
 *  pre-fence snapshot revision and clock. */
export function completeObservation(
  core: PrivateMemoryObservationCore,
  invalid: (field: string) => TeamDomainError,
  teamRevision: number,
  observedAt: number,
): PrivateMemoryObservation {
  const checked = canonicalizeObservationCore(core, invalid)
  return { kind: 'observed_result', ...checked, teamRevision, observedAt }
}

/** Retry-comparison equivalence over the witness core (Host revision/time
 *  are excluded like all other Host metadata: re-witnessing the same real
 *  pair is the same logical request; a different pair is a conflict). */
export function sameObservation(left?: PrivateMemoryObservationCore, right?: PrivateMemoryObservationCore): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined
  return left.tool === right.tool && left.callId === right.callId
    && left.callSeq === right.callSeq && left.resultSeq === right.resultSeq
    && left.isError === right.isError && left.resultDigest === right.resultDigest
}

/** The REQUEST-side projection of a durable observation block: the Host
 *  stamp fields (kind/teamRevision/observedAt) are Host metadata and stay
 *  out of normalized-request comparison, exactly like provenance. */
export function observationCoreOf(observation: PrivateMemoryObservation): PrivateMemoryObservationCore {
  return {
    tool: observation.tool, callId: observation.callId, callSeq: observation.callSeq,
    resultSeq: observation.resultSeq, isError: observation.isError, resultDigest: observation.resultDigest,
  }
}

/**
 * Durable-history canonical checks for the quality/observation dimensions
 * (M3). The `tampered` reporter is injected so the fold layer keeps its
 * error taxonomy; a PRESENT block must always match its own canonical
 * invariants — and a legacy row without either block is untouched (nothing
 * is ever invented).
 */
export function assertCanonicalQualityMetadata(
  quality: {
    readonly claim?: PrivateMemoryClaim | undefined
    readonly observation?: (PrivateMemoryObservation | PrivateMemoryObservationCore) | undefined
  },
  tampered: (reason: string) => void,
): void {
  const claim = quality.claim
  if (claim !== undefined && (claim.environment !== claim.environment.trim() || claim.version !== claim.version.trim()
    || (claim.taskId !== undefined && claim.taskId !== claim.taskId.trim())
    || (claim.attemptId !== undefined && claim.attemptId !== claim.attemptId.trim()))) {
    tampered('claim fields are not canonical (trimmed)')
  }
  const observation = quality.observation
  if (observation === undefined) return
  if ('kind' in observation && observation.kind !== 'observed_result') tampered('observation block has an unknown kind')
  if (observation.tool !== observation.tool.trim() || observation.callId !== observation.callId.trim()) {
    tampered('observation identifiers are not canonical (trimmed)')
  }
  if (!Number.isInteger(observation.callSeq) || observation.callSeq < 1) tampered('observation call sequence is invalid')
  if (!Number.isInteger(observation.resultSeq) || observation.resultSeq < 1) tampered('observation result sequence is invalid')
  // Basic coordinate invariant of a witnessed pair (independent of any
  // count check): a forged row can never place its result before its call.
  if (observation.resultSeq <= observation.callSeq) tampered('observation result must follow its call')
  if (typeof observation.isError !== 'boolean') tampered('observation error identity must be boolean')
  if (!DIGEST_PATTERN.test(observation.resultDigest)) tampered('observation result digest is not a lowercase hex digest')
}

/**
 * One note in the reader's folded view — a distinct type from any stored
 * record (a v2 operation is never cast as a v1 row). `seq`/`memoryId`/
 * `createdAt` stay the ORIGINAL creation identity (ids and pagination
 * offsets never drift); `headSeq` is the newest operation seq touching the
 * note; `status`/`supersededBy` carry invalidate/replace results.
 * `createdVia` explicitly marks notes whose creation came from a v2
 * add/replace (never inferred from status/headSeq). `provenance`/`tags`/
 * `applicability` describe the CURRENT payload's origin: ABSENT provenance
 * means the legacy v1 origin is UNKNOWN (never an invented 'unattributed'),
 * present only once a v2 operation supplied the payload; `applicability` ''
 * means unconditional. `claim` is DECLARED quality metadata (never truth)
 * and `observation` the Host-witnessed result block (tool-layer evidence,
 * never a validated conclusion). A replace keeps the old row superseded IN
 * PLACE (its own payload origin stays unknown) and appends the new note at
 * the END of creation order; maintenance rows never surface as notes.
 */
export interface PrivateMemoryNote {
  readonly scope: string
  readonly teamId: string
  readonly memberSessionId: string
  readonly seq: number
  readonly memoryId: string
  readonly content: string
  readonly evidenceRefs: string[]
  readonly createdAt: number
  readonly status: 'active' | 'invalidated' | 'superseded'
  readonly headSeq: number
  readonly supersededBy?: string
  readonly provenance?: PrivateMemoryProvenance
  readonly tags?: string[]
  readonly applicability?: string
  readonly claim?: PrivateMemoryClaim
  readonly observation?: PrivateMemoryObservation
  readonly createdVia?: { readonly operationId: string; readonly operation: 'add' | 'replace'; readonly seq: number }
}

/** One page of private-memory notes in member-local creation order. */
export interface PrivateMemoryPage {
  readonly rows: PrivateMemoryNote[]
  readonly nextCursor?: number
}
