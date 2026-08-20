/**
 * Durable Session-message acceptance checks shared by mailbox delivery
 * (M1B/F2) and persisted-child provisioning reconciliation (M1B/F3).
 *
 * The fold is the official acceptance notion (experimental agent-team
 * `session-message.ts`): a user-role message counts as accepted by a Session
 * when it is model-visible history (`user/message`) or still pending in the
 * durable inbox projection (`agent/inbox/spliced`), always within the
 * Session's non-inherited event suffix.
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
  return events.some(event => event.type === 'user/message' && predicate(event.data))
    || pendingInboxMessages(events).some(predicate)
}
