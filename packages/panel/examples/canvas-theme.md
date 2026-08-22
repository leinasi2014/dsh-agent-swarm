# Canvas host theme mapping example

The Canvas web app (React 19 + Tailwind 4) mounts the shared panel inside its
AgentPanel "Swarm" tab. The theme bridge maps the Tailwind/CSS variables that
`web/src/styles/globals.css` exposes (`--background`, `--card`, `--foreground`,
`--muted-foreground`, `--border`, `--primary`, `--destructive`, plus a green
success tone) onto the same `--swarm-*` contract the DSH host maps, then the
`.dark` class variant flips both layers together.

## Option A — static CSS (mirror of `examples/dsh-theme.css`)

```css
/* Ship next to the Swarm tab; scope to the tab container, map on the
 * ANCESTOR of .swarm-panel so the shared stylesheet keeps its defaults. */
.swarm-theme-canvas {
  --swarm-bg: var(--background);
  --swarm-bg-raised: var(--card);
  --swarm-fg: var(--foreground);
  --swarm-fg-muted: var(--muted-foreground);
  --swarm-border: var(--border);
  --swarm-accent: var(--primary);
  --swarm-state-running: var(--primary);
  --swarm-state-done: var(--success, var(--primary)); /* oklch green if defined */
  --swarm-state-error: var(--destructive);
}
```

## Option B — inline style bridge (when the tab container already computes a
style object from `useThemeStore` / `canvasThemes`)

```tsx
import { SwarmPanel, type SwarmPanelProps } from '@dsh-agent-swarm/panel'
import '@dsh-agent-swarm/panel/panel.css'

/** Theme tokens → the --swarm-* contract, as a React style object. */
function swarmThemeVars(theme: Record<string, string>): React.CSSProperties {
  return {
    '--swarm-bg': theme.background,
    '--swarm-bg-raised': theme.card,
    '--swarm-fg': theme.foreground,
    '--swarm-fg-muted': theme.mutedForeground,
    '--swarm-border': theme.border,
    '--swarm-accent': theme.primary,
    '--swarm-state-running': theme.primary,
    '--swarm-state-done': theme.success ?? theme.primary,
    '--swarm-state-error': theme.destructive,
  } as React.CSSProperties
}

export function SwarmTab(props: SwarmPanelProps) {
  const theme = useThemeStore(state => state.current)
  return (
    <div style={swarmThemeVars(theme)}>
      <SwarmPanel {...props} />
    </div>
  )
}
```

Rules the bridge must keep (spec §5.4 / §8.9):

1. Map on an ancestor of `.swarm-panel` — never edit the shared stylesheet or
   redeclare the variables on `.swarm-panel` itself.
2. The shared panel never sees a Tailwind class or an antd token; the bridge
   is the only place host tokens are named.
3. Dark mode is the host's mechanism (`.dark` class in Canvas,
   `body[data-ds-dark-theme]` in DSH); the contract variables simply resolve
   differently in each mode.
