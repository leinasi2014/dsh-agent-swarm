/**
 * Durable Session-message acceptance checks shared by mailbox delivery
 * (M1B/F2) and persisted-child provisioning reconciliation (M1B/F3).
 *
 * The fold is the official acceptance notion (experimental agent-team
 * `session-message.ts`): a user-role message counts as accepted by a Session
 * when it is model-visible history (`user/message`) or still pending in the
 * durable inbox projection (`agent/inbox/spliced`), always within the
 * Session's non-inherited event suffix.
 *
 * The pending-inbox half is a TRANSIENT acceptance: official turn lifecycle
 * paths (an aborted turn's teardown, an Activation disposal drain) may clear
 * unclaimed inbox work, so a still-pending frame is not yet a stable delivery
 * fact for waking mail (issue #52 / D1). Waking delivery therefore separates
 * the two forms: {@link messageClaimed} observes only the claimed,
 * model-visible history form, while {@link messagePending} observes only the
 * unclaimed projection.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

type InboxProjection = Record<'next-turn' | 'next-step', UserMessage[]>

/** Fold the durable inbox suffix into the messages still awaiting a claim. */
function pendingInboxMessages(events: readonly SessionEvent[]): UserMessage[] {
  const inbox: InboxProjection = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const pending = inbox[event.data.target]
    pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  return [...inbox['next-turn'], ...inbox['next-step']]
}

/**
 * Whether target history or its still-pending inbox already contains a match.
 */
export function messageAccepted(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): boolean {
  return messageClaimed(events, predicate) || messagePending(events, predicate)
}

/**
 * Whether the claimed, model-visible history already contains a match — the
 * stable acceptance form no turn lifecycle can discard (issue #52 / D1).
 */
export function messageClaimed(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): boolean {
  return events.some(event => event.type === 'user/message' && predicate(event.data))
}

/**
 * Whether the still-pending (unclaimed) inbox projection contains a match —
 * the transient acceptance form official teardown may still discard.
 */
export function messagePending(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): boolean {
  return pendingInboxMessages(events).some(predicate)
}
