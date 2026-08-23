import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SwarmReadClient } from './read-client.js'
import { TeamDashboardController } from './team-dashboard-controller.js'
import { TeamDashboardAction, type TeamDashboardActionInjected } from './TeamDashboardAction.js'
import { TeamDashboardOverlay, type TeamDashboardOverlayInjected } from './TeamDashboardOverlay.js'
import { en, TEAM_DASHBOARD_NS, zh, type TeamDashboardKey } from './team-dashboard-locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'swarm.team-dashboard': TeamDashboardKey
  }
}

export const inject = ['sessions', 'slots', 'locale']

/** Compose the additive DSH-native R3 read UI. */
export function apply(ctx: ClientContext): void {
  const sessionsService = ctx.get('sessions') as ISessions | undefined
  if (sessionsService === undefined) throw new Error('swarm Team dashboard requires the official Sessions service')
  const controller = new TeamDashboardController(new SwarmReadClient())
  ctx.effect(() => () => { controller.dispose() }, 'swarm Team dashboard controller')
  ctx.on('connection/reset', () => { controller.connectionReset() })
  ctx.effect(() => ctx.locale.register(TEAM_DASHBOARD_NS, { zh, en }), 'swarm Team dashboard dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'swarm-team',
    order: 30,
    locale: TEAM_DASHBOARD_NS,
    inject: (): TeamDashboardActionInjected => ({ controller }),
  }, TeamDashboardAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'swarm-team-dashboard',
    order: 30,
    locale: TEAM_DASHBOARD_NS,
    inject: (): TeamDashboardOverlayInjected => ({
      controller,
      openCaptainChat: async () => {
        await controller.openCaptainChat((rootSessionId) => {
          const sessions = sessionsService.list.getSnapshot()
          if (!Object.hasOwn(sessions.byId, rootSessionId)) {
            throw new Error('Captain Session is no longer in the official Session list')
          }
          sessionsService.open(rootSessionId as SessionId)
        })
      },
    }),
  }, TeamDashboardOverlay))
}
