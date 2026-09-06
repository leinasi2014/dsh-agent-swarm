export const shellCssExtra = `
[data-swarm-team-dashboard] .swarm-team-workspace__activity { border:0 solid var(--dsw-alias-border-l2); border-block-width:1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; padding:7px 2px; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-row + .swarm-team-workspace__activity-row { border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-signal { inline-size:7px; block-size:7px; border-radius:50%; background:var(--dsw-alias-brand-primary); }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-signal[data-swarm-signal="pending"] { background:var(--dsw-alias-label-caution,var(--dsw-alias-brand-primary)); }
[data-swarm-team-dashboard] [data-swarm-signal="settled"] { opacity:.35; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-copy { display:grid; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-title { overflow:hidden; font-size:10.5px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-meta { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__activity-state { color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__table { overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:8px; width:100%; min-width:0; padding:9px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2); background:transparent; color:inherit; font-size:11px; text-align:left; }
button.swarm-team-workspace__table-row { cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-row:last-child { border-bottom-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy { display:grid; gap:1px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy strong { overflow:hidden; font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-copy small,[data-swarm-team-dashboard] .swarm-team-workspace__table-copy time { overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:9px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__table-side { min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__manage { display:grid; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__manage-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; padding:9px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__manage-action { padding:4px 10px; border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l2)); border-radius:8px; background:transparent; color:var(--dsw-alias-brand-primary); font-size:10px; cursor:pointer; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-overlay { position:absolute; inset:0; z-index:6; display:grid; grid-template-rows:auto minmax(0,1fr); min-height:100%; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
[data-swarm-team-dashboard] .swarm-team-workspace__pane-body > .swarm-team-workspace__detail-overlay { position:relative; inset:auto; z-index:auto; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 9px; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-title { margin:0; font-size:13px; line-height:18px; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-sub { color:var(--dsw-alias-label-secondary); font-size:9px; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-body { min-height:0; padding:10px; overflow:auto; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section { display:grid; gap:8px; padding:9px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section + .swarm-team-workspace__detail-section { margin-top:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__detail-section h4 { margin:0; font-size:11px; }
[data-swarm-team-dashboard] .swarm-team-workspace__identity-head { display:grid; grid-template-columns:32px minmax(0,1fr); gap:8px; align-items:center; }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list { display:grid; grid-template-columns:minmax(100px,.45fr) minmax(0,1fr); gap:5px 8px; margin:0; font-size:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list dt { min-width:0; color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__field-list dd { margin:0; min-width:0; overflow-wrap:anywhere; }
[data-swarm-team-dashboard] .swarm-team-workspace__summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
[data-swarm-team-dashboard] .swarm-team-workspace__metric { display:grid; gap:1px; padding:7px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts { display:grid; gap:6px; margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__fact { display:grid; grid-template-columns:minmax(100px,.45fr) minmax(0,1fr); gap:8px; font-size:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dt { min-width:0; color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dd { margin:0; min-width:0; overflow:hidden; overflow-wrap:anywhere; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__contact-note { color:var(--dsw-alias-label-secondary); font-size:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__unavailable,[data-swarm-team-dashboard] .swarm-team-workspace__muted { color:var(--dsw-alias-label-secondary); font-size:11px; }
[data-swarm-team-dashboard] .swarm-team-workspace__truncate { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__status { display:flex; gap:8px; align-items:center; min-width:0; margin:0 0 8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__error { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-shell { display:flex; flex-direction:column; gap:8px; min-width:0; min-height:100%; padding:10px 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__empty-actions { display:flex; gap:8px; flex-wrap:wrap; }
@media (max-width: 995.98px) { [data-swarm-team-dashboard][data-swarm-team-panel] { position:fixed; inset:0; z-index:20; } }
`
