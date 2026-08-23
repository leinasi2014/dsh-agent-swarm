/**
 * The `agent_swarm_human` Storage Domain (SW-I1a): the additive
 * durable boundary of HumanInteraction request/receipt records. One record per
 * authoritative workspace scope + request id in the `interactions` table. The record family is correlation and
 * audit only — Team membership/tasks/mailbox stay canonical in `agent_swarm`,
 * and relay Agents never write either domain directly.
 *
 * Kept as a separate domain from `agent_swarm` following the workflow overlay
 * precedent: the Team aggregate's unit keeps its frozen version stamp, while
 * the interaction record family owns its own schema lifecycle.
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import type { TeamId } from '../domain/types.js'
import {
  HUMAN_INTERACTION_ID_PATTERN,
  type HumanInteractionRecord,
} from './human-interaction-contract.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const HUMAN_INTERACTION_DOMAIN_NAME = 'agent_swarm_human'
/** Domain format version; a medium stamped differently rejects at open. */
export const HUMAN_INTERACTION_DOMAIN_VERSION = 1

/** Collision-free durable/lock key; request ids are idempotent only inside one authoritative scope. */
function humanInteractionKey(scope: string, requestId: string): string {
  return JSON.stringify([scope, requestId])
}

/** Shared process-local serializer for one scope-bound interaction request. */
class HumanInteractionOperationLocks {
  private readonly locks = new Map<string, Promise<void>>()

  async run<T>(scope: string, requestId: string, operation: () => Promise<T>): Promise<T> {
    const key = humanInteractionKey(scope, requestId)
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

const timestamp = z.number().int().min(0)
const sessionId = z.string().min(1)

const sourceSchema = z.object({
  kind: z.enum(['captain-mediated', 'authenticated-human']),
  captainSessionId: sessionId,
  principalRef: z.string().min(1).optional(),
  hostSurface: z.string().min(1).optional(),
})

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('captain') }),
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('member'), memberName: z.string().min(1) }),
  z.object({ kind: z.literal('task'), taskId: z.string().min(1) }),
])

const originSchema = z.object({
  kind: z.literal('member'),
  memberSessionId: sessionId,
  memberName: z.string().min(1),
})

const requestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(HUMAN_INTERACTION_ID_PATTERN),
  teamId: z.string().min(1),
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
  body: z.string().min(1).optional(),
  expectedTeamRevision: z.number().int().min(1),
  expectedTaskRevision: z.number().int().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  decision: z.enum(['accept', 'reject']).optional(),
  diagnostic: z.string().min(1).optional(),
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
})

const receiptSchema = z.object({
  requestId: z.string().regex(HUMAN_INTERACTION_ID_PATTERN),
  teamId: z.string().min(1),
  status: z.enum(['pending', 'acknowledged', 'executed', 'rejected', 'failed', 'expired', 'cancelled']),
  routedMessageId: z.string().min(1).optional(),
  answerMessageId: z.string().min(1).optional(),
  resultingTaskId: z.string().min(1).optional(),
  resultingTeamRevision: z.number().int().min(1).optional(),
  code: z.string().min(1).optional(),
  diagnostic: z.string().min(1).optional(),
  updatedAt: timestamp,
})

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.string().min(1),
  request: requestSchema,
  receipt: receiptSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
})

// Single contained type-erasure: the zod object owns runtime validation at
// the durable boundary; `HumanInteractionRecord` is its precise in-memory
// projection (the team-spec/workflow-overlay pattern).
const storedRecordSchema = recordSchema as unknown as z.ZodType<HumanInteractionRecord>

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
  private readonly outcomeUnknown = new Set<string>()
  private storeClosed = false

  constructor(
    _ctx: Context,
    domain: Domain<typeof humanInteractionDomainSpec>,
  ) {
    this.interactions = domain.table('interactions')
  }

  private assertOpen(): void {
    if (this.storeClosed) throw new TeamDomainError('human interaction overlay store is closed', 'TEAM_INTERACTION_STORE_CLOSED')
  }

  /** Lifecycle probe only; reveals no record and performs no durable access. */
  assertAvailable(): void {
    this.assertOpen()
  }

  /** Serialize one complete request lifecycle across liaison and Control surfaces. */
  async runRequestExclusive<T>(scope: string, requestId: string, operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    return await this.lifecycleLocks.run(scope, requestId, operation)
  }

  get(scope: string, requestId: string): HumanInteractionRecord | undefined {
    this.assertOpen()
    const record = this.interactions.get(humanInteractionKey(scope, requestId))
    if (record !== undefined && record.scope !== scope) {
      throw new TeamDomainError('human interaction durable key does not match its authoritative scope', 'TEAM_INTERACTION_SCOPE_MISMATCH')
    }
    return record === undefined ? undefined : structuredClone(record)
  }

  /** Process-local I1a quarantine for a possibly committed, uncorrelated effect. */
  quarantine(scope: string, requestId: string): void {
    this.assertOpen()
    this.outcomeUnknown.add(humanInteractionKey(scope, requestId))
  }

  /** Durable marker is also honored when the best-effort quarantine write succeeded. */
  isOutcomeUnknown(scope: string, requestId: string): boolean {
    this.assertOpen()
    if (this.outcomeUnknown.has(humanInteractionKey(scope, requestId))) return true
    return this.get(scope, requestId)?.receipt.code === 'TEAM_INTERACTION_OUTCOME_UNKNOWN'
  }

  /** List records filtered by workspace scope and/or Team, oldest first. */
  list(scope?: string, teamId?: TeamId): HumanInteractionRecord[] {
    this.assertOpen()
    return [...this.interactions.entries()]
      .map(([, record]) => record)
      .filter(record => scope === undefined || record.scope === scope)
      .filter(record => teamId === undefined || record.request.teamId === teamId)
      .toSorted((left, right) => left.createdAt - right.createdAt || left.request.requestId.localeCompare(right.request.requestId))
      .map(record => structuredClone(record))
  }

  /**
   * Commit one new record only when the request id is absent. Idempotency
   * keys never overwrite: the caller decides whether an existing record is a
   * legitimate duplicate or a conflicting replay.
   */
  async commitIfAbsent(record: HumanInteractionRecord): Promise<HumanInteractionRecord | undefined> {
    this.assertOpen()
    return await this.operationLocks.run(record.scope, record.request.requestId, async () => {
      const key = humanInteractionKey(record.scope, record.request.requestId)
      const existing = this.interactions.get(key)
      if (existing !== undefined) return structuredClone(existing)
      await this.interactions.put(key, structuredClone(record))
      return undefined
    })
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
    return await this.operationLocks.run(record.scope, record.request.requestId, async () => {
      const key = humanInteractionKey(record.scope, record.request.requestId)
      const existing = this.interactions.get(key)
      if (existing === undefined) {
        throw new TeamDomainError(`interaction "${record.request.requestId}" not found`, 'TEAM_INTERACTION_NOT_FOUND')
      }
      if (previousUpdatedAt !== undefined && existing.receipt.updatedAt !== previousUpdatedAt) {
        throw new TeamDomainError(
          `interaction "${record.request.requestId}" changed since it was read`,
          'TEAM_INTERACTION_STATE_CONFLICT',
        )
      }
      if (existing.scope !== record.scope || existing.request.teamId !== record.request.teamId) {
        throw new TeamDomainError('interaction authority tuple cannot change', 'TEAM_INTERACTION_SCOPE_MISMATCH')
      }
      await this.interactions.put(key, structuredClone(record))
      return structuredClone(record)
    })
  }

  /** Stop accepting operations (the domain handle itself is closed by the owner). */
  close(): void {
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
  requestId: string,
  now: () => number,
): Promise<void> {
  overlay.quarantine(scope, requestId)
  const current = overlay.get(scope, requestId)
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
