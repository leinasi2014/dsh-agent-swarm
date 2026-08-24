import { Button, IconCodeOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import {
  TEAM_DASHBOARD_SURFACE_ID,
  type TeamDashboardSurfaceCoordinator,
} from './team-dashboard-surface-coordinator.js'
import TEAM_DASHBOARD_STYLES from './team-dashboard-styles.js'

export interface TeamDashboardActionInjected {
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly anchorRef: RefObject<HTMLSpanElement>
}

export type TeamDashboardActionProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardActionInjected

/** Additive Session-header entry; the official framework supplies the target hint. */
export function TeamDashboardAction({ anchorRef, coordinator, sessionId, t }: TeamDashboardActionProps) {
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  const active = state.mode === 'docked' && state.targetSessionId === sessionId
  const announcement = state.announcement === 'tool-selected'
    ? t('action.toolDetailsSelected')
    : state.announcement === 'tool-unavailable-runtime' ? t('action.toolDetailsUnavailableNow') : ''

  return (
    <span ref={anchorRef} data-swarm-team-anchor data-swarm-team-actions data-swarm-team-session={sessionId}>
      <style>{TEAM_DASHBOARD_STYLES}</style>
      <Button
        size="sm"
        variant="toolbar"
        aria-label={t('action.open')}
        title={t('action.open')}
        aria-controls={TEAM_DASHBOARD_SURFACE_ID}
        aria-expanded={active}
        data-swarm-team-trigger
        data-active={active || undefined}
        onClick={() => { coordinator.toggle(sessionId) }}
      >
        <IconUserOutline16 />
      </Button>
      <Button
        size="sm"
        variant="toolbar"
        aria-label={t('action.toolDetails')}
        title={t('action.toolDetails')}
        data-swarm-tool-trigger
        onClick={() => { coordinator.showToolDetails() }}
      >
        <IconCodeOutline16 />
      </Button>
      <span aria-live="polite" aria-atomic="true" data-swarm-team-visually-hidden data-announcement-revision={state.announcementRevision}>
        {announcement}
      </span>
    </span>
  )
}
