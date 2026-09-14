// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentType } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { render, t } from './helpers/dashboard-ui.js'
import { chatState, teamState } from './helpers/public-chat-fixtures.js'
import { apply } from '../src/client/team-dashboard-plugin.js'
import type { TeamDashboardController, TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { PublicChatController, PublicChatState } from '../src/client/public-chat-controller.js'
import { DirectoryMembers } from '../src/client/DirectoryMembers.js'
import { directoryEntry, directoryPage } from './helpers/public-directory.js'
import type { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'

afterEach(() => { vi.restoreAllMocks() })

/** Mount the actual Main Conversation group face; the official rightbar owns Team details. */
async function mountGroup(mode: 'inactive' | 'docked' = 'inactive') {
  const initial = teamState()
  let dashboard: TeamDashboardState = { ...initial, data: { ...initial.data!, teams: { ...initial.data!.teams,
    binding: { rootSessionId: initial.targetSessionId!, mainSessionId: initial.targetSessionId! } } } }
  let conversation = chatState(dashboard)
  let session = { current: dashboard.targetSessionId, ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
  const teamListeners = new Set<() => void>(), chatListeners = new Set<() => void>(), sessionListeners = new Set<() => void>()
  const entries: { name: string; inject?: () => Record<string, unknown>; component: ComponentType<Record<string, unknown>> }[] = []
  const selectPanel = vi.fn(), open = vi.fn(), deferred: (() => unknown)[] = []
  const sessions = { list: { getSnapshot: () => session, subscribe: (fn: () => void) => { sessionListeners.add(fn); return () => { sessionListeners.delete(fn) } } }, open }
  const ctx = {
    get: (name: string) => name === 'sessions' ? sessions : name === 'connection' ? { rpc: { call: vi.fn() } } : undefined,
    slots: {
      inject: (_name: string, callback: () => unknown) => { if (_name === 'main.conversation') { deferred.push(callback); return } const result = callback(); if (result && typeof result === 'object' && Symbol.iterator in result) Array.from(result as Iterable<unknown>) },
      register: (options: Omit<typeof entries[number], 'component'>, component: typeof entries[number]['component']) => { entries.push({ ...options, component }); return () => {} },
    },
    remote: {}, settingsScope: { bind: () => ({}) }, layout: { selectPanel },
    locale: { bind: () => t, register: vi.fn(), getLocale: () => ({ active: 'en' }) },
    effect: () => {}, on: () => {},
  }
  apply(ctx as never)
  const panel = entries.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject!()
  const hooks = { team: panel.controller as TeamDashboardController, chat: panel.chat as PublicChatController, surface: panel.coordinator as TeamDashboardSurfaceCoordinator }
  vi.spyOn(hooks.team, 'getSnapshot').mockImplementation(() => dashboard)
  vi.spyOn(hooks.team, 'subscribe').mockImplementation(fn => { teamListeners.add(fn); return () => { teamListeners.delete(fn) } })
  vi.spyOn(hooks.chat, 'getSnapshot').mockImplementation(() => conversation)
  vi.spyOn(hooks.chat, 'subscribe').mockImplementation(fn => { chatListeners.add(fn); return () => { chatListeners.delete(fn) } })
  vi.spyOn(hooks.chat, 'latest').mockImplementation(async () => {})
  const selectTeam = vi.spyOn(hooks.team, 'selectTeam').mockImplementation(() => {})
  const toggle = vi.spyOn(hooks.surface, 'toggle').mockImplementation(() => {})
  const observeTab = vi.spyOn(hooks.surface, 'observeTab')
  const closeSidebar = vi.spyOn(hooks.surface, 'closeAndRestoreFocus')
  const openMember = vi.spyOn(hooks.surface, 'openMemberChat').mockImplementation(async () => {})
  vi.spyOn(hooks.surface, 'getSnapshot').mockReturnValue({ mode, view: 'overview', targetSessionId: dashboard.targetSessionId })
  const showMembers = vi.spyOn(hooks.surface, 'showMembers').mockImplementation(() => {})
  vi.spyOn(hooks.surface, 'groupConversation').mockReturnValue(true)
  deferred.forEach(fn => fn())
  const main = entries.find(entry => entry.name === 'main.conversation')!, injected = main.inject!()
  const props = { ...injected, t,
    useTeam: <T,>(selector: (value: TeamDashboardState) => T) => selector(useSyncExternalStore(hooks.team.subscribe, hooks.team.getSnapshot)),
    useChat: <T,>(selector: (value: PublicChatState) => T) => selector(useSyncExternalStore(hooks.chat.subscribe, hooks.chat.getSnapshot)),
    useSurface: <T,>(selector: (value: ReturnType<typeof hooks.surface.getSnapshot>) => T) => selector(useSyncExternalStore(hooks.surface.subscribe, hooks.surface.getSnapshot)),
    useSessions: <T,>(selector: (value: typeof session) => T) => selector(useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)),
  }
  await render(createElement(main.component, props))
  return { hooks, showMembers, toggle, observeTab, closeSidebar, selectPanel, open, selectTeam, openMember,
    get state() { return dashboard }, get chat() { return conversation },
    update: async (state: TeamDashboardState, chat = conversation, current = session.current) => { await act(async () => {
      dashboard = state; conversation = chat; session = { ...session, current }
      teamListeners.forEach(fn => fn()); chatListeners.forEach(fn => fn()); sessionListeners.forEach(fn => fn())
    }) },
  }
}

const toggleButton = () => document.querySelector<HTMLButtonElement>('[data-swarm-team-toggle]')!

it.each(['inactive', 'docked'] as const)('opens the official member sidebar while preserving the group DOM (remembered %s)', async mode => {
  const f = await mountGroup(mode)
  const messages = document.querySelector<HTMLElement>('.swarm-public__messages')!
  const input = document.querySelector<HTMLTextAreaElement>('.swarm-public__composer textarea')!
  Object.defineProperties(messages, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } })
  await act(async () => { messages.scrollTop = 41; messages.dispatchEvent(new Event('scroll')) })
  input.setSelectionRange(2, 4)
  await act(async () => { toggleButton().click() })
  expect(f.showMembers).toHaveBeenCalledOnce()
  await f.update({ ...f.state })
  await act(async () => { toggleButton().click() })
  expect(f.showMembers).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-swarm-team-dashboard]')).toBeNull()
  expect(document.querySelector('[data-swarm-group-navigation]')).toBeNull()
  expect(document.querySelector('.swarm-public__messages')).toBe(messages)
  expect(document.querySelector('.swarm-public__composer textarea')).toBe(input)
  expect(messages.scrollTop).toBe(41); expect(input.value).toBe('send me')
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4])
  expect(f.selectPanel).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  expect(f.toggle).not.toHaveBeenCalled(); expect(f.observeTab).not.toHaveBeenCalled()
})

it('removes A messages during a pending B selection and renders only the fresh B binding', async () => {
  const f = await mountGroup(), a = f.state
  await f.update({ ...a, phase: 'reconnecting', pendingTeamId: 'b' })
  expect(document.querySelector('[data-public-message]')).toBeNull()
  expect(toggleButton().disabled).toBe(true)
  const data = a.data!, binding = { ...data.projection.binding, teamId: 'b', rootSessionId: 'captain-b' }
  const b: TeamDashboardState = { ...a, data: { ...data, projection: { ...data.projection, binding }, captainMembers: { ...data.captainMembers, binding, members: [] } } }
  await f.update(b, chatState(b))
  expect(document.querySelector('[data-swarm-public-chat]')?.getAttribute('data-team-id')).toBe('b')
  expect(document.querySelector('.swarm-public__header h1')?.textContent).toBe('Team B')
  expect(toggleButton().disabled).toBe(false)
})

it.each(['team', 'captain', 'viewer'] as const)('rejects mismatched %s identity for group content and member navigation', async mismatch => {
  const f = await mountGroup(), state = f.state
  const selection = { ...f.chat.selection!, ...(mismatch === 'team' ? { team: 'wrong-team' } : mismatch === 'captain' ? { captain: 'wrong-captain' } : {}) }
  await f.update(state, { ...f.chat, selection }, mismatch === 'viewer' ? 'other-session' : state.targetSessionId)
  await act(async () => { toggleButton().click() })
  expect(document.querySelector('[data-public-message]')).toBeNull()
  expect(f.showMembers).not.toHaveBeenCalled()
})

it.each(['teamId', 'rootSessionId'] as const)('keeps one card button per member and disables the profile contact entry when roster %s mismatches', async field => {
  const state = teamState(), binding = state.data!.projection.binding, captain = binding.rootSessionId
  let value = { ...chatState(state), directory: { ...directoryPage(binding.teamId, [{ ...directoryEntry(captain, 'Captain'), role: 'captain' as const }, directoryEntry('member-1', 'Lin')]), binding, totalCount: 2 } }
  const chat = { getSnapshot: () => value, subscribe: () => () => {}, refreshDirectory: vi.fn(async () => {}) }
  const navigation = { refreshDirectory: vi.fn(), selectGroup: vi.fn(), openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember: vi.fn(async () => {}) }
  const bad = { ...state, data: { ...state.data!, captainMembers: { ...state.data!.captainMembers, binding: { ...binding, [field]: 'wrong' } } } }
  await render(<DirectoryMembers chat={chat as unknown as PublicChatController} dashboard={bad} navigation={navigation} t={t as never} />)
  expect(document.querySelectorAll('[data-swarm-member-chat]')).toHaveLength(0)
  expect(document.querySelectorAll('[data-directory-member="member-1"]')).toHaveLength(1)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-directory-member="member-1"]')!.click() })
  const contact = document.querySelector<HTMLButtonElement>('[data-directory-card="member-1"] [data-directory-contact]')
  expect(contact).not.toBeNull()
  expect(contact!.disabled).toBe(true)
  expect(contact!.getAttribute('title')).toBe(t('detail.contactDisabled'))
  expect(navigation.openMember).not.toHaveBeenCalled()
})

it('opens the profile on a single card click and messages each fresh roster name in its precise official Session from the profile header', async () => {
  const state = teamState(), binding = state.data!.projection.binding, captain = binding.rootSessionId
  const value = { ...chatState(state), directory: { ...directoryPage(binding.teamId, [{ ...directoryEntry(captain, 'Captain'), role: 'captain' as const }, directoryEntry('member-1', 'Lin')]), binding, totalCount: 2 } }
  const chat = { getSnapshot: () => value, subscribe: () => () => {}, refreshDirectory: vi.fn(async () => {}) }
  const navigation = { refreshDirectory: vi.fn(), selectGroup: vi.fn(), openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember: vi.fn(async () => {}) }
  await render(<DirectoryMembers chat={chat as unknown as PublicChatController} dashboard={state} navigation={navigation} t={t as never} />)
  expect(document.querySelectorAll('[data-swarm-member-chat]')).toHaveLength(0)
  expect(document.querySelectorAll('[data-directory-member="member-1"]')).toHaveLength(1)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-directory-member="member-1"]')!.click() })
  expect(navigation.openMember).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const memberContact = document.querySelector<HTMLButtonElement>('[data-directory-card="member-1"] [data-directory-contact]')
  expect(memberContact).not.toBeNull()
  expect(memberContact!.disabled).toBe(false)
  await act(async () => { memberContact!.click() })
  expect(navigation.openMember).toHaveBeenCalledExactlyOnceWith('writer', 'member-1')
  await act(async () => {})
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { document.querySelector<HTMLButtonElement>(`[data-directory-member="${captain}"]`)!.click() })
  const captainContact = document.querySelector<HTMLButtonElement>(`[data-directory-card="${captain}"] [data-directory-contact]`)!
  expect(captainContact.disabled).toBe(false)
  await act(async () => { captainContact!.click() })
  expect(navigation.openCaptain).toHaveBeenCalledOnce()
  expect(navigation.openMember).toHaveBeenCalledOnce()
  await act(async () => {})
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('disables the profile contact entry with the shared reason when the roster member is no longer active', async () => {
  const state = teamState(), binding = state.data!.projection.binding
  const value = { ...chatState(state), directory: { ...directoryPage(binding.teamId, [directoryEntry('member-1', 'Lin')]), binding, totalCount: 1 } }
  const chat = { getSnapshot: () => value, subscribe: () => () => {}, refreshDirectory: vi.fn(async () => {}) }
  const navigation = { refreshDirectory: vi.fn(), selectGroup: vi.fn(), openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember: vi.fn(async () => {}) }
  const stale = { ...state, data: { ...state.data!, captainMembers: { ...state.data!.captainMembers, members: state.data!.captainMembers.members.map(row => ({ ...row, phase: 'failed' as const })) } } }
  await render(<DirectoryMembers chat={chat as unknown as PublicChatController} dashboard={stale} navigation={navigation} t={t as never} />)
  expect(document.querySelectorAll('[data-swarm-member-chat]')).toHaveLength(0)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-directory-member="member-1"]')!.click() })
  const contact = document.querySelector<HTMLButtonElement>('[data-directory-card="member-1"] [data-directory-contact]')
  expect(contact).not.toBeNull()
  expect(contact!.disabled).toBe(true)
  expect(contact!.getAttribute('title')).toBe(t('detail.contactDisabled'))
  await act(async () => { contact!.click() })
  expect(navigation.openMember).not.toHaveBeenCalled()
})

it.each(['session-first', 'dashboard-first'] as const)('hides the old viewer conversation during %s handoff', async order => {
  const f = await mountGroup(), state = f.state
  await f.update(order === 'session-first' ? state : { ...state, targetSessionId: 'new-viewer' }, f.chat, 'new-viewer')
  expect(document.querySelector('[data-public-message]')).toBeNull()
  expect(document.querySelector('[data-public-send]')).toBeNull()
  expect(f.showMembers).not.toHaveBeenCalled()
})
