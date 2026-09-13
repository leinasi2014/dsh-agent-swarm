// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentType } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { render, t } from './helpers/dashboard-ui.js'
import { teamState, chatState } from './helpers/public-chat-fixtures.js'
import { apply } from '../src/client/team-dashboard-plugin.js'
import { TeamDashboardController, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { PublicChatController } from '../src/client/public-chat-controller.js'
import type { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'

afterEach(() => vi.restoreAllMocks())

async function entryFixture() {
  const original = teamState()
  let state: TeamDashboardState = { ...original, data: { ...original.data!, teams: { ...original.data!.teams,
    binding: { rootSessionId: 'root', mainSessionId: 'root' }, teams: original.data!.teams.teams.slice(0, 1) } } }
  state = { ...state, targetSessionId: 'root' }
  let current = 'root'
  let session = { current, byId: { root: {}, captain: {} }, phase: 'ready', subagentsByParent: {}, ids: [], jobsBySession: {}, currentAddress: undefined }
  const listeners = new Set<() => void>(), sessionListeners = new Set<() => void>()
  const entries: { name: string; id?: string; key?: string; priority?: number; inject?: () => Record<string, unknown>; component: ComponentType<Record<string, unknown>>; active: boolean }[] = []
  const disposers: (() => void)[] = []
  const effects: (() => (() => void) | void)[] = []
  const selectPanel = vi.fn()
  const sessions = { list: { getSnapshot: () => session, subscribe: (fn: () => void) => { sessionListeners.add(fn); return () => { sessionListeners.delete(fn) } } },
    open: vi.fn((id: string) => { current = id; session = { ...session, current }; sessionListeners.forEach(fn => fn()) }) }
  const ctx = {
    get: (name: string) => name === 'sessions' ? sessions : name === 'connection' ? { rpc: { call: vi.fn() } } : undefined,
    slots: {
      inject: (_name: string, callback: () => unknown) => { const result = callback(); if (result && typeof result === 'object' && Symbol.iterator in result) Array.from(result as Iterable<unknown>); else if (typeof result === 'function') disposers.push(result as () => void) },
      register: (options: Omit<typeof entries[number], 'component' | 'active'>, component: typeof entries[number]['component']) => {
        const entry = { ...options, component, active: true }; entries.push(entry); return () => { entry.active = false }
      },
    },
    remote: {}, settingsScope: { bind: () => ({}) }, layout: { selectPanel },
    sidebarRight: { openTabIn: vi.fn(), isExpanded: () => false, toggleExpanded: vi.fn() }, sidebarRightTabs: { register: () => () => {} },
    locale: { bind: () => t, register: () => () => {}, getLocale: () => ({ active: 'en' }) },
    effect: (callback: () => (() => void) | void, label: string) => { if (label.includes('surface coordinator') || label.includes('Sidebar navigation')) effects.push(callback) }, on: () => {},
  }
  apply(ctx as never)
  const panel = entries.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject!()
  const controller = panel.controller as TeamDashboardController, chat = panel.chat as PublicChatController
  vi.spyOn(controller, 'getSnapshot').mockImplementation(() => state)
  vi.spyOn(controller, 'subscribe').mockImplementation(fn => { listeners.add(fn); return () => { listeners.delete(fn) } })
  vi.spyOn(controller, 'open').mockImplementation(id => { if (state.targetSessionId !== id) state = { open: true, phase: 'loading', targetSessionId: id }; listeners.forEach(fn => fn()) })
  const selectTeam = vi.spyOn(controller, 'selectTeam').mockImplementation(() => {})
  vi.spyOn(chat, 'getSnapshot').mockImplementation(() => chatState(state))
  vi.spyOn(chat, 'latest').mockImplementation(async () => {})
  for (const effect of effects) { const off = effect(); if (off) disposers.push(off) }
  return { entries, sessions, selectPanel, selectTeam, ctx, controller, coordinator: panel.coordinator as TeamDashboardSurfaceCoordinator,
    update: async (next: TeamDashboardState) => { await act(async () => { state = next; listeners.forEach(fn => fn()) }) },
    get state() { return state },
    close: () => { for (const off of disposers.toReversed()) off() },
  }
}

it('enters group chat inside the selected Main Conversation without adding a global panel or changing Session', async () => {
  const f = await entryFixture()
  try {
    expect(f.entries.filter(entry => entry.active && entry.name === 'sidebar.panellist')).toHaveLength(0)
    const entry = f.entries.find(entry => entry.active && entry.name === 'main.conversation')
    expect(entry, 'a verified unique Team Main must use the normal Conversation body').toBeDefined()
    expect(f.entries.filter(entry => entry.active && entry.name === 'main')).toHaveLength(0)
    expect(f.selectPanel).not.toHaveBeenCalled()
    expect(f.sessions.open).not.toHaveBeenCalled()
    const injected = entry!.inject!(), hooks = injected.hooks as { team: TeamDashboardController; chat: PublicChatController; surface: { getSnapshot(): unknown; subscribe(fn: () => void): () => void } }
    const chat = chatState(f.state)
    await render(createElement(entry!.component, { ...injected, t, sessionId: 'root',
      useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(useSyncExternalStore(hooks.team.subscribe, hooks.team.getSnapshot)),
      useChat: <T,>(selector: (state: typeof chat) => T) => selector(chat),
      useSurface: <T,>(selector: (state: unknown) => T) => selector(hooks.surface.getSnapshot()),
      useSessions: <T,>(selector: (state: ReturnType<typeof f.sessions.list.getSnapshot>) => T) => selector(f.sessions.list.getSnapshot()),
    }))
    expect(document.querySelector('[data-public-message]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-group-navigation]')).toBeNull()
    const members = document.querySelector<HTMLButtonElement>('[data-swarm-team-toggle]')!
    expect(members.textContent).toContain('2')
    await act(async () => { members.click() })
    expect(f.ctx.sidebarRight.toggleExpanded).toHaveBeenCalledOnce()
    expect(f.ctx.sidebarRight.openTabIn).toHaveBeenCalledWith('root', 'swarm-team')
    expect(document.querySelectorAll('[data-swarm-team-dashboard]')).toHaveLength(0) // The official rightbar owns its body.
  } finally { f.close() }
})

it('enters after successful Team creation, while pending or failed creation keeps the ordinary Main', async () => {
  const f = await entryFixture(), ready = f.state
  const active = () => f.entries.filter(entry => entry.active && entry.name === 'main.conversation')
  try {
    await f.update({ open: true, phase: 'error', targetSessionId: 'root', error: { code: 'SWARM_UI_NO_VISIBLE_TEAM', message: 'No Team' } })
    expect(active()).toHaveLength(0)
    await f.update({ ...ready, data: { ...ready.data!, teams: { ...ready.data!.teams, teams: [{ ...ready.data!.teams.teams[0]!, phase: 'staged', captainSessionId: '' }] } } })
    expect(active()).toHaveLength(0)
    await f.update(ready)
    expect(active()).toHaveLength(1)
    expect(f.selectPanel).not.toHaveBeenCalled(); expect(f.sessions.open).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('keeps explicit Main personal navigation through refresh and returns only to its selected group', async () => {
  const f = await entryFixture(), ready = f.state
  const active = () => f.entries.filter(entry => entry.active && entry.name === 'main.conversation')
  vi.spyOn(f.controller, 'openMainChat').mockImplementation(async open => { await open('root', new AbortController().signal) })
  try {
    await f.coordinator.openMainChat()
    expect(active()).toHaveLength(0)
    await f.update(ready)
    expect(active()).toHaveLength(0) // Polling cannot override a deliberate personal conversation.
    await f.coordinator.openGroupChat()
    expect(active()).toHaveLength(1)
    expect(f.selectTeam).toHaveBeenLastCalledWith(ready.data!.projection.binding.teamId, 'root')
    f.sessions.open('captain')
    await f.update({ ...ready, targetSessionId: 'captain', data: { ...ready.data!, teams: { ...ready.data!.teams, binding: { rootSessionId: 'captain', mainSessionId: 'root' } } } })
    expect(active()).toHaveLength(0)
    await f.coordinator.openGroupChat()
    expect(f.sessions.open).toHaveBeenLastCalledWith('root')
    expect(f.state.phase).toBe('loading')
    expect(active(), 'return keeps the group loading face while the fresh Main binding is pending').toHaveLength(1)
    expect(f.selectTeam).toHaveBeenLastCalledWith(ready.data!.projection.binding.teamId, 'root')
    await f.update(ready)
    expect(active()).toHaveLength(1)
  } finally { f.close() }
})

it('does not let an obsolete return-to-group completion select a different Main', async () => {
  const f = await entryFixture(), ready = f.state
  try {
    f.sessions.open('captain')
    await f.update({ ...ready, targetSessionId: 'captain', data: { ...ready.data!, teams: { ...ready.data!.teams, binding: { rootSessionId: 'captain', mainSessionId: 'root' } } } })
    vi.spyOn(f.controller, 'openMainChat').mockImplementation(async open => { await open('root', new AbortController().signal); f.sessions.open('other') })
    await expect(f.coordinator.openGroupChat()).rejects.toThrow('superseded')
    expect(f.selectTeam).not.toHaveBeenCalled()
    expect(f.entries.filter(entry => entry.active && entry.name === 'main.conversation')).toHaveLength(0)
  } finally { f.close() }
})

it('keeps the explicit multi-Team chooser in the group seat while its chosen binding is pending or failed', async () => {
  const f = await entryFixture()
  const choices = { ...f.state.data!.teams, teams: teamState().data!.teams.teams }
  try {
    await f.update({ open: true, phase: 'ready', targetSessionId: 'root', choices })
    const current = f.entries.find(entry => entry.active && entry.name === 'main.conversation')
    expect(current).toBeDefined()
    await f.update({ open: true, phase: 'loading', targetSessionId: 'root', pendingTeamId: 'b', choices })
    expect(current!.active).toBe(true)
    await f.update({ open: true, phase: 'error', targetSessionId: 'root', pendingTeamId: 'b', choices, error: { code: 'SWARM_UI_UNAVAILABLE', message: 'retry' } })
    expect(current!.active).toBe(true)
    expect(f.sessions.open).not.toHaveBeenCalled(); expect(f.selectPanel).not.toHaveBeenCalled()
  } finally { f.close() }
})
