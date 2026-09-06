export const shellCssBase = `
[data-swarm-team-dashboard] .swarm-team-workspace { position:relative; container-type:inline-size; height:100%; min-width:0; overflow:hidden; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__pane { display:grid; grid-template-rows:auto auto auto minmax(0,1fr); height:100%; min-width:0; min-height:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 10px; border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__title-row { display:flex; align-items:center; gap:7px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__title { margin:0; overflow:hidden; font-size:14px; line-height:19px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__team-switcher { min-width:0; max-inline-size:150px; padding:3px 22px 3px 7px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:10px; line-height:16px; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__team-switcher:hover { border-color:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__phase-pill { flex:0 0 auto; padding:1px 7px; border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l2)); border-radius:999px; background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-brand-primary); font-size:10px; font-weight:600; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__subtitle { margin:2px 0 0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-bar { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; padding:8px 10px; border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
@container (max-width: 560px) { [data-swarm-team-dashboard] .swarm-team-workspace__public-bar { grid-template-columns:1fr; } }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card { display:grid; gap:2px; min-width:0; min-height:36px; padding:7px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__public-card[data-swarm-goal-state="generated"] { border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2)); background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__public-title { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__public-content { min-width:0; overflow:hidden; font-size:10.5px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs { position:relative; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border:0 solid var(--dsw-alias-border-l2); border-bottom-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"] { min-width:0; overflow:hidden; padding:8px 4px; border:0; border-radius:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; font-weight:600; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"]:hover { color:var(--dsw-alias-label-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__view-tabs [role="tab"][aria-selected="true"] { color:var(--dsw-alias-brand-primary); box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__compat-task-tab { display:none !important; }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-body { position:relative; min-height:0; padding:10px 11px 16px; overflow:auto; scrollbar-width:thin; font-size:12px; line-height:1.45; }
[data-swarm-team-dashboard] .swarm-team-workspace__view-shell[data-detail-open="true"] { display:none; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0; margin:10px 0 6px; font-size:12px; font-weight:700; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head:first-child { margin-top:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__block-head small { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; font-weight:500; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress { display:grid; gap:6px; margin-bottom:10px; padding:9px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress .swarm-team-workspace__block-head { margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track { display:flex; gap:2px; block-size:7px; overflow:hidden; border-radius:999px; background:var(--dsw-alias-bg-layer-2); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span { min-inline-size:3px; flex:1 1 0; background:var(--dsw-alias-border-l3); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span[data-swarm-progress-tone="executing"] { background:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span[data-swarm-progress-tone="pending"], [data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span[data-swarm-progress-tone="blocked"] { background:var(--dsw-alias-label-caution,var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span[data-swarm-progress-tone="completed"] { background:var(--dsw-alias-label-positive,var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span[data-swarm-progress-tone="failed"] { background:var(--dsw-alias-label-negative,var(--dsw-alias-label-secondary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-track > span[data-swarm-progress-tone="cancelled"] { opacity:.45; }
[data-swarm-team-dashboard] .swarm-team-workspace__progress-legend { display:flex; flex-wrap:wrap; gap:4px 10px; color:var(--dsw-alias-label-secondary); font-size:9px; }
[data-swarm-team-dashboard] .swarm-team-workspace__workroom { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
@container (max-width: 520px) { [data-swarm-team-dashboard] .swarm-team-workspace__workroom { grid-template-columns:1fr; } }
[data-swarm-team-dashboard] .swarm-team-workspace__delegation .swarm-team-workspace__workroom { grid-template-columns:1fr; gap:4px; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk { position:relative; display:grid; grid-template-columns:32px minmax(0,1fr) auto; grid-template-rows:auto auto; align-items:center; column-gap:8px; min-width:0; min-block-size:56px; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); color:inherit; text-align:left; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk:hover { border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l2)); background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk:disabled { cursor:default; opacity:.75; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk .swarm-team-workspace__avatar { grid-row:1 / 3; }
[data-swarm-team-dashboard] .swarm-team-workspace__avatar { display:grid; place-items:center; inline-size:32px; block-size:32px; overflow:hidden; border-radius:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__avatar > * { max-inline-size:100%; max-block-size:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-copy { display:flex; flex-direction:column; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-name { min-width:0; overflow:hidden; font-size:11.5px; font-weight:680; line-height:17px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-role { min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9.5px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-state { display:flex; align-items:center; gap:4px; grid-column:3; grid-row:1 / 3; min-width:0; max-width:100%; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9.5px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__desk-dot { flex:0 0 auto; inline-size:7px; block-size:7px; border-radius:50%; background:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="standby"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-positive,var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="executing"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="pending"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-caution,var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__desk[data-swarm-tone="failed"] .swarm-team-workspace__desk-dot { background:var(--dsw-alias-label-negative,var(--dsw-alias-label-secondary)); }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-node { margin-bottom:3px; border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,var(--dsw-alias-border-l2)); }
[data-swarm-team-dashboard] .swarm-team-workspace__delegate-member { position:relative; display:grid; gap:2px; padding-left:14px; }
[data-swarm-team-dashboard] .swarm-team-workspace__delegate-member::before { content:""; position:absolute; inset-inline-start:5px; inset-block:0 16px; border-inline-start:1px solid var(--dsw-alias-border-l3); }
[data-swarm-team-dashboard] .swarm-team-workspace__delegate-member::after { content:""; position:absolute; inset-inline-start:5px; inset-block-start:27px; inline-size:7px; border-block-start:1px solid var(--dsw-alias-border-l3); }
[data-swarm-team-dashboard] .swarm-team-workspace__member-task { display:grid; grid-template-columns:auto minmax(0,1fr); gap:5px; min-width:0; padding:1px 8px 4px 12px; color:var(--dsw-alias-label-secondary); font-size:9px; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-task-copy { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-badge { margin-left:4px; padding:1px 4px; border-radius:4px; background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent); color:var(--dsw-alias-brand-primary); font-size:9px; font-weight:700; white-space:nowrap; }
`
