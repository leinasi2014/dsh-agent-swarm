import { Button, IconCloseOutline16, IconRefreshOutline16, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadAssetStatusV1, SwarmReadCaptainAnnouncementsV1, SwarmReadCaptainDiagnosticsV1, SwarmReadCaptainMembersV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { TeamIdentityCard } from './TeamIdentityCard.js'

/** The read contract reports un-generated member assets with a stable reason; the UI never fabricates one. */
const NOT_GENERATED_AVATAR: SwarmReadAssetStatusV1 = { state: 'not_generated', reason: 'avatar_backend_not_implemented' }

type Selection = { readonly kind: 'team' } | { readonly kind: 'member'; readonly name: string } | { readonly kind: 'task'; readonly id: string }
type FocusIntent = { readonly kind: 'roster' | 'tasks' } | { readonly kind: 'member'; readonly name: string } | { readonly kind: 'task'; readonly id: string }

export const shellCss = `
[data-swarm-team-dashboard] .swarm-team-workspace { container-type:inline-size; display:grid; grid-template-rows:auto minmax(0,1fr) auto; height:100%; min-width:0; overflow:hidden; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__header, [data-swarm-team-dashboard] .swarm-team-workspace__footer { display:flex; justify-content:space-between; gap:8px; padding:9px 12px; border-color:var(--dsw-alias-border-l2); border-style:solid; }
[data-swarm-team-dashboard] .swarm-team-workspace__header { align-items:flex-start; border-width:0 0 1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__footer { align-items:center; border-width:1px 0 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__title { margin:0; font-size:14px; line-height:20px; font-weight:700; }
[data-swarm-team-dashboard] .swarm-team-workspace__title-row, [data-swarm-team-dashboard] .swarm-team-workspace__member-identity { display:flex; align-items:center; gap:8px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-identity { flex:1 1 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-activity { flex:0 1 auto; min-width:0; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__description, [data-swarm-team-dashboard] .swarm-team-workspace__muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__description { display:none; }
[data-swarm-team-dashboard] .swarm-team-workspace__body { min-width:0; min-height:0; overflow:auto; padding:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__status { display:flex; gap:8px; align-items:center; min-width:0; margin:0 0 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__error { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__column-title { margin:0 0 10px; font-size:14px; }
[data-swarm-team-dashboard] [data-swarm-team-rail] > details { margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__metric { padding:10px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__metric strong { display:block; font-size:16px; }
[data-swarm-team-dashboard] .swarm-team-workspace__rows, [data-swarm-team-dashboard] .swarm-team-workspace__rows > li { min-width:0; max-width:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__rows { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
[data-swarm-team-dashboard] .swarm-team-workspace__row { display:block; box-sizing:border-box; width:100%; max-width:100%; min-width:0; overflow:hidden; padding:10px; color:inherit; text-align:left; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:transparent; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__row[aria-current="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__row-main, [data-swarm-team-dashboard] .swarm-team-workspace__fact { display:flex; justify-content:space-between; gap:8px; min-width:0; max-width:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__avatar { position:relative; display:grid; flex:0 0 auto; inline-size:40px; block-size:40px; place-items:center; overflow:hidden; border-radius:50%; background:linear-gradient(135deg, var(--dsw-alias-brand-primary), color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-bg-base))); color:var(--dsw-alias-bg-base); font-size:15px; font-weight:700; box-shadow:0 0 0 2px var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-badge { flex:0 0 auto; padding:2px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-brand-primary); font-size:12px; font-weight:600; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__truncate { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__task-assignee { display:block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts { display:grid; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dt { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dd { margin:0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__collapsible { margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__collapsible > summary { cursor:pointer; font-size:14px; font-weight:600; }
[data-swarm-team-dashboard] .swarm-team-workspace__collapsible > summary + * { margin-top:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__diagnostics { margin-top:12px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__notice { margin:0 0 10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__rail { width:100%; max-width:359px; margin-inline:auto; display:flex; flex-direction:column; gap:8px; min-width:0; padding:8px; block-size:100%; overflow:hidden; background:var(--dsw-alias-bg-base); font-size:13px; line-height:1.4; }
[data-swarm-team-dashboard] .swarm-team-workspace__switcher { display:flex; flex-direction:row; align-items:center; gap:12px; padding:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__switcher-title { display:flex; flex-direction:column; gap:2px; margin-bottom:8px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__switch-button { cursor:not-allowed; opacity:.72; }
[data-swarm-team-dashboard] .swarm-team-workspace__nav { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__nav-button { display:flex; align-items:center; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__badge { display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; padding:2px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); font-size:11px; font-weight:600; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__badge-current { color:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__badge-unavailable { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__unavailable-card { padding:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__unavailable-card strong { display:block; margin-bottom:4px; }
[data-swarm-team-dashboard] .swarm-team-workspace__capability { display:flex; justify-content:space-between; gap:8px; min-width:0; max-width:100%; padding:8px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); font-size:13px; }
/* Independent management surface: reached from the rail via its own entry, not stacked on the roster first screen. */
[data-swarm-team-dashboard] .swarm-team-workspace__management-entry { display:flex; align-items:center; justify-content:space-between; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__management { display:grid; gap:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__management-head { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
/* Identity-incomplete marker: no dossier backend yet, so the deterministic initial avatar stands in and
   the technical name is shown with an explicit "profile incomplete" label. */
[data-swarm-team-dashboard] .swarm-team-workspace__profile-incomplete { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); font-size:10px; }
/* Roster rows stay 40px tall with the identity name/role on a single ellipsis line; profile fields like
   personality only ever appear in the member detail, never on the 390px first screen. */
[data-swarm-team-dashboard] [data-swarm-member-rows] button.swarm-team-workspace__row, [data-swarm-team-dashboard] .swarm-team-workspace__roster > button { min-block-size:40px; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-identity strong, [data-swarm-team-dashboard] .swarm-team-workspace__member-identity { min-width:0; max-width:100%; }
/* Narrow (single-column) layout keeps every fold default-closed so the roster stays the only first-screen content. */
@media (max-width: 430px) { [data-swarm-team-dashboard] .swarm-team-workspace__roster .swarm-team-workspace__task-assignee, [data-swarm-team-dashboard] .swarm-team-workspace__roster small { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; } }
/* Narrow viewports: the official details track can overflow the visible viewport (~813px, member buttons land at x≈912), so the Team panel escapes the track and overlays the viewport. z-index 20 mirrors the official shell overlay layer constant; wide viewports never hit this media query and keep the docked details fill. The cap covers the official details auto-close threshold (columns.ts: SIDEBAR_COLLAPSED 56 + DETAILS_MIN 300 + CENTER_MIN 640 = 996px), so no 961–995px dead band remains where the panel would be zeroed and clipped. */
@media (max-width: 995.98px) { [data-swarm-team-dashboard][data-swarm-team-panel] { position:fixed; inset:0; z-index:20; } }
/* ---- task-11: QQ/微信群-style roster-first rail (consolidated) ---- */
[data-swarm-team-dashboard] .swarm-team-workspace__roster { min-width:0; display:flex; flex-direction:column; gap:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__roster .swarm-team-workspace__column-title { margin:0 2px 10px; font-size:11px; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); text-transform:uppercase; }
[data-swarm-team-dashboard] .swarm-team-workspace__members { display:grid; gap:4px; max-block-size:250px; overflow-y:auto; overflow-x:hidden; min-width:0; padding-right:2px; }
[data-swarm-team-dashboard] [data-swarm-member-rows] { display:grid; gap:4px; margin:0; padding:0; list-style:none; }
[data-swarm-team-dashboard] [data-swarm-member-rows] li { min-width:0; }
[data-swarm-team-dashboard] [data-swarm-member-rows] button.swarm-team-workspace__row, [data-swarm-team-dashboard] .swarm-team-workspace__row.swarm-team-workspace__captain-hero { display:grid; grid-template-columns:40px minmax(0,1fr) auto; align-items:center; gap:10px; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__member-copy { display:flex; flex-direction:column; gap:2px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-copy strong { font-size:13px; font-weight:650; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-role { color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-side { display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-side small { color:var(--dsw-alias-label-secondary); font-size:9px; }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-hero { grid-template-columns:48px minmax(0,1fr) auto; gap:12px; padding:10px; background:var(--dsw-alias-bg-layer-1); border-color:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-hero .swarm-team-workspace__avatar { inline-size:48px; block-size:48px; font-size:18px; }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-hero .swarm-team-workspace__captain-badge { background:var(--dsw-alias-bg-base); border-color:var(--dsw-alias-brand-primary); }
@media (max-width: 430px) { [data-swarm-team-dashboard] .swarm-team-workspace__rail { width:100%; max-width:100%; margin-inline:0; block-size:100%; } [data-swarm-team-dashboard] .swarm-team-workspace__members { max-block-size:none; } }
/* ---- task-11 pass 2 (consolidated): branded group header + surfaced contact cards ---- */
[data-swarm-team-dashboard] .swarm-team-workspace__switcher-mark { flex:0 0 auto; inline-size:44px; block-size:44px; border-radius:12px; display:grid; place-items:center; background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:800; font-size:18px; }
[data-swarm-team-dashboard] .swarm-team-workspace__switcher-inner { display:flex; flex-direction:column; gap:8px; min-width:0; flex:1 1 auto; }
[data-swarm-team-dashboard] [data-swarm-member-rows] button.swarm-team-workspace__row:hover { border-color:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__roster-label { margin:0 2px 4px; display:flex; justify-content:space-between; gap:8px; color:var(--dsw-alias-label-secondary); font-size:10px; font-weight:750; text-transform:uppercase; letter-spacing:.04em; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); align-items:center; gap:2px; padding:3px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"] { min-width:0; overflow:hidden; text-overflow:ellipsis; border:0; border-radius:7px; padding:5px 6px; background:transparent; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; font-weight:650; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"][aria-selected="true"] { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); box-shadow:0 1px 3px var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__roster-label small { font-weight:600; text-transform:none; letter-spacing:0; color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__rail-divider { block-size:1px; margin:8px 2px; border:0; background:var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-action { color:var(--dsw-alias-brand-primary); font-weight:800; }
[data-swarm-team-dashboard] .swarm-team-workspace__board { display:grid; gap:12px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__board-head { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__captains { display:grid; gap:6px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-list { display:grid; gap:6px; max-block-size:220px; overflow-y:auto; overflow-x:hidden; min-width:0; }
/* ---- task-3: honest identity card + safe pixel avatar (not-generated placeholder) ---- */
[data-swarm-team-dashboard] .swarm-team-workspace__identity-card { display:grid; gap:8px; padding:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-header { display:flex; align-items:center; gap:10px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-fields { display:grid; gap:6px; margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-fields div { display:flex; justify-content:space-between; gap:8px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-fields dt { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-fields dd { margin:0; color:var(--dsw-alias-brand-primary); font-weight:700; font-size:12px; }
[data-swarm-team-dashboard] [data-swarm-pixel-avatar] { border-radius:50%; }
[data-swarm-team-dashboard] [data-avatar-state="not_generated"], [data-swarm-team-dashboard] [data-avatar-state="unavailable"] { box-shadow:inset 0 0 0 1.5px var(--dsw-alias-border-l2); }
/* Empty/error/loading states keep the same product shell as a bound Team.  The
   transport error is secondary diagnostic copy, never the whole first screen. */
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell { display:flex; flex-direction:column; gap:8px; min-height:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-hero { display:grid; grid-template-columns:36px minmax(0,1fr); align-items:center; gap:9px; padding:9px; border:1px solid var(--dsw-alias-border-l2); border-radius:11px; background:linear-gradient(145deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-base)); }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-copy { display:flex; flex-direction:column; gap:4px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-copy strong { font-size:13px; line-height:18px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-copy small { font-size:10px; line-height:14px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-roster { display:grid; gap:6px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-person { display:grid; grid-template-columns:32px minmax(0,1fr) auto; align-items:center; gap:8px; padding:7px 8px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-person .swarm-team-workspace__avatar { inline-size:32px; block-size:32px; font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell .swarm-team-workspace__switcher-mark { inline-size:36px; block-size:36px; border-radius:9px; font-size:14px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell .swarm-team-workspace__unavailable-card { padding:8px; border-radius:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell .swarm-team-workspace__unavailable-card strong { font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell .swarm-team-workspace__unavailable-card p { margin:3px 0 0; font-size:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-person .swarm-team-workspace__avatar { filter:saturate(.25); opacity:.7; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-actions { display:flex; gap:8px; flex-wrap:wrap; }
`

/** The sole Team UI is a read-only projection in the official Details column. */
export function TeamDashboardContent({ controller, coordinator, descriptionId, headingId, localeTag, state, t }: {
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly descriptionId: string
  readonly headingId: string
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly state: TeamDashboardState
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [selection, setSelection] = useState<Selection>({ kind: 'team' })
  const [workspaceRef, workspaceLayout] = useTeamWorkspaceLayout()
  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void coordinator.openCaptainChat().catch(() => {}).finally(() => { setHandoffBusy(false) })
  }
  const onMainBrain = (): void => { coordinator.closeAndRestoreFocus() }
  const data = state.data?.projection
  return <div className="swarm-team-workspace" data-swarm-team-layout={workspaceLayout} ref={workspaceRef}>
    <style>{shellCss}</style>
    <header className="swarm-team-workspace__header">
      <div><div className="swarm-team-workspace__title-row"><h2 className="swarm-team-workspace__title swarm-team-workspace__truncate" id={headingId} title={data?.team.name}>{data?.team.name ?? t('title')}</h2>{data === undefined ? null : <span className="swarm-team-workspace__muted">{enumLabel(data.team.phase, t)}</span>}</div><p className="swarm-team-workspace__description" id={descriptionId}>{t('description')}</p></div>
      <Button size="sm" variant="toolbar" aria-label={t('close')} title={t('close')} onClick={() => { coordinator.closeAndRestoreFocus() }}><IconCloseOutline16 /></Button>
    </header>
    <main className="swarm-team-workspace__body">
      {data === undefined
        ? <Empty state={state} controller={controller} t={t} teams={state.data?.teams} onMainBrain={onMainBrain} onOpenCaptain={coordinator.openTeamCaptain} />
        : <><Status state={state} t={t} /><Workspace data={data} handoffBusy={handoffBusy} localeTag={localeTag} selection={selection} setSelection={setSelection} t={t} teams={state.data?.teams} announcements={state.data?.captainAnnouncements} diagnostics={state.data?.captainDiagnostics} memberAssets={state.data?.captainMembers} onMainBrain={onMainBrain} onMainChat={handoff} onOpenCaptain={coordinator.openTeamCaptain} /></>}
    </main>
    {data === undefined ? null : <footer className="swarm-team-workspace__footer">
      <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { controller.refresh() }}>{t('refresh')}</Button>
      <Button size="sm" variant="primary" disabled={data === undefined || handoffBusy} onClick={handoff}>{handoffBusy ? t('openingChat') : t('openChat')}</Button>
    </footer>}
  </div>
}

export const TEAM_WORKSPACE_WIDE_MIN_WIDTH = 720
export type TeamWorkspaceLayout = 'compact' | 'wide'
/** The Details container, rather than the browser viewport, chooses the layout branch. */
export function teamWorkspaceLayoutForWidth(width: number): TeamWorkspaceLayout { return width >= TEAM_WORKSPACE_WIDE_MIN_WIDTH ? 'wide' : 'compact' }

function useTeamWorkspaceLayout(): readonly [RefObject<HTMLDivElement>, TeamWorkspaceLayout] {
  const ref = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<TeamWorkspaceLayout>('compact')
  useLayoutEffect(() => {
    const workspace = ref.current
    if (workspace === null || typeof ResizeObserver === 'undefined') return undefined
    const setWidth = (width: number): void => { setLayout(teamWorkspaceLayoutForWidth(width)) }
    setWidth(workspace.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => { const entry = entries.find(candidate => candidate.target === workspace); if (entry !== undefined) setWidth(entry.contentRect.width) })
    observer.observe(workspace)
    return () => { observer.disconnect() }
  }, [])
  return [ref, layout]
}

function Status({ state, t }: { readonly state: TeamDashboardState; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading') : state.phase === 'reconnecting' ? t('reconnecting') : state.phase === 'stale' ? t('stale') : t('error')
  return <div className="swarm-team-workspace__status" role={failed ? 'alert' : 'status'} aria-live="polite"><StateDot state={failed ? 'warning' : 'ongoing'} /><span>{label}</span>{state.error === undefined ? null : <span className="swarm-team-workspace__error" title={`${state.error.code}: ${state.error.message}`}><code>{state.error.code}</code><small className="swarm-team-workspace__muted">: {state.error.message}</small></span>}</div>
}

function Empty({ state, controller, t, teams, onMainBrain, onOpenCaptain }: {
  readonly state: TeamDashboardState
  readonly controller: TeamDashboardController
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly onMainBrain: () => void
  readonly onOpenCaptain: (captainSessionId: string) => void
}) {
  const failed = state.phase === 'error' || state.phase === 'stale'
  return <section className="swarm-team-workspace__rail swarm-team-workspace__empty-shell" data-swarm-team-rail data-swarm-empty-shell>
    <ViewTabs active="main" onSelect={tab => { if (tab === 'main') onMainBrain() }} t={t} />
    <CaptainList teams={teams} number={new Intl.NumberFormat()} onOpenCaptain={onOpenCaptain} t={t} />
    <section className="swarm-team-workspace__empty-roster" aria-label={t('members')}>
      <span className="swarm-team-workspace__roster-label"><span>{t('members')} · 0</span><small>{t('rosterMembersHint')}</small></span>
      <div className="swarm-team-workspace__empty-person"><span className="swarm-team-workspace__avatar" aria-hidden="true">+</span><span className="swarm-team-workspace__member-copy"><strong>{t('empty')}</strong><small>{failed ? t('error') : t('loading')}</small></span><StateDot state={failed ? 'warning' : 'ongoing'} /></div>
    </section>
    <section className="swarm-team-workspace__unavailable-card" data-swarm-goal-unavailable><strong>{t('goal')}</strong><p className="swarm-team-workspace__muted">{t('goalUnavailable')}</p></section>
    <details className="swarm-team-workspace__diagnostics"><summary>{t('diagnostics')}</summary><Status state={state} t={t} /></details>
    <div className="swarm-team-workspace__empty-actions">{failed ? <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button> : null}<Button variant="ghost" onClick={() => { controller.refresh() }}>{t('refresh')}</Button></div>
  </section>
}

function Workspace({ data, handoffBusy, localeTag, selection, setSelection, t, teams, announcements, diagnostics, memberAssets, onMainBrain, onMainChat, onOpenCaptain }: {
  readonly data: SwarmHostReadProjectionV1
  readonly handoffBusy: boolean
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly selection: Selection
  readonly setSelection: (selection: Selection) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly onMainBrain: () => void
  readonly onMainChat: () => void
  readonly onOpenCaptain: (captainSessionId: string) => void
}) {
  const number = new Intl.NumberFormat(localeTag())
  const [missingMember, setMissingMember] = useState<string>()
  const [missingTask, setMissingTask] = useState<string>()
  const [managementOpen, setManagementOpen] = useState(false)
  const [view, setView] = useState<'roster' | 'board'>('roster')
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null)
  const taskSummaryRef = useRef<HTMLElement>(null)
  const memberTriggers = useRef(new Map<string, HTMLButtonElement>())
  const taskTriggers = useRef(new Map<string, HTMLButtonElement>())
  const focusIntent = useRef<FocusIntent>()
  const registerMemberTrigger = (name: string, element: HTMLButtonElement | null): void => {
    if (element === null) memberTriggers.current.delete(name)
    else memberTriggers.current.set(name, element)
  }
  const registerTaskTrigger = (id: string, element: HTMLButtonElement | null): void => {
    if (element === null) taskTriggers.current.delete(id)
    else taskTriggers.current.set(id, element)
  }
  useLayoutEffect(() => {
    const intent = focusIntent.current
    if (intent === undefined) return
    focusIntent.current = undefined
    let target: HTMLElement | null | undefined
    switch (intent.kind) {
      case 'roster': target = rosterHeadingRef.current; break
      case 'tasks': target = taskSummaryRef.current; break
      case 'member': target = memberTriggers.current.get(intent.name) ?? rosterHeadingRef.current; break
      case 'task': target = taskTriggers.current.get(intent.id) ?? taskSummaryRef.current; break
    }
    target?.focus()
  }, [data.roster, data.tasks, selection])
  useLayoutEffect(() => {
    if (selection.kind !== 'member' || data.roster.some(member => member.name === selection.name)) return
    setMissingMember(selection.name)
    focusIntent.current = { kind: 'roster' }
    setSelection({ kind: 'team' })
  }, [data.roster, selection, setSelection])
  useLayoutEffect(() => {
    if (selection.kind !== 'task' || data.tasks.some(task => task.id === selection.id)) return
    setMissingTask(selection.id)
    focusIntent.current = { kind: 'tasks' }
    setSelection({ kind: 'team' })
  }, [data.tasks, selection, setSelection])
  const selectMember = (name: string): void => { setMissingMember(undefined); setSelection({ kind: 'member', name }) }
  const selectTask = (id: string): void => { setMissingTask(undefined); setSelection({ kind: 'task', id }) }
  const returnToMembers = (name: string): void => { focusIntent.current = { kind: 'member', name }; setSelection({ kind: 'team' }) }
  const returnToTasks = (id: string): void => { focusIntent.current = { kind: 'task', id }; setSelection({ kind: 'team' }) }
  const selected = selection.kind === 'member' ? data.roster.find(member => member.name === selection.name) : undefined
  const onViewTab = (tab: 'main' | 'captain' | 'board'): void => {
    if (tab === 'main') onMainBrain()
    else if (tab === 'captain') onMainChat()
    else setView('board')
  }
  return <section className="swarm-team-workspace__rail" aria-label={t('tabs.label')} data-swarm-team-rail>
    <ViewTabs active={view === 'board' ? 'board' : 'main'} onSelect={onViewTab} t={t} />
    {view === 'board'
      ? <BoardView data={data} announcements={announcements} diagnostics={diagnostics} number={number} onBack={() => { setView('roster') }} t={t} />
      : <>{managementOpen
        ? <ManagementView data={data} announcements={announcements} diagnostics={diagnostics} number={number} onBack={() => { setManagementOpen(false) }} t={t} />
        : <><CaptainList teams={teams} number={number} onOpenCaptain={onOpenCaptain} t={t} />
        <BoundTeamIdentityCard data={data} teams={teams} t={t} />
        <TeamSwitcher data={data} t={t} />
        <BrowserNav busy={handoffBusy} onMainBrain={onMainBrain} onCaptain={onMainChat} t={t} />
        <ManagementEntry onOpen={() => { setManagementOpen(true) }} t={t} />
        <div className="swarm-team-workspace__roster"><span className="swarm-team-workspace__roster-label" data-swarm-roster-captain-label><span>{t('captainRole')} · 1</span><small>{t('rosterCaptainHint')}</small></span>
          <CaptainRow busy={handoffBusy} onMainChat={onMainChat} teamName={data.team.name} t={t} />
          <hr className="swarm-team-workspace__rail-divider" aria-hidden="true" data-swarm-rail-divider />
          <h3 className="swarm-team-workspace__column-title swarm-team-workspace__roster-label" ref={rosterHeadingRef} tabIndex={-1} data-swarm-roster-members-label><span>{t('members')} · {number.format(data.totals.roster)}</span><small>{t('rosterMembersHint')}</small></h3>
        {missingMember === undefined ? null : <p className="swarm-team-workspace__muted swarm-team-workspace__notice" role="status">{t('memberNoLongerAvailable', { name: missingMember })}</p>}
        <div className="swarm-team-workspace__members">{selected === undefined ? <MemberRows data={data} memberAssets={memberAssets} onSelect={selectMember} onTrigger={registerMemberTrigger} t={t} /> : <MemberDetail data={data} member={selected} memberAssets={memberAssets} onBack={() => { returnToMembers(selected.name) }} t={t} />}</div>
        {data.truncated.roster ? <p className="swarm-team-workspace__muted swarm-team-workspace__notice">{t('rosterTruncated', { shown: number.format(data.roster.length), total: number.format(data.totals.roster) })}</p> : null}
      </div>
      <details className="swarm-team-workspace__collapsible"><summary ref={taskSummaryRef}>{t('tasks')}</summary>{missingTask === undefined ? null : <p className="swarm-team-workspace__muted swarm-team-workspace__notice" role="status">{t('taskNoLongerAvailable')}</p>}{selection.kind === 'task' ? <TaskDetail data={data} id={selection.id} number={number} onBack={() => { returnToTasks(selection.id) }} t={t} /> : <TaskRows data={data} onSelect={selectTask} onTrigger={registerTaskTrigger} t={t} />}</details>
      <details className="swarm-team-workspace__collapsible"><summary>{t('tabs.overview')}</summary><div className="swarm-team-workspace__summary"><Metric label={t('members')} value={number.format(data.totals.roster)} /><Metric label={t('tasks')} value={number.format(data.totals.tasks)} /><Metric label={t('interactions')} value={number.format(data.totals.pendingInteractions)} /><Metric label={t('attempts')} value={number.format(data.totals.attempts)} /></div></details>
      <details className="swarm-team-workspace__collapsible"><summary>{t('budget')}</summary><BudgetStats budget={data.budget} number={number} t={t} /></details>
      <details className="swarm-team-workspace__collapsible"><summary>{t('capabilities')}</summary><CapabilityRows capabilities={data.capabilities} t={t} /></details>
      <Diagnostics data={data} captainDiagnostics={diagnostics} number={number} t={t} />
      </>}</>
    }
  </section>
}

/** View-tabs navigation segment transplanted from the wireframe: Main Brain / Captain / Board.
 *  Main Brain returns to the official central Chat; Captain opens the dedicated Captain Chat;
 *  Board switches to the in-slot announcements/board view. Arrow-key navigation over role=tablist. */
function ViewTabs({ active, onSelect, t }: { readonly active: 'main' | 'captain' | 'board'; readonly onSelect: (tab: 'main' | 'captain' | 'board') => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const tabs = [
    { id: 'main' as const, label: t('mainBrain') },
    { id: 'captain' as const, label: t('independentCaptain') },
    { id: 'board' as const, label: t('announcements') },
  ]
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onSelect(tabs[next]!.id)
    ;(event.currentTarget as HTMLButtonElement).focus()
  }
  return <div className="swarm-team-workspace__view-tabs" role="tablist" aria-label={t('tabs.label')} data-swarm-view-tabs>{tabs.map((tab, index) => (
    <button key={tab.id} type="button" role="tab" id={`swarm-tab-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} data-swarm-view-tab={tab.id} onKeyDown={event => { onKeyDown(event, index) }} onClick={() => { onSelect(tab.id) }}>{tab.label}</button>
  ))}</div>
}

/** Board view: real captain-scoped announcements/diagnostics reads plus folded real-data sections.
 *  Today the host answers announcements with an explicit bounded unavailable; the section still
 *  renders from the real response, never a hardcoded stub. */
function BoardView({ data, announcements, diagnostics, number, onBack, t }: { readonly data: SwarmHostReadProjectionV1; readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined; readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined; readonly number: Intl.NumberFormat; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <div className="swarm-team-workspace__board" data-swarm-board-view>
    <div className="swarm-team-workspace__board-head"><Button size="sm" variant="ghost" onClick={onBack}>{t('backToMembers')}</Button></div>
    <section className="swarm-team-workspace__unavailable-card" data-swarm-goal-unavailable><strong>{t('goal')}</strong><p className="swarm-team-workspace__muted">{t('goalUnavailable')}</p></section>
    <AnnouncementSection announcements={announcements} t={t} />
    <details className="swarm-team-workspace__collapsible"><summary>{t('budget')}</summary><BudgetStats budget={data.budget} number={number} t={t} /></details>
    <details className="swarm-team-workspace__collapsible"><summary>{t('capabilities')}</summary><CapabilityRows capabilities={data.capabilities} t={t} /></details>
    <Diagnostics data={data} captainDiagnostics={diagnostics} number={number} t={t} />
  </div>
}

/** Independent management entry: opens a separate management surface (public goal,
 *  announcements, write capabilities) instead of stacking internal fields on the
 *  roster-first sidebar. Diagnostics stay folded within that surface. */
function ManagementEntry({ onOpen, t }: { readonly onOpen: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <button className="swarm-team-workspace__row swarm-team-workspace__management-entry" type="button" data-swarm-management-entry onClick={onOpen} title={t('openPublicBoard')}><span className="swarm-team-workspace__row-main"><span className="swarm-team-workspace__truncate">{t('publicBoard')}</span><span className="swarm-team-workspace__badge">{t('manage')}</span></span></button>
}

/** The management/diagnostics surface is separate from the roster sidebar. It is a three-layer
 *  projection of the real Host read contract only:
 *    1) identity/onboarding state (no dossier backend → profiles are explicitly incomplete),
 *    2) real Team data (goal + announcements degrade to `unavailable`; budget & capabilities fold),
 *    3) folded technical diagnostics.
 *  The sidebar's first screen never shows these internal ledger fields. */
function ManagementView({ data, announcements, diagnostics, number, onBack, t }: { readonly data: SwarmHostReadProjectionV1; readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined; readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined; readonly number: Intl.NumberFormat; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { headingRef.current?.focus() }, [])
  return <div className="swarm-team-workspace__management" data-swarm-management-view>
    <div className="swarm-team-workspace__management-head"><h3 className="swarm-team-workspace__column-title" ref={headingRef} tabIndex={-1}>{t('managementTitle')}</h3><Button size="sm" variant="ghost" onClick={onBack}>{t('managementBack')}</Button></div>
    <p className="swarm-team-workspace__muted">{t('managementDescription')}</p>
    <section className="swarm-team-workspace__unavailable-card" data-swarm-identity-incomplete><strong>{t('identityStatus')}</strong><p className="swarm-team-workspace__muted">{t('profileIncomplete')}</p></section>
    <section className="swarm-team-workspace__unavailable-card" data-swarm-goal-unavailable><strong>{t('goal')}</strong><p className="swarm-team-workspace__muted">{t('goalUnavailable')}</p></section>
    <AnnouncementSection announcements={announcements} t={t} />
    <details className="swarm-team-workspace__collapsible"><summary>{t('writeCapabilities')}</summary><p className="swarm-team-workspace__muted">{t('writeUnavailable')}</p><CapabilityRows capabilities={data.capabilities} t={t} /></details>
    <details className="swarm-team-workspace__collapsible"><summary>{t('budget')}</summary><BudgetStats budget={data.budget} number={number} t={t} /></details>
    <Diagnostics data={data} captainDiagnostics={diagnostics} number={number} t={t} />
  </div>
}

/** Announcements rendered from the real captain read only. The read contract currently admits a
 *  single honest outcome — `state: 'unavailable'` with a stable reason and an always-empty entry
 *  list — so the section renders exactly that compact explicit unavailable state. It never renders
 *  placeholder rows, and it never implies a working notice board. If the backend later delivers
 *  entries, they must be rendered here as real user-visible notice content, never indices. */
function AnnouncementSection({ announcements, t }: { readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (announcements !== undefined && announcements.entries.length > 0) {
    return <section className="swarm-team-workspace__unavailable-card" data-swarm-announcements-state="unavailable"><strong>{t('announcements')}</strong><p className="swarm-team-workspace__muted">{t('announcementsUnavailable')}</p></section>
  }
  return <section className="swarm-team-workspace__unavailable-card" data-swarm-announcement-unavailable data-swarm-announcements-state={announcements?.state ?? 'loading'}>
    <strong>{t('announcements')}</strong>
    {announcements === undefined
      ? <p className="swarm-team-workspace__muted">{t('loading')}</p>
      : <p className="swarm-team-workspace__muted" data-swarm-announcement-reason={announcements.reason}>{t('announcementsUnavailable')}</p>}
  </section>
}

/** The Team switcher names the real bound Team. Without a Host Team directory it can
 *  only ever switch within the current Team, so the "switch to another Team" control is
 *  an explicit disabled `unavailable` capability — never a faked multi-Team index. */
function TeamSwitcher({ data, t }: { readonly data: SwarmHostReadProjectionV1; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <div className="swarm-team-workspace__switcher" data-swarm-team-switcher>
    <span className="swarm-team-workspace__switcher-mark" aria-hidden="true">{memberRosterInitial(data.team.name)}</span>
    <div className="swarm-team-workspace__switcher-inner"><div className="swarm-team-workspace__switcher-title"><strong className="swarm-team-workspace__truncate" title={data.team.name}>{data.team.name}</strong><span className="swarm-team-workspace__muted swarm-team-workspace__truncate" title={data.binding.teamId}>{t('teamBound')} · {data.binding.teamId}</span></div>
    <button className="swarm-team-workspace__row swarm-team-workspace__switch-button" type="button" disabled aria-disabled="true" data-swarm-team-switch-unavailable title={t('teamSwitcherUnavailable')}><span className="swarm-team-workspace__row-main"><span className="swarm-team-workspace__truncate">{t('switchTeam')}</span><span className="swarm-team-workspace__badge swarm-team-workspace__badge-unavailable">{t('unavailable')}</span></span></button></div>
  </div>
}

/** Main Brain / Dedicated Captain navigation over official seams: Main Brain returns to
 *  the owner conversation we are docked in; the Captain opens the dedicated Team Captain
 *  Chat via the existing `coordinator.openCaptainChat`. */
function BrowserNav({ busy, onMainBrain, onCaptain, t }: { readonly busy: boolean; readonly onMainBrain: () => void; readonly onCaptain: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <nav className="swarm-team-workspace__nav" aria-label={t('tabs.label')} data-swarm-browser-nav>
    <button className="swarm-team-workspace__row swarm-team-workspace__nav-button" type="button" data-swarm-nav-main onClick={onMainBrain} title={t('returnToMainBrain')}><span className="swarm-team-workspace__row-main"><span className="swarm-team-workspace__avatar" aria-hidden="true">脑</span><strong className="swarm-team-workspace__truncate">{t('mainBrain')}<small className="swarm-team-workspace__muted swarm-team-workspace__truncate">{t('mainBrainCaption')}</small></strong></span><span className="swarm-team-workspace__badge swarm-team-workspace__badge-current">{t('current')}</span></button>
    <button className="swarm-team-workspace__row swarm-team-workspace__nav-button" type="button" data-swarm-nav-captain disabled={busy} onClick={onCaptain} title={t('openIndependentCaptain')}><span className="swarm-team-workspace__row-main"><span className="swarm-team-workspace__avatar" aria-hidden="true">C</span><strong className="swarm-team-workspace__truncate">{t('independentCaptain')}</strong></span></button>
  </nav>
}

/** Budget is a read-only projection of the Host's authoritative usage counters
 *  (used/limit pairs); the client never recomputes or caps them. */
function BudgetStats({ budget, number, t }: { readonly budget: SwarmHostReadProjectionV1['budget']; readonly number: Intl.NumberFormat; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const metric = (used: number, limit?: number): string => limit === undefined ? number.format(used) : `${number.format(used)} / ${number.format(limit)}`
  return <div data-swarm-budget><Facts rows={[
    [t('usedTokens'), metric(budget.usedTokens, budget.tokenLimit)],
    [t('usedRequests'), metric(budget.usedRequests, budget.requestLimit)],
    [t('usedRetries'), metric(budget.usedRetries, budget.retryLimit)],
  ]} /></div>
}

/** Capabilities are shown exactly as the Host projects them; the write capabilities
 *  (message.write/control.write/effect.cancel) surface as explicit `unavailable`
 *  so a read-only Team workspace never implies a human write path. */
function CapabilityRows({ capabilities, t }: { readonly capabilities: SwarmHostReadProjectionV1['capabilities']; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows" data-swarm-capabilities>{capabilities.map(capability => (
    <li key={capability.capability}><span className="swarm-team-workspace__capability" data-swarm-capability={capability.capability} data-swarm-capability-state={capability.state}><span className="swarm-team-workspace__truncate" title={capability.capability}>{capability.capability}</span><span className="swarm-team-workspace__muted">{capability.state === 'available' ? t('available') : t('unavailable')}</span></span>{capability.blocker === undefined ? null : <small className="swarm-team-workspace__muted" data-swarm-capability-blocker>{capability.blocker}</small>}</li>
  ))}</ul>
}

function CaptainRow({ busy, onMainChat, teamName, t }: { readonly busy: boolean; readonly onMainChat: () => void; readonly teamName: string; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const label = t('captainCurrent', { team: teamName })
  return <button className="swarm-team-workspace__row swarm-team-workspace__captain-hero" type="button" disabled={busy} onClick={onMainChat} title={t('captainMainChatTitle')}><span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={teamName} asset={NOT_GENERATED_AVATAR} name={label} t={t} /></span><span className="swarm-team-workspace__member-copy"><strong className="swarm-team-workspace__truncate" title={label}>{label}</strong><small className="swarm-team-workspace__profile-incomplete" data-swarm-profile-incomplete>{t('profileIncomplete')}</small></span><span className="swarm-team-workspace__member-side"><span className="swarm-team-workspace__captain-badge">{t('captainRole')}</span><small className="swarm-team-workspace__captain-action" data-swarm-captain-action>{t('captainOpenAction')}</small></span></button>
}

/** First-level right-rail Captain/team list from the read-only Team enumeration (real aggregates,
 *  never a copied state). Each row shows an un-generated identity card (backend has no profile
 *  authority) and opens that Team's dedicated Captain via the official Session seam. Zero Teams is
 *  an explicit empty state; more than one Team is a legal multi-Captain result. */
function CaptainList({ teams, number, onOpenCaptain, t }: {
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly number: Intl.NumberFormat
  readonly onOpenCaptain: (captainSessionId: string) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const rows = teams?.teams ?? []
  return <section className="swarm-team-workspace__captains" data-swarm-captain-list>
    <span className="swarm-team-workspace__roster-label" data-swarm-captains-label><span>{t('captains')} · {number.format(rows.length)}</span><small>{t('captainsHint')}</small></span>
    {rows.length === 0
      ? <section className="swarm-team-workspace__unavailable-card" data-swarm-captains-empty><strong>{t('captainsEmpty')}</strong></section>
      : <div className="swarm-team-workspace__captain-list">{rows.map(team => (
        <button key={team.teamId} className="swarm-team-workspace__row swarm-team-workspace__captain-hero" type="button" data-swarm-captain-team={team.teamId} data-swarm-captain-session={team.captainSessionId} onClick={() => { onOpenCaptain(team.captainSessionId) }} title={t('openCaptainSession')}><span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={team.name} asset={team.avatar} name={team.name} t={t} /></span><span className="swarm-team-workspace__member-copy"><strong className="swarm-team-workspace__truncate" title={team.name}>{team.name}</strong><small className="swarm-team-workspace__profile-incomplete" data-swarm-profile-incomplete>{t('captainIdentityUnavailable')}</small></span><span className="swarm-team-workspace__member-side"><span className="swarm-team-workspace__captain-badge">{t('captainRole')}</span><small className="swarm-team-workspace__captain-action" data-swarm-captain-action>{t('openCaptainSession')}</small></span></button>
      ))}</div>}
  </section>
}

/** Identity card for the current bound Team: name/role are authoritative Team domain fields, while
 *  profession/personality and the pixel avatar render the honest not-generated/unavailable state the
 *  backend reports (never a fabricated profile). Falls back to explicit not-generated if the bound
 *  Team is not present in the enumeration. */
function BoundTeamIdentityCard({ data, teams, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const bound = teams?.teams.find(team => team.teamId === data.binding.teamId)
  return <TeamIdentityCard name={data.team.name} role={t('captainRole')}
    avatar={bound?.avatar ?? { state: 'not_generated', reason: 'avatar_backend_not_implemented' } as const}
    identityCard={bound?.identityCard ?? { state: 'not_generated', reason: 'identity_backend_not_implemented' } as const}
    t={t} />
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) { return <div className="swarm-team-workspace__metric"><strong>{value}</strong><span className="swarm-team-workspace__muted">{label}</span></div> }

/** Real member identity card data comes from the captainMembers read keyed by the authoritative
 *  roster name; a missing row keeps the honest not-generated placeholder, never a fabricated asset. */
function memberAssetOf(memberAssets: SwarmReadCaptainMembersV1 | undefined, name: string): { readonly avatar: SwarmReadAssetStatusV1; readonly identityCard: SwarmReadAssetStatusV1 } {
  const row = memberAssets?.members.find(candidate => candidate.name === name)
  return {
    avatar: row?.avatar ?? NOT_GENERATED_AVATAR,
    identityCard: row?.identityCard ?? { state: 'not_generated', reason: 'identity_backend_not_implemented' },
  }
}

function MemberRows({ data, memberAssets, onSelect, onTrigger, t }: { readonly data: SwarmHostReadProjectionV1; readonly memberAssets: SwarmReadCaptainMembersV1 | undefined; readonly onSelect: (name: string) => void; readonly onTrigger: (name: string, element: HTMLButtonElement | null) => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows" data-swarm-member-rows>{data.roster.length === 0 ? <li className="swarm-team-workspace__muted">{t('empty')}</li> : data.roster.map(member => {
    const activity = deriveMemberActivity(data, member.name, member.phase)
    const activityText = memberActivityLabel(activity, t)
    const lifecycleText = `${t('memberLifecycle')}: ${enumLabel(member.phase, t)}`
    const asset = memberAssetOf(memberAssets, member.name)
    return <li key={member.name}><button className="swarm-team-workspace__row" data-swarm-member-name={member.name} data-swarm-member-role={member.role} data-swarm-member-lifecycle={member.phase} data-swarm-member-activity={activity.state} type="button" ref={element => { onTrigger(member.name, element) }} onClick={() => { onSelect(member.name) }}><span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={member.name} t={t} /></span><span className="swarm-team-workspace__member-copy"><strong className="swarm-team-workspace__truncate" title={member.name}>{member.name}</strong><small className="swarm-team-workspace__muted swarm-team-workspace__member-role swarm-team-workspace__truncate" title={member.role}>{member.role}</small></span><span className="swarm-team-workspace__member-side"><span className="swarm-team-workspace__muted swarm-team-workspace__member-activity" data-swarm-member-visible-activity={activityText} title={activityText}><StateDot state={memberActivityDot(activity.state)} />{activityText}</span><small className="swarm-team-workspace__muted" data-swarm-member-visible-lifecycle={lifecycleText} title={lifecycleText}>{lifecycleText}</small><small className="swarm-team-workspace__profile-incomplete" data-swarm-profile-incomplete data-swarm-identity-state={asset.identityCard.state}>{asset.identityCard.state === 'generated' ? t('identityCardTitle') : t('profileIncomplete')}</small></span></button></li>
  })}</ul>
}

function MemberDetail({ data, member, memberAssets, onBack, t }: { readonly data: SwarmHostReadProjectionV1; readonly member: SwarmHostReadProjectionV1['roster'][number]; readonly memberAssets: SwarmReadCaptainMembersV1 | undefined; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const activity = deriveMemberActivity(data, member.name, member.phase)
  const current = isCurrentMemberWork(activity)
  const asset = memberAssetOf(memberAssets, member.name)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { headingRef.current?.focus() }, [])
  return <div data-swarm-member-detail><h4 className="swarm-team-workspace__column-title swarm-team-workspace__truncate" ref={headingRef} tabIndex={-1} title={member.name}>{t('memberDetailHeading', { name: member.name })}</h4><Button size="sm" variant="ghost" onClick={onBack}>{t('backToMembers')}</Button><div className="swarm-team-workspace__identity-header" data-swarm-member-detail-identity><span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={member.name} t={t} /></span><span className="swarm-team-workspace__member-copy"><strong className="swarm-team-workspace__truncate" title={member.name}>{member.name}</strong><small className="swarm-team-workspace__member-role swarm-team-workspace__truncate" title={member.role}>{member.role}</small></span></div><p className="swarm-team-workspace__profile-incomplete" data-swarm-profile-incomplete data-swarm-identity-state={asset.identityCard.state}>{asset.identityCard.state === 'generated' ? t('identityCardTitle') : t('profileIncomplete')}</p><Facts rows={[[t('memberName'), member.name], [t('memberRole'), member.role], [t('memberLifecycle'), enumLabel(member.phase, t)], [t('profileProfession'), t('profileNotGenerated')], [t('profilePersonality'), t('profileNotGenerated')], [t('profileModel'), t('profileNotGenerated')], [t('memberTask'), current ? activity.task?.subject ?? t('hostUnavailable') : t('memberNone')], [t('memberAttempt'), activity.attempt === undefined ? t('memberNone') : current ? enumLabel(activity.attempt.phase, t) : t('memberRecentAttempt', { phase: enumLabel(activity.attempt.phase, t) })]]} /></div>
}

function TaskRows({ data, onSelect, onTrigger, t }: { readonly data: SwarmHostReadProjectionV1; readonly onSelect: (id: string) => void; readonly onTrigger: (id: string, element: HTMLButtonElement | null) => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows" data-swarm-task-rows>{data.tasks.length === 0 ? <li className="swarm-team-workspace__muted">{t('empty')}</li> : data.tasks.map(task => {
    const owner = task.ownerName ?? t('hostUnavailable')
    const target = task.targetMemberName ?? t('hostUnavailable')
    return <li key={task.id}><button className="swarm-team-workspace__row" type="button" ref={element => { onTrigger(task.id, element) }} onClick={() => { onSelect(task.id) }}><span className="swarm-team-workspace__row-main"><strong className="swarm-team-workspace__truncate" title={task.subject}>{task.subject}</strong><span className="swarm-team-workspace__muted">{enumLabel(task.status, t)}</span></span><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" data-swarm-task-owner={`${t('taskOwner')}: ${owner}`} title={`${t('taskOwner')}: ${owner}`}>{t('taskOwner')}: {owner}</small><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" data-swarm-task-target={`${t('taskTarget')}: ${target}`} title={`${t('taskTarget')}: ${target}`}>{t('taskTarget')}: {target}</small></button></li>
  })}</ul>
}

function TaskDetail({ data, id, number, onBack, t }: { readonly data: SwarmHostReadProjectionV1; readonly id: string; readonly number: Intl.NumberFormat; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const task = data.tasks.find(candidate => candidate.id === id)
  if (task === undefined) return <p className="swarm-team-workspace__muted">{t('detailEmpty')}</p>
  return <TaskDetailBody data={data} number={number} onBack={onBack} t={t} task={task} />
}

function TaskDetailBody({ data, number, onBack, t, task }: { readonly data: SwarmHostReadProjectionV1; readonly number: Intl.NumberFormat; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>; readonly task: SwarmHostReadProjectionV1['tasks'][number] }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { headingRef.current?.focus() }, [])
  return <div data-swarm-task-detail><h4 className="swarm-team-workspace__column-title swarm-team-workspace__truncate" ref={headingRef} tabIndex={-1} title={task.subject}>{t('taskDetailHeading', { subject: task.subject })}</h4><Button size="sm" variant="ghost" onClick={onBack}>{t('backToTasks')}</Button><Facts rows={[[t('status'), enumLabel(task.status, t)], [t('taskOwner'), task.ownerName ?? t('hostUnavailable')], [t('taskTarget'), task.targetMemberName ?? t('hostUnavailable')], [t('taskBlocked', { count: number.format(task.blockedBy.length) }), task.blockedBy.length === 0 ? t('empty') : task.blockedBy.join(', ')]]} /><details className="swarm-team-workspace__diagnostics"><summary>{t('taskDiagnostics')}</summary><Facts rows={[[t('taskId'), task.id], [t('taskCurrentAttempt'), task.currentAttemptId ?? t('memberNone')]]} /></details><Diagnostics data={data} number={number} t={t} /></div>
}

function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) { return <dl className="swarm-team-workspace__facts">{rows.map(([label, value]) => <div className="swarm-team-workspace__fact" key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl> }

function Diagnostics({ data, captainDiagnostics, number, t }: { readonly data: SwarmHostReadProjectionV1; readonly captainDiagnostics?: SwarmReadCaptainDiagnosticsV1 | undefined; readonly number: Intl.NumberFormat; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <details className="swarm-team-workspace__diagnostics"><summary>{t('diagnostics')}</summary><p className="swarm-team-workspace__muted">{t('diagnosticsDescription')}</p><Facts rows={[[t('diagnosticsSession'), data.binding.rootSessionId], [t('diagnosticsRevision'), number.format(captainDiagnostics?.diagnostics.revision ?? data.team.revision)], ...(captainDiagnostics === undefined ? [] : [[t('diagnosticsBackend'), captainDiagnostics.diagnostics.backend] as const]), [t('diagnosticsAttempts'), number.format(data.totals.attempts)], [t('diagnosticsTrace'), t('diagnosticsTraceUnavailable')]]} /></details>
}

/** Pure display-only initials: NFC normalization plus the first grapheme cluster, never persisted. */
export function memberRosterInitial(name: string): string {
  const normalized = name.normalize('NFC')
  const segmenter = typeof Intl.Segmenter === 'undefined' ? undefined : new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return segmenter === undefined ? (Array.from(normalized)[0] ?? '') : (segmenter.segment(normalized)[Symbol.iterator]().next().value?.segment ?? '')
}

export type MemberActivity = {
  readonly task: SwarmHostReadProjectionV1['tasks'][number] | undefined
  readonly attempt: SwarmHostReadProjectionV1['attempts'][number] | undefined
  readonly state: 'running' | 'idle' | 'error' | 'provisioning' | 'removed' | SwarmHostReadProjectionV1['attempts'][number]['phase']
}

/** Strictly derives an activity only from a task's current attempt and matching member/task identifiers. */
export function deriveMemberActivity(data: SwarmHostReadProjectionV1, name: string, phase: SwarmHostReadProjectionV1['roster'][number]['phase']): MemberActivity {
  const currentAttempts = data.tasks.flatMap(task => {
    if (task.currentAttemptId === undefined) return []
    const attempt = data.attempts.find(candidate => candidate.id === task.currentAttemptId && candidate.taskId === task.id && candidate.memberName === name)
    return attempt === undefined ? [] : [{ task, attempt }]
  })
  const newest = currentAttempts.toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0]
  if (phase === 'failed') return { task: newest?.task, attempt: newest?.attempt, state: 'error' }
  if (phase === 'provisioning') return { task: newest?.task, attempt: newest?.attempt, state: 'provisioning' }
  if (phase === 'removed') return { task: newest?.task, attempt: newest?.attempt, state: 'removed' }
  const current = currentAttempts.filter(candidate => candidate.attempt.phase === 'running').toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0] ?? newest
  if (current?.attempt.phase === 'running') return { task: current.task, attempt: current.attempt, state: 'running' }
  if (current !== undefined) return { task: current.task, attempt: current.attempt, state: current.attempt.phase }
  return { task: undefined, attempt: undefined, state: 'idle' }
}

function isCurrentMemberWork(activity: MemberActivity): boolean {
  return activity.task !== undefined && activity.attempt !== undefined
    && ['in_progress', 'submitted', 'verifying'].includes(activity.task.status)
    && ['running', 'submitted', 'verifying'].includes(activity.attempt.phase)
}

function memberActivityLabel(activity: MemberActivity, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  if (activity.state === 'error') return t('memberError')
  if (activity.state === 'provisioning') return t('memberProvisioning')
  if (activity.state === 'removed') return t('memberRemoved')
  if (isCurrentMemberWork(activity)) return enumLabel(activity.attempt!.phase, t)
  if (activity.attempt !== undefined) return t('memberRecentAttempt', { phase: enumLabel(activity.attempt.phase, t) })
  return t('memberIdle')
}

/** Visible status dot mapped only from the derived real activity into three precise groups, never inventing a running state for idle/settled work:
 *  ongoing = running/provisioning/submitted/verifying (in flight); done = idle/accepted (settled, incl. completed work surfacing as an accepted attempt); warning = error/removed/rejected/stale/cancelled. */
function memberActivityDot(state: MemberActivity['state']): StateDotState {
  if (state === 'running' || state === 'provisioning' || state === 'submitted' || state === 'verifying') return 'ongoing'
  if (state === 'idle' || state === 'accepted') return 'done'
  return 'warning'
}

type WireEnum = SwarmHostReadProjectionV1['team']['phase'] | SwarmHostReadProjectionV1['roster'][number]['phase'] | SwarmHostReadProjectionV1['tasks'][number]['status'] | SwarmHostReadProjectionV1['attempts'][number]['phase']
const enumKey = Object.freeze({ active: 'enum.active', archived: 'enum.archived', provisioning: 'enum.provisioning', failed: 'enum.failed', removed: 'enum.removed', pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying', completed: 'enum.completed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted', rejected: 'enum.rejected', stale: 'enum.stale' } as const satisfies Record<WireEnum, TeamDashboardKey>)
function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string { return t(enumKey[value]) }
