/** End public delivery debt from durable facts without waking recipients or reopening Team writes. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId } from '../domain/types.js'
import type { RetirementPublicFact } from '../domain/team-retirement.js'
import { publicDeliveries } from '../domain/public-message.js'
import type { StorageDomainTeamStore } from '../storage/storage-domain-team-store.js'
import type { RetirementReceipt } from '../storage/team-retirement-store.js'
import { frameVisibility } from './frame-visibility.js'
import { publicInputPredicates } from './public-image-delivery.js'

export async function settleRetirementPublic(ctx: Context, store: StorageDomainTeamStore, receipt: RetirementReceipt): Promise<void> {
  const teamId = TeamId(receipt.teamId)
  const team = await store.read(receipt.scope, teamId)
  if (team === undefined) return
  const facts: RetirementPublicFact[] = []
  for (const message of team.publicChat?.messages ?? []) for (const delivery of publicDeliveries(message)) {
    if (delivery.state !== 'queued') continue
    const predicates = delivery.frameVersion === 3 ? publicInputPredicates(delivery.frame, message.id, delivery.projection, () => {}) : undefined
    const visibility = await frameVisibility(ctx, delivery.recipientSessionId, delivery.frame, new AbortController().signal, `retired public ${message.id}`, true, predicates)
    const ownedAndStopped = receipt.ownedSessionIds.includes(delivery.recipientSessionId)
      && ctx.agents.get(SessionId(delivery.recipientSessionId)) === undefined && ctx.sessions.get(SessionId(delivery.recipientSessionId)) === undefined
    if (visibility === 'claimed' || ('formatVersion' in message && (visibility === 'absent' || (visibility === 'pending' && ownedAndStopped)))) {
      facts.push({ messageId: message.id, recipientSessionId: delivery.recipientSessionId, visibility })
    }
  }
  if (facts.length > 0) receipt.teamRevision = await store.settleRetiredPublic(receipt.scope, teamId, facts)
}
