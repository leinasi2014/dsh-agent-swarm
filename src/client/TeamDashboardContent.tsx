import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadCaptainAnnouncementsV1, SwarmReadCaptainDiagnosticsV1, SwarmReadCaptainMembersV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { TaskDag } from './team-task-dag.js'
import { TeamDashboardCards, teamCardsCss } from './team-dashboard-cards.js'

import { ManageView, DetailView } from './team-dashboard-detail-content.js'
import { NOT_GENERATED_AVATAR, deriveMemberActivity, deriveMemberTone, memberAssetOf, formatTime, toneLabel, enumLabel, taskProgressState, type TaskProgressState, type DetailSelection, type DeskTone } from './team-dashboard-view-helpers.js'
export { MemberDetail } from './team-dashboard-detail-content.js'
export { deriveMemberActivity, deriveMemberTone, memberRosterInitial, TEAM_WORKSPACE_WIDE_MIN_WIDTH, teamWorkspaceLayoutForWidth } from './team-dashboard-view-helpers.js'

type WorkspaceView = 'workspace' | 'tasks' | 'notices' | 'manage'

export const shellCss = `
[data-swarm-team-dashboard], [data-swarm-team-dashboard] * { box-sizing:border-box; }
[data-swarm-team-dashboard] .swarm-team-workspace { position:relative; container-type:inline-size; height:100%; min-width:0; overflow:auto; scrollbar-width:thin; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__pane { display:flex; flex-direction:column; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-head { display:flex; flex:0 0 auto; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__title-row { display:flex; align-items:center; gap:8px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__title { margin:0; overflow:hidden; font-size:16px; line-height:23px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__phase-pill { flex:0 0 auto; padding:1px 7px; border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, var(--dsw-alias-border-l2)); border-radius:999px; background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-state-business-primary); font-size:12px; font-weight:600; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__subtitle { margin:4px 0 0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-bar { display:grid; gap:10px; padding:10px 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; border:0; padding:0; color:inherit; background:transparent; text-align:left; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card[data-swarm-goal-state="generated"] { background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__public-copy { display:grid; gap:4px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-title { color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-content { overflow:hidden; overflow-wrap:anywhere; font-size:12px; line-height:1.6; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card time { color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:0 16px; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"] { min-width:0; overflow:hidden; padding:10px 2px; border:0; border-radius:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:20px; font-weight:500; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"]:hover { color:var(--dsw-alias-label-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"][aria-selected="true"] { color:var(--dsw-alias-state-business-primary); box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-body { min-height:0; padding:12px; font-size:13px; line-height:1.6; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0; margin:16px 0 10px; font-size:13px; font-weight:650; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head:first-child { margin-top:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head small { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__workroom { display:flex; flex-direction:column; gap:6px; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk { position:relative; display:grid; grid-template-columns:28px minmax(0,1fr) auto; grid-template-rows:auto auto; align-items:center; column-gap:8px; width:100%; min-width:0; min-block-size:48px; padding:6px; border:0; border-radius:6px; background:transparent; color:inherit; text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk:hover { border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-border-l2)); background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk .swarm-team-workspace__avatar { grid-row:1 / 3; inline-size:28px; block-size:28px; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[aria-current="page"] { background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-copy { display:flex; flex-direction:column; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-name { min-width:0; overflow:hidden; font-size:14px; font-weight:650; line-height:21px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-role { min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:17px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-state { display:flex; align-items:center; gap:5px; grid-column:3; grid-row:1 / 3; min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-dot { flex:0 0 auto; inline-size:8px; block-size:8px; border-radius:50%; background:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="standby"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="executing"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-state-business-primary); animation:swarm-desk-pulse 1.4s ease-in-out infinite; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="pending"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-business-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="failed"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="offline"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-secondary); }
@keyframes swarm-desk-pulse { 0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent); } 50% { box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 0%, transparent); } }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-badge { flex:0 0 auto; margin-left:4px; padding:1px 4px; border-radius:4px; background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 13%, transparent); color:var(--dsw-alias-state-business-primary); font-size:12px; font-weight:700; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity { border:0 solid var(--dsw-alias-border-l2); border-block-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; padding:8px 2px; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-row + .swarm-team-workspace__activity-row { border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-signal { flex:0 0 auto; inline-size:7px; block-size:7px; border-radius:50%; background:var(--dsw-alias-state-business-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-signal[data-swarm-signal="pending"] { background:var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-business-primary)); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-business-primary)) 12%, transparent); }
[data-swarm-signal="settled"] { opacity:.35; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-copy { display:grid; gap:2px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-title { overflow:hidden; font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-meta { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-state { color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__table { overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,76px) auto; align-items:center; gap:10px; width:100%; min-width:0; padding:12px 10px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2); background:transparent; color:inherit; font-size:12px; text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row:last-child { border-bottom-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row:hover { background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy { display:grid; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy strong { overflow:hidden; font-size:13px; line-height:1.5; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy small { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-side { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__manage { display:grid; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__manage-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; padding:9px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__manage-action { flex:0 0 auto; padding:4px 10px; border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, var(--dsw-alias-border-l2)); border-radius:8px; background:transparent; color:var(--dsw-alias-state-business-primary); font-size:12px; cursor:pointer; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-view { display:block; min-width:0; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-head { display:flex; flex:0 0 auto; align-items:center; justify-content:flex-start; gap:10px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] [data-swarm-detail-back] { flex:none; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-title { margin:0; overflow:hidden; font-size:14px; line-height:22px; font-weight:650; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-sub { display:block; overflow:hidden; margin-top:1px; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-body { min-height:0; padding:12px 6px; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section { margin:0 0 16px; padding:0 0 16px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2); background:transparent; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section h4 { margin:0 0 12px; font-size:13px; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-tabs { display:flex; flex-wrap:wrap; gap:4px 12px; margin:0 0 16px; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__member-tabs [role="tab"] { flex:1 1 auto; min-width:0; padding:9px 0; border:0; border-radius:0; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-weight:550; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-tabs [role="tab"][aria-selected="true"] { color:var(--dsw-alias-state-business-primary); box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list { display:grid; grid-template-columns:84px minmax(0,1fr); gap:10px 12px; margin:0; font-size:12px; line-height:1.65; }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list dt { min-width:0; color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list dd { margin:0; min-width:0; overflow-wrap:anywhere; }
[data-swarm-team-dashboard] .swarm-team-workspace__unavailable { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__contact-note { margin:0; padding:8px; border:1px dashed var(--dsw-alias-border-l2); border-radius:9px; color:var(--dsw-alias-label-secondary); font-size:12px; }
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
[data-swarm-team-dashboard] .swarm-team-workspace__muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell { display:flex; flex-direction:column; gap:8px; grid-column:1 / -1; min-width:0; min-height:100%; padding:10px 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-actions { display:flex; gap:8px; flex-wrap:wrap; }
[data-swarm-team-dashboard] [hidden] { display:none !important; }
[data-swarm-team-dashboard] .swarm-team-workspace__browse { display:flex; flex-direction:column; min-width:0; }
[data-swarm-team-dashboard] [data-swarm-captain-desk] { background:transparent; border:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__members { display:grid; gap:4px; margin-left:19px; padding-left:12px; border-left:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__member-branch { position:relative; min-width:0; padding:2px 0 8px; border:0; background:transparent; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-branch::before { content:''; position:absolute; left:-12px; top:26px; width:12px; border-top:1px solid var(--dsw-alias-border-l2); }

[data-swarm-team-dashboard] .swarm-team-workspace__member-task { display:flex; align-items:center; gap:8px; margin:0 0 0 42px; padding:6px 10px; max-width:calc(100% - 42px); border:0; border-radius:6px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-task > span:first-child { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-task small { flex:none; color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress { min-width:0; padding:0; border:0; background:transparent; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-heading { display:flex; justify-content:space-between; gap:8px; margin:0 0 8px; font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-heading > span { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track { display:flex; gap:3px; height:5px; border-radius:4px; overflow:hidden; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span { min-width:3px; flex-basis:0; background:var(--progress-color); }
[data-swarm-team-dashboard] [data-tone] { --progress-color:var(--dsw-alias-label-tertiary); }
[data-swarm-team-dashboard] [data-tone="completed"] { --progress-color:var(--dsw-alias-state-success-primary); }
[data-swarm-team-dashboard] [data-tone="running"] { --progress-color:var(--dsw-alias-state-business-primary); }
[data-swarm-team-dashboard] [data-tone="blocked"], [data-swarm-team-dashboard] [data-tone="review"] { --progress-color:var(--dsw-alias-state-warn-primary); }
[data-swarm-team-dashboard] [data-tone="failed"] { --progress-color:var(--dsw-alias-state-error-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-legend { display:flex; flex-wrap:wrap; gap:6px 12px; margin-top:8px; color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-legend > span { display:flex; align-items:center; gap:4px; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-legend i { width:6px; height:6px; border-radius:2px; background:var(--progress-color); }
[data-swarm-team-dashboard] .swarm-team-workspace__attention { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 10px; border:0; border-radius:7px; background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,var(--dsw-alias-bg-base)); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; text-align:left; }
[data-swarm-team-dashboard] button.swarm-team-workspace__attention, [data-swarm-team-dashboard] .swarm-team-workspace__notice-preview { cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__notice-preview { padding-left:9px; border-left:2px solid var(--dsw-alias-border-l3); }
[data-swarm-team-dashboard] .swarm-team-workspace__text-action { padding:4px 0; border:0; background:none; color:var(--dsw-alias-state-business-primary); font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__fold { margin-top:16px; border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] summary { padding:12px 0; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:550; cursor:pointer; }
[data-swarm-team-dashboard] summary small { float:right; font-size:12px; font-weight:400; }
[data-swarm-team-dashboard] button:focus-visible, [data-swarm-team-dashboard] summary:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
${teamCardsCss}
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
      : <TeamDashboardCards key={state.targetSessionId} state={state} headingId={headingId} descriptionId={descriptionId} t={t}
          onSelectTeam={teamId => { controller.selectTeam(teamId) }}
          onMainChat={() => { void coordinator.openMainChat().catch(() => {}) }}
          onClose={() => { coordinator.closeAndRestoreFocus() }}>
        <Workspace
        data={data}
        handoffBusy={handoffBusy}
        localeTag={localeTag}
        state={state}
        t={t}
        teams={state.data?.teams}
        announcements={state.data?.captainAnnouncements}
        diagnostics={state.data?.captainDiagnostics}
        memberAssets={state.data?.captainMembers}
        onCaptainSession={handoff}
        onMemberSession={(name, sessionId) => { void coordinator.openMemberChat(name, sessionId).catch(() => {}) }}
        onClose={() => { coordinator.closeAndRestoreFocus() }}
      /></TeamDashboardCards>}
  </div>
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

function Workspace({ data, handoffBusy, localeTag, state, t, teams, announcements, diagnostics, memberAssets, onCaptainSession, onMemberSession, onClose }: {
  readonly data: SwarmHostReadProjectionV1
  readonly handoffBusy: boolean
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly state: TeamDashboardState
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly onCaptainSession: () => void
  readonly onMemberSession: (name: string, sessionId: string) => void
  readonly onClose: () => void
}) {
  const number = new Intl.NumberFormat(localeTag())
  const boundCaptain = teams?.teams.find(team => team.teamId === data.binding.teamId)
  const goal = boundCaptain?.goal
  const [view, setView] = useState<WorkspaceView>('workspace')
  const [detail, setDetail] = useState<DetailSelection>()
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const detailTriggerRef = useRef<HTMLElement | null>(null)
  const detailTeamRef = useRef(data.binding.teamId)
  const detailSessionRef = useRef<string>()
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
    if (detailTeamRef.current !== data.binding.teamId) {
      detailTeamRef.current = data.binding.teamId
      setDetail(undefined)
    }
  }, [data.binding.teamId])
  useLayoutEffect(() => {
    const member = memberAssets?.members.find(row => row.sessionId === state.targetSessionId)
    if (member !== undefined && detailSessionRef.current !== state.targetSessionId) {
      detailSessionRef.current = state.targetSessionId
      setDetail({ kind: 'member', name: member.name })
    }
  }, [memberAssets, state.targetSessionId])
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
  const captainGenerated = boundCaptain?.identityCard.state === 'generated'
  // The Team name is never a Captain name: only a real Captain-declared displayName is shown;
  // an un-generated identity (or a generated card without a displayName) renders the explicit
  // "profile not completed" marker instead of impersonation.
  const captainName = captainGenerated && boundCaptain?.displayName !== undefined ? boundCaptain.displayName : t('profileIncomplete')
  const captainProfession = captainGenerated && boundCaptain?.profession !== undefined ? boundCaptain.profession : undefined
  // The binding is the only authority for Captain navigation. It is not a personal activity
  // projection, so describe the actual Session relationship instead of calling the Captain
  // unavailable or inventing a working-state claim.
  const hasCaptain = Boolean(boundCaptain?.captainSessionId)
  const viewingCaptain = hasCaptain && state.targetSessionId === data.binding.rootSessionId
  const captainStateText = !hasCaptain ? t('captainNotCreated') : viewingCaptain ? t('captainCurrentSession') : t('captainOpenSession')
  const reviewTasks = data.tasks.filter(task => task.status === 'submitted' || task.status === 'verifying')
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
  const detailView = detail === undefined ? null : <DetailView detail={detail} data={data} localeTag={localeTag}
    number={number} headingRef={detailHeadingRef} memberAssets={memberAssets} diagnostics={diagnostics}
    onClose={() => { closeDetail(true) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(true) } }} t={t} />
  return <>
    <section className="swarm-team-workspace__pane">
      <Status state={state} t={t} />
      <div className="swarm-team-workspace__browse" data-swarm-workbench-browse hidden={detail !== undefined && detail.kind !== 'member'}>
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
      <details className="swarm-team-workspace__context" data-swarm-team-context open={data.team.phase === 'staged'}>
        <summary>{t('cards.context')}</summary>
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
        {data.team.phase === 'staged' && <section className="swarm-team-workspace__public-card swarm-team-workspace__attention" data-swarm-staged-plan data-swarm-staged-plan-state="pending">
          <span className="swarm-team-workspace__public-copy">
            <span className="swarm-team-workspace__public-title">{t('stagedPlan.title')}</span>
            {data.team.phase === 'staged'
              ? <span className="swarm-team-workspace__public-content" data-swarm-staged-plan-summary>{t('stagedPlan.summary', { members: data.team.plan?.members ?? 0, tasks: data.team.plan?.tasks ?? 0 })}</span>
              : <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('stagedPlan.absent')}</span>}
            {data.team.phase === 'staged' && <span className="swarm-team-workspace__public-content swarm-team-workspace__muted" data-swarm-staged-plan-hint>{t('stagedPlan.hint')}</span>}
          </span>
        </section>}
        {reviewTasks.length > 0 && <button type="button" className="swarm-team-workspace__attention" data-swarm-review-attention onClick={() => { openDetail({ kind: 'task', id: reviewTasks[0]!.id }) }}>
          <span>{t('progress.reviewAction', { count: number.format(reviewTasks.length) })}</span><span aria-hidden="true">→</span>
        </button>}
        {data.pendingInteractions.length > 0 && (
          <section className="swarm-team-workspace__public-card swarm-team-workspace__attention" data-swarm-attention>
            <span className="swarm-team-workspace__public-copy">
              <span className="swarm-team-workspace__public-title">{t('attention.title')}</span>
              <span className="swarm-team-workspace__public-content">{number.format(data.pendingInteractions.length)}</span>
              {data.pendingInteractions.slice(0, 3).map(item => (
                <span key={item.requestId} className="swarm-team-workspace__public-content" data-swarm-attention-row={item.requestId}>{t('attention.row', { intent: item.intent, target: item.targetRef ?? item.targetKind })}</span>
              ))}
            </span>
            <button type="button" className="swarm-team-workspace__text-action" onClick={viewingCaptain ? onClose : onCaptainSession}>{t('manageViaCaptain')}</button>
          </section>
        )}
        {latest !== undefined && <button type="button" className="swarm-team-workspace__public-card swarm-team-workspace__notice-preview" data-swarm-announcement-preview onClick={() => { setView('notices') }}>
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
        </button>}
        <TeamProgress data={data} number={number} t={t} />
      </div>
      </details>
      <main className="swarm-team-workspace__pane-body">
        {view === 'workspace' && <div role="tabpanel" id="swarm-panel-workspace" aria-labelledby="swarm-tab-workspace" data-swarm-panel="workspace">
          <div className="swarm-team-workspace__block-head"><span>{t('workspace.desks')}</span><small>{t('progress.memberCount', { count: number.format(data.totals.roster) })}</small></div>
          <section className="swarm-team-workspace__workroom" aria-label={t('workspace.desks')} data-swarm-workroom>
            <button
              className="swarm-team-workspace__desk"
              type="button"
              disabled={handoffBusy || viewingCaptain || !hasCaptain}
              data-swarm-captain-desk
              data-swarm-captain-current={viewingCaptain ? 'true' : 'false'}
              title={!hasCaptain ? t('captainNotCreated') : viewingCaptain ? t('captainCurrentSessionTitle') : t('captainMainChatTitle')}
              onClick={onCaptainSession}
            >
              <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={boundCaptain?.name ?? ''} asset={boundCaptain?.avatar ?? NOT_GENERATED_AVATAR} name={captainName} t={t} /></span>
              <span className="swarm-team-workspace__desk-copy">
                <strong className="swarm-team-workspace__desk-name" data-swarm-captain-visible-name={captainName} title={captainName}>{captainName}<b className="swarm-team-workspace__captain-badge">{t('captainRole')}</b></strong>
                <small className="swarm-team-workspace__desk-role" data-swarm-captain-profession={captainProfession ?? ''}>{captainProfession ?? t('profileNotGenerated')}</small>
              </span>
              <span className="swarm-team-workspace__desk-state" data-swarm-captain-state={captainStateText}>{captainStateText}<span aria-hidden="true">{viewingCaptain || !hasCaptain ? '' : ' →'}</span></span>
            </button>
            <div className="swarm-team-workspace__members" role="list" aria-label={t('members')}>
            {data.roster.map(member => {
              const tone = tones.get(member.name) ?? 'standby'
              const asset = memberAssetOf(memberAssets, member.name)
              const generated = asset.identityCard.state === 'generated'
              const displayName = generated && asset.displayName !== undefined ? asset.displayName : member.name
              const profession = generated && asset.profession !== undefined ? asset.profession : member.role
              const label = toneLabel(tone, t)
              const activity = deriveMemberActivity(data, member.name, member.phase)
              const current = activity.task !== undefined && activity.attempt !== undefined
                && ['in_progress', 'submitted', 'verifying'].includes(activity.task.status)
                && ['running', 'submitted', 'verifying'].includes(activity.attempt.phase) ? activity : undefined
              const waiting = current === undefined ? data.tasks.find(task => task.status === 'pending' && (task.ownerName === member.name || task.targetMemberName === member.name)) : undefined
              return (
                <div key={member.name} className="swarm-team-workspace__member-branch" data-swarm-member-branch={member.name} role="listitem">
                <button
                  className="swarm-team-workspace__desk"
                  type="button"
                  data-swarm-member-name={member.name}
                  data-swarm-member-role={member.role}
                  data-swarm-identity-state={asset.identityCard.state}
                  data-swarm-tone={tone}
                  aria-current={asset.sessionId === state.targetSessionId ? 'page' : undefined}
                  onClick={() => {
                    openDetail({ kind: 'member', name: member.name })
                    if (asset.sessionId !== undefined && asset.sessionId !== state.targetSessionId) onMemberSession(member.name, asset.sessionId)
                  }}
                >
                  <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={displayName} t={t} /></span>
                  <span className="swarm-team-workspace__desk-copy">
                    <strong className="swarm-team-workspace__desk-name" data-swarm-member-visible-name={displayName} title={displayName}>{displayName}</strong>
                    {asset.sessionId === state.targetSessionId ? <small className="swarm-team-workspace__current-label">{t('cards.currentChat')}</small> : null}
                    <small className="swarm-team-workspace__desk-role swarm-team-workspace__truncate" data-swarm-member-visible-profession={profession} title={profession}>{profession}</small>
                    {member.phase === 'failed' || member.provisioningAttempt !== undefined
                      ? <small className="swarm-team-workspace__desk-role" data-swarm-provisioning-attempt>{t(member.phase === 'failed' ? 'memberProvisioningFailed' : 'memberProvisioningAttempt', { count: member.provisioningAttempt ?? 1 })}</small>
                      : null}
                  </span>
                  <span className="swarm-team-workspace__desk-state" data-swarm-member-tone={tone} data-swarm-member-visible-activity={label} title={label}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" />{label}</span>
                </button>
                {current?.task !== undefined ? <button type="button" className="swarm-team-workspace__member-task" data-swarm-tree-task={current.task.id} data-swarm-current-attempt={current.attempt?.id} onClick={() => { openDetail({ kind: 'task', id: current.task!.id }) }}>
                  <span title={current.task.subject}>{current.task.subject}</span><small>{t('progress.attempt', { count: current.attempt!.generation })}</small><span aria-hidden="true">→</span>
                </button> : waiting !== undefined ? <button type="button" className="swarm-team-workspace__member-task" data-swarm-tree-waiting={waiting.id} onClick={() => { openDetail({ kind: 'task', id: waiting.id }) }}>
                  <span title={waiting.subject}>{waiting.subject}</span><small>{t(`progress.${taskProgressState(waiting, data.tasks)}`)}</small><span aria-hidden="true">→</span>
                </button> : null}
                {detail?.kind === 'member' && detail.name === member.name ? detailView : null}
                </div>
              )
            })}
            </div>
          </section>
          {data.truncated.roster ? <p className="swarm-team-workspace__muted">{t('rosterTruncated', { shown: number.format(data.roster.length), total: number.format(data.totals.roster) })}</p> : null}
          {data.tasks.length > 0 && <details className="swarm-team-workspace__fold" data-swarm-dependency-fold open={data.tasks.some(task => taskProgressState(task, data.tasks) === 'blocked')}>
            <summary>{t('dag.title')}<small>{t('progress.taskCount', { count: number.format(data.tasks.length) })}</small></summary>
            <TaskDag tasks={data.tasks} t={t} onSelect={id => { openDetail({ kind: 'task', id }) }} />
          </details>}
          <details className="swarm-team-workspace__fold" data-swarm-history>
          <summary>{t('workspace.teamActivity')}<small data-swarm-activity-count>{number.format(activities.length)}</small></summary>
          <p className="swarm-team-workspace__muted" data-swarm-desk-stats>{Object.entries(stats).filter(([, count]) => count > 0).map(([tone, count]) => `${number.format(count)} ${toneLabel(tone as DeskTone, t)}`).join(' · ')}</p>
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
          </details>
        </div>}
        {view === 'tasks' && <div role="tabpanel" id="swarm-panel-tasks" aria-labelledby="swarm-tab-tasks" data-swarm-panel="tasks">
          <div className="swarm-team-workspace__block-head"><span>{t('tasks')}</span><small data-swarm-task-count>{number.format(data.tasks.length)} {t('taskCount')}</small></div>
          {data.tasks.length === 0
            ? <p className="swarm-team-workspace__muted" data-swarm-task-empty>{t('empty')}</p>
            : <>
              <TaskDag tasks={data.tasks} t={t} onSelect={id => { openDetail({ kind: 'task', id }) }} />
              <section className="swarm-team-workspace__table" data-swarm-task-rows>
              {data.tasks.map(task => (
                <button key={task.id} className="swarm-team-workspace__table-row" type="button" data-swarm-task-id={task.id} data-swarm-task-status={task.status} onClick={() => { openDetail({ kind: 'task', id: task.id }) }}>
                  <span className="swarm-team-workspace__table-copy"><strong title={task.subject}>{task.subject}</strong><small>{task.blockedBy.length > 0 ? t('blocked', { count: task.blockedBy.length }) : ''}</small></span>
                  <span className="swarm-team-workspace__table-side" data-swarm-task-owner={`${t('taskOwner')}: ${task.ownerName ?? t('hostUnavailable')}`} title={`${t('taskOwner')}: ${task.ownerName ?? t('hostUnavailable')}`}>{task.ownerName ?? t('hostUnavailable')}</span>
                  <span className="swarm-team-workspace__table-side" data-swarm-task-state>{enumLabel(task.status, t)}</span>
                </button>
              ))}
            </section>
            </>}
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
          <ManageView data={data} memberAssets={memberAssets} hasCaptain={hasCaptain} number={number} onManageViaCaptain={onCaptainSession} onOpenDetail={openDetail} t={t} />
        </div>}
      </main>
      </div>
    {detail?.kind === 'member' ? null : detailView}
    </section>
  </>
}

/** The bar measures completed tasks, never an estimate of a model's internal progress. */
function TeamProgress({ data, number, t }: { readonly data: SwarmHostReadProjectionV1; readonly number: Intl.NumberFormat; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const counts: Record<TaskProgressState, number> = { completed: 0, running: 0, review: 0, blocked: 0, unknown: 0, ready: 0, failed: 0, cancelled: 0 }
  for (const task of data.tasks) counts[taskProgressState(task, data.tasks)] += 1
  const partial = data.truncated.tasks || data.tasks.length !== data.totals.tasks
  const states = Object.entries(counts) as [TaskProgressState, number][]
  return <section className="swarm-team-workspace__progress" data-swarm-progress aria-label={t('progress.title')}>
    <div className="swarm-team-workspace__progress-heading"><strong>{t('progress.title')}</strong><span>{t(partial ? 'progress.visibleSummary' : 'progress.summary', { completed: number.format(counts.completed), total: number.format(data.tasks.length) })}</span></div>
    {partial ? <p className="swarm-team-workspace__muted" data-swarm-progress-partial>{t('progress.partial', { shown: number.format(data.tasks.length), total: number.format(data.totals.tasks) })}</p>
      : data.tasks.length === 0 ? <p className="swarm-team-workspace__muted">{t('progress.empty')}</p>
        : <div className="swarm-team-workspace__progress-track" role="progressbar" aria-label={t('progress.title')} aria-valuemin={0} aria-valuemax={data.tasks.length} aria-valuenow={counts.completed}>
          {states.filter(([, count]) => count > 0).map(([state, count]) => <span key={state} data-tone={state} style={{ flexGrow: count }} />)}
        </div>}
    {data.tasks.length > 0 && <div className="swarm-team-workspace__progress-legend">
      {states.filter(([, count]) => count > 0).map(([state, count]) => <span key={state} data-tone={state} data-swarm-progress-state={state} data-count={count}><i aria-hidden="true" />{t(`progress.${state}`)} <b>{number.format(count)}</b></span>)}
    </div>}
  </section>
}
