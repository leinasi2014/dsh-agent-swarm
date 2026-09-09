import { Button, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamDashboardState } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { dedupeTeams, enumLabel } from './team-dashboard-view-helpers.js'

export const teamCardsCss = `
[data-swarm-team-dashboard] .swarm-team-workspace__cards-list { display:grid; gap:12px; padding:4px 12px 16px; }
[data-swarm-team-dashboard] .swarm-team-workspace__team-card { min-width:0; overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__team-card[data-swarm-current-team="true"] { border-color:var(--dsw-alias-state-business-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__card-toggle { display:grid; gap:5px; width:100%; padding:12px; border:0; background:transparent; color:var(--dsw-alias-label-primary); text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__card-toggle:hover { background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__card-title { display:flex; gap:8px; align-items:center; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__card-title strong { flex:1; min-width:0; overflow-wrap:anywhere; font-size:14px; line-height:1.5; font-weight:600; }
[data-swarm-team-dashboard] .swarm-team-workspace__card-title small { flex:none; color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__card-summary { display:flex; flex-wrap:wrap; gap:3px 10px; padding-left:16px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
[data-swarm-team-dashboard] .swarm-team-workspace__current-label { color:var(--dsw-alias-state-business-primary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__breadcrumb { display:flex; flex-wrap:wrap; gap:4px 6px; margin-top:6px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
[data-swarm-team-dashboard] .swarm-team-workspace__breadcrumb button { padding:0; border:0; background:none; color:var(--dsw-alias-state-business-primary); font:inherit; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__card-loading { padding:12px; color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__context { margin:0 12px; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__context > summary { padding:8px 0; }
`

/** One directory card per Team, with only the selected Team's verified body loaded. */
export function TeamDashboardCards({ state, headingId, descriptionId, onSelectTeam, onMainChat, onClose, children, t }: {
  readonly state: TeamDashboardState
  readonly headingId: string
  readonly descriptionId: string
  readonly onSelectTeam: (teamId: string) => void
  readonly onMainChat: () => void
  readonly onClose: () => void
  readonly children: ReactNode
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const data = state.data!
  const teams = dedupeTeams(data.teams)
  const boundId = data.projection.binding.teamId
  const [expanded, setExpanded] = useState<string | null>(boundId)
  const [pending, setPending] = useState<string>()
  useEffect(() => {
    if (pending === undefined || pending === boundId) setExpanded(current => current === null ? null : boundId)
    if (pending === boundId) setPending(undefined)
  }, [boundId, pending])
  const expandedId = expanded !== null && !teams.some(team => team.teamId === expanded) ? boundId : expanded
  const binding = data.teams.binding
  const currentTeamId = binding.currentTeamId
    ?? teams.find(team => team.captainSessionId === state.targetSessionId)?.teamId
    ?? (data.captainMembers?.members.some(member => member.sessionId === state.targetSessionId) ? boundId : undefined)
  const currentTeam = teams.find(team => team.teamId === currentTeamId)
  const currentMember = data.captainMembers?.members.find(member => member.sessionId === state.targetSessionId)
  const currentName = currentMember?.displayName ?? currentMember?.name
    ?? binding.currentMemberName
    ?? (currentTeam !== undefined && currentTeam.captainSessionId === state.targetSessionId ? currentTeam.displayName : undefined)
  const mainName = binding.mainSessionTitle ?? t('mainBrainCaption')
  const mainAvailable = binding.mainSessionId !== undefined && binding.mainSessionId !== state.targetSessionId
  const toggle = (teamId: string): void => {
    if (expandedId === teamId) { setExpanded(null); return }
    setExpanded(teamId)
    if (teamId !== boundId || (pending !== undefined && pending !== teamId)) { setPending(teamId); onSelectTeam(teamId) }
  }
  return <div data-swarm-team-cards>
    <header className="swarm-team-workspace__pane-head">
      <div className="swarm-team-workspace__truncate">
        <h2 className="swarm-team-workspace__title" id={headingId}>{t('cards.title', { count: teams.length })}</h2>
        <nav className="swarm-team-workspace__breadcrumb" id={descriptionId} aria-label={t('cards.lineage')} data-swarm-team-lineage>
          {mainAvailable ? <button type="button" onClick={onMainChat} data-swarm-main-chat>{mainName}</button> : <span>{mainName}</span>}
          {currentTeam === undefined ? null : <><span aria-hidden="true">›</span><span>{currentTeam.name}</span></>}
          {currentName === undefined ? null : <><span aria-hidden="true">›</span><span>{currentName}</span></>}
        </nav>
      </div>
      <Button size="sm" variant="toolbar" aria-label={t('close')} onClick={onClose}><IconCloseOutline16 /></Button>
    </header>
    <div className="swarm-team-workspace__cards-list">
      {teams.map(team => {
        const isExpanded = expandedId === team.teamId
        const current = currentTeamId === team.teamId
        return <section className="swarm-team-workspace__team-card" key={team.teamId} data-swarm-team-card={team.teamId} data-swarm-current-team={current ? 'true' : 'false'}>
          <button type="button" className="swarm-team-workspace__card-toggle" data-swarm-team-toggle={team.teamId}
            aria-expanded={isExpanded} aria-controls={`swarm-team-body-${team.teamId}`} onClick={() => { toggle(team.teamId) }}>
            <span className="swarm-team-workspace__card-title"><span aria-hidden="true">{isExpanded ? '⌄' : '›'}</span><strong>{team.name}</strong><small data-swarm-team-phase>{enumLabel(team.phase, t)}</small></span>
            <span className="swarm-team-workspace__card-summary">
              <span>{t('cards.captain', { name: team.displayName ?? t('profileIncomplete') })}</span>
              {team.summary === undefined ? null : <><span>{t('progress.memberCount', { count: team.summary.memberCount })}</span><span>{t('cards.tasks', { completed: team.summary.completedTaskCount, total: team.summary.taskCount })}</span></>}
              {current ? <span className="swarm-team-workspace__current-label">{t('cards.currentTeam')}</span> : null}
            </span>
          </button>
          <div id={`swarm-team-body-${team.teamId}`} hidden={!isExpanded}>
            {isExpanded && boundId === team.teamId ? children
              : isExpanded ? <div className="swarm-team-workspace__card-loading" role="status">{state.error !== undefined && pending === team.teamId ? t('error') : t('loading')}</div> : null}
          </div>
        </section>
      })}
    </div>
  </div>
}
