import type { PublicChatController } from './public-chat-controller.js'
import { useState } from 'react'
import type { PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type Props = PropsRuntime<'sidebar.navigation.section'> & PropsHooks<{ team: TeamDashboardController; chat: PublicChatController }> & PropsLocale<typeof TEAM_DASHBOARD_NS> & {
  readonly refreshDirectory: () => void
  readonly selectGroup: (teamId: string) => void
  readonly openMain: () => Promise<void>
  readonly openCaptain: () => Promise<void>
  readonly openMember: (name: string, sessionId: string) => Promise<void>
}
/** Additive navigation in the official left seat; it never owns Session or column state. */
export function TeamGroupNavigation(props: Props) {
  const state = props.useTeam(value => value)
  const chat = props.useChat?.(value => value)
  const activePanel = props.usePanelInfo(value => value.activePanelId)
  const [expanded, setExpanded] = useState<string>()
  const [error, setError] = useState<string>()
  const data = state.data
  if (data === undefined || !data.teams.complete) return null
  const selected = data.projection.binding.teamId
  const handoff = (action: () => Promise<void>): void => { setError(undefined); void action().catch(reason => { setError(reason instanceof Error ? reason.message : props.t('error')) }) }
  return <nav onFocusCapture={props.refreshDirectory} className="swarm-groups" aria-label={props.t('public.groups')} data-swarm-group-navigation>
    <style>{`.swarm-groups{min-width:0;padding:0 8px 8px;color:var(--dsw-alias-label-primary);font-size:13px}.swarm-groups button{display:flex;align-items:center;gap:7px;width:100%;min-width:0;border:0;border-radius:7px;background:transparent;color:inherit;padding:8px;text-align:left;cursor:pointer}.swarm-groups button:hover,.swarm-groups button[aria-current=page]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}.swarm-groups button:disabled{opacity:.5;cursor:default}.swarm-groups button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.swarm-groups ul{list-style:none;padding:0;margin:0}.swarm-groups ul ul{margin-left:16px;border-left:1px solid var(--dsw-alias-border-l2);padding-left:5px}.swarm-groups small{color:var(--dsw-alias-label-secondary)}.swarm-groups p{overflow-wrap:anywhere}.swarm-groups__heading{box-sizing:border-box;display:flex;align-items:center;height:36px;margin:2px -8px 4px;padding-left:4px;overflow:hidden;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:20px}`}</style>
    {props.wide ? <>
      <div className="swarm-groups__heading">{props.t('public.groups')}</div><ul>{data.teams.teams.map(team => {
        const open = expanded === team.teamId
        const ready = state.phase === 'ready' && selected === team.teamId
        const currentCaptain = activePanel === null && state.targetSessionId === team.captainSessionId
        const membersBound = data.captainMembers.binding.teamId === selected
          && data.captainMembers.binding.rootSessionId === data.projection.binding.rootSessionId
        return <li key={team.teamId}>
          <button type="button" data-swarm-group={team.teamId} title={team.name} aria-expanded={open} aria-current={activePanel === 'swarm.group' && selected === team.teamId ? 'page' : undefined}
            onClick={() => { setExpanded(open ? undefined : team.teamId); props.selectGroup(team.teamId) }}><span aria-hidden="true">{open ? '▾' : '▸'}</span><span>{team.name}</span></button>
          {open ? <ul><li><button type="button" data-swarm-group-captain aria-current={currentCaptain ? 'page' : undefined}
            title={props.t(currentCaptain ? 'captainCurrentSessionTitle' : 'captainMainChatTitle')}
            disabled={!ready || !team.captainSessionId || team.captainSessionId !== data.projection.binding.rootSessionId || currentCaptain}
            onClick={() => { handoff(props.openCaptain) }}><span>{chat?.directory?.binding.teamId === team.teamId ? chat.directory.entries.find(row => row.role === 'captain')?.label ?? props.t('captainRole') : team.displayName || props.t('captainRole')}</span><small>{props.t(currentCaptain ? 'captainCurrentSession' : 'captainRole')}</small></button></li>
            {chat !== undefined ? ready && chat.directory?.binding.teamId === selected && chat.directory.binding.rootSessionId === data.projection.binding.rootSessionId
              ? chat.directory.entries.filter(row => row.role === 'member').map(member => <li key={member.memberId}><button type="button" data-swarm-group-member={member.name}
                title={`${member.label} · ${member.name} · ${member.memberId}`} disabled={member.phase !== 'active'}
                onClick={() => { handoff(() => props.openMember(member.name, member.memberId)) }}><span>{member.label}</span><small>{member.name}</small></button></li>)
              : <li role={chat.directoryError ? 'alert' : 'status'}>{chat.directoryError ?? props.t('directory.loading')}</li>
            : <>{ready && membersBound ? data.captainMembers.members.map(member => <li key={member.name}><button type="button" data-swarm-group-member={member.name}
              disabled={member.phase !== 'active' || member.sessionId === undefined || !data.projection.roster.some(row => row.name === member.name && row.phase === 'active')}
              onClick={() => { if (member.sessionId !== undefined) handoff(() => props.openMember(member.name, member.sessionId!)) }}><span>{member.displayName || member.name}</span></button></li>) : <li>{props.t('loading')}</li>}</>}

          </ul> : null}
        </li>
      })}</ul>
    </> : <button type="button" title={props.t('public.groups')} aria-label={props.t('public.groups')} onClick={props.expandSidebar}>◉</button>}
    {error === undefined ? null : <p role="alert">{error}</p>}
  </nav>
}
