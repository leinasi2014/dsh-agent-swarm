/**
 * Reserved official seams for the A-class capabilities listed in
 * docs/12-official-interface-architecture.md.
 *
 * Every A-class capability has exactly one entry point here. Today each probe
 * fails and the caller keeps the official default; when the official surface
 * lands, only these functions change — callers and their tests stay put.
 */

/** A1: the official sidebar region that would host a resident Team list, if one exists. */
export const RESERVED_SIDEBAR_LIST_SLOT: string | undefined = undefined

/** One resident rail registration an official sidebar list region would receive. */
export type SidebarRegionInstaller = (region: string) => () => void

/**
 * A1: install the resident Team rail in an official sidebar list region when the
 * official sidebar exposes one.
 * @param slots - the client slot service; only its `register` face is probed.
 * @param install - invoked with the official region name; never called when the region is absent.
 * @param region - official region name, reserved as {@link RESERVED_SIDEBAR_LIST_SLOT}.
 * @returns the registration disposer, or `undefined` when the official region is
 *   absent — the caller then keeps the rail inside the Team panel and registers nothing.
 */
export function registerSidebarNavigation(
  slots: unknown,
  install: SidebarRegionInstaller,
  region: string | undefined = RESERVED_SIDEBAR_LIST_SLOT,
): (() => void) | undefined {
  const candidate = slots as { register?: unknown } | undefined
  if (region === undefined || candidate === undefined || typeof candidate.register !== 'function') return undefined
  return install(region)
}

/** A2: the per-panel geometry a capable official layout entry would receive. */
export const TEAM_PANEL_GEOMETRY = Object.freeze({
  rightSidebar: 'current-session' as const,
  columns: Object.freeze({
    sidebar: Object.freeze({ defaultWidth: 166, minWidth: 166 }),
    rightbar: Object.freeze({ defaultWidth: 320 }),
  }),
})

export interface PanelGeometrySeam {
  (panelId: string, geometry: typeof TEAM_PANEL_GEOMETRY): () => void
}

/** A2: probe an official per-panel geometry entry; `undefined` keeps framework defaults. */
export function probePanelGeometry(layout: unknown): PanelGeometrySeam | undefined {
  const candidate = layout as { registerPanelPresentation?: unknown } | undefined
  return candidate !== undefined && typeof candidate.registerPanelPresentation === 'function'
    ? (candidate.registerPanelPresentation as PanelGeometrySeam).bind(candidate)
    : undefined
}

/** A3: ask for a one-shot latest position where the official surface offers it; otherwise the
 *  official Chat behavior stands (first open lands at the bottom, a saved position is restored). */
export function requestLatestNavigation(ctx: { get(name: string): unknown }, sessionId: string): void {
  const navigation = ctx.get('chatNavigation') as { requestLatest?: (id: string) => () => void } | undefined
  navigation?.requestLatest?.(sessionId)
}
