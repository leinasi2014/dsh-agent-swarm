import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SwarmReadClient } from './read-client.js'
import type { SwarmReadSkillCatalogV1, SwarmReadToolCatalogV1 } from '../rpc/read-rpc-contract.js'
import { TeamDashboardController } from './team-dashboard-controller.js'
import { en, TEAM_DASHBOARD_NS, zh, type TeamDashboardKey } from './team-dashboard-locales.js'
import { TeamDashboardSurfaceCoordinator, TEAM_TAB_ID, TEAM_TAB_KIND } from './team-dashboard-surface-coordinator.js'
import { TeamDashboardDetails } from './TeamDashboardDetails.js'
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

export const inject = ['sessions', 'slots', 'locale', 'settingsScope', 'remote', 'remote.session', 'sidebarRight', 'sidebarRightTabs']

/** Compose an additive official Sidebar tab and Session utility. */
export function apply(ctx: ClientContext): void {
  const sessionsService = ctx.get('sessions') as ISessions | undefined
  if (sessionsService === undefined) throw new Error('swarm Team dashboard requires the official Sessions service')
  const readClient = new SwarmReadClient()
  const catalog: TeamSettingsCatalog = {
    currentSessionId: () => sessionsService.list.getSnapshot().current,
    subscribe: listener => sessionsService.list.subscribe(listener),
    listTools: async sessionId => {
      const response = await readClient.request({ schemaVersion: 1, method: 'toolCatalog', target: { rootSessionId: sessionId } })
      if (!response.ok) throw new Error(response.error.message)
      const value = response.value as SwarmReadToolCatalogV1
      if (value.binding.rootSessionId !== sessionId || !value.complete) throw new Error('DSH tool catalog Session binding changed')
      return value.tools
    },
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
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) throw new Error(response.error.message)
      return response.value.groups.flatMap(group => group.models.map(model => ({
        provider: group.id, providerName: group.name, model: model.id, modelName: model.name,
      })))
    },
  }
  const controller = new TeamDashboardController(readClient)
  const anchorRef = { current: null as HTMLSpanElement | null }
  const coordinator = new TeamDashboardSurfaceCoordinator({ sessions: sessionsService, locale: ctx.locale, controller, anchorRef })
  ctx.effect(() => coordinator.mount(), 'swarm Team dashboard surface coordinator')
  ctx.on('connection/reset', () => { controller.connectionReset() })
  ctx.effect(() => ctx.locale.register(TEAM_DASHBOARD_NS, { zh, en }), 'swarm Team dashboard dictionaries')
  ctx.effect(() => ctx.locale.register(TEAM_SKILL_SETTINGS_NS, { zh: teamSkillSettingsZh, en: teamSkillSettingsEn }), 'swarm Team Skills settings dictionaries')
  ctx.effect(() => coordinator.bindSidebar(ctx.sidebarRight), 'swarm Team Sidebar navigation')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TEAM_TAB_ID, kind: TEAM_TAB_KIND,
    title: () => ctx.locale.bind(TEAM_DASHBOARD_NS)('title'),
    guide: [{ order: 30, title: () => ctx.locale.bind(TEAM_DASHBOARD_NS)('title'),
      description: () => ctx.locale.bind(TEAM_DASHBOARD_NS)('description') }],
  }), 'swarm Team Sidebar tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TEAM_TAB_ID, locale: TEAM_DASHBOARD_NS,
    inject: () => ({ anchorRef, controller, coordinator, localeTag: coordinator.localeTag }),
  }, TeamDashboardDetails))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TEAM_SKILL_SETTINGS_NS,
    locale: TEAM_SKILL_SETTINGS_NS,
    inject: (): TeamSkillSettingsFace => ({ scope: ctx.settingsScope.bind({ namespace: TEAM_SKILL_SETTINGS_NS }), catalog }),
  }, TeamSkillSettingsCard))
}
