// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { sidebarHarness } from './helpers/sidebar-harness.js'
import { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

function fixture() {
  const controller: { state: TeamDashboardState; listeners: Set<() => void>; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; openCaptainChat: ReturnType<typeof vi.fn>; getSnapshot(): TeamDashboardState; subscribe(listener: () => void): () => void } = { state: { open: false, phase: 'closed' }, listeners: new Set(), open: vi.fn(function (this: typeof controller, id: string) { this.state = { open: true, phase: 'loading', targetSessionId: id }; this.listeners.forEach(listener => listener()) }), close: vi.fn(function (this: typeof controller) { this.state = { open: false, phase: 'closed' }; this.listeners.forEach(listener => listener()) }), refresh: vi.fn(), dispose: vi.fn(), openCaptainChat: vi.fn(), getSnapshot() { return this.state }, subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  let current = 'root'; const sessionListeners = new Set<() => void>()
  const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current, byId: { root: {}, other: {} } }), subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } } }, setCurrent: (next: string) => { sidebar.hide(current); current = next; sessionListeners.forEach(listener => listener()); sidebar.show(current) } }
  const anchor = document.createElement('span'); document.body.append(anchor)
  const coordinator = new TeamDashboardSurfaceCoordinator({ sessions, locale: { getLocale: () => ({ active: 'en' }) }, controller, anchorRef: { current: anchor } } as never)
  const sidebar = sidebarHarness(coordinator, () => current)
  const unmount = coordinator.mount(); const releaseSidebar = coordinator.bindSidebar(sidebar.sidebar)
  const setReady = (teamId = 'team-1', targetSessionId = current) => {
    controller.state = { open: true, phase: 'ready', targetSessionId, data: {
      teams: { binding: { rootSessionId: targetSessionId, mainSessionId: 'root' }, teams: [] },
      projection: { binding: { rootSessionId: 'captain', teamId } }, captainMembers: { members: [] },
    } } as unknown as TeamDashboardState
    controller.listeners.forEach(listener => listener())
  }
  return { sidebar, controller, sessions, coordinator, setReady, releaseSidebar, unmount,
    destroy: () => { releaseSidebar(); unmount(); sidebar.dispose(); anchor.remove() } }
}

describe('TeamDashboardSurfaceCoordinator', () => {
  it('retains the Details lease across sibling Captains and returns only to a verified official main Chat (#225)', async () => {
    const f = fixture()
    f.coordinator.toggle('root')
    f.controller.state = { open: true, phase: 'ready', targetSessionId: 'root', data: {
      teams: { binding: { rootSessionId: 'root', mainSessionId: 'root' }, teams: [{ teamId: 'a', captainSessionId: 'captain-a' }, { teamId: 'b', captainSessionId: 'captain-b' }] },
      projection: { binding: { rootSessionId: 'captain-a', teamId: 'a' } }, captainMembers: { members: [] },
    } } as unknown as TeamDashboardState
    const original = f.sidebar.records.get('root')
    f.sessions.setCurrent('captain-b')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.setReady('team-b', 'captain-b')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'captain-b' })
    expect(f.sidebar.records.get('root')).toBe(original)
    const signal = new AbortController().signal
    Object.assign(f.controller, { openMainChat: async (open: (id: string, signal: AbortSignal) => void) => { open('root', signal) } })
    await f.coordinator.openMainChat()
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('root')
    const snapshot = f.sessions.list.getSnapshot
    Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), byId: { root: { origin: 'subagent', parentId: 'foreign' } } }) })
    await expect(f.coordinator.openMainChat()).rejects.toThrow('official root Session list')
    expect(f.sessions.open).toHaveBeenCalledOnce()
    Object.assign(f.sessions.list, { getSnapshot: snapshot })
    Object.assign(f.controller, { openMainChat: async (open: (id: string, signal: AbortSignal) => void) => { f.sessions.setCurrent('other'); open('root', signal) } })
    await expect(f.coordinator.openMainChat()).rejects.toThrow('superseded')
    expect(f.sessions.open).toHaveBeenCalledOnce()
    f.destroy()
  })

  it('fences stale Sidebar disposers and rediscovers available Team when the public service returns (#225)', () => {
    const f = fixture()
    f.releaseSidebar()
    f.setReady()
    expect(f.sidebar.openTab).not.toHaveBeenCalled()
    const release = f.coordinator.bindSidebar(f.sidebar.sidebar)
    expect(f.sidebar.openTab).toHaveBeenCalledOnce()
    f.releaseSidebar()
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    release()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(true)
    f.destroy()
  })

  it('discovers the current Team without a toolbar click, and respects dismissal until a different Team or Session (#225)', () => {
    const f = fixture()
    expect(f.controller.open).toHaveBeenCalledWith('root')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    const ready = (teamId: string, targetSessionId = 'root') => {
      f.controller.state = { open: true, phase: 'ready', targetSessionId, data: {
        teams: { binding: { rootSessionId: targetSessionId }, teams: [] },
        projection: { binding: { rootSessionId: 'captain', teamId } }, captainMembers: { members: [] },
      } } as unknown as TeamDashboardState
      f.controller.listeners.forEach(listener => listener())
    }
    ready('team-1')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'root' })
    f.coordinator.closeAndRestoreFocus()
    ready('team-1')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    ready('team-2')
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    f.sidebar.hide()
    ready('team-2')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.sessions.setCurrent('other')
    ready('team-2') // stale response from the old Session
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    ready('team-3', 'other')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'other' })
    f.destroy()
  })

  it('opens a dedicated Captain through its verified parent catalog on first navigation', async () => {
    const f = fixture()
    f.setReady()
    const snapshot = f.sessions.list.getSnapshot
    let mode = 'continuable'
    Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), byId: { ...snapshot().byId, captain: { origin: 'subagent', parentId: 'root' } }, subagentsByParent: { root: { state: 'ready', entries: [{ kind: 'child', id: 'captain', mode }] } } }) })
    const refresh = vi.fn(async () => {})
    const open = vi.fn()
    Object.assign(f.sessions, { refreshSubagents: refresh, openSubagent: open })
    f.controller.openCaptainChat.mockImplementation(async (callback: (id: string, signal: AbortSignal) => Promise<void>) => { await callback('captain', new AbortController().signal) })
    await f.coordinator.openCaptainChat()
    expect(open).toHaveBeenCalledExactlyOnceWith({ parentSessionId: 'root', childSessionId: 'captain', mode: 'continuable' })
    expect(f.sessions.open).not.toHaveBeenCalled()
    mode = 'oneshot'
    await expect(f.coordinator.openCaptainChat()).rejects.toThrow('official parent child catalog')
    expect(open).toHaveBeenCalledTimes(1)
    mode = 'continuable'
    refresh.mockImplementation(async () => { f.sessions.setCurrent('other') })
    await expect(f.coordinator.openCaptainChat()).rejects.toThrow('superseded')
    expect(open).toHaveBeenCalledTimes(1)
    f.destroy()
  })

  it('uses the official direct-child catalog and rejects wrong parents or a superseded handoff (#221)', async () => {
    const f = fixture()
    f.coordinator.toggle('root')
    const ready: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'root', data: {
      teams: { binding: { rootSessionId: 'root' }, teams: [] },
      projection: { binding: { rootSessionId: 'captain', teamId: 'team-1' } },
      captainMembers: { members: [{ name: 'worker', sessionId: 'member-1', phase: 'active' }] },
    } } as unknown as TeamDashboardState
    f.controller.state = ready
    const abort = new AbortController()
    const handoff = vi.fn(async (_name: string, _id: string, callback: (captain: string, member: string, signal: AbortSignal) => Promise<void>) => { await callback('captain', 'member-1', abort.signal) })
    Object.assign(f.controller, { openMemberChat: handoff })
    const address = { parentSessionId: 'captain', childSessionId: 'member-1', mode: 'continuable' }
    let catalogParent = 'captain'
    let catalogState = 'ready'
    const snapshot = f.sessions.list.getSnapshot
    Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), subagentsByParent: {
      [catalogParent]: { state: catalogState, error: null, parentAvailable: true, entries: [{ kind: 'child', id: 'member-1', mode: 'continuable', activity: 'inactive', hasChildren: false, label: 'Writer' }] },
    } }) })
    const refresh = vi.fn(async () => {})
    const open = vi.fn(() => { f.sessions.setCurrent('member-1') })
    // The official catalog has no retained subagentAddress until the FIRST navigation;
    // refreshing the catalog alone does not populate that address cache.
    Object.assign(f.sessions, { refreshSubagents: refresh, subagentAddress: () => undefined, openSubagent: open })
    await f.coordinator.openMemberChat('worker', 'member-1')
    expect(refresh).toHaveBeenCalledWith('captain')
    expect(open).toHaveBeenCalledExactlyOnceWith(address)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.setReady('team-1', 'member-1')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'member-1' })
    f.controller.state = ready
    f.sessions.setCurrent('root')
    catalogParent = 'wrong-parent'
    await expect(f.coordinator.openMemberChat('worker', 'member-1')).rejects.toThrow('official Captain child catalog')
    expect(open).toHaveBeenCalledTimes(1)
    catalogParent = 'captain'
    catalogState = 'error'
    await expect(f.coordinator.openMemberChat('worker', 'member-1')).rejects.toThrow('official Captain child catalog')
    expect(open).toHaveBeenCalledTimes(1)
    catalogState = 'ready'
    refresh.mockImplementation(async () => { f.sessions.setCurrent('other') })
    await expect(f.coordinator.openMemberChat('worker', 'member-1')).rejects.toThrow('superseded')
    expect(open).toHaveBeenCalledTimes(1)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.destroy()
  })

  it('retains per-Session Team tabs through member, Captain and root navigation (#221)', () => {
    const f = fixture(); f.setReady()
    const rootTab = f.sidebar.records.get('root')!
    for (const id of ['member-1', 'captain', 'root']) {
      f.sessions.setCurrent(id); f.setReady('team-1', id)
      expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: id })
      expect(f.controller.open).toHaveBeenLastCalledWith(id)
    }
    expect(f.sidebar.records.get('root')).toBe(rootTab)
    expect(rootTab.tab.signal.aborted).toBe(false)
    f.sessions.setCurrent('other')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive'); f.destroy()
  })

  it('closes only its exact tab and leaves other Session tabs and official resources intact', () => {
    const f = fixture(); f.setReady()
    const root = f.sidebar.records.get('root')!
    f.sessions.setCurrent('other'); f.setReady()
    const other = f.sidebar.records.get('other')!
    f.coordinator.closeAndRestoreFocus()
    expect(other.tab.signal.aborted).toBe(true)
    expect(root.tab.signal.aborted).toBe(false)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive'); f.destroy()
  })

  it('does not manufacture a narrow-screen surface when another official tab hides its body', () => {
    const f = fixture(); f.setReady()
    f.sidebar.sidebar.openResource('dsh-resource://file/example')
    f.setReady()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(true)
    expect(f.sidebar.openTab).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="dialog"]')).toBeNull(); f.destroy()
  })

  it('retains a hidden tab across polling and allows the official guide to reopen a removed occurrence', () => {
    const f = fixture(); f.setReady()
    f.sidebar.hide(); f.setReady()
    expect(f.sidebar.openTab).toHaveBeenCalledOnce()
    f.sidebar.show(); f.coordinator.closeAndRestoreFocus(); f.setReady()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.sidebar.sidebar.openTab('swarm-team')
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    f.setReady(); expect(f.sidebar.openTab).toHaveBeenCalledTimes(2); f.destroy()
  })
  it('hands Captain navigation to the exact official Session only when it remains listed', async () => {
    const f = fixture(); f.setReady()
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => Promise<void>) => { await callback('root') })
    await f.coordinator.openCaptainChat()
    expect(f.sessions.open).toHaveBeenCalledWith('root')
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => Promise<void>) => { await callback('missing') })
    await expect(f.coordinator.openCaptainChat()).rejects.toThrow('official Session list')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    f.destroy()
  })
  it('releases observations and controller on plugin unload without closing the user Sidebar', () => {
    const f = fixture(); f.setReady(); f.sessions.setCurrent('other')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.setReady(); const other = f.sidebar.records.get('other')!
    f.unmount()
    expect(other.tab.signal.aborted).toBe(false)
    expect(f.controller.dispose).toHaveBeenCalledOnce(); f.destroy()
  })
  it('opens the official Session of an enumerated dedicated Captain only while it stays listed, and degrades to unavailable otherwise', async () => {
    const f = fixture(); f.setReady()
    // The enumeration row hands the exact official Captain Session id; the official Catalog is the authority.
    await f.coordinator.openTeamCaptain('other')
    expect(f.sessions.open).toHaveBeenCalledWith('other')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    // A Captain that left the official Session list can never open a fabricated chat.
    await expect(f.coordinator.openTeamCaptain('not-listed')).rejects.toThrow('official Session list')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    f.destroy()
  })
  it('keeps equal tab IDs in different Sessions independent even after a late abort', () => {
    const f = fixture(); f.setReady(); const root = f.sidebar.records.get('root')!
    f.sessions.setCurrent('other'); f.setReady(); const other = f.sidebar.records.get('other')!
    expect(root.tab.id).toBe(other.tab.id)
    f.sidebar.remove('root')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'other' })
    f.setReady(); expect(f.sidebar.openTab).toHaveBeenCalledTimes(2); f.destroy()
  })

  it('does not expand a collapsed official Sidebar on a Team refresh', () => {
    const f = fixture(); f.setReady(); f.sidebar.sidebar.toggleExpanded(); f.setReady()
    expect(f.sidebar.sidebar.isExpanded()).toBe(false)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.sidebar.openTab).toHaveBeenCalledOnce(); f.destroy()
  })

  it('binds dismissal to the first result when the official user closes a loading Team tab', () => {
    const f = fixture(); f.sidebar.sidebar.openTab('swarm-team')
    f.coordinator.closeAndRestoreFocus(); f.setReady('team-1'); f.setReady('team-1')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.sidebar.openTab).toHaveBeenCalledOnce()
    f.setReady('team-2'); expect(f.sidebar.openTab).toHaveBeenCalledTimes(2); f.destroy()
  })

})
