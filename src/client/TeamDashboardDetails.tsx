import { useId, useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { TeamDashboardContent } from './TeamDashboardContent.js'

const TEAM_DASHBOARD_SURFACE_ID = 'swarm-team-surface'

export interface TeamDashboardDetailsInjected {
  readonly anchorRef: RefObject<HTMLSpanElement>
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly localeTag: () => 'zh-CN' | 'en-US'
}

export type TeamDashboardDetailsProps = PropsRuntime<'details'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS> & TeamDashboardDetailsInjected

/** The sole Team surface. Official AppFrame owns Details sizing and recovery. */
export function TeamDashboardDetails({ controller, coordinator, localeTag, sessionId, t }: TeamDashboardDetailsProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const surface = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  const headingId = useId()
  const descriptionId = useId()
  const leased = surface.mode === 'docked' && surface.targetSessionId === sessionId && state.open
  if (!leased) return null
  return <aside id={TEAM_DASHBOARD_SURFACE_ID} role="complementary" tabIndex={-1}
    aria-labelledby={headingId} aria-describedby={descriptionId}
    data-swarm-team-panel data-swarm-team-dashboard data-phase={state.phase}
    style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
    <TeamDashboardContent controller={controller} coordinator={coordinator} descriptionId={descriptionId}
      headingId={headingId} localeTag={localeTag} state={state} t={t} />
  </aside>
}
