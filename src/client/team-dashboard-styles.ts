const TEAM_DASHBOARD_STYLES = `
[data-swarm-team-anchor] {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
[data-swarm-team-trigger],
[data-swarm-tool-trigger] {
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
[data-swarm-team-panel] {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  border-left: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-family);
  overflow: hidden;
}
[data-swarm-team-header] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 12px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
[data-swarm-team-heading] {
  min-width: 0;
}
[data-swarm-team-heading] h2 {
  margin: 0;
  overflow: hidden;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-swarm-team-heading] p {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
[data-swarm-team-tabs] {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin: 12px 16px 0;
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
  font: var(--dsw-font-xs-13);
  cursor: pointer;
}
[data-swarm-team-tabs] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-swarm-team-tabs] button[aria-pressed='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}
[data-swarm-team-body] {
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 16px;
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
  border: 1px solid var(--dsw-alias-border-l1);
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
  border-top: 1px solid var(--dsw-alias-border-l1);
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
[data-swarm-team-row-copy] {
  display: grid;
  gap: 2px;
}
[data-swarm-team-row-copy] > span {
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
  padding: 12px 16px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
}
[data-swarm-team-visually-hidden] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`

export default TEAM_DASHBOARD_STYLES
