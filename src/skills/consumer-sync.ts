/**
 * The consumer advance planner (root contract ① + ②): pure functions over ONE
 * official Team-aggregate snapshot — no second `workActivity` read, no mixed
 * snapshots. Per Team at most ONE un-acked bounded batch (≤ pageSize ≤ 100
 * refs carrying kind) is durable; an un-acked batch is RE-SERVED, never
 * extended, never evicted, and re-serving captures nothing. Durable observed
 * seq-ID anchors (≤ 1024, aligned with official source retention) detect a
 * replaced ID at a retained sequence INSIDE the observable window only — no
 * claims outside it. needsResync is STICKY: once a gap, regression, or
 * replaced ID is seen, no ordinary read clears it (only an out-of-band
 * recovery decision may, which S1 never performs automatically). Ledger
 * items are kept by stable identity — deduplicated, never silently lost;
 * overflow past the ledger cap is marked, not quietly sliced. A broken first
 * slice stops and reports the needed recovery instead of rebuilding a cursor.
 *
 * @module dsh-agent-swarm/skills/consumer-sync
 */
import { createHash } from 'node:crypto'
import type { WorkActivity } from '../domain/work-request.js'
import type { SkillsSyncPage } from './contracts.js'
import {
  canonicalJson,
  type SkillsConsumerAnchor,
  type SkillsConsumerBatchRef,
  type SkillsConsumerRecord,
} from '../storage/skills-management.js'

/** The ONE aggregate snapshot every consumer watermark is derived from. */
export interface ConsumerSourceSnapshot {
  readonly found: boolean
  readonly archived: boolean
  readonly hasWorkActivity: boolean
  readonly retained: readonly WorkActivity[]
  readonly nextSequence: number
  readonly teamRevision: number
  readonly taskWatermarks: readonly { readonly taskId: string; readonly revision: number; readonly status: string; readonly currentAttemptId?: string }[]
}

export interface ConsumerPageView {
  readonly entries: readonly SkillsConsumerBatchRef[]
  readonly hasMore: boolean
  readonly batchId?: string
  readonly reServed: boolean
  readonly sourceState: SkillsConsumerRecord['sourceState']
}

export interface ConsumerPlan {
  /** False means the advance is a pure re-serve (or terminal silence): zero writes. */
  readonly mutate: boolean
  /** The record identity this plan was derived from; the commit callback re-checks it. */
  readonly basis: { readonly cursorSequence: number; readonly batchId?: string }
  readonly next: (current: SkillsConsumerRecord) => Omit<SkillsConsumerRecord, 'schemaVersion' | 'scope' | 'teamId' | 'updatedAt'>
  readonly page: ConsumerPageView
}

const LEDGER_CAP = 1024
const ANCHOR_CAP = 1024

/** Deterministic batch identity over the exact captured refs (survives restarts). */
export function skillsBatchId(refs: readonly SkillsConsumerBatchRef[]): string {
  const tail = refs.at(-1)?.sequence ?? 0
  const digest = createHash('sha256').update(canonicalJson(refs), 'utf8').digest('hex').slice(0, 16)
  return `batch:${tail}:${digest}`
}

/** Canonical ack payload: the idempotency discriminator for `lastAck` read-back. */
export function skillsAckHash(batchId: string, outcome: string, refs: readonly SkillsConsumerBatchRef[]): string {
  return createHash('sha256').update(canonicalJson({ batchId, outcome, refs }), 'utf8').digest('hex')
}

function toBatchRef(entry: WorkActivity): SkillsConsumerBatchRef {
  return {
    sequence: entry.sequence,
    id: entry.id,
    kind: entry.kind,
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
    ...(entry.attemptId === undefined ? {} : { attemptId: entry.attemptId }),
    ...(entry.workRequestId === undefined ? {} : { workRequestId: entry.workRequestId }),
  }
}

/**
 * Dedup by stable identity and keep the outstanding items. Items beyond the
 * cap are never silently dropped: the flag records that the ledger overflowed
 * so the reader knows the window, while needsResync keeps the condition alive.
 */
function appendLedger<T>(existing: readonly T[], additions: readonly T[], identity: (value: T) => string, alreadyTruncated: boolean): { items: T[]; truncated: boolean } {
  const seen = new Set(existing.map(identity))
  const merged = [...existing]
  for (const addition of additions) {
    const key = identity(addition)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(addition)
  }
  return { items: merged.slice(0, LEDGER_CAP), truncated: alreadyTruncated || merged.length > LEDGER_CAP }
}

/**
 * Seq-ID anchor window (≤ 1024, official-retention aligned): keep every
 * observed identity while the window is not full — only genuine beyond-window
 * overflow drops the OLDEST anchors, counted loudly.
 */
function appendAnchors(existing: readonly SkillsConsumerAnchor[], additions: readonly SkillsConsumerAnchor[], existingDropped: number): { anchors: SkillsConsumerAnchor[]; dropped: number } {
  const bySeq = new Map(existing.map(anchor => [anchor.sequence, anchor]))
  let added = 0
  for (const anchor of additions) {
    if (bySeq.has(anchor.sequence)) continue
    bySeq.set(anchor.sequence, anchor)
    added += 1
  }
  const sorted = [...bySeq.values()].toSorted((left, right) => left.sequence - right.sequence)
  const overflow = Math.max(0, sorted.length - ANCHOR_CAP)
  return { anchors: sorted.slice(Math.max(0, sorted.length - ANCHOR_CAP)), dropped: existingDropped + overflow }
}

/**
 * Plan one consumer advance from ONE snapshot. Every durability-relevant
 * outcome is explicit: re-serve (`mutate: false`), captured batch, regression,
 * gap, replaced ID (conflict), archived, missing, legacy.
 */
export function planConsumerAdvance(
  consumer: SkillsConsumerRecord,
  snapshot: ConsumerSourceSnapshot,
  pageSize: number,
  observedAt: number,
): ConsumerPlan {
  const basis = {
    cursorSequence: consumer.cursorSequence,
    ...(consumer.pendingBatch === undefined ? {} : { batchId: consumer.pendingBatch.batchId }),
  }
  const through = Math.max(snapshot.nextSequence - 1, 0)
  const gapAdditions: SkillsConsumerRecord['gaps'] = []
  const conflictAdditions: SkillsConsumerRecord['conflicts'] = []

  // Replaced-ID detection over the retained ∩ observed (anchors + batch) window.
  const observed = new Map<number, string>(consumer.anchors.map(anchor => [anchor.sequence, anchor.id]))
  for (const ref of consumer.pendingBatch?.refs ?? []) observed.set(ref.sequence, ref.id)
  for (const entry of snapshot.retained) {
    const known = observed.get(entry.sequence)
    if (known !== undefined && known !== entry.id) {
      conflictAdditions.push({ sequence: entry.sequence, expectedEventId: known, actualEventId: entry.id, observedAt })
    }
  }
  // Regression: the durable cursor sits ahead of the source head.
  const regressed = snapshot.found && snapshot.hasWorkActivity && through < consumer.cursorSequence
  let regression = consumer.sourceRegression
  if (regressed) regression = regression ?? { cursorSequence: consumer.cursorSequence, observedThroughSequence: through, observedAt }
  // Retention gap ahead of the cursor (explicit window stop, never a rebuild).
  else if (snapshot.found && snapshot.hasWorkActivity) {
    const retainedFrom = snapshot.retained[0]?.sequence
    if (retainedFrom !== undefined && retainedFrom > consumer.cursorSequence + 1) {
      gapAdditions.push({ fromSequence: consumer.cursorSequence + 1, toSequence: retainedFrom - 1, observedAt })
    } else if (snapshot.retained.length === 0 && through > consumer.cursorSequence) {
      gapAdditions.push({ fromSequence: consumer.cursorSequence + 1, toSequence: through, observedAt })
    }
  }

  const gaps = appendLedger(consumer.gaps, gapAdditions, gap => `${gap.fromSequence}:${gap.toSequence}`, consumer.gapsTruncated)
  const conflicts = appendLedger(consumer.conflicts, conflictAdditions, c => `${c.sequence}:${c.expectedEventId}:${c.actualEventId}`, consumer.conflictsTruncated)
  const gapsChanged = JSON.stringify(gaps.items) !== JSON.stringify(consumer.gaps) || gaps.truncated !== consumer.gapsTruncated
  const conflictsChanged = JSON.stringify(conflicts.items) !== JSON.stringify(consumer.conflicts) || conflicts.truncated !== consumer.conflictsTruncated
  const hasLedgerDelta = gapsChanged || conflictsChanged

  const sourceState: SkillsConsumerRecord['sourceState'] = !snapshot.found
    ? 'missing'
    : snapshot.archived
      ? 'archived'
      : 'available'

  // STICKY by contract: once set, NO ordinary read clears needsResync — not a
  // repaired source, not conditions leaving the retained window. Recovery is
  // an explicit out-of-band decision, which the first slice never makes.
  // An unavailable (missing) source is itself a resync-grade condition.
  const conditionsNow = regressed || conflictAdditions.length > 0 || gapAdditions.length > 0 || sourceState === 'missing'
  const needsResync = consumer.needsResync || conditionsNow
  const settledTerminal = consumer.sourceState === sourceState && !hasLedgerDelta && consumer.sourceRegression === regression && consumer.needsResync === needsResync
  if (settledTerminal && (sourceState === 'archived' || sourceState === 'missing')) {
    // Terminal source states replay with ZERO writes once durably recorded.
    return {
      mutate: false,
      basis,
      next: current => current,
      page: { entries: [], hasMore: false, reServed: false, sourceState },
    }
  }

  const baseline = consumer.baseline ?? (snapshot.found ? {
    capturedTeamRevision: snapshot.teamRevision,
    ...(snapshot.hasWorkActivity ? { retainedFromSequence: snapshot.retained[0]?.sequence ?? snapshot.nextSequence } : {}),
    throughSequence: through,
    legacyNoWorkActivity: !snapshot.hasWorkActivity,
    taskWatermarks: snapshot.taskWatermarks.slice(0, 400).map(mark => ({
      taskId: mark.taskId,
      revision: mark.revision,
      status: mark.status,
      ...(mark.currentAttemptId === undefined ? {} : { currentAttemptId: mark.currentAttemptId }),
    })),
  } : undefined)
  const needsBaseline = baseline !== undefined && consumer.baseline === undefined

  const ledgerFields = {
    gaps: gaps.items,
    gapsTruncated: gaps.truncated,
    conflicts: conflicts.items,
    conflictsTruncated: conflicts.truncated,
    ...(regression === undefined ? {} : { sourceRegression: regression }),
    sourceState,
    needsResync,
  } as const
  const regressionDelta = regression !== undefined && consumer.sourceRegression === undefined

  // Un-acked pending batch: RE-SERVE it — never capture the next page, never
  // evict refs; ledger bookkeeping may still land, the cursor/batch stay put.
  if (consumer.pendingBatch !== undefined) {
    return {
      mutate: hasLedgerDelta || regressionDelta || consumer.sourceState !== sourceState || needsResync !== consumer.needsResync || needsBaseline,
      basis,
      next: current => ({ ...current, ...ledgerFields, ...(baseline === undefined ? {} : { baseline }) }),
      page: {
        entries: consumer.pendingBatch.refs,
        hasMore: snapshot.hasWorkActivity && through > consumer.cursorSequence,
        batchId: consumer.pendingBatch.batchId,
        reServed: true,
        sourceState,
      },
    }
  }

  // The caught-up / resync-stop ANSWER is the same empty page: ledger
  // bookkeeping may still land, but no batch is captured over a broken or
  // exhausted window. One shared plan; both callers keep their own trigger.
  const emptyPagePlan = (): ConsumerPlan => ({
    mutate: hasLedgerDelta || regressionDelta || consumer.sourceState !== sourceState || needsBaseline,
    basis,
    next: current => ({ ...current, ...ledgerFields, ...(baseline === undefined ? {} : { baseline }) }),
    page: { entries: [], hasMore: false, reServed: false, sourceState },
  })

  // A conflict, gap, regression, or an outstanding resync stops the first
  // slice explicitly: no new batch is captured over a broken window.
  if (needsResync) return emptyPagePlan()

  const beyond = snapshot.hasWorkActivity ? snapshot.retained.filter(entry => entry.sequence > consumer.cursorSequence) : []
  const captured = beyond.slice(0, pageSize)
  if (captured.length === 0) {
    // Caught up: no batch to capture; stay silent unless the ledger moved.
    return emptyPagePlan()
  }

  const refs = captured.map(toBatchRef)
  const batchId = skillsBatchId(refs)
  const anchors = appendAnchors(consumer.anchors, refs.map(ref => ({ sequence: ref.sequence, id: ref.id })), consumer.anchorsDropped)
  const tail = refs.at(-1)!
  return {
    mutate: true,
    basis,
    next: current => ({
      ...current,
      ...ledgerFields,
      ...(baseline === undefined ? {} : { baseline }),
      cursorSequence: tail.sequence,
      lastEventId: tail.id,
      pendingBatch: { batchId, capturedAt: observedAt, refs },
      anchors: anchors.anchors,
      anchorsDropped: anchors.dropped,
    }),
    page: { entries: refs, hasMore: beyond.length > captured.length, batchId, reServed: false, sourceState },
  }
}

/** Honest projection of the POST-COMMIT record + this advance's page view. */
export function projectConsumerPage(consumer: SkillsConsumerRecord, plan: ConsumerPlan): SkillsSyncPage {
  return {
    sourceState: plan.page.sourceState,
    needsResync: consumer.needsResync,
    cursorSequence: consumer.cursorSequence,
    throughSequence: consumer.baseline?.throughSequence ?? 0,
    ...(consumer.baseline?.retainedFromSequence === undefined ? {} : { retainedFromSequence: consumer.baseline.retainedFromSequence }),
    hasMore: plan.page.hasMore,
    reServed: plan.page.reServed,
    pending: consumer.pendingBatch !== undefined,
    ...(plan.page.batchId === undefined ? {} : { batchId: plan.page.batchId }),
    legacyNoWorkActivity: consumer.baseline?.legacyNoWorkActivity ?? false,
    gaps: consumer.gaps,
    gapsTruncated: consumer.gapsTruncated,
    conflicts: consumer.conflicts,
    conflictsTruncated: consumer.conflictsTruncated,
    entries: plan.page.entries,
  }
}
