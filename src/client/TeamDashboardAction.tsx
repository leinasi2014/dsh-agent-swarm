import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export interface TeamDashboardActionInjected {
  readonly controller: TeamDashboardController
}

export type TeamDashboardActionProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardActionInjected

/** Additive Session-header entry; the official framework supplies the target hint. */
export function TeamDashboardAction({ controller, sessionId, t }: TeamDashboardActionProps) {
  return (
    <Button
      size="sm"
      variant="toolbar"
      aria-label={t('action.open')}
      onClick={() => { controller.open(sessionId) }}
    >
      {t('action.open')}
    </Button>
  )
}
