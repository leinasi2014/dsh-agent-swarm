// @vitest-environment jsdom
/** Run the installed official AppFrame, layout reducers and public LayoutController.
 * Only the store subscription carrier and unrelated slot contents are test fixtures. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sidebarHarness } from './helpers/sidebar-harness.js'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { TeamDashboardDetails, type TeamDashboardDetailsProps } from '../src/client/TeamDashboardDetails.js'
import { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

vi.mock('../src/client/TeamDashboardContent.js', () => ({ TeamDashboardContent: () => <div>Team content</div> }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

interface Panels { sidebar: number; viewportWidth: number; narrowExpanded: boolean; rightbar: number | null; rightbarShown: boolean; rightbarTrack: boolean; rightbarFullscreen: boolean; rightbarInstant: boolean }
interface Store { init(): Panels; actions: Record<string, (draft: Panels, ...values: unknown[]) => void> }
interface SessionList { current: string; byId: Record<string, { blank: false }>; subagentsByParent: Record<string, unknown> }
interface FrameProps {
  useStore<T>(selector: (panels: Panels) => T): T
  useSessions<T>(selector: (sessions: SessionList) => T): T
  actions: Record<string, (...values: unknown[]) => void>
  renderSlot(name: string): React.ReactNode
  SessionProvider: React.ComponentType<React.PropsWithChildren>
  t(key: string): string
}
interface RootRegistration { store(): Store; inject(actions: FrameProps['actions']): unknown }

function officialLayout(viewport: number) {
  let exports!: { apply(ctx: unknown): void }
  const require = createRequire(import.meta.url)
  const source = readFileSync(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-layout/package.json')), 'lib/client.js'), 'utf8')
  runInNewContext(source, { window: { innerWidth: viewport, __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): typeof exports }) => {
    exports = entry.factory(name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsx
      if (name === '@deepseek-ai/dsh-client-store') return { defineStore: (store: Store) => store }
      throw new Error(`Unexpected official layout dependency: ${name}`)
    })
  } } }, document, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame, cancelAnimationFrame })
  let Frame!: React.ComponentType<FrameProps>
  let registration!: RootRegistration
  let layout!: ILayout
  exports.apply({
    effect: (effect: () => unknown, label: string) => { if (label === 'ui-layout: service + root registration') effect() },
    reflect: { provide: (_name: string, value: ILayout) => { layout = value; return () => {} } },
    slots: { register: (options: RootRegistration, component: React.ComponentType<FrameProps>) => { registration = options; Frame = component; return () => {} } },
  })
  return { Frame, registration, layout }
}

function harness(viewport = 1440) {
  const { Frame, registration, layout } = officialLayout(viewport)
  const bounds = HTMLElement.prototype.getBoundingClientRect
  // jsdom has no layout engine. Geometry below is derived from the installed
  // AppFrame's actual rendered column tracks, not a copy of its width solver.
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const frame = this.style.gridTemplateColumns ? this : this.closest<HTMLElement>('[style*="grid-template-columns"]')
    const width = this === frame ? viewport : this.hasAttribute('data-swarm-team-panel')
      ? Number(frame?.style.gridTemplateColumns.match(/(\d+)px$/u)?.[1] ?? 0) : undefined
    return width === undefined ? bounds.call(this) : { x: 0, y: 0, width, height: 730, top: 0, right: width, bottom: 730, left: 0, toJSON: () => ({}) }
  })
  const store = registration.store()
  let panels = store.init()
  let session: SessionList = { current: 'root', byId: { root: { blank: false }, captain: { blank: false }, member: { blank: false }, other: { blank: false } },
    subagentsByParent: { captain: { state: 'ready', entries: [{ id: 'member', kind: 'child', mode: 'continuable' }] } } }
  const panelListeners = new Set<() => void>()
  const sessionListeners = new Set<() => void>()
  const trace: string[] = []
  const actions = Object.fromEntries(Object.entries(store.actions).map(([name, reduce]) => [name, (...values: unknown[]) => {
    panels = { ...panels }; reduce(panels, ...values)
    if (name.endsWith('Rightbar')) trace.push(`${name}:${session.current}`)
    panelListeners.forEach(listener => listener())
  }]))
  registration.inject(actions)
  const navigate = (current: string) => { sidebar.hide(session.current); session = { ...session, current }; sessionListeners.forEach(listener => listener()) }
  const sessions = { list: { getSnapshot: () => session, subscribe: (fn: () => void) => { sessionListeners.add(fn); return () => { sessionListeners.delete(fn) } } },
    refreshSubagents: async () => {}, openSubagent: (address: { childSessionId: string }) => { navigate(address.childSessionId) } }
  let state = { open: false, phase: 'closed' } as TeamDashboardState
  const controllerListeners = new Set<() => void>()
  const controller = { getSnapshot: () => state, subscribe: (fn: () => void) => { controllerListeners.add(fn); return () => { controllerListeners.delete(fn) } },
    open: (id: string) => { state = id === 'other' ? { open: true, phase: 'error', targetSessionId: id } : { open: true, phase: 'ready', targetSessionId: id, data: {
      teams: { binding: { rootSessionId: id, mainSessionId: 'root' }, teams: [{ teamId: 'team', captainSessionId: 'captain' }] },
      projection: { binding: { rootSessionId: 'captain', teamId: 'team' } }, captainMembers: { members: [{ name: 'worker', sessionId: 'member', phase: 'active' }] },
    } } as unknown as TeamDashboardState; controllerListeners.forEach(fn => fn()) },
    close: () => { state = { open: false, phase: 'closed' }; controllerListeners.forEach(fn => fn()) }, refresh: () => {}, dispose: () => {},
    openMemberChat: async (_name: string, _id: string, open: (captain: string, member: string, signal: AbortSignal) => Promise<void>) => { await open('captain', 'member', new AbortController().signal) },
  }
  let entry: object | undefined
  const slots = { entries: () => entry === undefined ? [] : [entry], entriesOfSlot: () => entry === undefined ? [] : [entry],
    register: () => { entry = {}; return () => { entry = undefined } }, onEntryError: () => () => {}, subscribe: () => () => {} }
  const coordinator = new TeamDashboardSurfaceCoordinator({ slots, sessions, controller, locale: { getLocale: () => ({ active: 'en' }) }, anchorRef: { current: null } } as never)
  const sidebar = sidebarHarness(coordinator, () => session.current, () => { layout.openRightbar(true, false) })
  sidebar.setAutoMount(false)
  const unmount = coordinator.mount(); coordinator.bindSidebar(sidebar.sidebar)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Details() {
    const current = React.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot).current
    const info = sidebar.records.get(current)
    if (info === undefined) return null
    return <TeamDashboardDetails {...({ controller, coordinator, useTabInfo: () => info, localeTag: coordinator.localeTag, sessionId: current, t: (key: string) => key } as unknown as TeamDashboardDetailsProps)} />
  }
  const frameProps: FrameProps = {
    useStore: selector => selector(React.useSyncExternalStore(fn => { panelListeners.add(fn); return () => { panelListeners.delete(fn) } }, () => panels)),
    useSessions: selector => selector(React.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)),
    actions, renderSlot: name => name === 'rightbar' ? <Details /> : null, SessionProvider: React.Fragment, t: key => key,
  }
  const settleFrame = async () => { await React.act(async () => { await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) }) }) }
  return { coordinator, navigate, trace, layout, settleFrame, sidebar, refresh: () => { controller.open(session.current) }, panels: () => panels,
    mount: async () => { await React.act(async () => { root.render(<Frame {...frameProps} />) }); await settleFrame() },
    dispose: async () => { await React.act(async () => { root.unmount(); unmount() }); geometry.mockRestore() },
  }
}

afterEach(() => { document.body.replaceChildren() })

describe('Team navigation in the installed official AppFrame', () => {
  it('shows Team automatically at 1088px and leaves later sidebar changes to the official layout owner', async () => {
    const f = harness(1088)
    try {
      await f.mount()
      const panel = document.querySelector('[data-swarm-team-panel]')!
      const frame = panel.closest<HTMLElement>('[style*="grid-template-columns"]')!
      expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 408px')
      await React.act(async () => { f.layout.toggleSidebar() })
      await React.act(async () => { await f.coordinator.openMemberChat('worker', 'member') })
      await f.settleFrame()
      expect(frame.style.gridTemplateColumns).toBe('56px minmax(0, 1fr) 490px')
      expect(f.panels().sidebar).toBe(0)
    } finally { await f.dispose() }
  })

  it.each([980, 1000, 1440])('keeps the official responsive column solver at %ipx', async viewport => {
    const f = harness(viewport)
    const toggle = vi.spyOn(f.layout, 'toggleSidebar')
    try {
      await f.mount()
      expect(toggle).not.toHaveBeenCalled()
      const frame = document.querySelector<HTMLElement>('[style*="grid-template-columns"]')!
      expect(frame.style.gridTemplateColumns).toBe(viewport === 980 ? '56px minmax(0, 1fr) 441px'
        : viewport === 1000 ? '56px minmax(0, 1fr) 450px' : '280px minmax(0, 1fr) 648px')
      expect(document.querySelector('[data-swarm-team-panel]')?.getBoundingClientRect().width).toBeGreaterThan(0)
    } finally { toggle.mockRestore(); await f.dispose() }
  })

  it('does not reopen a removed Team on a later read or layout effect', async () => {
    const f = harness()
    try {
      await f.mount()
      expect(f.panels().rightbarShown).toBe(true)
      f.trace.length = 0
      await React.act(async () => { f.coordinator.closeAndRestoreFocus(); f.layout.closeRightbar(); f.refresh() })
      await f.settleFrame()
      expect(f.coordinator.getSnapshot().mode).toBe('inactive')
      expect(f.trace).not.toContain('openRightbar:root')
      expect(f.panels().rightbarShown).toBe(false)
      expect(document.querySelector('[data-rightbar-collapsed]')).not.toBeNull()
    } finally { await f.dispose() }
  })

  it('keeps nonzero official right-column geometry through exact member navigation without a close/reopen layout workaround', async () => {
    const f = harness()
    try {
      await f.mount(); f.trace.length = 0
      await React.act(async () => { await f.coordinator.openMemberChat('worker', 'member') })
      expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'member' })
      expect(f.trace).toEqual(['openRightbar:member'])
      const panel = document.querySelector('[data-swarm-team-panel]')!
      const frame = panel.closest<HTMLElement>('[style*="grid-template-columns"]')!
      expect(frame.hasAttribute('data-rightbar-collapsed')).toBe(false)
      expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 648px')
      await React.act(async () => { f.navigate('other') })
      expect(f.coordinator.getSnapshot().mode).toBe('inactive')
      expect(document.querySelector('[data-swarm-team-panel]')).toBeNull()
      // Team discovery does not commandeer the official column on an unrelated Session.
      expect(f.panels().rightbarShown).toBe(true)
    } finally { await f.dispose() }
  })
})
