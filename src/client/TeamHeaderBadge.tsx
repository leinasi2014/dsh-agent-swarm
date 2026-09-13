import type { PropsHooks, PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import type { TeamNavigationCallbacks } from './TeamGroupNavigation.js'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { useState } from 'react'

type Props = PropsRuntime<'conversation.session.header.actions'> & PropsHooks<{ team: TeamDashboardController }> & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & { coordinator: TeamDashboardSurfaceCoordinator; navigation: TeamNavigationCallbacks }

/** B3: the Team context badge in the official session-header action list.
 *  It renders only for the exact Session the verified Team read is bound to. */
export function TeamHeaderBadge(props: Props) {
  const state = props.useTeam(value => value)
  const [error, setError] = useState<string>()
  const data = state.data
  if (!state.open || state.phase !== 'ready' || data === undefined || !data.teams.complete) return null
  if (state.targetSessionId !== props.sessionId) return null
  const team = data.teams.teams.find(candidate => candidate.teamId === data.projection.binding.teamId)
  if (team === undefined || team.name.trim() === '') return null
  return <span data-swarm-team-badge={team.teamId} title={team.name}
    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 6px', borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
    <button type="button" data-swarm-return-group onClick={() => { void props.navigation.returnGroup?.().catch(reason => { setError(String(reason)) }) }}>{props.t('public.returnGroup')} · {team.name}</button>
    <button type="button" data-swarm-team-trigger onClick={() => { props.coordinator.showMembers() }}>{props.t('public.memberCount', { count: data.captainMembers.members.filter(member => member.phase === 'active').length + 1 })}</button>
    {error ? <span role="alert">{error}</span> : null}
  </span>
}
