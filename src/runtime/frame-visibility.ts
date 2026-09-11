/**
 * Waking frame claim visibility (issues #52 / D1 and #60 / P2-1): the
 * durable claim-observation seam shared by mailbox delivery and assignment
 * dispatch. Every waking delivery — a wakeup message and an assignment
 * prompt alike — is a subagent followup, and a followup's return only proves
 * inbox ADMISSION: the pending-inbox form is transient (official turn
 * lifecycle paths — an aborted turn's teardown, an Activation disposal
 * drain — clear unclaimed inbox work), while the claimed `user/message`
 * history form is the only acceptance no turn lifecycle can discard.
 *
 * Two observations live here: the bounded in-send wait for one frame's
 * claim, and the live-or-persisted three-form fold used by every rescan and
 * reserved-attempt reconciliation. The pure claimed/pending predicates stay
 * in `session-acceptance.ts`; this module adds the ctx-bound durability
 * discipline (flush before confirming a live claim) the callers share.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { messageAccepted, messageClaimed, messageInFlight, messagePending } from './session-acceptance.js'
import { readPersistedSession } from './persisted-session.js'

/**
 * Bounded wait for a waking frame's claim at the target's next turn
 * or step boundary. An idle or cold target claims within its first pre-step
 * (milliseconds on a warm host; a cold runner's first member assemble can
 * take seconds); a busy member claims at the nearest later step, which
 * can be long — the grace expires, the delivery debt stays unsettled, and
 * the target's `agent/status → idle` edge re-runs the pass that completes
 * the acknowledgement on the claimed form.
 */
const WAKEUP_CLAIM_GRACE_MS = 5_000

/** One frame's visibility fold over a target's durable facts. */
export type FrameVisibility = 'claimed' | 'pending' | 'absent' | 'unknown'
export interface FramePredicates {
  readonly identity: (message: UserMessage) => boolean
  readonly complete: (message: UserMessage) => boolean
  readonly onMismatch?: () => void
}

/** Identity predicate matching the exact framed text block of one delivery. */
export function framePredicate(frame: string): (message: UserMessage) => boolean {
  return candidate => candidate.content.some(block => block.type === 'text' && block.text === frame)
}

/** Fold one live Session's non-inherited suffix for an acceptance check. */
export function sessionAccepts(session: Session, predicate: (message: UserMessage) => boolean): boolean {
  return messageAccepted(session.snapshotEvents().slice(session.inheritedEventCount), predicate)
}

/**
 * Wait for one waking frame's CLAIM into the target's model-visible history
 * (issue #52 / D1, generalized to assignments by issue #60): the durable
 * claim is the acceptance form no official turn lifecycle can discard.
 * Flushes before each observation so a confirmed claim is already durable.
 * `false` keeps the delivery debt unsettled — pending-only acceptance is
 * transient and must not be acknowledged.
 */
export async function waitForFrameClaim(
  ctx: Context,
  target: Agent,
  frame: string,
  signal: AbortSignal,
  graceMs: number = WAKEUP_CLAIM_GRACE_MS,
  requireDurableFlush = false,
  predicates?: FramePredicates,
  throwOnFailure = false,
): Promise<boolean> {
  const predicate = predicates?.complete ?? framePredicate(frame)
  const identity = predicates?.identity ?? predicate
  const own = () => target.session.snapshotEvents().slice(target.session.inheritedEventCount)
  const mismatch = (events: readonly SessionEvent[]) => messageAccepted(events, message => identity(message) && !predicate(message))
  const deadline = Date.now() + graceMs
  for (;;) {
    if (requireDurableFlush && (ctx.agents.get(target.id) !== target || ctx.sessions.get(target.id) !== target.session)) {
      return await frameVisibility(ctx, target.id, frame, signal, 'public claim after activation change', true, predicates, throwOnFailure) === 'claimed'
    }
    if (mismatch(own())) { predicates?.onMismatch?.(); return false }
    if (messageClaimed(own(), predicate)) {
      let durable: boolean
      try { durable = await ctx.sessions.flush(target.session) } catch (error) {
        if (!requireDurableFlush || throwOnFailure) throw error
        return await frameVisibility(ctx, target.id, frame, signal, 'public claim checkpoint changed', true, predicates, throwOnFailure) === 'claimed'
      }
      if (requireDurableFlush && durable !== true) return false
      if (requireDurableFlush && (ctx.agents.get(target.id) !== target || ctx.sessions.get(target.id) !== target.session)) {
        return await frameVisibility(ctx, target.id, frame, signal, 'public claim after flush activation change', true, predicates, throwOnFailure) === 'claimed'
      }
      const events = own()
      if (mismatch(events)) { predicates?.onMismatch?.(); return false }
      if (messageClaimed(events, predicate)) return true
    }
    if (signal.aborted || Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Fold one target's durable facts for one waking frame (M1B/F2 discipline,
 * the #60 assignment isomorph of the message rescan fold): a live target is
 * flushed before its acceptance is confirmed, a cold target is inspected
 * through the persisted Session suffix. `claimed` — the frame is model-
 * visible history and the store acknowledgement is the only debt; `pending`
 * — the frame sits unclaimed in the durable inbox projection (transient;
 * neither acknowledged nor resent); `absent` — no acceptance exists
 * anywhere, so redelivery is owed; `unknown` — the persisted target could
 * not be inspected, the flush failed, or its live driver has dequeued the
 * exact input for a proposed step but has not appended it to history yet.
 * Uncertainty keeps the debt unsettled rather than risking a duplicate.
 */
export async function frameVisibility(
  ctx: Context,
  targetSessionId: string,
  frame: string,
  signal: AbortSignal,
  label: string,
  requireDurableFlush = false,
  predicates?: FramePredicates,
  throwOnFailure = false,
): Promise<FrameVisibility> {
  const predicate = predicates?.complete ?? framePredicate(frame)
  const identity = predicates?.identity ?? predicate
  const read = (events: readonly SessionEvent[], includeInFlight = false): FrameVisibility => {
    if (messageAccepted(events, message => identity(message) && !predicate(message))) { predicates?.onMismatch?.(); return 'unknown' }
    if (includeInFlight && messageInFlight(events, identity)) {
      if (messageInFlight(events, message => identity(message) && !predicate(message))) predicates?.onMismatch?.()
      return 'unknown'
    }
    if (messageClaimed(events, predicate)) return 'claimed'
    return messagePending(events, predicate) ? 'pending' : 'absent'
  }
  const live = ctx.agents.get(SessionId(targetSessionId))
  if (live !== undefined) {
    const own = () => live.session.snapshotEvents().slice(live.session.inheritedEventCount)
    // A real driver may have removed the frame from its Inbox while awaiting
    // assembly, pre-step or prepareRequest. Absence is not proven in that gap.
    if (!sessionAccepts(live.session, identity) && !(live.status === 'running' && messageInFlight(own(), identity))) return 'absent'
    try {
      const durable = await ctx.sessions.flush(live.session)
      if (requireDurableFlush && durable !== true) return 'unknown'
    } catch (error) {
      if (throwOnFailure) throw error
      ctx.logger.warn(`agent-swarm: ${label} acceptance flush failed: ${String(error)}`)
      return 'unknown'
    }
    if (ctx.agents.get(live.id) !== live || ctx.sessions.get(live.id) !== live.session) return 'unknown'
    return read(own(), live.status === 'running')
  }
  try {
    const stored = await readPersistedSession(ctx.sessionPersistence, SessionId(targetSessionId), signal)
    return read(stored.events.slice(stored.inheritedEventCount ?? 0))
  } catch (error) {
    if (throwOnFailure) throw error
    ctx.logger.warn(`agent-swarm: ${label} target ${targetSessionId} cannot be reconciled: ${String(error)}`)
    return 'unknown'
  }
}
