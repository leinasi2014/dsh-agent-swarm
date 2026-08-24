import { useEffect, useId, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import {
  TEAM_DASHBOARD_SURFACE_ID,
  type TeamDashboardSurfaceCoordinator,
} from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { TeamDashboardContent } from './TeamDashboardContent.js'

interface TeamDashboardDetailsInjected {
  readonly anchorRef: RefObject<HTMLSpanElement>
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly localeTag: () => 'zh-CN' | 'en-US'
}

export type TeamDashboardDetailsProps = PropsRuntime<'details'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardDetailsInjected

/** Temporary details occupant. It renders null until the coordinator commits docking. */
export function TeamDashboardDetails({ anchorRef, controller, coordinator, localeTag, sessionId, t }: TeamDashboardDetailsProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const surface = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  const asideRef = useRef<HTMLElement>(null)
  const headingId = useId()
  const descriptionId = useId()
  const committed = surface.mode === 'docked' && surface.targetSessionId === sessionId && state.open

  useEffect(() => {
    if (!committed) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      const insidePanel = target instanceof Node && asideRef.current?.contains(target) === true
      const insideActions = target instanceof Node && anchorRef.current?.contains(target) === true
      if (!insidePanel && !insideActions) return
      event.preventDefault()
      coordinator.closeAndRestoreFocus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [anchorRef, committed, coordinator])

  if (!committed) return null
  return (
    <aside
      ref={asideRef}
      id={TEAM_DASHBOARD_SURFACE_ID}
      role="complementary"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      data-swarm-team-panel
      data-swarm-team-dashboard
      data-phase={state.phase}
    >
      <TeamDashboardContent
        controller={controller}
        coordinator={coordinator}
        descriptionId={descriptionId}
        headingId={headingId}
        localeTag={localeTag}
        state={state}
        t={t}
      />
    </aside>
  )
}
