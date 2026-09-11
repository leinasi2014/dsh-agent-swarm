import { tabInfoFixture as sidebarTabInfo } from './helpers/sidebar-tab.js'
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installedTargetedSidebar } from './helpers/official-sidebar.js'
import { fixture } from './helpers/coordinator-fixture.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { SessionId } from '@deepseek-ai/dsh-session/types'


vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

describe('TeamDashboardSurfaceCoordinator', () => {
  it('opens the frozen retirement Main even after the child and Team disappear or a different Main is selected', () => {
    const f = fixture()
    const snapshot = f.sessions.list.getSnapshot
    Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), phase: 'ready', current: 'deleted-captain' }) })
    f.controller.state = { open: true, phase: 'loading', targetSessionId: 'other' }
    const targetRead = vi.fn(() => { throw new Error('Deleted Team must not be read') })
    Object.assign(f.controller, { openMainChat: targetRead })
    f.coordinator.openRetirementMainChat('root')
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('root')
    expect(targetRead).not.toHaveBeenCalled()
    Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), phase: 'ready', byId: { root: { origin: 'subagent', parentId: 'other' } } }) })
    expect(() => f.coordinator.openRetirementMainChat('root')).toThrow('official root Session list')
    expect(f.sessions.open).toHaveBeenCalledOnce()
    f.destroy()
  })
  it('retains task view preferences through official close/reopen, isolates root plus Team, and clears them on disposal', () => {
    const f = fixture()
    f.setReady('team-a')
    const a = { rootSessionId: 'captain', teamId: 'team-a' }
    const b = { rootSessionId: 'captain', teamId: 'team-b' }
    const otherRoot = { rootSessionId: 'different-captain', teamId: 'team-a' }
    const selected = { view: 'tasks' as const, detail: { kind: 'task' as const, id: 'reused-id' }, taskView: 'trace' as const, rounds: { 'attempt-1': true }, historyOpen: true }
    const updates = vi.fn()
    const unsubscribe = f.coordinator.subscribe(updates)
    f.coordinator.updateWorkspaceSelection(a, selected)
    expect(updates).toHaveBeenCalled()
    f.coordinator.closeAndRestoreFocus()
    f.coordinator.toggle('root')
    expect(f.coordinator.getWorkspaceSelection(a)).toEqual(selected)
    f.setReady('team-b')
    expect(f.coordinator.getWorkspaceSelection(b)).toMatchObject({ view: 'tasks', taskView: 'overview' })
    expect(f.coordinator.getWorkspaceSelection(b).detail).toBeUndefined()
    f.coordinator.updateWorkspaceSelection(a, { detail: undefined }) // stale UI cannot overwrite another Team
    expect(f.coordinator.getWorkspaceSelection(a).detail).toEqual(selected.detail)
    f.coordinator.updateWorkspaceSelection(b, { view: 'members' })
    expect(f.coordinator.getWorkspaceSelection(otherRoot).view).toBe('tasks')
    f.controller.state = { ...f.controller.state, data: { ...f.controller.state.data!, projection: { ...f.controller.state.data!.projection, binding: otherRoot } } }
    f.coordinator.updateWorkspaceSelection(otherRoot, { view: 'info' })
    expect(f.coordinator.getWorkspaceSelection(a).taskView).toBe('trace')
    expect(f.coordinator.getWorkspaceSelection(otherRoot).view).toBe('info')
    unsubscribe(); f.destroy()
    expect(f.coordinator.getWorkspaceSelection(a).detail).toBeUndefined()
    expect(f.coordinator.getWorkspaceSelection(b).view).toBe('tasks')
  })
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
    expect(f.sidebar.openTabIn).not.toHaveBeenCalled()
    const release = f.coordinator.bindSidebar(f.sidebar.sidebar)
    expect(f.sidebar.openTabIn).toHaveBeenCalledOnce()
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
    f.coordinator.closeAndRestoreFocus()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    await f.coordinator.openMemberChat('worker', 'member-1')
    expect(refresh).toHaveBeenCalledWith('captain')
    expect(open).toHaveBeenCalledExactlyOnceWith(address)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.setReady('team-1', 'member-1')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'member-1' })
    f.controller.state = ready
    f.sessions.setCurrent('root')
    f.controller.state = ready
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
    expect(f.sidebar.openTabIn).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="dialog"]')).toBeNull(); f.destroy()
  })

  it('retains a hidden tab across polling and allows the official guide to reopen a removed occurrence', () => {
    const f = fixture(); f.setReady()
    f.sidebar.hide(); f.setReady()
    expect(f.sidebar.openTabIn).toHaveBeenCalledOnce()
    f.sidebar.show(); f.coordinator.closeAndRestoreFocus(); f.setReady()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.sidebar.sidebar.openTab('swarm-team')
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    f.setReady(); expect(f.sidebar.openTabIn).toHaveBeenCalledTimes(2); f.destroy()
  })
  it('hands Captain navigation to the exact official Session only when it remains listed', async () => {
    const f = fixture(); f.setReady()
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => Promise<void>) => { await callback('other') })
    await f.coordinator.openCaptainChat()
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('other')
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
    f.setReady(); expect(f.sidebar.openTabIn).toHaveBeenCalledTimes(2); f.destroy()
  })

  it('does not expand a collapsed official Sidebar on a Team refresh', () => {
    const f = fixture(); f.setReady(); f.sidebar.sidebar.toggleExpanded(); f.setReady()
    expect(f.sidebar.sidebar.isExpanded()).toBe(false)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.sidebar.openTabIn).toHaveBeenCalledOnce(); f.destroy()
  })

  it('binds dismissal to the first result when the official user closes a loading Team tab', () => {
    const f = fixture(); f.sidebar.sidebar.openTab('swarm-team')
    f.coordinator.closeAndRestoreFocus(); f.setReady('team-1'); f.setReady('team-1')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.sidebar.openTabIn).toHaveBeenCalledOnce()
    f.setReady('team-2'); expect(f.sidebar.openTabIn).toHaveBeenCalledTimes(2); f.destroy()
  })

})

it('targets the exact new Session while the official mounted seat still belongs to the old one', () => {
  const f=fixture(), official=installedTargetedSidebar()
  let offRoot: (() => void) | undefined
  try {
    f.releaseSidebar(); official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
    f.coordinator.bindSidebar(official.controller)
    f.setReady('team-1','root')
    offRoot=f.coordinator.observeTab('root',sidebarTabInfo().tab)
    official.calls.length=0
    offRoot(); offRoot=undefined
    f.controller.open.mockImplementation((id: string)=>{f.setReady('team-1',id)})
    f.sessions.setCurrent('captain')
    // The new Session is authoritative before React adopts or binds its seat.
    // A target-addressed call is a no-op here; it must never open the old root.
    expect(official.calls).toEqual([])
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    official.adopt('captain')
    official.controller.setExpandedIn('captain', true)
    f.setReady('team-1','captain') // Existing authoritative read cadence; no new timer.
    expect(official.calls).toEqual(['captain'])
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    official.bind('captain')
    const offCaptain=f.coordinator.observeTab('captain',sidebarTabInfo('captain-tab').tab)
    expect(f.coordinator.getSnapshot()).toMatchObject({mode:'docked',targetSessionId:'captain'})
    f.setReady('team-1','captain')
    expect(official.calls).toEqual(['captain'])
    offCaptain()
  } finally { offRoot?.(); f.destroy(); official.dispose() }
})

it('reads and commits only the exact adopted sidebar store, including a hidden previously expanded target', () => {
  const f = installedTargetedSidebar()
  try {
    expect(f.controller.isExpandedIn('new')).toBeUndefined()
    f.controller.setExpandedIn('new', true)
    f.adopt('new')
    expect(f.controller.isExpandedIn('new')).toBe(false) // Unknown target did not queue a write.
    f.adopt('source'); f.controller.setExpandedIn('source', true); f.bind('source')
    f.controller.setExpandedIn('new', true)
    expect(f.controller.isExpandedIn('new')).toBe(true)
    f.controller.setExpandedIn('new', false)
    expect(f.controller.isExpandedIn('new')).toBe(false)
    expect(f.controller.isExpandedIn('source')).toBe(true)
    f.controller.setExpandedIn('source', false)
    expect(f.controller.isExpandedIn('source')).toBe(false)
  } finally { f.dispose() }
})

it('preserves a newly adopted collapsed source when opening an already expanded target through the real sidebar owner', async () => {
  const f = fixture(), official = installedTargetedSidebar()
  try {
    f.releaseSidebar(); official.adopt('root'); official.bind('root')
    official.adopt('other'); official.controller.setExpandedIn('other', true)
    f.coordinator.bindSidebar(official.controller); f.setReady()
    expect(official.calls).toEqual([])
    await f.coordinator.openTeamCaptain('other')
    expect(official.controller.isExpandedIn('root')).toBe(false)
    expect(official.controller.isExpandedIn('other')).toBe(false)
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('other')
  } finally { f.destroy(); official.dispose() }
})

it('requests latest before official opening, supports same-current reentry and cancels only superseded or failed intents', async () => {
  const events: string[] = [], cancels: Array<ReturnType<typeof vi.fn>> = []
  const requestLatest = vi.fn((id: string) => { events.push(`request:${id}`); const cancel = vi.fn(); cancels.push(cancel); return cancel })
  const f = fixture({ requestLatest })
  try {
    f.setReady()
    await f.coordinator.openTeamCaptain('root')
    expect(requestLatest).toHaveBeenCalledWith('root')
    expect(f.sessions.open).not.toHaveBeenCalled()
    f.sessions.open.mockImplementation((id: string) => { events.push(`open:${id}`); f.sessions.setCurrent(id) })
    await f.coordinator.openTeamCaptain('other')
    expect(events).toEqual(['request:root', 'request:other', 'open:other'])
    expect(cancels[0]).toHaveBeenCalledOnce()
    expect(cancels[1]).not.toHaveBeenCalled() // Expected selection must survive until the Chat view mounts.
    f.sessions.setCurrent('root'); f.setReady()
    expect(cancels[1]).toHaveBeenCalledOnce()
    f.sessions.open.mockImplementation(() => { throw new Error('official open failed') })
    await expect(f.coordinator.openTeamCaptain('other')).rejects.toThrow('official open failed')
    expect(cancels[2]).toHaveBeenCalledOnce()
    f.sessions.open.mockImplementation(() => {})
    await f.coordinator.openTeamCaptain('root')
    f.unmount()
    expect(cancels[3]).toHaveBeenCalledOnce()
  } finally { f.destroy() }
})

it('uses the user expansion choice at catalog commit time, rather than restoring a preference captured before await', async () => {
  const f = fixture()
  try {
    f.setReady()
    const snapshot = f.sessions.list.getSnapshot
    Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), byId: { ...snapshot().byId, captain: { origin: 'subagent', parentId: 'root' } }, subagentsByParent: { root: { state: 'ready', entries: [{ kind: 'child', id: 'captain', mode: 'continuable' }] } } }) })
    let finish!: () => void
    const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const open = vi.fn()
    Object.assign(f.sessions, { refreshSubagents: refresh, openSubagent: open })
    f.sidebar.sidebar.toggleExpanded() // Initially hidden.
    const first = f.coordinator.openTeamCaptain('captain')
    f.sidebar.sidebar.toggleExpanded() // The user reopens while authorization is in flight.
    finish(); await first
    expect(f.sidebar.sidebar.isExpandedIn('captain' as SessionId)).toBe(true)
    const second = f.coordinator.openTeamCaptain('captain')
    f.sidebar.sidebar.toggleExpanded() // The user closes while the next authorization is in flight.
    finish(); await second
    expect(f.sidebar.sidebar.isExpandedIn('captain' as SessionId)).toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
  } finally { f.destroy() }
})
