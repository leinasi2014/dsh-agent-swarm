import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentHeaderDisplayOwner, SubagentHeaderDisplayProps } from '@deepseek-ai/dsh-client-ui-subagent/client'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'

function shortTeamName(name: string): string {
  const characters = Array.from(name)
  return characters.length > 6 ? `${characters.slice(0, 6).join('')}…` : name
}

/** Exact read-side affiliation; the official catalog still owns addresses and counts. */
export function projectTeamLineage(owner: SubagentHeaderDisplayOwner, state: TeamDashboardState): { text: string; title: string } | undefined {
  const data = state.phase === 'ready' ? state.data : undefined
  if (data === undefined || !data.teams.complete) return undefined
  const activeTeams = data.teams.teams.filter(team => team.phase === 'active' && team.captainSessionId !== '')
  if (owner.kind === 'count') {
    if (!activeTeams.some(team => team.captainSessionId === owner.parentSessionId)) return undefined
    return { text: `x${owner.count}`, title: owner.defaultText }
  }
  const address = owner.address
  if (address === undefined || address.mode !== 'continuable') return undefined
  const captain = activeTeams.find(team => team.captainSessionId === address.childSessionId)
  if (captain !== undefined && data.teams.binding.mainSessionId === address.parentSessionId) {
    const name = captain.displayName?.trim()
    if (!name) return undefined
    return { text: `${shortTeamName(captain.name)} · ${name}`, title: `${captain.name} · ${name}` }
  }
  const selected = activeTeams.find(team => team.teamId === data.projection.binding.teamId
    && team.captainSessionId === data.projection.binding.rootSessionId
    && team.captainSessionId === address.parentSessionId)
  if (selected === undefined || data.captainMembers.binding.teamId !== selected.teamId
    || data.captainMembers.binding.rootSessionId !== selected.captainSessionId) return undefined
  const member = data.captainMembers.members.find(row => row.phase === 'active' && row.sessionId === address.childSessionId)
  if (member === undefined) return undefined
  const name = member.displayName?.trim() || member.name
  return { text: name, title: `${selected.name} · ${selected.displayName?.trim() || 'Captain'} → ${name}` }
}

type TeamLineageDisplayProps = SubagentHeaderDisplayProps & PropsHooks<{ team: TeamDashboardController }>

/** A text-only consumer inside the existing DSH lineage controls. */
export function TeamLineageDisplay(props: TeamLineageDisplayProps) {
  const display = projectTeamLineage(props, props.useTeam(state => state))
  if (display === undefined) return props.defaultText
  return <span title={display.title} data-swarm-lineage-label>{display.text}</span>
}
