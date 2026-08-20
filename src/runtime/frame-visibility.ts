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
import { messageAccepted, messageClaimed, messagePending } from './session-acceptance.js'

/**
 * Bounded wait for a waking frame's claim at the target's next turn
 * boundary. An idle or cold target claims within its first pre-step
 * (milliseconds on a warm host; a cold runner's first member assemble can
 * take seconds); a member mid-turn claims when the running turn ends, which
 * can be long — the grace expires, the delivery debt stays unsettled, and
 * the target's `agent/status → idle` edge re-runs the pass that completes
 * the acknowledgement on the claimed form.
 */
const WAKEUP_CLAIM_GRACE_MS = 5_000

/** One frame's visibility fold over a target's durable facts. */
export type FrameVisibility = 'claimed' | 'pending' | 'absent' | 'unknown'

/** Identity predicate matching the exact framed text block of one delivery. */
export function framePredicate(frame: string): (message: UserMessage) => boolean {
  return candidate => candidate.content.some(block => block.type === 'text' && block.text === frame)
}

/** Fold one live Session's non-inherited suffix for an acceptance check. */
export function sessionAccepts(session: Session, predicate: (message: UserMessage) => boolean): boolean {
  return messageAccepted(session.events.slice(session.header.seedLength ?? 0), predicate)
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
): Promise<boolean> {
  const predicate = framePredicate(frame)
  const deadline = Date.now() + graceMs
  for (;;) {
    if (messageClaimed(target.session.events, predicate)) {
      await ctx.sessions.flush(target.session)
      if (messageClaimed(target.session.events, predicate)) return true
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
 * not be inspected or the flush failed, and uncertainty keeps the debt
 * unsettled rather than risk a duplicate model-visible delivery.
 */
export async function frameVisibility(
  ctx: Context,
  targetSessionId: string,
  frame: string,
  signal: AbortSignal,
  label: string,
): Promise<FrameVisibility> {
  const predicate = framePredicate(frame)
  const read = (events: readonly SessionEvent[]): FrameVisibility => {
    if (messageClaimed(events, predicate)) return 'claimed'
    return messagePending(events, predicate) ? 'pending' : 'absent'
  }
  const live = ctx.agents.get(SessionId(targetSessionId))
  if (live !== undefined) {
    if (!sessionAccepts(live.session, predicate)) return 'absent'
    try {
      await ctx.sessions.flush(live.session)
    } catch (error) {
      ctx.logger.warn(`agent-swarm: ${label} acceptance flush failed: ${String(error)}`)
      return 'unknown'
    }
    return read(live.session.events)
  }
  try {
    const stored = await ctx.sessionPersistence.inspect(SessionId(targetSessionId), signal)
    return read(stored.events.slice(stored.meta.seedLength ?? 0))
  } catch (error) {
    ctx.logger.warn(`agent-swarm: ${label} target ${targetSessionId} cannot be reconciled: ${String(error)}`)
    return 'unknown'
  }
}
