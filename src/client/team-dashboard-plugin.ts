import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SwarmReadClient } from './read-client.js'
import type { SwarmReadSkillCatalogV1, SwarmReadToolCatalogV1 } from '../rpc/read-rpc-contract.js'
import { TeamDashboardController } from './team-dashboard-controller.js'
import { en, TEAM_DASHBOARD_NS, zh, type TeamDashboardKey } from './team-dashboard-locales.js'
import { TeamDashboardSurfaceCoordinator, TEAM_TAB_ID, TEAM_TAB_KIND } from './team-dashboard-surface-coordinator.js'
import { TeamDashboardDetails } from './TeamDashboardDetails.js'
import { TeamLineageDisplay } from './TeamLineageDisplay.js'
import { PublicChatClient } from './public-rpc-client.js'
import { PublicChatController } from './public-chat-controller.js'
import { TeamPublicChat } from './TeamPublicChat.js'
import { TeamGroupNavigation } from './TeamGroupNavigation.js'
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

export const inject = ['sessions', 'slots', 'locale', 'settingsScope', 'remote', 'remote.session', 'remote.subagents', 'sidebarRight', 'sidebarRightTabs', 'layout', 'connection']

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
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('swarm public conversation requires the official Client Connection')
  const chat = new PublicChatController(new PublicChatClient(connection.rpc), globalThis.location?.origin ?? 'local', {
    getItem: key => globalThis.sessionStorage.getItem(key), setItem: (key, value) => { globalThis.sessionStorage.setItem(key, value) },
  })
  // Slot injection can run again during Host refreshes; mounted images keep one reader.
  const readPublicImage = (messageId: string, imageId: string, signal: AbortSignal): Promise<Blob> => chat.image(messageId, imageId, signal)
  const groupPanel = 'swarm.group' as MainPanelId
  const anchorRef = { current: null as HTMLSpanElement | null }
  const coordinator = new TeamDashboardSurfaceCoordinator({ sessions: sessionsService, locale: ctx.locale, controller, anchorRef,
    sendCaptainPrompt: async (request, signal) => {
      const content = [{ type: 'text' as const, text: request.text }]
      const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const result = request.parentSessionId === undefined
        ? await ctx.remote.session.prompt({ requestId: crypto.randomUUID() as SessionRequestId, sessionId: request.sessionId as SessionId, mode: 'queue', content, clientTimeZone }, signal)
        : await ctx.remote.subagents.prompt({ requestId: crypto.randomUUID() as SubagentPromptRequestId, parentSessionId: request.parentSessionId as SessionId, childSessionId: request.sessionId as SessionId, mode: 'continuable', delivery: 'queue', content, clientTimeZone }, signal)
      if (!result.ok) throw new Error(result.error.message)
    },
  })
  ctx.effect(() => coordinator.mount(), 'swarm Team dashboard surface coordinator')
  ctx.effect(() => chat.connect(controller), 'swarm public conversation state')
  ctx.on('connection/reset', () => { controller.connectionReset() })
  ctx.effect(() => ctx.locale.register(TEAM_DASHBOARD_NS, { zh, en }), 'swarm Team dashboard dictionaries')
  ctx.effect(() => ctx.locale.register(TEAM_SKILL_SETTINGS_NS, { zh: teamSkillSettingsZh, en: teamSkillSettingsEn }), 'swarm Team Skills settings dictionaries')
  ctx.effect(() => coordinator.bindSidebar(ctx.sidebarRight), 'swarm Team Sidebar navigation')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TEAM_TAB_ID, kind: TEAM_TAB_KIND,
    title: () => ctx.locale.bind(TEAM_DASHBOARD_NS)('title'),
    guide: [{ order: 30, title: () => ctx.locale.bind(TEAM_DASHBOARD_NS)('title') }],
  }), 'swarm Team Sidebar tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TEAM_TAB_ID, locale: TEAM_DASHBOARD_NS,
    inject: () => ({ anchorRef, controller, coordinator, chat, localeTag: coordinator.localeTag }),
  }, TeamDashboardDetails))
  ctx.slots.inject('conversation.session.header.lineage.display', () => ctx.slots.register({
    name: 'conversation.session.header.lineage.display',
    inject: () => ({ hooks: { team: controller } }),
  }, TeamLineageDisplay))
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: groupPanel, locale: TEAM_DASHBOARD_NS,
      inject: () => ({ hooks: { chat, team: controller, surface: coordinator },
        edit: (text: string) => { chat.edit(text) }, reply: (id: string | undefined) => { chat.reply(id) },
        replaceText: (start: number, end: number, text: string) => { chat.replaceText(start, end, text) },
        chooseMention: (start: number, end: number, memberId: string) => { chat.chooseMention(start, end, memberId) },
        removeMention: (start: number, reselect?: boolean) => { chat.removeMention(start, reselect) },
        refreshDirectory: () => { void chat.refreshDirectory() }, upgradeLegacy: () => { void chat.upgradeLegacy() },
        addImages: (files: readonly File[]) => { chat.addImages(files) }, removeImage: (id: string) => { chat.removeImage(id) },
        image: readPublicImage,
        retryDraftStorage: () => { void chat.retryDraftStorage() }, useStoredDraft: () => { void chat.useStoredDraft() },
        send: () => { void chat.send() }, recover: () => { void chat.recover() },
        earlier: () => { void chat.earlier() }, newer: () => { void chat.newer() }, refresh: () => { void chat.refresh() },
        openTeam: () => { const current = sessionsService.list.getSnapshot().current; if (current !== undefined) coordinator.toggle(current) },
      }),
    }, TeamPublicChat)
    yield ctx.layout.registerPanelPresentation(groupPanel, {
      rightSidebar: 'current-session',
      columns: { sidebar: { defaultWidth: 166, minWidth: 166 }, rightbar: { defaultWidth: 320 } },
    })
  })
  ctx.slots.inject('sidebar.navigation.section', () => ctx.slots.register({
    name: 'sidebar.navigation.section', id: 'swarm.groups', locale: TEAM_DASHBOARD_NS,
    inject: () => ({ hooks: { team: controller, chat }, refreshDirectory: () => { void chat.refreshDirectory() },
      selectGroup: (teamId: string) => { controller.selectTeam(teamId); ctx.layout.selectPanel(groupPanel) },
      openMain: async () => { await coordinator.openMainChat(); ctx.layout.selectPanel(null) },
      openCaptain: async () => { await coordinator.openCaptainChat(); ctx.layout.selectPanel(null) },
      openMember: async (name: string, sessionId: string) => { await coordinator.openMemberChat(name, sessionId); ctx.layout.selectPanel(null) },
    }),
  }, TeamGroupNavigation))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TEAM_SKILL_SETTINGS_NS,
    locale: TEAM_SKILL_SETTINGS_NS,
    inject: (): TeamSkillSettingsFace => ({ scope: ctx.settingsScope.bind({ namespace: TEAM_SKILL_SETTINGS_NS }), catalog }),
  }, TeamSkillSettingsCard))
}
