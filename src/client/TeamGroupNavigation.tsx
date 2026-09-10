import { useState } from 'react'
import type { PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type Props = PropsRuntime<'sidebar.navigation.section'> & PropsHooks<{ team: TeamDashboardController }> & PropsLocale<typeof TEAM_DASHBOARD_NS> & {
  readonly selectGroup: (teamId: string) => void
  readonly openMain: () => Promise<void>
  readonly openCaptain: () => Promise<void>
  readonly openMember: (name: string, sessionId: string) => Promise<void>
}
/** Additive navigation in the official left seat; it never owns Session or column state. */
export function TeamGroupNavigation(props: Props) {
  const state = props.useTeam(value => value)
  const activePanel = props.usePanelInfo(value => value.activePanelId)
  const [expanded, setExpanded] = useState<string>()
  const [error, setError] = useState<string>()
  const data = state.data
  if (data === undefined || !data.teams.complete) return null
  const selected = data.projection.binding.teamId
  const handoff = (action: () => Promise<void>): void => { setError(undefined); void action().catch(reason => { setError(reason instanceof Error ? reason.message : props.t('error')) }) }
  return <nav className="swarm-groups" aria-label={props.t('public.groups')} data-swarm-group-navigation>
    <style>{`.swarm-groups{min-width:0;padding:8px;color:var(--dsw-alias-label-primary);font-size:13px}.swarm-groups button{display:flex;align-items:center;gap:7px;width:100%;min-width:0;border:0;border-radius:7px;background:transparent;color:inherit;padding:8px;text-align:left;cursor:pointer}.swarm-groups button:hover,.swarm-groups button[aria-current=page]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}.swarm-groups button:disabled{opacity:.5;cursor:default}.swarm-groups button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.swarm-groups ul{list-style:none;padding:0;margin:0}.swarm-groups ul ul{margin-left:16px;border-left:1px solid var(--dsw-alias-border-l2);padding-left:5px}.swarm-groups small{color:var(--dsw-alias-label-secondary)}.swarm-groups p{overflow-wrap:anywhere}`}</style>
    {props.wide ? <>
      <button type="button" disabled={state.phase !== 'ready'} onClick={() => { handoff(props.openMain) }}><span>{data.teams.binding.mainSessionTitle || props.t('openChat')}</span></button>
      <small>{props.t('public.groups')}</small><ul>{data.teams.teams.map(team => {
        const open = expanded === team.teamId
        const ready = state.phase === 'ready' && selected === team.teamId
        return <li key={team.teamId}>
          <button type="button" data-swarm-group={team.teamId} aria-expanded={open} aria-current={activePanel === 'swarm.group' && selected === team.teamId ? 'page' : undefined}
            onClick={() => { setExpanded(open ? undefined : team.teamId); props.selectGroup(team.teamId) }}><span aria-hidden="true">{open ? '▾' : '▸'}</span><span>{team.name}</span></button>
          {open ? <ul><li><button type="button" data-swarm-group-captain disabled={!ready || !team.captainSessionId} onClick={() => { handoff(props.openCaptain) }}><span>{team.displayName || props.t('captainRole')}</span><small>{props.t('captainRole')}</small></button></li>
            {ready ? data.captainMembers.members.map(member => <li key={member.name}><button type="button" data-swarm-group-member={member.name} disabled={member.phase !== 'active' || member.sessionId === undefined}
              onClick={() => { if (member.sessionId !== undefined) handoff(() => props.openMember(member.name, member.sessionId!)) }}><span>{member.displayName || member.name}</span></button></li>) : <li>{props.t('loading')}</li>}
          </ul> : null}
        </li>
      })}</ul>
    </> : <button type="button" title={props.t('public.groups')} aria-label={props.t('public.groups')} onClick={props.expandSidebar}>◉</button>}
    {error === undefined ? null : <p role="alert">{error}</p>}
  </nav>
}
