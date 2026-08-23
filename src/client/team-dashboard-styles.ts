const TEAM_DASHBOARD_STYLES = `
[data-swarm-team-anchor] {
  display: inline-flex;
}
[data-swarm-team-trigger] {
  width: 32px;
  min-width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 10px;
}
[data-swarm-team-trigger][data-active] {
  color: var(--dsw-alias-label-primary-bluish);
  background: var(--dsw-alias-interactive-bg-active);
}
[data-swarm-team-layer] {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
[data-swarm-team-card] {
  position: fixed;
  pointer-events: auto;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100dvh - 100px);
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 20px;
  box-shadow: 0 18px 48px rgb(0 0 0 / 18%);
  font-family: var(--dsw-font-family);
  overflow: hidden;
}
[data-swarm-team-header] {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 20px 14px;
}
[data-swarm-team-heading] {
  min-width: 0;
}
[data-swarm-team-heading] h2 {
  margin: 0;
  font: var(--dsw-font-m-18);
}
[data-swarm-team-heading] p {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}
[data-swarm-team-tabs] {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin: 0 20px;
  padding: 4px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
[data-swarm-team-tabs] button {
  min-width: 0;
  padding: 7px 4px;
  border: 0;
  border-radius: 9px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  font: var(--dsw-font-xs-13);
  cursor: pointer;
}
[data-swarm-team-tabs] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-swarm-team-tabs] button[aria-selected='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}
[data-swarm-team-body] {
  min-height: 0;
  overflow: auto;
  padding: 16px 20px 20px;
}
[data-swarm-team-stack] {
  display: grid;
  gap: 12px;
}
[data-swarm-team-summary] {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
[data-swarm-team-stat] {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-subtle);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
}
[data-swarm-team-stat] strong,
[data-swarm-team-stat] span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-swarm-team-stat] strong {
  font: var(--dsw-font-s-strong-14);
}
[data-swarm-team-stat] span {
  margin-top: 3px;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}
[data-swarm-team-section] {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-base);
}
[data-swarm-team-section] h3 {
  margin: 0 0 10px;
  font: var(--dsw-font-s-strong-14);
}
[data-swarm-team-list] {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-swarm-team-row] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 7px 0;
  border-top: 1px solid var(--dsw-alias-border-subtle);
}
[data-swarm-team-row]:first-child {
  padding-top: 0;
  border-top: 0;
}
[data-swarm-team-row] > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-swarm-team-muted] {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}
[data-swarm-team-pills] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[data-swarm-team-diagnostics] summary {
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
}
[data-swarm-team-diagnostics] p {
  margin: 10px 0 0;
}
[data-swarm-team-footer] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
@media (prefers-reduced-motion: no-preference) {
  [data-swarm-team-card] { animation: swarm-team-peek-in 160ms ease-out; transform-origin: top right; }
  @keyframes swarm-team-peek-in {
    from { transform: translateY(-4px) scale(.985); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }
}
@media (max-width: 720px) {
  [data-swarm-team-card] {
    left: 8px !important;
    right: 8px;
    width: auto;
    max-height: calc(100dvh - 92px);
    border-radius: 16px;
  }
  [data-swarm-team-footer] { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
}
`

export default TEAM_DASHBOARD_STYLES
