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
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { messageObsoleteReason } from '../domain/team-domain-mailbox.js'
import type { TeamId, TeamMessage, TeamMessageId, TeamState } from '../domain/types.js'
import { framePredicate, frameVisibility, sessionAccepts, waitForFrameClaim, type FramePredicates } from './frame-visibility.js'
import { messageFrame } from './prompts.js'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { publicRecipientEligibility } from './public-lineage.js'
import { isPublicMessageV3, publicDeliveries, publicManagedParent } from '../domain/public-message.js'
import { publicInputPredicates, publicRecipientImageCapability, samePublicImageInput, steerVerifiedPublicImagePrompt, verifyPublicImageReferences } from './public-image-delivery.js'
import { deliverWorkRequestNotice } from './work-request-delivery.js'
import { openClaimNoticeDeferred } from '../domain/team-domain-open-claim.js'

/** One serialized drain, including overlapping work it waited for. */
export interface PublicDeliveryResult {
  readonly admitted: boolean
  readonly deferred: boolean
  readonly reconciled: number
}

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
  private readonly publicChains = new Map<string, Promise<PublicDeliveryResult>>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      isClosing: () => boolean
      scopeOf: (agent: Agent) => TeamScope
      accountAgentUsage: (scope: TeamScope, teamId: TeamId, agent: Agent) => Promise<void>
      publicTeam?: (scope: TeamScope, teamId: TeamId) => Promise<TeamState | undefined>
      publicRoot?: (parentSessionId: string, scope: TeamScope) => Promise<Agent>
      goalAllowed?: (scope: TeamScope, teamId: TeamId) => boolean
    },
  ) {}

  /** Drain typed work notices through the same mailbox chains and retirement fence. */
  async deliverWorkRequests(scope: TeamScope, teamId: TeamId, signal: AbortSignal): Promise<PublicDeliveryResult> {
    return await this.drainCaptainNotices(scope, teamId, signal, 'work-request-notice')
  }

  async deliverGoalNotices(scope: TeamScope, teamId: TeamId, signal: AbortSignal): Promise<PublicDeliveryResult> {
    return await this.drainCaptainNotices(scope, teamId, signal, 'goal-coordination-notice')
  }

  private async drainCaptainNotices(scope: TeamScope, teamId: TeamId, signal: AbortSignal,
    kind: 'work-request-notice' | 'goal-coordination-notice'): Promise<PublicDeliveryResult> {
    const result = { admitted: false, deferred: false, reconciled: 0 }
    const team = await this.deps.publicTeam?.(scope, teamId)
    for (const notice of team?.messages ?? []) {
      if (notice.kind !== kind || notice.phase !== 'queued' || this.deps.isClosing()) continue
      await this.queueMessageOperation(scope, teamId, notice.id, async () => {
        const value = await this.deliverWorkNotice(scope, teamId, notice.id, signal, kind)
        result.admitted ||= value.result.admitted; result.deferred ||= value.result.deferred; result.reconciled += value.result.reconciled
        return value.message
      })
    }
    return result
  }

  private deliverWorkNotice(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId, signal: AbortSignal,
    kind: 'work-request-notice' | 'goal-coordination-notice' = 'work-request-notice') {
    return this.withPublicAdmissionFence(scope, teamId, () => deliverWorkRequestNotice(this.ctx, {
      domain: this.deps.domain, closing: this.deps.isClosing,
      team: async (boundScope, id) => await this.deps.publicTeam?.(boundScope, id),
      root: async (parent, boundScope) => {
        if (this.deps.publicRoot === undefined) throw new Error('Managed Main restoration is unavailable')
        return await this.deps.publicRoot(parent, boundScope)
      }, account: this.deps.accountAgentUsage,
      ...(this.deps.goalAllowed === undefined ? {} : { goalAllowed: this.deps.goalAllowed }),
    }, scope, teamId, messageId, signal, kind))
  }

  /** Serialize membership retirement with the entire official public admission,
   * including cold observation/materialization and the bounded claim wait.
   * A retirement cannot return while an earlier admission can still create a child.
   */
  async withPublicAdmissionFence<T>(scope: TeamScope, teamId: TeamId, operation: () => Promise<T>): Promise<T> {
    const key = `${scope}\0${teamId}`
    let inherited: PublicDeliveryResult = { admitted: false, deferred: true, reconciled: 0 }
    const previous = this.publicChains.get(key) ?? Promise.resolve({ admitted: false, deferred: false, reconciled: 0 })
    const outcome = previous.catch(() => inherited).then(async prior => {
      inherited = prior
      return { prior, value: await operation() }
    })
    const next = outcome.then(({ prior }) => prior, () => ({ ...inherited, deferred: true }))
      .finally(() => { if (this.publicChains.get(key) === next) this.publicChains.delete(key) })
    this.publicChains.set(key, next)
    return (await outcome).value
  }

  /** Public input uses this same delivery owner and immutable aggregate debt. */
  async deliverPublicMessages(scope: TeamScope, teamId: TeamId, signal: AbortSignal): Promise<PublicDeliveryResult> {
    const key = `${scope}\0${teamId}`
    const previous = this.publicChains.get(key) ?? Promise.resolve({ admitted: false, deferred: false, reconciled: 0 })
    const next = previous.catch(() => ({ admitted: false, deferred: true, reconciled: 0 })).then(async prior => {
      // OR/OR/SUM across messages and overlapping callers. A preceding
      // admission still owns this wake even if its Agent has already retired.
      const result = { ...prior }
      const read = () => this.deps.publicTeam?.(scope, teamId)
      if (!this.deps.isClosing()) { signal.throwIfAborted(); await this.deps.domain().reconcileVisualAssistance(scope, teamId) }
      const initial = await read()
      if (initial === undefined || this.deps.isClosing()) return { ...result, deferred: true }
      for (const row of initial.publicChat?.messages ?? []) {
        for (const frozen of publicDeliveries(row)) {
        if (frozen.state !== 'queued') continue
        signal.throwIfAborted()
        try {
        let team = await read()
        let message = team?.publicChat?.messages.find(candidate => candidate.id === row.id)
        if (team === undefined || message === undefined) { result.deferred = true; continue }
        const delivery = publicDeliveries(message).find(recipient => recipient.recipientSessionId === frozen.recipientSessionId)
        if (delivery?.state !== 'queued') continue
        let mismatch = false
        const predicates = delivery.frameVersion === 3 ? publicInputPredicates(delivery.frame, message.id, delivery.projection, () => { mismatch = true }) : undefined
        const visibility = await frameVisibility(this.ctx, delivery.recipientSessionId, delivery.frame, signal, `public ${message.id}`, true, predicates)
        if (visibility === 'claimed') {
          await this.deps.domain().acknowledgePublicMessage(scope, teamId, message.id, delivery.recipientSessionId)
          result.reconciled++
          continue
        }
        // A pending inbox entry or an unreadable checkpoint is not permission
        // to resend. Only proven absence can reach official prompt admission.
        if (visibility !== 'absent' || this.deps.isClosing()) {
          if (visibility === 'unknown' && isPublicMessageV3(message)) await this.deps.domain().deferPublicImageDelivery(scope, teamId, message.id,
            delivery.recipientSessionId, mismatch ? 'projection-mismatch' : 'recipient-unavailable')
          result.deferred = true; continue
        }
        // This entire drain is serialized with all admissions by the same
        // owner. Only durable absence permits a terminal non-delivery.
        team = await read()
        if (team === undefined) { result.deferred = true; continue }
        const assistance = isPublicMessageV3(message) ? message.assistance : undefined
        if (assistance?.kind === 'request' && team.publicChat?.schemaVersion === 3
          && team.publicChat.assistances?.some(assist => assist.assistanceId === assistance.assistanceId && assist.result !== undefined)) {
          await this.deps.domain().settlePublicMessage(scope, teamId, message.id, delivery.recipientSessionId, 'assistance-closed')
          result.reconciled++; continue
        }
        const removed = delivery.recipientSessionId !== team.captainSessionId
          && !team.members.some(member => member.sessionId === delivery.recipientSessionId && member.phase === 'active')
        if (team.phase === 'archived' || removed) {
          if ('formatVersion' in message) {
            await this.deps.domain().settlePublicMessage(scope, teamId, message.id, delivery.recipientSessionId,
              team.phase === 'archived' ? 'team-archived' : 'recipient-removed')
            result.reconciled++
          } else result.deferred = true
          continue
        }
        if (!await publicRecipientEligibility(this.ctx, scope, team, [delivery.recipientSessionId], signal)) {
          if (isPublicMessageV3(message)) await this.deps.domain().deferPublicImageDelivery(scope, teamId, message.id, delivery.recipientSessionId, 'recipient-unavailable')
          result.deferred = true; continue
        }
        const parent = publicManagedParent(team.managedOrigin)
        if (parent === undefined) { result.deferred = true; continue }
        const root = await this.deps.publicRoot?.(parent, scope)
        if (root === undefined) { result.deferred = true; continue }
        const admit = async (directParent: Agent, leaseSignal: AbortSignal) => {
          team = await read()
          message = team?.publicChat?.messages.find(candidate => candidate.id === row.id)
          const current = message === undefined ? undefined : publicDeliveries(message).find(recipient => recipient.recipientSessionId === delivery.recipientSessionId)
          if (team?.phase !== 'active' || current?.state !== 'queued' || current.frame !== delivery.frame
            || (team.captainSessionId !== delivery.recipientSessionId && !team.members.some(member => member.sessionId === delivery.recipientSessionId && member.phase === 'active'))) {
            result.deferred = true; return
          }
          leaseSignal.throwIfAborted()
          if (this.deps.isClosing()) { result.deferred = true; return }
          let claimPredicates: FramePredicates | undefined
          if (isPublicMessageV3(message!) && current.frameVersion === 3) {
            const imageMessage = message!
            const hasImages = imageMessage.content.some(part => part.type === 'image')
            const capability = !hasImages || current.projection?.mode === 'text-only' ? 'supported'
              : await publicRecipientImageCapability(this.ctx, scope, team, delivery.recipientSessionId, leaseSignal)
            if (capability === 'unknown' || (capability === 'unsupported' && current.projection?.mode === 'images')) {
              await this.deps.domain().deferPublicImageDelivery(scope, teamId, imageMessage.id, delivery.recipientSessionId,
                capability === 'unknown' ? 'image-capability-unknown' : 'image-model-unsupported')
              result.deferred = true; return
            }
            const prepared = current.projection === undefined ? await this.deps.domain().preparePublicImageDelivery(scope, teamId, imageMessage.id,
              delivery.recipientSessionId, capability === 'unsupported' ? 'text-only' : 'images') : current
            if (prepared.state !== 'queued' || prepared.projection === undefined) { result.deferred = true; return }
            try { await verifyPublicImageReferences(this.ctx, imageMessage, leaseSignal) }
            catch { leaseSignal.throwIfAborted(); await this.deps.domain().deferPublicImageDelivery(scope, teamId, imageMessage.id, delivery.recipientSessionId, 'image-unavailable'); result.deferred = true; return }
            claimPredicates = publicInputPredicates(prepared.frame, imageMessage.id, prepared.projection, () => { mismatch = true })
            const latestVisibility = await frameVisibility(this.ctx, prepared.recipientSessionId, prepared.frame, leaseSignal, `public ${imageMessage.id} before admission`, true, claimPredicates)
            if (latestVisibility === 'claimed') { await this.deps.domain().acknowledgePublicMessage(scope, teamId, imageMessage.id, prepared.recipientSessionId); result.reconciled++; return }
            if (latestVisibility !== 'absent') {
              if (latestVisibility === 'unknown') await this.deps.domain().deferPublicImageDelivery(scope, teamId, imageMessage.id,
                prepared.recipientSessionId, mismatch ? 'projection-mismatch' : 'recipient-unavailable')
              result.deferred = true; return
            }
            const freshTeam = await read(), freshMessage = freshTeam?.publicChat?.messages.find(candidate => candidate.id === imageMessage.id)
            const fresh = freshMessage === undefined ? undefined : publicDeliveries(freshMessage).find(recipient => recipient.recipientSessionId === delivery.recipientSessionId)
            leaseSignal.throwIfAborted()
            if (imageMessage.assistance?.kind === 'request' && (imageMessage.assistance.expiresAt <= Date.now()
              || (freshTeam?.publicChat?.schemaVersion === 3 && freshTeam.publicChat.assistances?.some(assist => assist.assistanceId === imageMessage.assistance!.assistanceId && assist.result !== undefined)))) {
              await this.deps.domain().reconcileVisualAssistance(scope, teamId)
              // Append a drain to this same chain so a newly terminal result does not wait for another timer.
              void this.deliverPublicMessages(scope, teamId, signal).catch(() => {})
              result.deferred = true; return
            }
            if (this.deps.isClosing() || freshTeam?.phase !== 'active' || fresh?.state !== 'queued' || fresh.frameVersion !== 3
              || !samePublicImageInput(prepared, fresh) || directParent.id !== prepared.parentSessionId
              || this.ctx.agents.get(directParent.id) !== directParent || this.ctx.sessions.get(directParent.id) !== directParent.session
              || (delivery.recipientSessionId !== freshTeam.captainSessionId && !freshTeam.members.some(member => member.sessionId === delivery.recipientSessionId && member.phase === 'active'))) {
              result.deferred = true; return
            }
            if (hasImages && prepared.projection.mode === 'images') {
              const admission = await steerVerifiedPublicImagePrompt(this.ctx, scope, freshTeam, directParent,
                { ...prepared, projection: prepared.projection }, leaseSignal,
                imageMessage.assistance?.kind === 'request' ? imageMessage.assistance.expiresAt : undefined)
              if (admission === 'expired') {
                await this.deps.domain().reconcileVisualAssistance(scope, teamId)
                void this.deliverPublicMessages(scope, teamId, signal).catch(() => {})
                result.deferred = true; return
              }
              if (admission !== 'admitted') {
                await this.deps.domain().deferPublicImageDelivery(scope, teamId, imageMessage.id, prepared.recipientSessionId,
                  admission === 'unknown' ? 'image-capability-unknown' : 'image-model-unsupported')
                result.deferred = true; return
              }
            } else await steerHostSubagentPrompt(this.ctx.subagents, directParent, SessionId(prepared.recipientSessionId),
              prepared.projection.content, prepared.projection.source, leaseSignal)
          } else await this.ctx.subagents.prompt({ requestId: row.id as SubagentPromptRequestId,
            parentSessionId: SessionId(delivery.parentSessionId), childSessionId: SessionId(delivery.recipientSessionId),
            mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: delivery.frame }] }, leaseSignal)
          result.admitted = true
          const target = this.ctx.agents.get(SessionId(delivery.recipientSessionId))
          if (target !== undefined) {
            await this.deps.accountAgentUsage(scope, teamId, target)
            if (await waitForFrameClaim(this.ctx, target, delivery.frame, leaseSignal, 5_000, true, claimPredicates)) {
              await this.deps.domain().acknowledgePublicMessage(scope, teamId, row.id, delivery.recipientSessionId)
            } else if (mismatch && isPublicMessageV3(message!)) await this.deps.domain().deferPublicImageDelivery(scope, teamId, row.id, delivery.recipientSessionId, 'projection-mismatch')
          }
        }
        if (delivery.recipientSessionId === team.captainSessionId) await admit(root, signal)
        else await this.ctx.subagents.withContinuableChild(root, SessionId(team.captainSessionId), signal,
          async (captain, leaseSignal) => await admit(captain, leaseSignal))
        } catch (error) {
          signal.throwIfAborted()
          result.deferred = true
          this.ctx.logger.warn(`agent-swarm: public recipient ${frozen.recipientSessionId} remains queued: ${String(error)}`)
        }
        }
      }
      return result
    }).finally(() => { if (this.publicChains.get(key) === next) this.publicChains.delete(key) })
    this.publicChains.set(key, next)
    return await next
  }

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
        const captain = this.ctx.agents.get(SessionId(team.captainSessionId))
        if (captain === undefined || this.ctx.agents.get(sender.id) !== sender
          || sender.session.header.parentSession !== captain.id) return false
        if (message.delivery === 'quiet') {
          signal.throwIfAborted()
          captain.inject(createUserMessage({
            content: [{ type: 'text', text: frame }],
            source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
          }))
          return await this.targetFlushedAndRecorded(captain.session, frame)
        }
        await this.ctx.subagents.sendMessage(sender, captain.id, [{ type: 'text', text: frame }], { signal })
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
      if (message.kind === 'open-claim-notice') {
        const current = (await this.deps.domain().snapshot(this.deps.scopeOf(captain), team.id, captain.id)).team
        const notice = current.messages.find(candidate => candidate.id === message.id)
        if (notice?.phase !== 'queued') return false
        const obsolete = messageObsoleteReason(current, notice)
        if (obsolete !== undefined) {
          await this.deps.domain().markMessageObsolete(this.deps.scopeOf(captain), team.id, notice.id, obsolete)
          return false
        }
        if (current.goalLifecycle?.phase === 'paused' || openClaimNoticeDeferred(current, notice, Date.now()) || this.ctx.agents.get(SessionId(notice.targetSessionId))?.status === 'running') return false
      }
      await steerHostSubagentPrompt(
        this.ctx.subagents,
        captain,
        SessionId(message.targetSessionId),
        [{ type: 'text', text: frame }],
        { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal,
      )
      // Steering reaches a busy member's next step and may cold-resume an
      // inactive target; observe the CURRENT
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
    return await this.queueMessageOperation(scope, teamId, messageId, async () => {
      if (this.deps.isClosing()) return undefined
      const snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)
      const message = snapshot.team.messages.find(candidate => candidate.id === messageId)
      if (message === undefined || message.phase !== 'queued') return message
      if (message.kind === 'work-request-notice') return (await this.deliverWorkNotice(scope, teamId, messageId, signal)).message
      if (message.kind === 'goal-coordination-notice') return (await this.deliverWorkNotice(scope, teamId, messageId, signal, message.kind)).message
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
      if (message.kind === 'open-claim-notice' && (snapshot.team.goalLifecycle?.phase === 'paused' || openClaimNoticeDeferred(snapshot.team, message, Date.now())
        || this.ctx.agents.get(SessionId(message.targetSessionId))?.status === 'running')) return undefined
      const sender = message.senderSessionId === captain.id
        ? captain
        : this.ctx.agents.get(SessionId(message.senderSessionId))
      if (sender === undefined && message.targetSessionId === captain.id) return undefined
      const delivered = await this.deliverMessage(snapshot.team, sender ?? captain, message, signal)
      if (!delivered) return undefined
      return await this.deps.domain().acknowledgeMessage(scope, teamId, message.id)
    })
  }

  private async queueMessageOperation(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId,
    operation: () => Promise<TeamMessage | undefined>): Promise<TeamMessage | undefined> {
    const key = `${scope}\0${teamId}\0${messageId}`
    const previous = this.chains.get(key) ?? Promise.resolve(undefined)
    const next = previous.catch(() => undefined).then(operation).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
    return await next
  }

  /** Wait for every in-flight delivery chain (disposal path). */
  async waitPrivateTeam(scope: TeamScope, teamId: TeamId): Promise<void> {
    const prefix = `${scope}\0${teamId}\0`
    await Promise.allSettled([...this.chains].filter(([key]) => key.startsWith(prefix)).map(([, operation]) => operation))
  }

  /** Wait for every in-flight delivery chain (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<TeamMessage | undefined | PublicDeliveryResult>>> {
    return Promise.allSettled([...this.chains.values(), ...this.publicChains.values()])
  }
}
