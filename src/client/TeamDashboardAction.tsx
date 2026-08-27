import { Button, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'

const TEAM_DASHBOARD_SURFACE_ID = 'swarm-team-surface'

export interface TeamDashboardActionInjected {
  readonly anchorRef: RefObject<HTMLSpanElement>
  readonly coordinator: TeamDashboardSurfaceCoordinator
}

export type TeamDashboardActionProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardActionInjected

/** Additive Session utility. The framework-owned Session id is only a target hint. */
export function TeamDashboardAction({ anchorRef, coordinator, sessionId, t }: TeamDashboardActionProps) {
  const surface = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  const active = surface.mode === 'docked' && surface.targetSessionId === sessionId
  return (
    <span ref={anchorRef} data-swarm-team-actions data-swarm-team-session={sessionId}>
      <Button
        size="sm"
        variant="toolbar"
        aria-label={t('action.open')}
        aria-controls={TEAM_DASHBOARD_SURFACE_ID}
        aria-expanded={active}
        data-swarm-team-trigger
        onClick={() => { coordinator.toggle(sessionId) }}
      >
        <IconUserOutline16 />
      </Button>
    </span>
  )
}
