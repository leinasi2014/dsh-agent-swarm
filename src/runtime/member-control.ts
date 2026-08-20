/**
 * Captain-owned member turn control (issue #19, official Lead-only keepInbox
 * interrupt parity).
 *
 * `interruptMember` cancels one member's current turn through the subagent
 * interrupt seam — which is `Agent.cancel(cause, { keepInbox: true })` —
 * without releasing task ownership, removing the roster row, cancelling
 * durable mail or draining the continuable Activation (unlike
 * `removeMember`'s fence-and-drain). The domain stays the roster authority;
 * this collaborator only resolves the target by name and performs the live
 * cancellation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import { foldMemberName } from '../domain/team-domain-shared.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'

/** Collaborators the captain member-control surface needs from its runtime. */
export interface MemberControlDeps {
  readonly ctx: Context
  readonly domain: () => TeamDomainPort
  readonly isClosing: () => boolean
  readonly scopeOf: (agent: Agent) => TeamScope
  readonly ensureReady: () => Promise<void>
}

/**
 * Interrupt one member's current turn, keepInbox (official roster `interrupt`
 * parity). Caller cancellation is not admitted mid-flight: the cancellation
 * request itself is synchronous once authorized.
 * @returns the target's sampled pre-cancellation status.
 */
export async function interruptMember(
  deps: MemberControlDeps,
  exec: ToolExecutionAuthority,
  name: string,
): Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive' }> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const captain = requireAgent(exec)
  const scope = deps.scopeOf(captain)
  const membership = await deps.domain().requireMembership(scope, captain.id)
  if (membership.role !== 'captain') {
    throw new TeamDomainError('only the captain can interrupt members', 'TEAM_CAPTAIN_REQUIRED')
  }
  const normalizedName = foldMemberName(name)
  if (normalizedName === 'captain') {
    throw new TeamDomainError('the captain cannot interrupt itself', 'TEAM_INVALID_TARGET')
  }
  const target = membership.team.members.find(member => member.name === normalizedName && member.phase === 'active')
  if (target === undefined) {
    throw new TeamDomainError(`active member "${normalizedName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  const live = deps.ctx.agents.get(SessionId(target.sessionId))
  if (live === undefined) return { name: normalizedName, previousStatus: 'inactive' }
  const previousStatus = live.status
  deps.ctx.subagents.interrupt(SessionId(target.sessionId), { kind: 'ancestor', agent: captain })
  return { name: normalizedName, previousStatus }
}
