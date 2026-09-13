import { TeamPublicChat, type TeamPublicChatProps } from './TeamPublicChat.js'
import type { TeamNavigationCallbacks } from './TeamGroupNavigation.js'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import type { PublicChatController } from './public-chat-controller.js'
import type { WorkRequestController } from './work-request-controller.js'

export type TeamGroupPanelProps = Omit<TeamPublicChatProps, 'openTeam' | 'teamExpanded' | 'teamPanelId'> & {
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly chat: PublicChatController
  readonly work: WorkRequestController
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly navigation: TeamNavigationCallbacks
}

/** The normal Main Conversation's group face. The official layout owns the rightbar. */
export function TeamGroupPanel(props: TeamGroupPanelProps) {
  const state = props.useTeam(value => value)
  const current = props.useSessions(value => value.current)
  const choices = state.choices
  if (choices === undefined && state.data === undefined) return <section data-swarm-group-loading style={{ padding: 24 }}>
    <p role={state.error === undefined ? 'status' : 'alert'}>{state.error?.message ?? props.t('loading')}</p>
    {state.error === undefined ? null : <button type="button" onClick={() => { void props.controller.refresh() }}>{props.t('retry')}</button>}
  </section>
  if (choices !== undefined) return <section data-swarm-group-choice style={{ padding: 24 }}>
    <h1>{props.t('public.chooseGroup')}</h1>
    {state.phase === 'loading' || state.phase === 'reconnecting' ? <p role="status">{props.t('loading')}</p> : null}
    {state.error !== undefined ? <p role="alert">{state.error.message} <button type="button" onClick={() => { void props.controller.refresh() }}>{props.t('retry')}</button></p> : null}
    {choices.complete && choices.binding.rootSessionId === current && state.targetSessionId === current
      ? choices.teams.map(team => <button key={team.teamId} type="button" data-swarm-choose-team={team.teamId}
        disabled={state.phase !== 'ready'} onClick={() => { props.navigation.selectGroup(team.teamId) }}>{team.name}</button>) : <p>{props.t('loading')}</p>}
  </section>
  const members = state.data?.captainMembers.members.filter(member => member.phase === 'active').length ?? 0
  return <TeamPublicChat {...props} openTeam={() => { props.coordinator.showMembers() }} teamExpanded={false}
    readingPositions={props.chat.readingPositions} teamButtonLabel={props.t('public.memberCount', { count: members + 1 })} />
}
