/** Stop selected owned branches through their real, already attached parent handles. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import type { RetirementReceipt } from '../storage/team-retirement-store.js'

export async function stopRetirementSessions(ctx: Context, receipt: RetirementReceipt): Promise<void> {
  const owned = new Set(receipt.ownedSessionIds)
  const live = receipt.ownedSessionIds.flatMap(id => {
    const agent = ctx.agents.get(SessionId(id))
    return agent === undefined ? [] : [agent]
  })
  for (const session of ctx.sessions.list()) {
    if (!owned.has(session.id) && session.header.origin === 'subagent' && session.header.parentSession !== undefined
      && owned.has(session.header.parentSession)) throw new TeamDomainError('Selected parent still owns a protected live child', 'TEAM_RETIREMENT_REFERENCE_CONFLICT')
  }
  const roots = live.filter(agent => !live.some(parent => parent.id === agent.session.header.parentSession))
  for (const child of roots) {
    const parentId = child.session.header.parentSession
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    if (parent === undefined || ctx.sessions.get(parent.id) !== parent.session || ctx.sessions.get(child.id) !== child.session) {
      throw new TeamDomainError('Retired branch has no exact live continuation owner', 'TEAM_RETIREMENT_DRAIN_PENDING')
    }
    ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
    await ctx.subagents.drainContinuableDescendants([child])
    await ctx.subagents.drainContinuableChildren(parent, [child.id])
  }
}
