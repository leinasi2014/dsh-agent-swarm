import { Button, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export interface TeamDashboardActionInjected {
  readonly controller: TeamDashboardController
}

export type TeamDashboardActionProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardActionInjected

/** Additive Session-header entry; the official framework supplies the target hint. */
export function TeamDashboardAction({ controller, sessionId, t }: TeamDashboardActionProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const active = state.open && state.targetSessionId === sessionId

  return (
    <Button
      size="sm"
      variant="toolbar"
      aria-label={t('action.open')}
      title={t('action.open')}
      aria-controls="swarm-team-peek-drawer"
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
  )
}
