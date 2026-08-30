import { Button, IconCloseOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadAssetStatusV1, SwarmReadCaptainAnnouncementsV1, SwarmReadCaptainDiagnosticsV1, SwarmReadCaptainMembersV1, SwarmReadMemberCompositionV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'

/** The read contract reports un-generated member assets with a stable reason; the UI never fabricates one. */
const NOT_GENERATED_AVATAR: SwarmReadAssetStatusV1 = { state: 'not_generated', reason: 'avatar_backend_not_implemented' }
const NOT_GENERATED_IDENTITY: SwarmReadAssetStatusV1 = { state: 'not_generated', reason: 'identity_backend_not_implemented' }

type DeskTone = 'standby' | 'executing' | 'pending' | 'failed' | 'offline'
type WorkspaceView = 'workspace' | 'tasks' | 'notices' | 'manage'
type DetailSelection =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'growth' }
  | { readonly kind: 'overview' }
  | { readonly kind: 'diagnostics' }

export const shellCss = `
[data-swarm-team-dashboard] .swarm-team-workspace { position:relative; container-type:inline-size; height:100%; min-width:0; overflow:hidden; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__pane { display:grid; grid-template-rows:auto auto auto minmax(0,1fr); min-width:0; min-height:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__title-row { display:flex; align-items:center; gap:8px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__title { margin:0; overflow:hidden; font-size:14px; line-height:19px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__team-switcher { min-width:0; max-inline-size:150px; padding:3px 22px 3px 7px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:10px; line-height:16px; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__team-switcher:hover { border-color:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__phase-pill { flex:0 0 auto; padding:1px 7px; border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l2)); border-radius:999px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-brand-primary); font-size:10px; font-weight:600; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__subtitle { margin:2px 0 0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-bar { display:grid; gap:8px; padding:8px 10px; border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; min-height:40px; padding:7px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card[data-swarm-goal-state="generated"] { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l2)); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__public-copy { display:grid; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-title { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-content { overflow:hidden; font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card time { color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"] { min-width:0; overflow:hidden; padding:8px 4px; border:0; border-radius:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; font-weight:600; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"]:hover { color:var(--dsw-alias-label-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"][aria-selected="true"] { color:var(--dsw-alias-brand-primary); box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-body { min-height:0; padding:10px 11px 16px; overflow:auto; scrollbar-width:thin; font-size:12px; line-height:1.45; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0; margin:10px 0 6px; font-size:12px; font-weight:700; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head:first-child { margin-top:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head small { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; font-weight:500; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__workroom { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
@container (max-width: 520px) { [data-swarm-team-dashboard] .swarm-team-workspace__workroom { grid-template-columns:1fr; } }
[data-swarm-team-dashboard] .swarm-team-workspace__desk { position:relative; display:grid; grid-template-columns:32px minmax(0,1fr) auto; grid-template-rows:auto auto; align-items:center; column-gap:8px; min-width:0; min-block-size:56px; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); color:inherit; text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk:hover { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l2)); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk .swarm-team-workspace__avatar { grid-row:1 / 3; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-copy { display:flex; flex-direction:column; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-name { min-width:0; overflow:hidden; font-size:12px; font-weight:680; line-height:17px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-role { min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-state { display:flex; align-items:center; gap:4px; grid-column:3; grid-row:1 / 3; min-width:0; max-width:100%; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-dot { flex:0 0 auto; inline-size:8px; block-size:8px; border-radius:50%; background:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="standby"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-positive, var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="executing"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-brand-primary); animation:swarm-desk-pulse 1.4s ease-in-out infinite; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="pending"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-caution, var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="failed"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-negative, var(--dsw-alias-label-secondary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="offline"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-secondary); }
@keyframes swarm-desk-pulse { 0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); } 50% { box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary) 0%, transparent); } }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-badge { flex:0 0 auto; margin-left:4px; padding:1px 4px; border-radius:4px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent); color:var(--dsw-alias-brand-primary); font-size:9px; font-weight:700; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity { border:0 solid var(--dsw-alias-border-l2); border-block-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; padding:8px 2px; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-row + .swarm-team-workspace__activity-row { border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-signal { flex:0 0 auto; inline-size:7px; block-size:7px; border-radius:50%; background:var(--dsw-alias-brand-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-signal[data-swarm-signal="pending"] { background:var(--dsw-alias-label-caution, var(--dsw-alias-brand-primary)); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-caution, var(--dsw-alias-brand-primary)) 12%, transparent); }
[data-swarm-signal="settled"] { opacity:.35; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-copy { display:grid; gap:2px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-title { overflow:hidden; font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-meta { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-state { color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__table { overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:8px; width:100%; min-width:0; padding:9px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2); background:transparent; color:inherit; font-size:11px; text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row:last-child { border-bottom-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row:hover { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy { display:grid; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy strong { overflow:hidden; font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy small { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-side { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__manage { display:grid; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__manage-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; padding:9px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__manage-action { flex:0 0 auto; padding:4px 10px; border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l2)); border-radius:8px; background:transparent; color:var(--dsw-alias-brand-primary); font-size:10px; cursor:pointer; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-overlay { position:absolute; inset:0; z-index:6; display:grid; grid-template-rows:auto minmax(0,1fr); background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-title { margin:0; overflow:hidden; font-size:13px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-sub { display:block; overflow:hidden; margin-top:1px; color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-body { min-height:0; padding:10px 11px 16px; overflow:auto; scrollbar-width:thin; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section { margin-bottom:8px; padding:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section h4 { margin:0 0 8px; font-size:11px; }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list { display:grid; grid-template-columns:74px minmax(0,1fr); gap:7px 8px; margin:0; font-size:11px; }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list dt { min-width:0; color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list dd { margin:0; min-width:0; overflow-wrap:anywhere; }
[data-swarm-team-dashboard] .swarm-team-workspace__unavailable { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__contact-note { margin:0; padding:8px; border:1px dashed var(--dsw-alias-border-l2); border-radius:9px; color:var(--dsw-alias-label-secondary); font-size:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-head { display:grid; grid-template-columns:40px minmax(0,1fr); align-items:center; gap:10px; margin-bottom:10px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-head .swarm-team-workspace__avatar { inline-size:40px; block-size:40px; }
[data-swarm-team-dashboard] .swarm-team-workspace__avatar { position:relative; display:grid; flex:0 0 auto; inline-size:32px; block-size:32px; place-items:center; overflow:hidden; border-radius:9px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 0 0 1px color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent); }
[data-swarm-team-dashboard] .swarm-team-workspace__summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:0 0 8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__metric { padding:8px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__metric strong { display:block; font-size:14px; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts { display:grid; gap:6px; margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dt { min-width:0; color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dd { margin:0; min-width:0; overflow:hidden; overflow-wrap:anywhere; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__truncate { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__status { display:flex; gap:8px; align-items:center; min-width:0; margin:0 0 8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__error { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__muted { color:var(--dsw-alias-label-secondary); font-size:11px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell { display:flex; flex-direction:column; gap:8px; grid-column:1 / -1; min-width:0; min-height:100%; padding:10px 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-actions { display:flex; gap:8px; flex-wrap:wrap; }
/* Narrow viewports: the official details track can overflow the visible viewport, so the Team panel escapes the track and overlays the viewport (z-index mirrors the official shell overlay layer). */
@media (max-width: 995.98px) { [data-swarm-team-dashboard][data-swarm-team-panel] { position:fixed; inset:0; z-index:20; } }
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
  const data = state.data?.projection
  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void coordinator.openCaptainChat().catch(() => {}).finally(() => { setHandoffBusy(false) })
  }
  return <div className="swarm-team-workspace" data-swarm-team-layout="workspace">
    <style>{shellCss}</style>
    {data === undefined
      ? <Empty state={state} controller={controller} t={t} />
      : <Workspace
        data={data}
        handoffBusy={handoffBusy}
        localeTag={localeTag}
        descriptionId={descriptionId}
        headingId={headingId}
        state={state}
        t={t}
        teams={state.data?.teams}
        announcements={state.data?.captainAnnouncements}
        diagnostics={state.data?.captainDiagnostics}
        memberAssets={state.data?.captainMembers}
        onCaptainSession={handoff}
        onSelectTeam={teamId => { controller.selectTeam(teamId) }}
        onClose={() => { coordinator.closeAndRestoreFocus() }}
      />}
  </div>
}

export const TEAM_WORKSPACE_WIDE_MIN_WIDTH = 720
export type TeamWorkspaceLayout = 'compact' | 'wide'
/** The Details container, rather than the browser viewport, chooses the layout branch. */
export function teamWorkspaceLayoutForWidth(width: number): TeamWorkspaceLayout { return width >= TEAM_WORKSPACE_WIDE_MIN_WIDTH ? 'wide' : 'compact' }

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

export type MemberActivity = {
  readonly task: SwarmHostReadProjectionV1['tasks'][number] | undefined
  readonly attempt: SwarmHostReadProjectionV1['attempts'][number] | undefined
  readonly state: 'running' | 'idle' | 'error' | 'provisioning' | 'removed' | SwarmHostReadProjectionV1['attempts'][number]['phase']
}

export type DeskToneExport = DeskTone
/** Visible work-seat status mapped only from the real roster/tasks/attempts into five honest tones:
 *  executing (blue pulse) = running attempt; pending (amber) = provisioning lifecycle, a
 *  submitted/verifying attempt, or a pending/in-flight task owned but not running; failed =
 *  failed lifecycle or errored activity; standby (green) = settled (accepted/rejected/cancelled/
 *  stale are ended, never pending) or no current work; offline (gray) = removed member. */
export function deriveMemberTone(data: SwarmHostReadProjectionV1, name: string, phase: SwarmHostReadProjectionV1['roster'][number]['phase']): DeskTone {
  if (phase === 'removed') return 'offline'
  const activity = deriveMemberActivity(data, name, phase)
  if (phase === 'failed' || activity.state === 'error') return 'failed'
  if (phase === 'provisioning') return 'pending'
  if (activity.state === 'running') return 'executing'
  if (activity.attempt !== undefined && (activity.attempt.phase === 'submitted' || activity.attempt.phase === 'verifying')) return 'pending'
  // Terminal attempts (accepted/rejected/cancelled/stale) are ended, never pending — unless the
  // member still owns another genuinely in-flight or unstarted task.
  if (data.tasks.some(task => task.ownerName === name && ['pending', 'in_progress', 'submitted', 'verifying'].includes(task.status))) return 'pending'
  return 'standby'
}

function toneLabel(tone: DeskTone, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  if (tone === 'executing') return t('tone.executing')
  if (tone === 'pending') return t('tone.pending')
  if (tone === 'failed') return t('tone.failed')
  if (tone === 'offline') return t('tone.offline')
  return t('tone.standby')
}

/** Pure display-only initials: NFC normalization plus the first grapheme cluster, never persisted. */
export function memberRosterInitial(name: string): string {
  const normalized = name.normalize('NFC')
  const segmenter = typeof Intl.Segmenter === 'undefined' ? undefined : new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return segmenter === undefined ? (Array.from(normalized)[0] ?? '') : (segmenter.segment(normalized)[Symbol.iterator]().next().value?.segment ?? '')
}

function Status({ state, t }: { readonly state: TeamDashboardState; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading') : state.phase === 'reconnecting' ? t('reconnecting') : state.phase === 'stale' ? t('stale') : t('error')
  return <div className="swarm-team-workspace__status" role={failed ? 'alert' : 'status'} aria-live="polite"><StateDot state={failed ? 'warning' : 'ongoing'} /><span>{label}</span>{state.error === undefined ? null : <span className="swarm-team-workspace__error" title={`${state.error.code}: ${state.error.message}`}><code>{state.error.code}</code><small className="swarm-team-workspace__muted">: {state.error.message}</small></span>}</div>
}

function Empty({ state, controller, t }: { readonly state: TeamDashboardState; readonly controller: TeamDashboardController; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const failed = state.phase === 'error' || state.phase === 'stale'
  return <section className="swarm-team-workspace__empty-shell" data-swarm-empty-shell>
    <Status state={state} t={t} />
    {/* Exactly one honest empty/loading/error state: no duplicated placeholder roster or goal cards. */}
    <section className="swarm-team-workspace__detail-section" data-swarm-empty-state>
      <h4>{failed ? t('error') : t('loading')}</h4>
      {state.error === undefined ? null : <p className="swarm-team-workspace__muted" title={`${state.error.code}: ${state.error.message}`}>{state.error.message}</p>}
    </section>
    <details className="swarm-team-workspace__detail-section"><summary>{t('diagnostics')}</summary><Status state={state} t={t} /></details>
    <div className="swarm-team-workspace__empty-actions">{failed ? <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button> : null}<Button variant="ghost" onClick={() => { controller.refresh() }}>{t('refresh')}</Button></div>
  </section>
}

function Workspace({ data, handoffBusy, localeTag, descriptionId, headingId, state, t, teams, announcements, diagnostics, memberAssets, onCaptainSession, onSelectTeam, onClose }: {
  readonly data: SwarmHostReadProjectionV1
  readonly handoffBusy: boolean
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly descriptionId: string
  readonly headingId: string
  readonly state: TeamDashboardState
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly onCaptainSession: () => void
  readonly onSelectTeam: (teamId: string) => void
  readonly onClose: () => void
}) {
  const number = new Intl.NumberFormat(localeTag())
  const boundCaptain = teams?.teams.find(team => team.teamId === data.binding.teamId)
  const goal = boundCaptain?.goal
  const [view, setView] = useState<WorkspaceView>('workspace')
  const [detail, setDetail] = useState<DetailSelection>()
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const detailTriggerRef = useRef<HTMLElement | null>(null)
  const openDetail = (selection: DetailSelection): void => {
    detailTriggerRef.current = document.activeElement as HTMLElement | null
    setDetail(selection)
  }
  const closeDetail = (refocus: boolean): void => {
    setDetail(undefined)
    if (refocus) queueMicrotask(() => {
      const trigger = detailTriggerRef.current
      if (trigger !== null && trigger.isConnected) trigger.focus()
      else document.querySelector<HTMLElement>('[data-swarm-view-tabs] [role="tab"][aria-selected="true"]')?.focus()
    })
  }
  useLayoutEffect(() => { if (detail !== undefined) detailHeadingRef.current?.focus() }, [detail])
  useLayoutEffect(() => {
    if (detail === undefined) return
    const gone = (detail.kind === 'member' && !data.roster.some(member => member.name === detail.name))
      || (detail.kind === 'task' && !data.tasks.some(task => task.id === detail.id))
    // An authority-driven auto-close must still leave usable focus behind.
    if (gone) closeDetail(true)
  }, [data, detail])
  // Work-seat tones and the statistic line derive from the SAME real projection.
  const tones = new Map<string, DeskTone>(data.roster.map(member => [member.name, deriveMemberTone(data, member.name, member.phase)]))
  const stats = { executing: 0, pending: 0, failed: 0, standby: 0, offline: 0 } as Record<DeskTone, number>
  for (const tone of tones.values()) stats[tone] += 1
  const executingCount = stats.executing
  const captainGenerated = boundCaptain?.identityCard.state === 'generated'
  // The Team name is never a Captain name: only a real Captain-declared displayName is shown;
  // an un-generated identity (or a generated card without a displayName) renders the explicit
  // "profile not completed" marker instead of impersonation.
  const captainName = captainGenerated && boundCaptain?.displayName !== undefined ? boundCaptain.displayName : t('profileIncomplete')
  const captainProfession = captainGenerated && boundCaptain?.profession !== undefined ? boundCaptain.profession : undefined
  const subtitleParts = [captainProfession, `${number.format(executingCount)} ${t('subtitle.executing')}`].filter(part => part !== undefined)
  const inFlight = ['in_progress', 'submitted', 'verifying'] as const
  // The binding is the only authority for Captain navigation. It is not a personal activity
  // projection, so describe the actual Session relationship instead of calling the Captain
  // unavailable or inventing a working-state claim.
  const viewingCaptain = state.targetSessionId === data.binding.rootSessionId
  const captainStateText = viewingCaptain ? t('captainCurrentSession') : t('captainOpenSession')
  const captainTone: DeskTone = 'offline'
  const summaries = data.tasks.filter(task => inFlight.includes(task.status as (typeof inFlight)[number])).toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, 2)
  const activities = data.attempts.toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, 3)
  const entries = announcements?.state === 'available' ? announcements.entries : []
  const latest = entries.toSorted((left, right) => right.createdAt - left.createdAt)[0]
  const tabs = [
    { id: 'workspace' as const, label: t('tabs.workspace') },
    { id: 'tasks' as const, label: t('tasks') },
    { id: 'notices' as const, label: t('announcements') },
    { id: 'manage' as const, label: t('manage') },
  ]
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    setView(tabs[next]!.id)
    // Roving tabindex: focus follows the selection after React re-renders the tab strip.
    const nextTab = tabs[next]!.id
    queueMicrotask(() => { document.querySelector<HTMLElement>(`[data-swarm-view-tab="${nextTab}"]`)?.focus() })
  }
  const visibleTeams = dedupeTeams(teams)
  return <>
    <section className="swarm-team-workspace__pane">
      <header className="swarm-team-workspace__pane-head">
        <div className="swarm-team-workspace__truncate">
          <div className="swarm-team-workspace__title-row">
            <h2 className="swarm-team-workspace__title" id={headingId} title={data.team.name}>{data.team.name}</h2>
            {visibleTeams.length > 1
              ? <select className="swarm-team-workspace__team-switcher" aria-label={t('switchTeam')} value={data.binding.teamId}
                  data-swarm-team-switcher onChange={event => { if (event.target.value !== data.binding.teamId) onSelectTeam(event.target.value) }}>
                  {visibleTeams.map(team => <option key={team.teamId} value={team.teamId}>{team.name}</option>)}
                </select>
              : null}
            <span className="swarm-team-workspace__phase-pill" data-swarm-team-phase>{enumLabel(data.team.phase, t)}</span>
          </div>
          <p className="swarm-team-workspace__subtitle" id={descriptionId}>{subtitleParts.join(' · ')}</p>
          <p className="swarm-team-workspace__subtitle">{t('description')}</p>
        </div>
        <Button size="sm" variant="toolbar" aria-label={t('close')} title={t('close')} onClick={onClose}><IconCloseOutline16 /></Button>
      </header>
      <div className="swarm-team-workspace__public-bar" data-swarm-public-bar>
        <section className="swarm-team-workspace__public-card" data-swarm-goal-card data-swarm-goal-state={goal?.state ?? 'loading'}>
          <span className="swarm-team-workspace__public-copy">
            <span className="swarm-team-workspace__public-title">{t('goal')}</span>
            {goal === undefined
              ? <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('loading')}</span>
              : goal.state === 'generated'
                ? <span className="swarm-team-workspace__public-content" data-swarm-goal-text title={goal.text}>{goal.text}</span>
                : <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable" data-swarm-goal-not-set>{t('goalNotSet')}</span>}
          </span>
        </section>
        <section className="swarm-team-workspace__public-card" data-swarm-announcement-preview>
          <span className="swarm-team-workspace__public-copy">
            <span className="swarm-team-workspace__public-title">{t('announcement.latest')}</span>
            {announcements === undefined
              ? <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('loading')}</span>
              : announcements.state === 'available'
                ? latest === undefined
                  ? <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable" data-swarm-announcements-empty>{t('announcementsEmpty')}</span>
                  : <span className="swarm-team-workspace__public-content" title={latest.text}>{latest.text}</span>
                : <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('announcementsUnavailable')}</span>}
          </span>
        </section>
      </div>
      <div className="swarm-team-workspace__view-tabs" role="tablist" aria-label={t('tabs.label')} data-swarm-view-tabs>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`swarm-tab-${tab.id}`}
            aria-selected={view === tab.id}
            aria-controls={`swarm-panel-${tab.id}`}
            tabIndex={view === tab.id ? 0 : -1}
            data-swarm-view-tab={tab.id}
            onKeyDown={event => { onTabKeyDown(event, index) }}
            onClick={() => { setView(tab.id) }}
          >{tab.label}</button>
        ))}
      </div>
      <main className="swarm-team-workspace__pane-body">
        <Status state={state} t={t} />
        {view === 'workspace' && <div role="tabpanel" id="swarm-panel-workspace" aria-labelledby="swarm-tab-workspace" data-swarm-panel="workspace">
          <div className="swarm-team-workspace__block-head"><span>{t('workspace.desks')}</span><small data-swarm-desk-stats>{number.format(stats.executing)} {t('tone.executing')} · {number.format(stats.pending)} {t('tone.pending')} · {number.format(stats.failed)} {t('tone.failed')} · {number.format(stats.standby)} {t('tone.standby')} · {number.format(stats.offline)} {t('tone.offline')}</small></div>
          <section className="swarm-team-workspace__workroom" aria-label={t('workspace.desks')} data-swarm-workroom>
            <button
              className="swarm-team-workspace__desk"
              type="button"
              disabled={handoffBusy || viewingCaptain}
              data-swarm-captain-desk
              data-swarm-captain-current={viewingCaptain ? 'true' : 'false'}
              data-swarm-tone={captainTone}
              title={viewingCaptain ? t('captainCurrentSessionTitle') : t('captainMainChatTitle')}
              onClick={onCaptainSession}
            >
              <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={boundCaptain?.name ?? ''} asset={boundCaptain?.avatar ?? NOT_GENERATED_AVATAR} name={captainName} t={t} /></span>
              <span className="swarm-team-workspace__desk-copy">
                <strong className="swarm-team-workspace__desk-name" data-swarm-captain-visible-name={captainName} title={captainName}>{captainName}<b className="swarm-team-workspace__captain-badge">{t('captainRole')}</b></strong>
                <small className="swarm-team-workspace__desk-role" data-swarm-captain-profession={captainProfession ?? ''}>{captainProfession ?? t('profileNotGenerated')}</small>
              </span>
              <span className="swarm-team-workspace__desk-state" data-swarm-captain-state={captainStateText}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" />{captainStateText}</span>
            </button>
            {data.roster.map(member => {
              const tone = tones.get(member.name) ?? 'standby'
              const asset = memberAssetOf(memberAssets, member.name)
              const generated = asset.identityCard.state === 'generated'
              const displayName = generated && asset.displayName !== undefined ? asset.displayName : member.name
              const profession = generated && asset.profession !== undefined ? asset.profession : member.role
              const label = toneLabel(tone, t)
              return (
                <button
                  key={member.name}
                  className="swarm-team-workspace__desk"
                  type="button"
                  aria-haspopup="dialog"
                  data-swarm-member-name={member.name}
                  data-swarm-member-role={member.role}
                  data-swarm-identity-state={asset.identityCard.state}
                  data-swarm-tone={tone}
                  onClick={() => { openDetail({ kind: 'member', name: member.name }) }}
                >
                  <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={displayName} t={t} /></span>
                  <span className="swarm-team-workspace__desk-copy">
                    <strong className="swarm-team-workspace__desk-name" data-swarm-member-visible-name={displayName} title={displayName}>{displayName}</strong>
                    <small className="swarm-team-workspace__desk-role swarm-team-workspace__truncate" data-swarm-member-visible-profession={profession} title={profession}>{profession}</small>
                  </span>
                  <span className="swarm-team-workspace__desk-state" data-swarm-member-tone={tone} data-swarm-member-visible-activity={label} title={label}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" />{label}</span>
                </button>
              )
            })}
          </section>
          {data.truncated.roster ? <p className="swarm-team-workspace__muted">{t('rosterTruncated', { shown: number.format(data.roster.length), total: number.format(data.totals.roster) })}</p> : null}
          <div className="swarm-team-workspace__block-head"><span>{t('workspace.execSummary')}</span><small data-swarm-summary-count>{number.format(summaries.length)}</small></div>
          {summaries.length === 0
            ? <p className="swarm-team-workspace__muted" data-swarm-summary-empty>{t('empty')}</p>
            : <section className="swarm-team-workspace__activity" data-swarm-exec-summaries aria-label={t('workspace.execSummary')}>
              {summaries.map(task => {
                const pending = task.status !== 'in_progress'
                return <div key={task.id} className="swarm-team-workspace__activity-row" data-swarm-summary-task={task.id}>
                  <i className="swarm-team-workspace__activity-signal" data-swarm-signal={pending ? 'pending' : 'executing'} aria-hidden="true" />
                  <span className="swarm-team-workspace__activity-copy">
                    <span className="swarm-team-workspace__activity-title" title={task.subject}>{task.subject}</span>
                    <span className="swarm-team-workspace__activity-meta">{task.ownerName ?? t('hostUnavailable')}</span>
                  </span>
                  <span className="swarm-team-workspace__activity-state">{enumLabel(task.status, t)}</span>
                </div>
              })}
            </section>}
          <div className="swarm-team-workspace__block-head"><span>{t('workspace.teamActivity')}</span><small data-swarm-activity-count>{number.format(activities.length)}</small></div>
          {activities.length === 0
            ? <p className="swarm-team-workspace__muted" data-swarm-activity-empty>{t('empty')}</p>
            : <section className="swarm-team-workspace__activity" data-swarm-team-activity aria-label={t('workspace.teamActivity')}>
              {activities.map(attempt => {
                const task = data.tasks.find(candidate => candidate.id === attempt.taskId)
                // Honest signal: submitted/verifying are the only pending phases; accepted/
                // rejected/cancelled/stale attempts are ended and stay visually neutral.
                const signal = attempt.phase === 'running' ? 'executing' : attempt.phase === 'submitted' || attempt.phase === 'verifying' ? 'pending' : 'settled'
                return <div key={attempt.id} className="swarm-team-workspace__activity-row" data-swarm-activity-attempt={attempt.id}>
                  <i className="swarm-team-workspace__activity-signal" data-swarm-signal={signal} aria-hidden="true" />
                  <span className="swarm-team-workspace__activity-copy">
                    <span className="swarm-team-workspace__activity-title">{attempt.memberName ?? t('hostUnavailable')}</span>
                    <span className="swarm-team-workspace__activity-meta">{task?.subject ?? t('hostUnavailable')}</span>
                  </span>
                  <span className="swarm-team-workspace__activity-state">{enumLabel(attempt.phase, t)}</span>
                </div>
              })}
            </section>}
        </div>}
        {view === 'tasks' && <div role="tabpanel" id="swarm-panel-tasks" aria-labelledby="swarm-tab-tasks" data-swarm-panel="tasks">
          <div className="swarm-team-workspace__block-head"><span>{t('tasks')}</span><small data-swarm-task-count>{number.format(data.tasks.length)} {t('taskCount')}</small></div>
          {data.tasks.length === 0
            ? <p className="swarm-team-workspace__muted" data-swarm-task-empty>{t('empty')}</p>
            : <section className="swarm-team-workspace__table" data-swarm-task-rows>
              {data.tasks.map(task => (
                <button key={task.id} className="swarm-team-workspace__table-row" type="button" aria-haspopup="dialog" data-swarm-task-id={task.id} data-swarm-task-status={task.status} onClick={() => { openDetail({ kind: 'task', id: task.id }) }}>
                  <span className="swarm-team-workspace__table-copy"><strong title={task.subject}>{task.subject}</strong><small>{task.id}</small></span>
                  <span className="swarm-team-workspace__table-side" data-swarm-task-owner={`${t('taskOwner')}: ${task.ownerName ?? t('hostUnavailable')}`} title={`${t('taskOwner')}: ${task.ownerName ?? t('hostUnavailable')}`}>{task.ownerName ?? t('hostUnavailable')}</span>
                  <span className="swarm-team-workspace__table-side" data-swarm-task-state>{enumLabel(task.status, t)}</span>
                </button>
              ))}
            </section>}
        </div>}
        {view === 'notices' && <div role="tabpanel" id="swarm-panel-notices" aria-labelledby="swarm-tab-notices" data-swarm-panel="notices">
          <div className="swarm-team-workspace__block-head"><span>{t('announcements')}</span><small data-swarm-notice-count>{number.format(entries.length)} {t('announcementCount')}</small></div>
          {announcements === undefined
            ? <p className="swarm-team-workspace__muted">{t('loading')}</p>
            : announcements.state !== 'available'
              ? <p className="swarm-team-workspace__muted" data-swarm-announcement-reason={announcements.reason}>{t('announcementsUnavailable')}</p>
              : entries.length === 0
                ? <p className="swarm-team-workspace__muted" data-swarm-announcements-empty>{t('announcementsEmpty')}</p>
                : <section className="swarm-team-workspace__table" data-swarm-announcements-state="available" data-swarm-announcements-list>
                  {entries.map(entry => {
                    const formatted = formatTime(entry.createdAt, localeTag)
                    return <div key={entry.id} className="swarm-team-workspace__table-row" data-swarm-announcement-entry={entry.id}>
                      <span className="swarm-team-workspace__table-copy"><strong title={entry.text}>{entry.text}</strong>{formatted === undefined ? null : <time dateTime={new Date(entry.createdAt).toISOString()}>{formatted}</time>}</span>
                    </div>
                  })}
                </section>}
        </div>}
        {view === 'manage' && <div role="tabpanel" id="swarm-panel-manage" aria-labelledby="swarm-tab-manage" data-swarm-panel="manage">
          <ManageView data={data} memberAssets={memberAssets} number={number} onManageViaCaptain={onCaptainSession} onOpenDetail={openDetail} t={t} />
        </div>}
      </main>
    </section>
    {detail === undefined ? null : <DetailOverlay
      detail={detail}
      data={data}
      localeTag={localeTag}
      number={number}
      headingRef={detailHeadingRef}
      memberAssets={memberAssets}
      diagnostics={diagnostics}
      onClose={() => { closeDetail(true) }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(true) } }}
      t={t}
    />}
  </>
}

function dedupeTeams(teams: SwarmReadTeamsV1 | undefined): SwarmReadTeamsV1['teams'] {
  const unique = new Map<string, SwarmReadTeamsV1['teams'][number]>()
  for (const team of teams?.teams ?? []) {
    if (!unique.has(team.teamId)) unique.set(team.teamId, team)
  }
  return [...unique.values()]
}

/** Fail-safe timestamp: a malformed/non-finite createdAt must never throw during render. */
function formatTime(createdAt: number, localeTag: () => 'zh-CN' | 'en-US'): string | undefined {
  if (!Number.isFinite(createdAt)) return undefined
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return undefined
  try { return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(date) } catch { return undefined }
}

/** Real member identity card data comes from the captainMembers read keyed by the authoritative
 *  roster name; a missing row keeps the honest not-generated placeholder, never a fabricated asset. */
function memberAssetOf(memberAssets: SwarmReadCaptainMembersV1 | undefined, name: string): {
  readonly avatar: SwarmReadAssetStatusV1
  readonly identityCard: SwarmReadAssetStatusV1
  readonly displayName?: string
  readonly profession?: string
  readonly personality?: string
  readonly growth: { readonly privateMemory: 'private_to_member'; readonly skills: 'not_implemented'; readonly capability: 'not_implemented' }
  readonly composition?: SwarmReadMemberCompositionV1
  readonly skills?: readonly string[]
  readonly callableTools?: readonly string[]
  readonly growthSummary?: string
  readonly currentActivity?: SwarmReadCaptainMembersV1['members'][number]['currentActivity']
  readonly recentOutcome?: SwarmReadCaptainMembersV1['members'][number]['recentOutcome']
} {
  const row = memberAssets?.members.find(candidate => candidate.name === name)
  return {
    avatar: row?.avatar ?? NOT_GENERATED_AVATAR,
    identityCard: row?.identityCard ?? NOT_GENERATED_IDENTITY,
    ...(row?.displayName === undefined ? {} : { displayName: row.displayName }),
    ...(row?.profession === undefined ? {} : { profession: row.profession }),
    ...(row?.personality === undefined ? {} : { personality: row.personality }),
    growth: row?.growth ?? { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
    ...(row?.composition === undefined ? {} : { composition: row.composition }),
    ...(row?.skills === undefined ? {} : { skills: row.skills }),
    ...(row?.callableTools === undefined ? {} : { callableTools: row.callableTools }),
    ...(row?.growthSummary === undefined ? {} : { growthSummary: row.growthSummary }),
    ...(row?.currentActivity === undefined ? {} : { currentActivity: row.currentActivity }),
    ...(row?.recentOutcome === undefined ? {} : { recentOutcome: row.recentOutcome }),
  }
}

function ManageView({ data, memberAssets, number, onManageViaCaptain, onOpenDetail, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly number: Intl.NumberFormat
  readonly onManageViaCaptain: () => void
  readonly onOpenDetail: (selection: DetailSelection) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  return <div className="swarm-team-workspace__manage" data-swarm-manage-view>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-members>
      <span className="swarm-team-workspace__table-copy"><strong>{t('manage.membersTitle')}</strong><small>{t('manage.membersDesc', { count: number.format(data.totals.roster) })}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" onClick={onManageViaCaptain} title={t('manageViaCaptain')}>{t('manage.open')}</button>
    </div>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-growth>
      <span className="swarm-team-workspace__table-copy"><strong>{t('manage.growthTitle')}</strong><small>{t('manage.growthDesc')}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" aria-haspopup="dialog" onClick={() => { onOpenDetail({ kind: 'growth' }) }}>{t('manage.open')}</button>
    </div>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-overview>
      <span className="swarm-team-workspace__table-copy"><strong>{t('manage.overviewTitle')}</strong><small>{t('manage.overviewDesc')}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" aria-haspopup="dialog" onClick={() => { onOpenDetail({ kind: 'overview' }) }}>{t('manage.open')}</button>
    </div>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-diagnostics>
      <span className="swarm-team-workspace__table-copy"><strong>{t('diagnostics')}</strong><small>{t('manage.diagnosticsDesc')}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" aria-haspopup="dialog" onClick={() => { onOpenDetail({ kind: 'diagnostics' }) }}>{t('manage.open')}</button>
    </div>
    {/* Member growth is the only real growth projection available; it also backs the growth overlay. */}
    <p className="swarm-team-workspace__contact-note">{memberAssets === undefined ? t('loading') : t('manageViaCaptainHint')}</p>
  </div>
}

function DetailOverlay({ detail, data, localeTag, number, headingRef, memberAssets, diagnostics, onClose, onKeyDown, t }: {
  readonly detail: DetailSelection
  readonly data: SwarmHostReadProjectionV1
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly number: Intl.NumberFormat
  readonly headingRef: RefObject<HTMLHeadingElement>
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly onClose: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const heading = detailHeading(detail, data, t)
  const headingId = useId()
  // Basic focus trap: Tab/Shift+Tab cycles inside the dialog so keyboard focus never escapes
  // the overlay while it is open; Escape/close restore focus to the trigger (or the active tab).
  const onTabCycle = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const focusables = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(element => element.offsetParent !== null || element === document.activeElement)
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const activeIndex = focusables.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    if (event.shiftKey) (activeIndex <= 0 ? last : focusables[activeIndex - 1]!).focus()
    else (activeIndex === -1 || activeIndex === focusables.length - 1 ? first : focusables[activeIndex + 1]!).focus()
  }
  return <div className="swarm-team-workspace__detail-overlay" role="dialog" aria-modal="true" aria-labelledby={headingId} data-swarm-detail-overlay data-swarm-detail-kind={detail.kind} onKeyDown={event => { onTabCycle(event); onKeyDown(event) }}>
    <header className="swarm-team-workspace__detail-head">
      <div className="swarm-team-workspace__truncate">
        <h3 className="swarm-team-workspace__detail-title" id={headingId} ref={headingRef} tabIndex={-1}>{heading.title}</h3>
        <small className="swarm-team-workspace__detail-sub">{heading.sub}</small>
      </div>
      <Button size="sm" variant="toolbar" aria-label={t('backToMembers')} title={t('backToMembers')} data-swarm-detail-back onClick={onClose}><IconCloseOutline16 /></Button>
    </header>
    <div className="swarm-team-workspace__detail-body">
      {detail.kind === 'member' ? <MemberDetail detail={detail} data={data} localeTag={localeTag} memberAssets={memberAssets} t={t} />
        : detail.kind === 'task' ? <TaskDetail detail={detail} data={data} number={number} localeTag={localeTag} t={t} />
          : detail.kind === 'growth' ? <GrowthDetail data={data} t={t} />
            : detail.kind === 'overview' ? <OverviewDetail data={data} number={number} t={t} />
              : <DiagnosticsDetail data={data} diagnostics={diagnostics} number={number} t={t} />}
    </div>
  </div>
}

function detailHeading(detail: DetailSelection, data: SwarmHostReadProjectionV1, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): { readonly title: string; readonly sub: string } {
  if (detail.kind === 'member') {
    const member = data.roster.find(candidate => candidate.name === detail.name)
    return { title: t('memberDetailHeading', { name: detail.name }), sub: member?.role ?? '' }
  }
  if (detail.kind === 'task') {
    const task = data.tasks.find(candidate => candidate.id === detail.id)
    return { title: t('taskDetailHeading', { subject: task?.subject ?? detail.id }), sub: detail.id }
  }
  if (detail.kind === 'growth') return { title: t('manage.growthTitle'), sub: '' }
  if (detail.kind === 'overview') return { title: t('manage.overviewTitle'), sub: data.team.name }
  return { title: t('diagnostics'), sub: data.team.name }
}

/** Overlay member detail. Every field renders its real read value or the explicit
 *  "not available yet" marker — never a fabricated profile, skill, tool or model claim. */
function MemberDetail({ detail, data, localeTag, memberAssets, t }: {
  readonly detail: { readonly kind: 'member'; readonly name: string }
  readonly data: SwarmHostReadProjectionV1
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const member = data.roster.find(candidate => candidate.name === detail.name)
  if (member === undefined) return null
  const asset = memberAssetOf(memberAssets, member.name)
  const generated = asset.identityCard.state === 'generated'
  const displayName = generated && asset.displayName !== undefined ? asset.displayName : member.name
  const activity = deriveMemberActivity(data, member.name, member.phase)
  const tone = deriveMemberTone(data, member.name, member.phase)
  // "Current task" accepts ONLY genuinely in-flight work: a task in an in-flight status whose
  // current attempt is running/submitted/verifying. Any terminal status or attempt phase is
  // recent history, never current work.
  const hasCurrentWork = activity.task !== undefined && activity.attempt !== undefined
    && ['in_progress', 'submitted', 'verifying'].includes(activity.task.status)
    && ['running', 'submitted', 'verifying'].includes(activity.attempt.phase)
  const currentTask = hasCurrentWork ? activity.task : undefined
  const unavailable = <span className="swarm-team-workspace__unavailable">{t('detail.unavailable')}</span>
  const value = (real: string | undefined): string | typeof unavailable => real === undefined ? unavailable : real
  // captainMembers.composition.v1: real derived composition only. A non-`available` row
  // discloses state/reason plus runtimeProvider and nothing else (contract fail-closed);
  // a missing composition renders honest unavailable markers, never a fabricated claim.
  const composition = asset.composition
  const compositionReady = composition?.state === 'available'
  const compositionValue = (real: string | undefined): string | typeof unavailable =>
    composition === undefined || !compositionReady || real === undefined ? unavailable : real
  const personaValue = composition !== undefined && compositionReady && typeof composition.personaConfigured === 'boolean'
    ? t(composition.personaConfigured ? 'detail.yes' : 'detail.no')
    : unavailable
  return <>
    <div className="swarm-team-workspace__detail-section" data-swarm-detail-profile>
      <h4>{t('detail.section.profile')}</h4>
      <div className="swarm-team-workspace__identity-head">
        <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={displayName} t={t} /></span>
        <span className="swarm-team-workspace__desk-copy">
          <strong className="swarm-team-workspace__truncate" title={displayName}>{displayName}</strong>
          <small className="swarm-team-workspace__desk-role" data-swarm-member-visible-activity={toneLabel(tone, t)}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" /> {toneLabel(tone, t)}</small>
        </span>
      </div>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.name')}</dt><dd>{displayName}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.isCaptain')}</dt><dd>{t('detail.no')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('memberRole')}</dt><dd data-swarm-detail-role>{member.role}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('profileProfession')}</dt><dd data-swarm-detail-profession>{generated && asset.profession !== undefined ? asset.profession : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('profilePersonality')}</dt><dd data-swarm-detail-personality>{value(generated && asset.personality !== undefined ? asset.personality : undefined)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.intro')}</dt><dd>{unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.model')}</dt><dd data-swarm-detail-model>{compositionValue(composition?.model)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.provider')}</dt><dd data-swarm-detail-provider>{value(composition?.runtimeProvider)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.llmProvider')}</dt><dd data-swarm-detail-llm-provider>{compositionValue(composition?.llmProvider)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.preset')}</dt><dd data-swarm-detail-preset>{compositionValue(composition?.presetId)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.persona')}</dt><dd data-swarm-detail-persona>{personaValue}</dd></div>
        {composition !== undefined && !compositionReady ? <>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.compositionState')}</dt><dd data-swarm-detail-composition-state>{composition.state}</dd></div>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.compositionReason')}</dt><dd data-swarm-detail-composition-reason>{composition.reason}</dd></div>
        </> : null}
      </dl>
    </div>
    <div className="swarm-team-workspace__detail-section" data-swarm-detail-skills>
      <h4>{t('detail.section.skills')}</h4>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.skills')}</dt><dd data-swarm-detail-skills-value>{asset.skills === undefined ? unavailable : asset.skills.length === 0 ? t('detail.field.none') : asset.skills.join(', ')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.tools')}</dt><dd data-swarm-detail-callable-tools>{asset.callableTools === undefined ? unavailable : asset.callableTools.length === 0 ? t('detail.field.none') : asset.callableTools.join(', ')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.deniedTools')}</dt><dd data-swarm-detail-denied-tools>{composition !== undefined && compositionReady ? (composition.deniedTools === undefined ? unavailable : composition.deniedTools.length === 0 ? t('detail.field.none') : composition.deniedTools.join(', ')) : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.permissions')}</dt><dd>{unavailable}</dd></div>
      </dl>
    </div>
    <div className="swarm-team-workspace__detail-section" data-swarm-detail-task>
      <h4>{t('detail.section.currentTask')}</h4>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('tasks')}</dt><dd data-swarm-detail-task-subject>{currentTask?.subject ?? asset.currentActivity?.subject ?? t('memberNone')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('status')}</dt><dd data-swarm-detail-task-status>{currentTask !== undefined ? enumLabel(currentTask.status, t) : asset.currentActivity !== undefined ? enumLabel(asset.currentActivity.status, t) : t('memberNone')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.progress')}</dt><dd>{unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.started')}</dt><dd data-swarm-detail-task-started>{value(currentTask !== undefined && activity.attempt !== undefined ? formatTime(activity.attempt.createdAt, localeTag) : undefined)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.due')}</dt><dd>{unavailable}</dd></div>
      </dl>
    </div>
    <div className="swarm-team-workspace__detail-section" data-swarm-detail-growth>
      <h4>{t('detail.section.growth')}</h4>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.recentTask')}</dt><dd data-swarm-detail-recent-attempt>{activity.attempt !== undefined ? `${activity.attempt.phase} · ${formatTime(activity.attempt.updatedAt, localeTag) ?? ''}` : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.recentOutput')}</dt><dd data-swarm-detail-recent-outcome>{asset.recentOutcome !== undefined ? `${asset.recentOutcome.phase} · ${formatTime(asset.recentOutcome.at, localeTag) ?? ''}` : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthTitle')}</dt><dd data-swarm-detail-growth-summary>{asset.growthSummary === undefined ? unavailable : asset.growthSummary === '' ? t('detail.field.none') : asset.growthSummary}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.memory')}</dt><dd data-swarm-detail-memory>{t('growthMemoryPrivate')}</dd></div>
      </dl>
    </div>
    {/* Ordinary members have no direct chat capability in the current base; the honest disabled
        note explains the Captain coordination path instead of a fabricated contact action. */}
    <p className="swarm-team-workspace__contact-note" data-swarm-contact-disabled>{t('detail.contactDisabled')}</p>
  </>
}

function TaskDetail({ detail, data, number, localeTag, t }: {
  readonly detail: { readonly kind: 'task'; readonly id: string }
  readonly data: SwarmHostReadProjectionV1
  readonly number: Intl.NumberFormat
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const task = data.tasks.find(candidate => candidate.id === detail.id)
  if (task === undefined) return null
  const attempt = task.currentAttemptId === undefined ? undefined : data.attempts.find(candidate => candidate.id === task.currentAttemptId)
  return <div className="swarm-team-workspace__detail-section" data-swarm-task-detail>
    <dl className="swarm-team-workspace__field-list">
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('status')}</dt><dd>{enumLabel(task.status, t)}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskOwner')}</dt><dd>{task.ownerName ?? t('hostUnavailable')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskTarget')}</dt><dd>{task.targetMemberName ?? t('hostUnavailable')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskBlocked', { count: number.format(task.blockedBy.length) })}</dt><dd>{task.blockedBy.length === 0 ? t('empty') : task.blockedBy.join(', ')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.created')}</dt><dd>{formatTime(task.createdAt, localeTag) ?? t('detail.unavailable')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskCurrentAttempt')}</dt><dd>{task.currentAttemptId ?? t('memberNone')}{attempt === undefined ? '' : ` · ${enumLabel(attempt.phase, t)}`}</dd></div>
    </dl>
  </div>
}

function GrowthDetail({ data, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const unavailable = <span className="swarm-team-workspace__unavailable">{t('detail.unavailable')}</span>
  return <div data-swarm-growth-detail>
    {data.roster.length === 0 ? <p className="swarm-team-workspace__muted">{t('empty')}</p> : data.roster.map(member => {
  return <div key={member.name} className="swarm-team-workspace__detail-section" data-swarm-growth-member={member.name}>
        <h4>{member.name}</h4>
        <dl className="swarm-team-workspace__field-list">
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthMemory')}</dt><dd>{t('growthMemoryPrivate')}</dd></div>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthSkills')}</dt><dd>{unavailable}</dd></div>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthCapability')}</dt><dd>{unavailable}</dd></div>
        </dl>
      </div>
    })}
  </div>
}

function OverviewDetail({ data, number, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly number: Intl.NumberFormat
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const metric = (used: number, limit?: number): string => limit === undefined ? number.format(used) : `${number.format(used)} / ${number.format(limit)}`
  return <div data-swarm-overview-detail>
    <div className="swarm-team-workspace__summary" data-swarm-overview-metrics>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.roster)}</strong><span className="swarm-team-workspace__muted">{t('members')}</span></div>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.tasks)}</strong><span className="swarm-team-workspace__muted">{t('tasks')}</span></div>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.attempts)}</strong><span className="swarm-team-workspace__muted">{t('attempts')}</span></div>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.pendingInteractions)}</strong><span className="swarm-team-workspace__muted">{t('interactions')}</span></div>
    </div>
    <div className="swarm-team-workspace__detail-section" data-swarm-overview-budget>
      <h4>{t('budget')}</h4>
      <Facts rows={[
        [t('usedTokens'), metric(data.budget.usedTokens, data.budget.tokenLimit)],
        [t('usedRequests'), metric(data.budget.usedRequests, data.budget.requestLimit)],
        [t('usedRetries'), metric(data.budget.usedRetries, data.budget.retryLimit)],
      ]} />
    </div>
  </div>
}

function DiagnosticsDetail({ data, diagnostics, number, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly number: Intl.NumberFormat
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  return <div className="swarm-team-workspace__detail-section" data-swarm-diagnostics-detail>
    <Facts rows={[
      [t('diagnosticsSession'), data.binding.rootSessionId],
      [t('diagnosticsRevision'), number.format(diagnostics?.diagnostics.revision ?? data.team.revision)],
      ...(diagnostics === undefined ? [] : [[t('diagnosticsBackend'), diagnostics.diagnostics.backend] as const]),
      [t('diagnosticsAttempts'), number.format(data.totals.attempts)],
      [t('diagnosticsTrace'), t('diagnosticsTraceUnavailable')],
    ]} />
  </div>
}

function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) { return <dl className="swarm-team-workspace__facts">{rows.map(([label, value]) => <div className="swarm-team-workspace__fact" key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl> }

type WireEnum = SwarmHostReadProjectionV1['team']['phase'] | SwarmHostReadProjectionV1['roster'][number]['phase'] | SwarmHostReadProjectionV1['tasks'][number]['status'] | SwarmHostReadProjectionV1['attempts'][number]['phase']
const enumKey = Object.freeze({ active: 'enum.active', archived: 'enum.archived', provisioning: 'enum.provisioning', failed: 'enum.failed', removed: 'enum.removed', pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying', completed: 'enum.completed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted', rejected: 'enum.rejected', stale: 'enum.stale' } as const satisfies Record<WireEnum, TeamDashboardKey>)
function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string { return t(enumKey[value]) }
