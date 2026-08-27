import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SwarmReadClient } from './read-client.js'
import { TeamDashboardController } from './team-dashboard-controller.js'
import { TeamDashboardAction, type TeamDashboardActionInjected } from './TeamDashboardAction.js'
import { en, TEAM_DASHBOARD_NS, zh, type TeamDashboardKey } from './team-dashboard-locales.js'
import { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'swarm.team-dashboard': TeamDashboardKey
  }
}

export const inject = ['sessions', 'slots', 'locale']

/** Compose the additive DSH-native Details occupant and Session utility. */
export function apply(ctx: ClientContext): void {
  const sessionsService = ctx.get('sessions') as ISessions | undefined
  if (sessionsService === undefined) throw new Error('swarm Team dashboard requires the official Sessions service')
  const controller = new TeamDashboardController(new SwarmReadClient())
  const anchorRef = { current: null as HTMLSpanElement | null }
  const coordinator = new TeamDashboardSurfaceCoordinator({ slots: ctx.slots, sessions: sessionsService, locale: ctx.locale, controller, anchorRef })
  ctx.effect(() => coordinator.mount(), 'swarm Team dashboard surface coordinator')
  ctx.on('connection/reset', () => { controller.connectionReset() })
  ctx.effect(() => ctx.locale.register(TEAM_DASHBOARD_NS, { zh, en }), 'swarm Team dashboard dictionaries')
  ctx.inject(['layout'], layoutCtx => {
    const layout = layoutCtx.get('layout')
    if (layout !== undefined) layoutCtx.effect(() => coordinator.bindLayout(layout), 'swarm Team dashboard Details lease')
  })
  ctx.slots.inject('details', () => coordinator.bindDetailsDeclaration())
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'swarm-team',
    order: 30,
    locale: TEAM_DASHBOARD_NS,
    inject: (): TeamDashboardActionInjected => ({ anchorRef, coordinator }),
  }, TeamDashboardAction))
}
