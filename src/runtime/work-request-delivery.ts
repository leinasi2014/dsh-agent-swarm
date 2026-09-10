/** Stateless adapter for genuine operator/Main notices; MessageDelivery owns serialization. */
import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamMessage, TeamMessageId, TeamState } from '../domain/types.js'
import { publicManagedParent } from '../domain/public-message.js'
import { messageObsoleteReason } from '../domain/team-domain-mailbox.js'
import { frameVisibility, waitForFrameClaim } from './frame-visibility.js'
import { messageFrame } from './prompts.js'
import { publicAppendEligibility } from './public-lineage.js'
import type { PublicDeliveryResult } from './message-delivery.js'

export async function deliverWorkRequestNotice(ctx: Context, deps: {
  domain(): TeamDomainPort; closing(): boolean
  team(scope: TeamScope, teamId: TeamId): Promise<TeamState | undefined>
  root(parentId: string, scope: TeamScope): Promise<Agent>
  account(scope: TeamScope, teamId: TeamId, agent: Agent): Promise<void>
}, scope: TeamScope, teamId: TeamId, messageId: TeamMessageId, signal: AbortSignal): Promise<{
  message?: TeamMessage; result: PublicDeliveryResult
}> {
  const result = { admitted: false, deferred: false, reconciled: 0 }
  try {
    if (deps.closing()) return { result: { ...result, deferred: true } }
    const team = await deps.team(scope, teamId)
    const notice = team?.messages.find(message => message.id === messageId)
    if (team === undefined || notice?.kind !== 'work-request-notice' || notice.phase !== 'queued') {
      return { ...(notice === undefined ? {} : { message: notice }), result }
    }
    const frame = messageFrame(notice)
    // Official durable input wins even when the request was resolved in that same turn.
    const visible = await frameVisibility(ctx, notice.targetSessionId, frame, signal, `work request ${notice.workRequestId}`, true)
    if (visible === 'claimed') return { message: await deps.domain().acknowledgeMessage(scope, teamId, notice.id), result: { ...result, reconciled: 1 } }
    const obsolete = messageObsoleteReason(team, notice)
    if (obsolete !== undefined) return { message: await deps.domain().markMessageObsolete(scope, teamId, notice.id, obsolete), result }
    if (visible !== 'absent') return { result: { ...result, deferred: true } }
    const parentId = publicManagedParent(team.managedOrigin)
    if (parentId === undefined || (await publicAppendEligibility(ctx, scope, team, signal)).state !== 'available') {
      return { result: { ...result, deferred: true } }
    }
    const root = await deps.root(parentId, scope)
    signal.throwIfAborted()
    const current = await deps.team(scope, teamId)
    const currentNotice = current?.messages.find(message => message.id === messageId)
    if (deps.closing() || current?.phase !== 'active' || current.managedOrigin !== team.managedOrigin
      || current.captainSessionId !== team.captainSessionId || currentNotice?.kind !== 'work-request-notice'
      || currentNotice.phase !== 'queued' || messageFrame(currentNotice) !== frame
      || ctx.agents.get(root.id) !== root || ctx.sessions.get(root.id) !== root.session
      || root.id !== parentId || root.session.header.parentSession !== undefined
      || (await publicAppendEligibility(ctx, scope, current, signal)).state !== 'available') {
      return { result: { ...result, deferred: true } }
    }
    // The official lineage proof can await IO while the Captain resolves the request.
    // Use the post-proof aggregate, then enter prompt admission without another proof await.
    const latest = await deps.team(scope, teamId)
    const latestNotice = latest?.messages.find(message => message.id === messageId)
    if (deps.closing() || latest?.phase !== 'active' || latest.managedOrigin !== team.managedOrigin
      || latest.captainSessionId !== team.captainSessionId || latestNotice?.kind !== 'work-request-notice'
      || latestNotice.phase !== 'queued' || messageFrame(latestNotice) !== frame
      || ctx.agents.get(root.id) !== root || ctx.sessions.get(root.id) !== root.session
      || root.id !== parentId || root.session.header.parentSession !== undefined
      || root.session.header.cwd === undefined || resolve(root.session.header.cwd) !== scope) {
      return { result: { ...result, deferred: true } }
    }
    const stale = messageObsoleteReason(latest, latestNotice)
    if (stale !== undefined) return { message: await deps.domain().markMessageObsolete(scope, teamId, notice.id, stale), result }
    signal.throwIfAborted()
    await steerHostSubagentPrompt(ctx.subagents, root, SessionId(team.captainSessionId), [{ type: 'text', text: frame }],
      { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal)
    result.admitted = true
    const captain = ctx.agents.get(SessionId(team.captainSessionId))
    if (captain === undefined) return { result: { ...result, deferred: true } }
    await deps.account(scope, teamId, captain)
    if (!await waitForFrameClaim(ctx, captain, frame, signal, 10_000, true)) return { result: { ...result, deferred: true } }
    return { message: await deps.domain().acknowledgeMessage(scope, teamId, notice.id), result }
  } catch (error) {
    if (!deps.closing()) ctx.logger.warn(`agent-swarm: work notice ${messageId} remains queued: ${String(error)}`)
    return { result: { ...result, deferred: true } }
  }
}
