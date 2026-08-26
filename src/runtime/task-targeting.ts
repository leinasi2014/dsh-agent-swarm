import { TeamDomainError } from '../domain/error.js'
import { normalizeMemberName } from '../domain/team-domain-shared.js'
import type { TeamMember } from '../domain/types.js'

/** Resolve the public member-name selector to the sole durable child identity. */
export function resolveTaskTarget(members: readonly TeamMember[], targetMemberName: string): string {
  const name = normalizeMemberName(targetMemberName)
  const target = members.find(member => member.name === name && (member.phase === 'provisioning' || member.phase === 'active'))
  if (target === undefined) throw new TeamDomainError(`Team member "${targetMemberName}" is unavailable`, 'TEAM_ASSIGNEE_INVALID')
  return target.sessionId
}
