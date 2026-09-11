import type { PublicChatController } from './public-chat-controller.js'
import { useEffect, useRef, useState } from 'react'
import { IconQueueOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { RetirementClient } from './retirement-client.js'
import type { RetirementResult, RetirementTarget } from '../shared/team-retirement.js'
import { TeamRetirementMenu } from './TeamRetirementMenu.js'
import { TeamRetirementPanel } from './TeamRetirementPanel.js'
import { TeamRetirementRequests } from './TeamRetirementRequests.js'

type Props = PropsRuntime<'sidebar.navigation.section'> & PropsHooks<{ team: TeamDashboardController; chat: PublicChatController }> & PropsLocale<typeof TEAM_DASHBOARD_NS> & {
  readonly refreshDirectory: () => void
  readonly selectGroup: (teamId: string) => void
  readonly openMain: () => Promise<void>
  readonly openCaptain: () => Promise<void>
  readonly openMember: (name: string, sessionId: string) => Promise<void>
  readonly retirement?: RetirementClient
  readonly retired?: (result: RetirementResult) => Promise<void>
}
/** Additive navigation in the official left seat; it never owns Session or column state. */
export function TeamGroupNavigation(props: Props) {
  const state = props.useTeam(value => value)
  const chat = props.useChat?.(value => value)
  const activePanel = props.usePanelInfo(value => value.activePanelId)
  const [expanded, setExpanded] = useState<string>()
  const [showArchived, setShowArchived] = useState(false)
  const [menu, setMenu] = useState<{ target: RetirementTarget; x: number; y: number }>()
  const [panel, setPanel] = useState<{ target: RetirementTarget; action: 'archive' | 'delete' | 'history'; sessionId?: string }>()
  const [error, setError] = useState<{ message: string; scope: string }>()
  const [pending, setPending] = useState<{ name: string; scope: string; token: object }>()
  const data = state.data
  const scope = JSON.stringify([state.targetSessionId, data?.projection.binding.teamId])
  const activeScope = useRef(scope), navigation = useRef<object>()
  activeScope.current = scope
  useEffect(() => { navigation.current = undefined; setError(undefined); setPending(undefined) }, [scope])
  const handoff = (action: () => Promise<void>, name = ''): void => {
    const token = {}; navigation.current = token; setError(undefined); setPending({ name, scope, token })
    void action().catch(reason => { if (navigation.current === token && activeScope.current === scope) setError({ scope, message: reason instanceof Error ? reason.message : props.t('error') }) })
      .finally(() => { setPending(current => current?.token === token ? undefined : current) })
  }
  const renderNavigation = () => {
  if (data === undefined || !data.teams.complete) return null
  const selected = data.projection.binding.teamId
  const mainId = data.teams.binding.mainSessionId
  const archived = data.teams.teams.filter(team => team.phase === 'archived')
  const visibleTeams = data.teams.teams.filter(team => team.phase !== 'archived' || showArchived)
  const menuTeam = data.teams.teams.find(team => team.teamId === menu?.target.teamId)
  const history = (teamId: string, sessionId: string) => { if (mainId !== undefined) setPanel({ target: { rootSessionId: mainId, teamId }, action: 'history', sessionId }) }
  return <nav className="swarm-groups" data-compact={!props.wide} aria-label={props.t('public.groups')} data-swarm-group-navigation>
    <style>{`.swarm-groups{min-width:0;padding:0 8px 8px;color:var(--dsw-alias-label-primary);font-size:13px}.swarm-groups button{display:flex;align-items:center;gap:7px;width:100%;min-width:0;border:0;border-radius:7px;background:transparent;color:inherit;padding:8px;text-align:left;cursor:pointer}.swarm-groups[data-compact=true]{padding:0 0 12px}.swarm-groups[data-compact=true] button{width:36px;height:36px;justify-content:center;padding:0}.swarm-groups[data-compact=true] button span{display:flex}.swarm-groups[data-compact=true] button>span:last-of-type{flex:0 0 auto}.swarm-groups button:hover,.swarm-groups button[aria-current=page]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}.swarm-groups button:disabled{opacity:.5;cursor:default}.swarm-groups button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.swarm-groups ul{list-style:none;padding:0;margin:0}.swarm-groups ul ul{margin-left:8px;border-left:1px solid var(--dsw-alias-border-l2);padding-left:5px}.swarm-groups small{color:var(--dsw-alias-label-secondary);flex:0 1 40%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:18px}.swarm-groups button>span:last-of-type{flex:1 1 auto}.swarm-groups ul ul button{gap:5px;padding:7px 5px}.swarm-groups p{overflow-wrap:anywhere}.swarm-groups__row{display:flex;align-items:center;min-width:0}.swarm-groups__row>button:first-child{flex:1;width:auto}.swarm-groups .swarm-groups__more{flex:0 0 24px;width:24px;height:28px;justify-content:center;padding:0;opacity:0;font-size:20px}.swarm-groups__row:hover .swarm-groups__more,.swarm-groups__row:focus-within .swarm-groups__more{opacity:1}@media(hover:none),(pointer:coarse){.swarm-groups .swarm-groups__more{opacity:1}}.swarm-groups .swarm-groups__archived{justify-content:space-between;padding:5px 8px;color:var(--dsw-alias-label-secondary);font-size:11px}.swarm-groups__row small{margin-left:auto;font-size:10px}.swarm-groups__heading{box-sizing:border-box;display:flex;align-items:center;height:36px;margin:2px -8px 4px;padding-left:4px;overflow:hidden;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:20px}`}</style>
    {props.wide ? <>
      <div className="swarm-groups__heading">{props.t('public.groups')}</div>
      {archived.length === 0 ? null : <button type="button" className="swarm-groups__archived" aria-expanded={showArchived} onClick={() => { setShowArchived(!showArchived) }}>{props.t('retirement.archived')} ({archived.length}) <span aria-hidden="true">{showArchived ? '▴' : '▾'}</span></button>}
      <ul>{visibleTeams.map(team => {
        const open = expanded === team.teamId
        const ready = state.phase === 'ready' && selected === team.teamId
        const currentCaptain = activePanel === null && state.targetSessionId === team.captainSessionId
        const captainLabel = chat?.directory?.binding.teamId === team.teamId ? chat.directory.entries.find(row => row.role === 'captain')?.label ?? props.t('captainRole') : team.displayName || props.t('captainRole')
        const membersBound = data.captainMembers.binding.teamId === selected
          && data.captainMembers.binding.rootSessionId === data.projection.binding.rootSessionId
        return <li key={team.teamId}>
          <div className="swarm-groups__row" onContextMenu={event => { if (props.retirement !== undefined && mainId !== undefined) { event.preventDefault(); setMenu({ target: { rootSessionId: mainId, teamId: team.teamId }, x: event.clientX, y: event.clientY }) } }}>
          <button type="button" data-swarm-group={team.teamId} title={team.name} aria-expanded={open} aria-busy={state.pendingTeamId === team.teamId} aria-current={activePanel === 'swarm.group' && selected === team.teamId ? 'page' : undefined}
            onClick={() => { setExpanded(open ? undefined : team.teamId); props.selectGroup(team.teamId) }}><span aria-hidden="true">{open ? '▾' : '▸'}</span><span>{team.name}</span>{state.pendingTeamId === team.teamId ? <small role="status">{props.t('loading')}</small> : null}{team.phase === 'archived' ? <small title={props.t('retirement.archived')}>▣</small> : null}</button>
          {props.retirement === undefined || mainId === undefined ? null : <button className="swarm-groups__more" type="button" aria-label={`${team.name} · ${props.t('retirement.more')}`} aria-haspopup="menu" aria-expanded={menu?.target.teamId === team.teamId}
            onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ target: { rootSessionId: mainId, teamId: team.teamId }, x: box.left, y: box.bottom }) }}>⋯</button>}</div>
          {open ? <ul><li><button type="button" data-swarm-group-captain aria-current={currentCaptain ? 'page' : undefined}
            title={`${captainLabel} · ${props.t(team.phase === 'archived' ? 'retirement.history' : currentCaptain ? 'captainCurrentSessionTitle' : 'captainMainChatTitle')}`}
            disabled={team.phase === 'archived' ? !team.captainSessionId : !ready || !team.captainSessionId || team.captainSessionId !== data.projection.binding.rootSessionId || currentCaptain}
            onClick={() => { if (team.phase === 'archived') history(team.teamId, team.captainSessionId); else handoff(props.openCaptain) }}><span>{captainLabel}</span><small>{props.t(team.phase === 'archived' ? 'retirement.history' : currentCaptain ? 'captainCurrentSession' : 'captainRole')}</small></button></li>
            {ready && membersBound ? data.captainMembers.members.map(member => {
              const entry = chat?.directory?.binding.teamId === selected && chat.directory.binding.rootSessionId === data.projection.binding.rootSessionId
                ? chat.directory.entries.find(row => row.role === 'member' && row.memberId === member.sessionId && row.name === member.name) : undefined
              const busy = pending?.scope === scope && pending.name === member.name
              const sessionId = team.phase === 'archived' ? member.historySessionId : member.sessionId
              return <li key={member.name}><button type="button" data-swarm-group-member={member.name} aria-busy={busy}
                title={`${entry?.label ?? (member.displayName || member.name)} · ${member.name}`}
                disabled={sessionId === undefined || (team.phase !== 'archived' && (member.phase !== 'active' || !data.projection.roster.some(row => row.name === member.name && row.phase === 'active')))}
                onClick={() => { if (sessionId !== undefined) { if (team.phase === 'archived') history(team.teamId, sessionId); else handoff(() => props.openMember(member.name, sessionId), member.name) } }}><span>{entry?.label ?? (member.displayName || member.name)}</span><small>{busy ? props.t('loading') : member.name}</small></button></li>
            }) : <li role="status">{props.t('loading')}</li>}

          </ul> : null}
        </li>
      })}</ul>
    </> : <button type="button" title={props.t('public.groups')} aria-label={props.t('public.groups')} onClick={props.expandSidebar}><span aria-hidden="true"><IconQueueOutline14 size={18} /></span></button>}
    {error?.scope === scope ? <p role="alert">{error.message}</p> : null}
    {menu !== undefined && menuTeam !== undefined ? <TeamRetirementMenu x={menu.x} y={menu.y} archived={menuTeam.phase === 'archived'} t={props.t} close={() => { setMenu(undefined) }} choose={action => { setPanel({ target: menu.target, action }); setMenu(undefined) }} /> : null}
  </nav>
  }
  return <>{renderNavigation()}{props.retirement === undefined ? null : <TeamRetirementRequests client={props.retirement} t={props.t} open={request => { setPanel({ target: request.target, action: request.action }) }} />}{panel !== undefined && props.retirement !== undefined ? <TeamRetirementPanel key={`${panel.target.rootSessionId}:${panel.target.teamId}:${panel.action}:${panel.sessionId ?? ''}`} client={props.retirement} target={panel.target} action={panel.action} initialSessionId={panel.sessionId} t={props.t}
    close={() => { setPanel(undefined) }} completed={async result => { if (result.action === 'archive') setShowArchived(true); await props.retired?.(result) }} /> : null}</>
}
