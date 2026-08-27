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
  const slots = new Slots(); const controller: { state: TeamDashboardState; listeners: Set<() => void>; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; openCaptainChat: ReturnType<typeof vi.fn>; getSnapshot(): TeamDashboardState; subscribe(listener: () => void): () => void } = { state: { open: false, phase: 'closed' }, listeners: new Set(), open: vi.fn(function (this: typeof controller, id: string) { this.state = { open: true, phase: 'loading', targetSessionId: id }; this.listeners.forEach(listener => listener()) }), close: vi.fn(function (this: typeof controller) { this.state = { open: false, phase: 'closed' }; this.listeners.forEach(listener => listener()) }), dispose: vi.fn(), openCaptainChat: vi.fn(), getSnapshot() { return this.state }, subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }; let current = 'root'; const sessionListeners = new Set<() => void>()
  const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current, byId: { root: {}, other: {} } }), subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } } }, setCurrent: (next: string) => { current = next; sessionListeners.forEach(listener => listener()) } }
  const anchor = document.createElement('span'); anchor.innerHTML = '<button data-swarm-team-trigger></button>'; document.body.append(anchor)
  const coordinator = new TeamDashboardSurfaceCoordinator({ slots, sessions, locale: { getLocale: () => ({ active: 'en' }) }, controller, anchorRef: { current: anchor } } as never)
  const unmount = coordinator.mount(); const releaseLayout = coordinator.bindLayout(layout as never); const releaseDetails = coordinator.bindDetailsDeclaration()
  return { slots, controller, layout, sessions, coordinator, releaseDetails, releaseLayout, unmount, destroy: () => { releaseDetails(); releaseLayout(); unmount(); anchor.remove() } }
}
describe('TeamDashboardSurfaceCoordinator', () => {
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
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => void) => { callback('root') })
    await f.coordinator.openCaptainChat()
    expect(f.sessions.open).toHaveBeenCalledWith('root')
    f.controller.openCaptainChat.mockImplementation(async (callback: (rootSessionId: string) => void) => { callback('missing') })
    await expect(f.coordinator.openCaptainChat()).rejects.toThrow('official Session list')
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    f.destroy()
  })
  it('cleans the lease and controller when the Session switches or the plugin unloads', () => {
    const f = fixture(); f.coordinator.toggle('root'); f.sessions.setCurrent('other')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive'); expect((f.slots.entriesOfSlot()[0] as { priority: number }).priority).toBe(0)
    f.coordinator.toggle('other'); f.unmount(); expect(f.layout.closeDetails).toHaveBeenCalled(); expect(f.controller.dispose).toHaveBeenCalledTimes(1); f.destroy()
  })
})
