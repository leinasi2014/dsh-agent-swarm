// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

class Slots {
  official = { priority: 0 }; team: { priority: number } | undefined; intruder: { priority: number } | undefined
  listeners = new Set<() => void>()
  register = (options: { priority: number }): (() => void) => { const entry = { priority: options.priority }; this.team = entry; this.emit(); return () => { if (this.team === entry) { this.team = undefined; this.emit() } } }
  entries = (): object[] => [this.official, this.team, this.intruder].filter(Boolean) as object[]
  entriesOfSlot = (): object[] => this.entries().toSorted((a, b) => (a as { priority: number }).priority - (b as { priority: number }).priority)
  onEntryError = (): (() => void) => () => {}
  subscribe = (_key: string, listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  addLower(): void { this.intruder = { priority: -2 }; this.emit() }
  private emit(): void { this.listeners.forEach(listener => listener()) }
}
function fixture() {
  const slots = new Slots(); const controller: { state: TeamDashboardState; listeners: Set<() => void>; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; openCaptainChat: ReturnType<typeof vi.fn>; getSnapshot(): TeamDashboardState; subscribe(listener: () => void): () => void } = { state: { open: false, phase: 'closed' }, listeners: new Set(), open: vi.fn(function (this: typeof controller, id: string) { this.state = { open: true, phase: 'loading', targetSessionId: id }; this.listeners.forEach(listener => listener()) }), close: vi.fn(function (this: typeof controller) { this.state = { open: false, phase: 'closed' }; this.listeners.forEach(listener => listener()) }), refresh: vi.fn(), dispose: vi.fn(), openCaptainChat: vi.fn(), getSnapshot() { return this.state }, subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }; let current = 'root'; const sessionListeners = new Set<() => void>()
  const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current, byId: { root: {}, other: {} } }), subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } } }, setCurrent: (next: string) => { current = next; sessionListeners.forEach(listener => listener()) } }
  const anchor = document.createElement('span'); anchor.innerHTML = '<button data-swarm-team-trigger></button>'; document.body.append(anchor)
  const coordinator = new TeamDashboardSurfaceCoordinator({ slots, sessions, locale: { getLocale: () => ({ active: 'en' }) }, controller, anchorRef: { current: anchor } } as never)
  const unmount = coordinator.mount(); const releaseLayout = coordinator.bindLayout(layout as never); const releaseDetails = coordinator.bindDetailsDeclaration()
  return { slots, controller, layout, sessions, coordinator, releaseDetails, releaseLayout, unmount, destroy: () => { releaseDetails(); releaseLayout(); unmount(); anchor.remove() } }
}
describe('TeamDashboardSurfaceCoordinator', () => {
  it('resumes current Session discovery after layout and declaration replacement without a toolbar (#225)', () => {
    const f = fixture()
    f.releaseLayout()
    expect(f.controller.state.open).toBe(false)
    const previous = f.controller.open.mock.calls.length
    const release = f.coordinator.bindLayout(f.layout as never)
    expect(f.controller.open).toHaveBeenCalledTimes(previous + 1)
    expect(f.controller.state).toMatchObject({ open: true, targetSessionId: 'root' })
    f.releaseDetails()
    expect(f.controller.state.open).toBe(false)
    const releaseDeclaration = f.coordinator.bindDetailsDeclaration()
    expect(f.controller.open).toHaveBeenCalledTimes(previous + 2)
    expect(f.controller.state).toMatchObject({ open: true, targetSessionId: 'root' })
    releaseDeclaration(); release(); f.destroy()
  })

  it('discovers the current Team without a toolbar click, and respects dismissal until a different Team or Session (#225)', () => {
    const f = fixture()
    expect(f.controller.open).toHaveBeenCalledWith('root')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    const ready = (teamId: string, targetSessionId = 'root') => {
      f.controller.state = { open: true, phase: 'ready', targetSessionId, data: {
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
    f.coordinator.showToolDetails()
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
    // Official rc.1 has no retained subagentAddress until the FIRST navigation;
    // refreshing the catalog alone does not populate that address cache.
    Object.assign(f.sessions, { refreshSubagents: refresh, subagentAddress: () => undefined, openSubagent: open })
    await f.coordinator.openMemberChat('worker', 'member-1')
    expect(refresh).toHaveBeenCalledWith('captain')
    expect(open).toHaveBeenCalledExactlyOnceWith(address)
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

  it('keeps Details through exact member, Captain and original root navigation (#221)', () => {
    const f = fixture()
    f.coordinator.toggle('root')
    const ready = (targetSessionId: string): void => {
      f.controller.state = { open: true, phase: 'ready', targetSessionId,
        data: { projection: { binding: { rootSessionId: 'captain', teamId: 'team-1' } }, captainMembers: { members: [{ name: 'worker', sessionId: 'member-1', phase: 'active' }] } } } as unknown as TeamDashboardState
    }
    ready('root')
    f.sessions.setCurrent('member-1')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'member-1' })
    expect(f.controller.open).toHaveBeenLastCalledWith('member-1')
    expect(f.slots.team).toBeDefined()
    // Host load is still pending: Controller.open already cleared data.
    f.sessions.setCurrent('captain')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'captain' })
    ready('captain')
    f.sessions.setCurrent('root')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'root' })
    ready('root')
    f.sessions.setCurrent('other')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    f.destroy()
  })

  it('leases public Details at priority -1 and toggles closed back to official Tool Details', () => {
    const f = fixture(); f.coordinator.toggle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('docked'); expect((f.slots.entriesOfSlot()[0] as { priority: number }).priority).toBe(-1); expect(f.layout.openDetails).toHaveBeenCalledTimes(1)
    f.coordinator.toggle('root'); expect(f.coordinator.getSnapshot().mode).toBe('inactive'); expect((f.slots.entriesOfSlot()[0] as { priority: number }).priority).toBe(0); expect(f.layout.closeDetails).toHaveBeenCalledTimes(1); f.destroy()
  })
  it('does not create a narrow-screen fallback and closes when Details loses its priority', () => {
    const f = fixture(); f.coordinator.toggle('root'); f.slots.addLower()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive'); expect(f.controller.close).toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull(); f.destroy()
  })
  it('yields its lease to the official Tool Details column and fences stale declaration/layout disposers', () => {
    const f = fixture(); const nextLayout = f.coordinator.bindLayout(f.layout as never); const nextDetails = f.coordinator.bindDetailsDeclaration()
    f.releaseLayout(); f.releaseDetails(); f.coordinator.toggle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    f.coordinator.showToolDetails(); expect(f.coordinator.getSnapshot().mode).toBe('inactive'); expect((f.slots.entriesOfSlot()[0] as { priority: number }).priority).toBe(0); expect(f.layout.openDetails).toHaveBeenCalled()
    nextLayout(); nextDetails(); f.destroy()
  })
  it('hands Captain navigation to the exact official Session only when it remains listed', async () => {
    const f = fixture()
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => Promise<void>) => { await callback('root') })
    await f.coordinator.openCaptainChat()
    expect(f.sessions.open).toHaveBeenCalledWith('root')
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => Promise<void>) => { await callback('missing') })
    await expect(f.coordinator.openCaptainChat()).rejects.toThrow('official Session list')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    f.destroy()
  })
  it('cleans the lease and controller when the Session switches or the plugin unloads', () => {
    const f = fixture(); f.coordinator.toggle('root'); f.sessions.setCurrent('other')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive'); expect((f.slots.entriesOfSlot()[0] as { priority: number }).priority).toBe(0)
    f.coordinator.toggle('other'); f.unmount(); expect(f.layout.closeDetails).toHaveBeenCalled(); expect(f.controller.dispose).toHaveBeenCalledTimes(1); f.destroy()
  })
  it('opens the official Session of an enumerated dedicated Captain only while it stays listed, and degrades to unavailable otherwise', async () => {
    const f = fixture()
    // The enumeration row hands the exact official Captain Session id; the official Catalog is the authority.
    await f.coordinator.openTeamCaptain('other')
    expect(f.sessions.open).toHaveBeenCalledWith('other')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    // A Captain that left the official Session list can never open a fabricated chat.
    await expect(f.coordinator.openTeamCaptain('not-listed')).rejects.toThrow('official Session list')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    f.destroy()
  })
})
