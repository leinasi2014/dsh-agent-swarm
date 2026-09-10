import type { WorkRequestController } from './work-request-controller.js'
import type { PublicChatController } from './public-chat-controller.js'
import { useEffect, useId, useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { TeamDashboardContent } from './TeamDashboardContent.js'

const TEAM_DASHBOARD_SURFACE_ID = 'swarm-team-surface'

interface TeamDashboardDetailsInjected {
  readonly work?: WorkRequestController | undefined
  readonly chat?: PublicChatController | undefined
  readonly anchorRef: RefObject<HTMLSpanElement>
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly localeTag: () => 'zh-CN' | 'en-US'
}

export type TeamDashboardDetailsProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS> & TeamDashboardDetailsInjected

/** The Team tab body; official Sidebar owns its geometry and presentation. */
export function TeamDashboardDetails({ controller, coordinator, chat, work, localeTag, sessionId, useTabInfo, t }: TeamDashboardDetailsProps) {
  const { tab } = useTabInfo()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const surface = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  const headingId = useId()
  const descriptionId = useId()
  const leased = tab.visible && surface.mode === 'docked' && surface.targetSessionId === sessionId
    && state.open && state.targetSessionId === sessionId
  useEffect(() => {
    return coordinator.observeTab(sessionId, tab)
  }, [coordinator, sessionId, tab])
  if (!leased) return null
  return <aside id={TEAM_DASHBOARD_SURFACE_ID} role="complementary" tabIndex={-1}
    aria-labelledby={headingId} aria-describedby={descriptionId}
    data-swarm-team-panel data-swarm-team-dashboard data-phase={state.phase}
    style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
    <TeamDashboardContent work={work} chat={chat} controller={controller} coordinator={coordinator} descriptionId={descriptionId}
      headingId={headingId} localeTag={localeTag} state={state} t={t} />
  </aside>
}
