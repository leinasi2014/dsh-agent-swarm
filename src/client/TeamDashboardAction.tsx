import { Button, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore, type RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export interface TeamDashboardActionInjected {
  readonly controller: TeamDashboardController
  readonly anchorRef: RefObject<HTMLSpanElement>
}

export type TeamDashboardActionProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardActionInjected

/** Additive Session-header entry; the official framework supplies the target hint. */
export function TeamDashboardAction({ anchorRef, controller, sessionId, t }: TeamDashboardActionProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const active = state.open && state.targetSessionId === sessionId

  return (
    <span ref={anchorRef} data-swarm-team-anchor>
      <Button
        size="sm"
        variant="toolbar"
        aria-label={t('action.open')}
        title={t('action.open')}
        aria-controls="swarm-team-peek-card"
        aria-expanded={active}
        data-swarm-team-trigger
        data-active={active || undefined}
        onClick={() => {
          if (active) controller.close()
          else controller.open(sessionId)
        }}
      >
        <IconUserOutline16 />
      </Button>
    </span>
  )
}
