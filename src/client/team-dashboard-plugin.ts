import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RefObject } from 'react'
import { SwarmReadClient } from './read-client.js'
import { TeamDashboardController } from './team-dashboard-controller.js'
import { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TeamDashboardAction, type TeamDashboardActionInjected } from './TeamDashboardAction.js'
import { en, TEAM_DASHBOARD_NS, zh, type TeamDashboardKey } from './team-dashboard-locales.js'
import { AgentSwarmSettingsCard } from './AgentSwarmSettingsCard.js'
import {
  AGENT_SWARM_CLIENT_SETTINGS_NAMESPACE,
  AgentSwarmSettingsController,
} from './agent-swarm-settings-controller.js'
import {
  agentSwarmSettingsEn,
  agentSwarmSettingsZh,
} from './agent-swarm-settings-locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'swarm.team-dashboard': TeamDashboardKey
  }
}

export const inject = ['sessions', 'slots', 'locale', 'settingsScope']

/** Compose the additive DSH-native R3 read UI. */
export function apply(ctx: ClientContext): void {
  const sessionsService = ctx.get('sessions') as ISessions | undefined
  if (sessionsService === undefined) throw new Error('swarm Team dashboard requires the official Sessions service')
  const controller = new TeamDashboardController(new SwarmReadClient())
  const settings = new AgentSwarmSettingsController(ctx.settingsScope.bind({
    namespace: AGENT_SWARM_CLIENT_SETTINGS_NAMESPACE,
  }))
  const anchorRef: RefObject<HTMLSpanElement> = { current: null }
  const coordinator = new TeamDashboardSurfaceCoordinator({
    slots: ctx.slots,
    sessions: sessionsService,
    locale: ctx.locale,
    controller,
    anchorRef,
  })
  ctx.effect(() => coordinator.mount(), 'swarm Team dashboard surface coordinator')
  ctx.inject(['layout'], (layoutCtx) => {
    const layout = layoutCtx.get('layout') as ILayout | undefined
    if (layout === undefined) return
    layoutCtx.effect(() => coordinator.bindLayout(layout), 'swarm Team dashboard current Layout lease')
  })
  ctx.on('connection/reset', () => { controller.connectionReset() })
  ctx.effect(() => ctx.locale.register(TEAM_DASHBOARD_NS, { zh, en }), 'swarm Team dashboard dictionaries')
  ctx.effect(() => ctx.locale.register('swarm.settings', {
    zh: agentSwarmSettingsZh,
    en: agentSwarmSettingsEn,
  }), 'swarm settings dictionaries')
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
    key: AGENT_SWARM_CLIENT_SETTINGS_NAMESPACE,
    locale: 'swarm.settings',
    inject: () => settings.inject(),
  }, AgentSwarmSettingsCard))
}
