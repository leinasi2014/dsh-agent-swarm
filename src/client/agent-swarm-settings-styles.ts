const AGENT_SWARM_SETTINGS_STYLES = `
[data-swarm-settings-card] { list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); }
[data-swarm-settings-card][data-open='true'] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
[data-swarm-settings-header] { width: 100%; border: 0; border-radius: 12px; padding: 14px 16px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px; }
[data-swarm-settings-header]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
[data-swarm-settings-head-copy] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
[data-swarm-settings-title] { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 1.4; }
[data-swarm-settings-description] { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
[data-swarm-settings-pending] { flex: none; padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; }
[data-swarm-settings-chevron] { color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
[data-swarm-settings-card][data-open='true'] [data-swarm-settings-chevron] { transform: rotate(180deg); }
[data-swarm-settings-body] { margin: 0 16px; padding-bottom: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
[data-swarm-settings-group] { margin: 0; padding: 12px 0 0; border: 0; }
[data-swarm-settings-group] + [data-swarm-settings-group] { margin-top: 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
[data-swarm-settings-legend] { padding: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; }
[data-swarm-settings-field] { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
[data-swarm-settings-field] + [data-swarm-settings-field] { border-top: 1px solid var(--dsw-alias-border-l2); }
[data-swarm-settings-field-head] { display: flex; align-items: center; gap: 8px; }
[data-swarm-settings-label] { flex: 1; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 1.5; }
[data-swarm-settings-badge] { padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; }
[data-swarm-settings-reset] { border: 0; padding: 0; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
[data-swarm-settings-input] { height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
[data-swarm-settings-input][aria-invalid='true'] { border-color: var(--dsw-alias-label-error); }
[data-swarm-settings-input]:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
[data-swarm-settings-hint] { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
[data-swarm-settings-hint][data-invalid='true'] { color: var(--dsw-alias-label-error); }
[data-swarm-settings-toggle] { flex: 1; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); font-size: 13px; }
[data-swarm-settings-readonly] { margin: 12px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
[data-swarm-settings-footer] { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
[data-swarm-settings-failed] { flex: 1; margin: 0; color: var(--dsw-alias-label-error); font-size: 12px; }
[data-swarm-settings-action] { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 5px 14px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
[data-swarm-settings-action='save'] { border-color: transparent; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
[data-swarm-settings-action]:disabled, [data-swarm-settings-input]:disabled, [data-swarm-settings-reset]:disabled { opacity: .4; cursor: default; }
`

export default AGENT_SWARM_SETTINGS_STYLES
