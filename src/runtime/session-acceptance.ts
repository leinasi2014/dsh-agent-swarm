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

/** One fold for pending input and the current turn's dequeued proposals. */
function inboxMessages(events: readonly SessionEvent[]): { pending: UserMessage[]; inFlight: UserMessage[] } {
  const inbox: InboxProjection = { 'next-turn': [], 'next-step': [] }
  const inFlight = new Map<string, UserMessage>()
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data.turn; inFlight.clear() }
    if (event.type === 'turn/end' && event.data.turn === turn) { turn = undefined; inFlight.clear() }
    if (event.type === 'user/message') inFlight.delete(event.data.id)
    if (event.type !== 'agent/inbox/spliced') continue
    const pending = inbox[event.data.target]
    const removed = pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
    // Official claim() removes input before asynchronous assembly/pre-step/
    // request preparation. Explicit remove/clear instead records canceled.
    if (turn !== undefined && event.data.outcome !== 'canceled') {
      for (const message of removed) inFlight.set(message.id, message)
    }
  }
  return { pending: [...inbox['next-turn'], ...inbox['next-step']], inFlight: [...inFlight.values()] }
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
  return inboxMessages(events).pending.some(predicate)
}

/** A proposed message may still enter history only while its exact driver is
 * live and running. Callers must establish that lifetime; a cold interrupted
 * turn cannot retain this reservation, and this is never an acknowledgement.
 */
export function messageInFlight(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): boolean {
  return inboxMessages(events).inFlight.some(predicate)
}
