/**
 * Durable-before-delivery Team mailbox delivery.
 *
 * Messages reach this collaborator only after the authoritative store has
 * committed them as queued. Delivery serializes per message id; the store
 * acknowledgement happens strictly after the target accepted the content.
 * The accepted-at-target / unacknowledged-in-store crash window (M1B/F2)
 * closes target-side: before any resend attempt, the target's durable
 * inbox/history is folded on the stable framed message identity, and an
 * already accepted frame is only acknowledged, never redelivered.
 *
 * Issue #19 / F13 quiet semantics (official `dispatchOnce` parity): a quiet
 * message to a member delivers only while the target is live, through the
 * non-waking `Agent.inject` seam; an inactive target's quiet message stays
 * durably queued across sends, scheduler passes and reload-recovery rescans
 * — only wakeup delivery may cold-resume an inactive member.
 *
 * Issue #52 / D1 visibility gate: waking (non-quiet) mail acknowledges only
 * after the frame is CLAIMED into the target's model-visible history. A
 * still-pending frame is a transient acceptance — official turn lifecycle
 * paths (an aborted turn, an Activation disposal drain) clear unclaimed
 * inbox work — so `delivered` never precedes model visibility: a
 * pending-only frame keeps the message durably queued (never resent while
 * pending), and a frame whose acceptance was discarded is redelivered
 * exactly once by the next rescan.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { messageObsoleteReason } from '../domain/team-domain-mailbox.js'
import type { TeamId, TeamMessage, TeamMessageId, TeamState } from '../domain/types.js'
import { framePredicate, frameVisibility, sessionAccepts, waitForFrameClaim } from './frame-visibility.js'
import { messageFrame } from './prompts.js'

/**
 * The exact model-visible frame one message is delivered under lives in
 * `prompts.ts` with the other F8 delimiting surfaces: the frame keeps its
 * stable target-side identity (M1B/F2, message id allocated once at queue
 * time) while the untrusted body travels as fenced data under an explicit
 * not-instructions declaration. The claim-wait and visibility-fold
 * primitives the delivery debt settles on live in `frame-visibility.ts`
 * (shared with the assignment dispatch path since issue #60).
 */

/** Serialized per-message delivery over the authoritative mailbox. */
export class MessageDelivery {
  private readonly chains = new Map<string, Promise<TeamMessage | undefined>>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      isClosing: () => boolean
      scopeOf: (agent: Agent) => TeamScope
      accountAgentUsage: (scope: TeamScope, teamId: TeamId, agent: Agent) => Promise<void>
    },
  ) {}

  /**
   * Flush one live accepting target's durability checkpoint, then confirm
   * the frame is recorded (official `checkpointDelivered` parity): the store
   * acknowledgement may only commit over an acceptance that survived the
   * flush. A cold-resumed target skips this — its inbox admission is already
   * durable through the persisted session.
   */
  private async targetFlushedAndRecorded(session: Session, frame: string): Promise<boolean> {
    await this.ctx.sessions.flush(session)
    return sessionAccepts(session, framePredicate(frame))
  }

  /** Deliver one message body; `false` keeps it durably queued. */
  private async deliverMessage(team: TeamState, sender: Agent, message: TeamMessage, signal: AbortSignal): Promise<boolean> {
    try {
      const frame = messageFrame(message)
      if (message.targetSessionId === team.captainSessionId && sender.id !== team.captainSessionId) {
        await this.ctx.subagents.reportFrom(sender, [{ type: 'text', text: frame }], {
          delivery: message.delivery === 'quiet' ? 'quiet' : 'next-step',
          signal,
        })
        const captain = this.ctx.agents.get(SessionId(team.captainSessionId))
        if (message.delivery === 'quiet') {
          return captain === undefined || await this.targetFlushedAndRecorded(captain.session, frame)
        }
        // Waking mail to the captain (issue #52 / D1): acknowledge only on
        // the claimed, model-visible form.
        return captain !== undefined && await waitForFrameClaim(this.ctx, captain, frame, signal)
      }
      const target = this.ctx.agents.get(SessionId(message.targetSessionId))
      if (message.delivery === 'quiet') {
        // Issue #19 / F13, official `dispatchOnce` parity: quiet mail to a
        // member delivers only while the target is live, through the
        // non-waking `Agent.inject` seam (pending until the running driver's
        // next step boundary or a later wake). An inactive target's quiet
        // message stays durably queued — the send path, the reload-recovery
        // rescan and the scheduler pass must never cold-resume it; only a
        // wakeup message (or the member's own return) makes delivery
        // possible again. This also gives the official quiet ordered-bypass
        // effect structurally: the inject never queues behind an in-flight
        // wakeup dispatch.
        if (target === undefined) return false
        target.inject(createUserMessage({
          content: [{ type: 'text', text: frame }],
          source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
        }))
        const captain = sender.id === team.captainSessionId
          ? sender
          : this.ctx.agents.get(SessionId(team.captainSessionId))
        await this.deps.accountAgentUsage(this.deps.scopeOf(captain ?? target), team.id, target)
        return await this.targetFlushedAndRecorded(target.session, frame)
      }
      const captain = sender.id === team.captainSessionId
        ? sender
        : this.ctx.agents.get(SessionId(team.captainSessionId))
      if (captain === undefined) return false
      await this.ctx.subagents.followup(
        captain,
        SessionId(message.targetSessionId),
        [{ type: 'text', text: frame }],
        { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal },
      )
      // The followup may have cold-resumed the target; observe the CURRENT
      // live agent (issue #52 / D1: waking mail acks only on the claim).
      const woken = this.ctx.agents.get(SessionId(message.targetSessionId))
      if (woken === undefined) return false
      await this.deps.accountAgentUsage(this.deps.scopeOf(captain), team.id, woken)
      return await waitForFrameClaim(this.ctx, woken, frame, signal)
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: message ${message.id} remains queued: ${String(error)}`)
      return false
    }
  }

  /**
   * Reconcile one queued message against the target's durable facts (M1B/F2).
   *
   * `true` — the exact framed text is already accepted at the target and the
   * store acknowledgement is the only debt, so the caller acknowledges
   * without resending. `false` — no acceptance exists: deliver normally.
   * `undefined` — the target could not be inspected, or (waking mail, issue
   * #52 / D1) the acceptance is still the transient pending-inbox form;
   * uncertainty keeps the message durably queued rather than risk a
   * duplicate model-visible delivery. The shared fold (`frameVisibility`)
   * flushes a live target's durability checkpoint before confirming, so a
   * make-up acknowledgement never commits over an acceptance that is still
   * only in memory. Quiet mail keeps the pending form as an accepted
   * delivery (its F13 contract IS inbox delivery for the recipient's own
   * next turn); waking mail settles only on the claimed history form.
   */
  private async targetAlreadyAccepted(message: TeamMessage, signal: AbortSignal): Promise<boolean | undefined> {
    const visibility = await frameVisibility(
      this.ctx, message.targetSessionId, messageFrame(message), signal, `message ${message.id}`,
    )
    if (message.delivery === 'quiet') return visibility === 'claimed' || visibility === 'pending'
    if (visibility === 'claimed') return true
    return visibility === 'absent' ? false : undefined
  }

  /**
   * Run one message through its serialized chain: reread the authoritative
   * snapshot, deliver only if still queued, then acknowledge after target
   * acceptance. A queued message whose target already durably accepted it
   * (crash window, reload rescan, or any repeated call) folds to an
   * acknowledgement only.
   */
  async deliverQueuedMessage(
    scope: TeamScope,
    teamId: TeamId,
    captain: Agent,
    messageId: TeamMessageId,
    signal: AbortSignal,
  ): Promise<TeamMessage | undefined> {
    const key = `${scope}\0${teamId}\0${messageId}`
    const previous = this.chains.get(key) ?? Promise.resolve(undefined)
    const next = previous.then(async () => {
      if (this.deps.isClosing()) return undefined
      const snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)
      const message = snapshot.team.messages.find(candidate => candidate.id === messageId)
      if (message === undefined || message.phase !== 'queued') return message
      // Mail-obsolescence single obsolete funnel (delivery admission): an
      // obsolete message is NEVER delivered, injected, followed-up or used to
      // wake its target. It is settled terminal once, and the caller observes
      // the real terminal result.
      const obsoleteReason = messageObsoleteReason(snapshot.team, message)
      if (obsoleteReason !== undefined) {
        return await this.deps.domain().markMessageObsolete(scope, teamId, message.id, obsoleteReason)
      }
      const accepted = await this.targetAlreadyAccepted(message, signal)
      if (accepted === undefined) return undefined
      if (accepted) return await this.deps.domain().acknowledgeMessage(scope, teamId, message.id)
      const sender = message.senderSessionId === captain.id
        ? captain
        : this.ctx.agents.get(SessionId(message.senderSessionId))
      if (sender === undefined && message.targetSessionId === captain.id) return undefined
      const delivered = await this.deliverMessage(snapshot.team, sender ?? captain, message, signal)
      if (!delivered) return undefined
      return await this.deps.domain().acknowledgeMessage(scope, teamId, message.id)
    }).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
    return await next
  }

  /** Wait for every in-flight delivery chain (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<TeamMessage | undefined>>> {
    return Promise.allSettled(this.chains.values())
  }
}
