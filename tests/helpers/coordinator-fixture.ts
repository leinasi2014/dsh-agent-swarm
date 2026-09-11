import { vi } from 'vitest'
import { sidebarHarness } from './sidebar-harness.js'
import { TeamDashboardSurfaceCoordinator } from '../../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../../src/client/team-dashboard-controller.js'

/** Shared coordinator fixture: fake controller/sessions, harness sidebar, ready-frame helper, teardown. */
export function fixture(chatNavigation?: { requestLatest: (id: string) => () => void }) {
  const controller: { state: TeamDashboardState; listeners: Set<() => void>; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; openCaptainChat: ReturnType<typeof vi.fn>; getSnapshot(): TeamDashboardState; subscribe(listener: () => void): () => void } = { state: { open: false, phase: 'closed' }, listeners: new Set(), open: vi.fn(function (this: typeof controller, id: string) { this.state = { open: true, phase: 'loading', targetSessionId: id }; this.listeners.forEach(listener => listener()) }), close: vi.fn(function (this: typeof controller) { this.state = { open: false, phase: 'closed' }; this.listeners.forEach(listener => listener()) }), refresh: vi.fn(), dispose: vi.fn(), openCaptainChat: vi.fn(), getSnapshot() { return this.state }, subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  let current = 'root'; const sessionListeners = new Set<() => void>()
  const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current, byId: { root: {}, other: {} } }), subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } } }, setCurrent: (next: string) => { sidebar.hide(current); current = next; sessionListeners.forEach(listener => listener()); sidebar.show(current) } }
  const anchor = document.createElement('span'); document.body.append(anchor)
  const coordinator = new TeamDashboardSurfaceCoordinator({ sessions, chatNavigation, locale: { getLocale: () => ({ active: 'en' }) }, controller, anchorRef: { current: anchor } } as never)
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
