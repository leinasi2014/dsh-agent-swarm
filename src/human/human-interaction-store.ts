/**
 * The `agent_swarm_human` Storage Domain (SW-I1a): the additive
 * durable boundary of HumanInteraction request/receipt records. One record per
 * authoritative workspace scope + Team id + request id in the `interactions` table. The record family is correlation and
 * audit only — Team membership/tasks/mailbox stay canonical in `agent_swarm`,
 * and relay Agents never write either domain directly.
 *
 * Kept as a separate domain from `agent_swarm` following the workflow overlay
 * precedent: the Team aggregate's unit keeps its frozen version stamp, while
 * the interaction record family owns its own schema lifecycle.
 */

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import type { TeamId } from '../domain/types.js'
import { CommitSequence } from '../util/commit-sequence.js'
import {
  HUMAN_INTERACTION_ID_PATTERN,
  type HumanInteractionRecord,
  type HumanInteractionRequest,
} from './human-interaction-contract.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const HUMAN_INTERACTION_DOMAIN_NAME = 'agent_swarm_human'
/** Domain format version; a medium stamped differently rejects at open. */
export const HUMAN_INTERACTION_DOMAIN_VERSION = 1

/** Collision-free durable/lock key; request ids are idempotent only inside one authoritative scope. */
function humanInteractionKey(scope: string, teamId: TeamId, requestId: string): string {
  return JSON.stringify([scope, teamId, requestId])
}

function legacyHumanInteractionKey(scope: string, requestId: string): string {
  return JSON.stringify([scope, requestId])
}

export interface HumanInteractionPageKey {
  readonly createdAt: number
  readonly requestId: string
}

export interface HumanInteractionRecordPage {
  readonly records: HumanInteractionRecord[]
  readonly snapshotHighWater: number
  readonly hasMore: boolean
}

function comparePageKey(left: HumanInteractionPageKey, right: HumanInteractionPageKey): number {
  return left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId)
}

/** Shared process-local serializer for one scope-bound interaction request. */
class HumanInteractionOperationLocks {
  private readonly locks = new Map<string, Promise<void>>()

  async run<T>(scope: string, teamId: TeamId, requestId: string, operation: () => Promise<T>): Promise<T> {
    const key = humanInteractionKey(scope, teamId, requestId)
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.locks.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

const boundedText = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)
const requestIdSchema = z.string().regex(HUMAN_INTERACTION_ID_PATTERN).refine(
  value => Buffer.byteLength(value, 'utf8') <= 96,
  'must not exceed 96 UTF-8 bytes',
)
const timestamp = z.number().int().min(0)
const sessionId = boundedText(256)

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('captain-mediated'),
    captainSessionId: sessionId,
    hostSurface: boundedText(128).optional(),
  }).strict(),
  z.object({
    kind: z.literal('authenticated-human'),
    captainSessionId: sessionId,
    principalRef: boundedText(256),
    hostSurface: boundedText(128).optional(),
  }).strict(),
])

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('captain') }).strict(),
  z.object({ kind: z.literal('team') }).strict(),
  z.object({ kind: z.literal('member'), memberName: boundedText(64) }).strict(),
  z.object({ kind: z.literal('task'), taskId: boundedText(128) }).strict(),
])

const originSchema = z.object({
  kind: z.literal('member'),
  memberSessionId: sessionId,
  memberName: boundedText(64),
}).strict()

const requestFields = {
  requestId: requestIdSchema,
  teamId: boundedText(128),
  source: sourceSchema,
  target: targetSchema,
  intent: z.enum([
      'message',
      'member-question',
      'correct-task',
      'interrupt-member',
      'wake-member',
      'reassign-task',
      'review-task',
    ]),
  origin: originSchema.optional(),
  body: boundedText(4_096).optional(),
  expectedTeamRevision: z.number().int().min(1),
  expectedTaskRevision: z.number().int().min(1).optional(),
  attemptId: boundedText(128).optional(),
  decision: z.enum(['accept', 'reject']).optional(),
  diagnostic: boundedText(2_048).optional(),
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
}

const requestV1Schema = z.object({ schemaVersion: z.literal(1), ...requestFields }).strict()
const requestV2Schema = z.object({ schemaVersion: z.literal(2), ...requestFields }).strict()
const requestSchema = z.discriminatedUnion('schemaVersion', [requestV1Schema, requestV2Schema])

const receiptSchema = z.object({
  requestId: requestIdSchema,
  teamId: boundedText(128),
  status: z.enum(['pending', 'acknowledged', 'executed', 'rejected', 'failed', 'expired', 'cancelled']),
  routedMessageId: boundedText(128).optional(),
  answerMessageId: boundedText(128).optional(),
  resultingTaskId: boundedText(128).optional(),
  resultingTeamRevision: z.number().int().min(1).optional(),
  code: boundedText(128).optional(),
  diagnostic: boundedText(2_048).optional(),
  updatedAt: timestamp,
}).strict()

const recordFields = {
  scope: boundedText(4_096),
  receipt: receiptSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
}

// Epoch is a durable authority boundary, not an optional annotation: a v1
// record cannot be reinterpreted as an I1b candidate after reopen.
const recordSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), request: requestV1Schema, ...recordFields }).strict(),
  z.object({ schemaVersion: z.literal(2), admissionAuthorityEpoch: z.literal(2), request: requestV2Schema, ...recordFields }).strict(),
])

// Single contained type-erasure: the zod object owns runtime validation at
// the durable boundary; `HumanInteractionRecord` is its precise in-memory
// projection (the team-spec/workflow-overlay pattern).
const storedRecordSchema = recordSchema as unknown as z.ZodType<HumanInteractionRecord>

/** One strict request shape authority shared by public normalization and durable writes. */
export function parseHumanInteractionRequestRecord(value: unknown): HumanInteractionRequest {
  try {
    return structuredClone(requestSchema.parse(value) as HumanInteractionRequest)
  } catch {
    throw new TeamDomainError('human interaction request failed strict validation', 'TEAM_INTERACTION_INVALID')
  }
}

function parseStoredRecord(value: unknown): HumanInteractionRecord {
  try {
    return structuredClone(storedRecordSchema.parse(value))
  } catch {
    throw new TeamDomainError('human interaction record failed strict validation', 'TEAM_INTERACTION_INVALID')
  }
}

/** The `agent_swarm_human` domain spec opened through `ctx.storageDomain`. */
export const humanInteractionDomainSpec = defineDomain({
  name: HUMAN_INTERACTION_DOMAIN_NAME,
  version: HUMAN_INTERACTION_DOMAIN_VERSION,
  tables: {
    interactions: domainTable<string, HumanInteractionRecord>(storedRecordSchema),
  },
})

/**
 * The overlay store over one open domain handle. Writes reach backend
 * durability through the domain's write chain before `put` resolves, so a
 * committed receipt is observable after a crash (reload reconciliation).
 * Process-local per-request serialization is explicit and never a
 * cross-process claim.
 */
export class HumanInteractionOverlayStore {
  private readonly interactions: ReturnType<Domain<typeof humanInteractionDomainSpec>['table']>
  private readonly operationLocks = new HumanInteractionOperationLocks()
  private readonly lifecycleLocks = new HumanInteractionOperationLocks()
  private readonly commitSequence = new CommitSequence()
  private readonly recordSequences = new Map<string, number>()
  private nextRecordSequence = 0
  private readonly outcomeUnknown = new Set<string>()
  private storeClosed = false
  private accepting = true
  private admittedOperations = 0
  private readonly drainWaiters = new Set<() => void>()

  constructor(
    _ctx: Context,
    domain: Domain<typeof humanInteractionDomainSpec>,
  ) {
    this.interactions = domain.table('interactions')
    const existing = [...this.interactions.entries()]
      .filter(([key, record]) => key === humanInteractionKey(record.scope, record.request.teamId, record.request.requestId))
      .toSorted(([, left], [, right]) => left.createdAt - right.createdAt
        || left.request.requestId.localeCompare(right.request.requestId))
    for (const [key] of existing) this.recordSequences.set(key, ++this.nextRecordSequence)
  }

  private assertOpen(): void {
    if (this.storeClosed) throw new TeamDomainError('human interaction overlay store is closed', 'TEAM_INTERACTION_STORE_CLOSED')
  }

  /** Lifecycle probe only; reveals no record and performs no durable access. */
  assertAvailable(): void {
    this.assertOpen()
    if (!this.accepting) throw new TeamDomainError('human interaction surface is stopping', 'TEAM_INTERACTION_STOPPING')
  }

  /** Admit one public operation before it can touch Team or durable state. */
  async runAdmitted<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    this.admittedOperations += 1
    try {
      return await operation()
    } finally {
      this.admittedOperations -= 1
      if (this.admittedOperations === 0) {
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      }
    }
  }

  /** Serialize one complete request lifecycle across liaison and Control surfaces. */
  async runRequestExclusive<T>(scope: string, teamId: TeamId, requestId: string, operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    return await this.lifecycleLocks.run(scope, teamId, requestId, operation)
  }

  get(scope: string, teamId: TeamId, requestId: string): HumanInteractionRecord | undefined {
    this.assertOpen()
    const record = this.interactions.get(humanInteractionKey(scope, teamId, requestId))
    if (record !== undefined && (record.scope !== scope || record.request.teamId !== teamId)) {
      throw new TeamDomainError('human interaction durable key does not match its authority tuple', 'TEAM_INTERACTION_SCOPE_MISMATCH')
    }
    const legacy = this.interactions.get(legacyHumanInteractionKey(scope, requestId))
    if (legacy !== undefined && legacy.request.teamId === teamId) {
      throw new TeamDomainError('legacy human interaction key requires explicit migration', 'TEAM_INTERACTION_LEGACY_KEY_UNSUPPORTED')
    }
    return record === undefined ? undefined : structuredClone(record)
  }

  /** Process-local I1a quarantine for a possibly committed, uncorrelated effect. */
  quarantine(scope: string, teamId: TeamId, requestId: string): void {
    this.assertOpen()
    this.outcomeUnknown.add(humanInteractionKey(scope, teamId, requestId))
  }

  /** Durable marker is also honored when the best-effort quarantine write succeeded. */
  isOutcomeUnknown(scope: string, teamId: TeamId, requestId: string): boolean {
    this.assertOpen()
    if (this.outcomeUnknown.has(humanInteractionKey(scope, teamId, requestId))) return true
    return this.get(scope, teamId, requestId)?.receipt.code === 'TEAM_INTERACTION_OUTCOME_UNKNOWN'
  }

  /** List records filtered by workspace scope and/or Team, oldest first. */
  list(scope?: string, teamId?: TeamId): HumanInteractionRecord[] {
    this.assertOpen()
    return [...this.interactions.entries()]
      .filter(([, record]) => scope === undefined || record.scope === scope)
      .filter(([, record]) => teamId === undefined || record.request.teamId === teamId)
      .map(([key, record]) => {
        if (key !== humanInteractionKey(record.scope, record.request.teamId, record.request.requestId)) {
          throw new TeamDomainError('legacy or mismatched human interaction key requires explicit migration', 'TEAM_INTERACTION_LEGACY_KEY_UNSUPPORTED')
        }
        return record
      })
      .toSorted((left, right) => left.createdAt - right.createdAt || left.request.requestId.localeCompare(right.request.requestId))
      .map(record => structuredClone(record))
  }

  /**
   * Scan one immutable receipt snapshot with bounded retained memory. The
   * caller supplies an authenticated upper/after key; this store never owns
   * cursor authority and never exposes durable keys.
   */
  pageRecords(
    scope: string,
    teamId: TeamId,
    limit: number,
    after?: HumanInteractionPageKey,
    snapshotHighWater?: number,
  ): HumanInteractionRecordPage {
    this.assertOpen()
    const highWater = snapshotHighWater ?? this.nextRecordSequence
    const selected: HumanInteractionRecord[] = []
    for (const [key, record] of this.interactions.entries()) {
      if (record.scope !== scope || record.request.teamId !== teamId) continue
      if (key !== humanInteractionKey(record.scope, record.request.teamId, record.request.requestId)) {
        throw new TeamDomainError('legacy or mismatched human interaction key requires explicit migration', 'TEAM_INTERACTION_LEGACY_KEY_UNSUPPORTED')
      }
      const sequence = this.recordSequences.get(key)
      if (sequence === undefined || sequence > highWater) continue
      const pageKey = { createdAt: record.createdAt, requestId: record.request.requestId }
      if (after !== undefined && comparePageKey(pageKey, after) <= 0) continue
      const insertion = selected.findIndex(candidate => comparePageKey(pageKey, {
        createdAt: candidate.createdAt,
        requestId: candidate.request.requestId,
      }) < 0)
      if (selected.length < limit + 1) {
        if (insertion === -1) selected.push(record)
        else selected.splice(insertion, 0, record)
      } else if (insertion !== -1) {
        selected.pop()
        selected.splice(insertion, 0, record)
      }
    }
    return {
      records: selected.slice(0, limit).map(record => structuredClone(record)),
      snapshotHighWater: highWater,
      hasMore: selected.length > limit,
    }
  }

  /**
   * Commit one new record only when the request id is absent. Idempotency
   * keys never overwrite: the caller decides whether an existing record is a
   * legitimate duplicate or a conflicting replay.
   */
  async commitIfAbsent(record: HumanInteractionRecord): Promise<HumanInteractionRecord | undefined> {
    this.assertOpen()
    const normalized = parseStoredRecord(record)
    return await this.operationLocks.run(normalized.scope, normalized.request.teamId, normalized.request.requestId, async () => (
      await this.commitSequence.run(async () => {
        const key = humanInteractionKey(normalized.scope, normalized.request.teamId, normalized.request.requestId)
        const legacy = this.interactions.get(legacyHumanInteractionKey(normalized.scope, normalized.request.requestId))
        if (legacy !== undefined && legacy.request.teamId === normalized.request.teamId) {
          throw new TeamDomainError('legacy human interaction key requires explicit migration', 'TEAM_INTERACTION_LEGACY_KEY_UNSUPPORTED')
        }
        const existing = this.interactions.get(key)
        if (existing !== undefined) return structuredClone(existing)
        await this.interactions.put(key, normalized)
        this.recordSequences.set(key, ++this.nextRecordSequence)
        return undefined
      })
    ))
  }

  /**
   * Durably upsert one record. When `previousUpdatedAt` is supplied, the write
   * is fenced on the last observed receipt update so two stale transitions
   * cannot silently overwrite each other.
   */
  async update(
    record: HumanInteractionRecord,
    previousUpdatedAt?: number,
  ): Promise<HumanInteractionRecord> {
    this.assertOpen()
    const normalized = parseStoredRecord(record)
    return await this.operationLocks.run(normalized.scope, normalized.request.teamId, normalized.request.requestId, async () => {
      const key = humanInteractionKey(normalized.scope, normalized.request.teamId, normalized.request.requestId)
      const existing = this.interactions.get(key)
      if (existing === undefined) {
        throw new TeamDomainError(`interaction "${normalized.request.requestId}" not found`, 'TEAM_INTERACTION_NOT_FOUND')
      }
      if (previousUpdatedAt !== undefined && existing.receipt.updatedAt !== previousUpdatedAt) {
        throw new TeamDomainError(
          `interaction "${normalized.request.requestId}" changed since it was read`,
          'TEAM_INTERACTION_STATE_CONFLICT',
        )
      }
      if (existing.scope !== normalized.scope || existing.request.teamId !== normalized.request.teamId) {
        throw new TeamDomainError('interaction authority tuple cannot change', 'TEAM_INTERACTION_SCOPE_MISMATCH')
      }
      await this.interactions.put(key, normalized)
      return structuredClone(normalized)
    })
  }

  /** Stop admission and wait for already admitted operations to settle. */
  async stopAdmissionAndDrain(timeoutMs = 5_000): Promise<void> {
    this.assertOpen()
    this.accepting = false
    if (this.admittedOperations === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let drainResolve!: () => void
    const drained = new Promise<void>(resolve => {
      drainResolve = resolve
      this.drainWaiters.add(resolve)
    })
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TeamDomainError(
            'human interaction operations did not drain before disposal timeout',
            'TEAM_INTERACTION_DISPOSAL_TIMEOUT',
          )), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.drainWaiters.delete(drainResolve)
    }
  }

  /** Close only after a successful drain (the domain handle is owned by the caller). */
  close(): void {
    if (this.admittedOperations !== 0) {
      throw new TeamDomainError('cannot close human interaction overlay with admitted operations', 'TEAM_INTERACTION_DISPOSAL_TIMEOUT')
    }
    this.accepting = false
    this.storeClosed = true
    this.outcomeUnknown.clear()
  }
}

/**
 * Quarantine a possibly committed effect without persisting raw adapter or
 * storage errors. The durable marker is best-effort; the in-process marker is
 * mandatory and blocks replay, cancel and expiry reconciliation.
 */
export async function quarantineInteractionOutcome(
  overlay: HumanInteractionOverlayStore,
  scope: string,
  teamId: TeamId,
  requestId: string,
  now: () => number,
): Promise<void> {
  overlay.quarantine(scope, teamId, requestId)
  const current = overlay.get(scope, teamId, requestId)
  if (current === undefined || (current.receipt.status !== 'pending' && current.receipt.status !== 'acknowledged')) return
  const marked: HumanInteractionRecord = {
    ...current,
    receipt: {
      ...current.receipt,
      code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
      diagnostic: 'effect outcome unknown; reconciliation required',
      updatedAt: now(),
    },
    updatedAt: now(),
  }
  await overlay.update(marked, current.receipt.updatedAt).catch(() => undefined)
}
