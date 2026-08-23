import { Button, IconCodeOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import {
  TEAM_DASHBOARD_SURFACE_ID,
  type TeamDashboardSurfaceCoordinator,
} from './team-dashboard-surface-coordinator.js'

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
  const descriptionId = useId()
  const active = state.mode !== 'inactive' && state.targetSessionId === sessionId
  const toolUnavailable = !state.safeWidth
  const announcement = state.announcement === 'tool-shown'
    ? t('action.toolDetailsShown')
    : state.announcement === 'tool-unavailable-width'
      ? t('action.toolDetailsUnavailable')
      : state.announcement === 'tool-unavailable-runtime' ? t('action.toolDetailsUnavailableNow') : ''

  return (
    <span ref={anchorRef} data-swarm-team-anchor data-swarm-team-actions data-swarm-team-session={sessionId}>
      <Button
        size="sm"
        variant="toolbar"
        aria-label={t('action.open')}
        title={t('action.open')}
        aria-controls={TEAM_DASHBOARD_SURFACE_ID}
        aria-expanded={active}
        data-swarm-team-trigger
        data-active={active || undefined}
        data-presentation={active ? state.mode : undefined}
        onClick={() => { coordinator.cycle(sessionId) }}
      >
        <IconUserOutline16 />
      </Button>
      <Button
        size="sm"
        variant="toolbar"
        aria-label={t('action.toolDetails')}
        title={toolUnavailable ? t('action.toolDetailsUnavailable') : t('action.toolDetails')}
        aria-disabled={toolUnavailable}
        aria-describedby={toolUnavailable ? descriptionId : undefined}
        data-swarm-tool-trigger
        onClick={() => { coordinator.showToolDetails() }}
      >
        <IconCodeOutline16 />
      </Button>
      <span id={descriptionId} data-swarm-team-visually-hidden>
        {toolUnavailable ? t('action.toolDetailsUnavailable') : ''}
      </span>
      <span aria-live="polite" aria-atomic="true" data-swarm-team-visually-hidden data-announcement-revision={state.announcementRevision}>
        {announcement}
      </span>
    </span>
  )
}
