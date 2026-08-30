import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SwarmReadClient } from './read-client.js'
import type { SwarmReadSkillCatalogV1 } from '../rpc/read-rpc-contract.js'
import { TeamDashboardController } from './team-dashboard-controller.js'
import { TeamDashboardAction, type TeamDashboardActionInjected } from './TeamDashboardAction.js'
import { en, TEAM_DASHBOARD_NS, zh, type TeamDashboardKey } from './team-dashboard-locales.js'
import { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import {
  TeamSkillSettingsCard,
  TEAM_SKILL_SETTINGS_NS,
  teamSkillSettingsEn,
  teamSkillSettingsZh,
  type TeamSkillSettingsFace,
  type TeamSkillSettingsKey,
  type TeamModelRoute,
  type TeamSettingsCatalog,
} from './TeamSkillSettingsCard.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'swarm.team-dashboard': TeamDashboardKey
    'agent-swarm': TeamSkillSettingsKey
  }
}

export const inject = ['sessions', 'slots', 'locale', 'settingsScope', 'connection']

interface CatalogResponse<T> {
  readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }
}

interface TeamSettingsConnection {
  readonly api: {
    readonly sessions: { models(input: { readonly sessionId: string }): Promise<CatalogResponse<{ readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly { readonly id: string; readonly name: string }[] }[] }>> }
  }
}

/** Compose the additive DSH-native Details occupant and Session utility. */
export function apply(ctx: ClientContext): void {
  const sessionsService = ctx.get('sessions') as ISessions | undefined
  if (sessionsService === undefined) throw new Error('swarm Team dashboard requires the official Sessions service')
  const connection = ctx.get('connection') as TeamSettingsConnection | undefined
  if (connection === undefined) throw new Error('swarm Team settings requires the official Connection service')
  const readClient = new SwarmReadClient()
  const catalog: TeamSettingsCatalog = {
    currentSessionId: () => sessionsService.list.getSnapshot().current,
    subscribe: listener => sessionsService.list.subscribe(listener),
    listSkills: async (sessionId) => {
      const response = await readClient.request({
        schemaVersion: 1,
        method: 'skillCatalog',
        target: { rootSessionId: sessionId },
      })
      if (!response.ok) throw new Error(response.error.message)
      const value = response.value as SwarmReadSkillCatalogV1
      if (!value.complete) throw new Error('DSH Skill catalog changed during discovery; refresh and try again')
      return value.skills
    },
    listModelRoutes: async (): Promise<readonly TeamModelRoute[]> => {
      const sessionId = sessionsService.list.getSnapshot().current
      if (sessionId === undefined) return []
      const response = await connection.api.sessions.models({ sessionId })
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.groups.flatMap(group => group.models.map(model => ({
        provider: group.id, providerName: group.name, model: model.id, modelName: model.name,
      })))
    },
  }
  const controller = new TeamDashboardController(readClient)
  const anchorRef = { current: null as HTMLSpanElement | null }
  const coordinator = new TeamDashboardSurfaceCoordinator({ slots: ctx.slots, sessions: sessionsService, locale: ctx.locale, controller, anchorRef })
  ctx.effect(() => coordinator.mount(), 'swarm Team dashboard surface coordinator')
  ctx.on('connection/reset', () => { controller.connectionReset() })
  ctx.effect(() => ctx.locale.register(TEAM_DASHBOARD_NS, { zh, en }), 'swarm Team dashboard dictionaries')
  ctx.effect(() => ctx.locale.register(TEAM_SKILL_SETTINGS_NS, { zh: teamSkillSettingsZh, en: teamSkillSettingsEn }), 'swarm Team Skills settings dictionaries')
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
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TEAM_SKILL_SETTINGS_NS,
    locale: TEAM_SKILL_SETTINGS_NS,
    inject: (): TeamSkillSettingsFace => ({ scope: ctx.settingsScope.bind({ namespace: TEAM_SKILL_SETTINGS_NS }), catalog }),
  }, TeamSkillSettingsCard))
}
