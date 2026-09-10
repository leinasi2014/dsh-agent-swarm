/** Existing idle recovery consumes canonical debt and requests the one scheduler. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState } from '../domain/types.js'
import { hasPendingVisualAssistance, hasPublicDebt } from '../domain/public-message.js'
import type { MemberProvisioner } from './member-provisioning.js'
import type { MessageDelivery } from './message-delivery.js'

export async function recoverIdleAgent(ctx: Context, agent: Agent, scope: TeamScope, deps: {
  domain: TeamDomainPort; closing(): boolean; signal: AbortSignal
  delivery: MessageDelivery; provisioning: MemberProvisioner
  track(captain: Agent, team: TeamState): void
  allowed(teamId: TeamId): boolean
  schedule(teamId: TeamId, captain: Agent): void
}): Promise<void> {
  let membership = await deps.domain.findMembership(scope, agent.id)
  if (membership === undefined || deps.closing()) return
  if (hasPublicDebt(membership.team.publicChat) || hasPendingVisualAssistance(membership.team.publicChat)) {
    await deps.delivery.deliverPublicMessages(scope, membership.team.id, deps.signal)
  }
  if (membership.team.messages.some(message => message.kind === 'work-request-notice' && message.phase === 'queued')) {
    await deps.delivery.deliverWorkRequests(scope, membership.team.id, deps.signal)
  }
  if (membership.role === 'captain') {
    const settled = await deps.provisioning.recoverInterrupted(agent, scope, membership)
    if (settled > 0) membership = await deps.domain.requireMembership(scope, agent.id)
  }
  const captain = ctx.agents.get(SessionId(membership.team.captainSessionId))
  if (captain === undefined) return
  deps.track(captain, membership.team)
  if (agent.status === 'idle' && deps.allowed(membership.team.id)) deps.schedule(membership.team.id, captain)
}
