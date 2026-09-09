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
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { TeamDashboardDetails, type TeamDashboardDetailsProps } from '../src/client/TeamDashboardDetails.js'
import { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

vi.mock('../src/client/TeamDashboardContent.js', () => ({ TeamDashboardContent: () => <div>Team content</div> }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

interface Panels { sidebar: number; details: number; narrow: boolean; narrowExpanded: boolean }
interface Store { init(): Panels; actions: Record<string, (draft: Panels, value?: unknown) => void> }
interface SessionList { current: string; byId: Record<string, { blank: false }>; subagentsByParent: Record<string, unknown> }
interface FrameProps {
  useStore<T>(selector: (panels: Panels) => T): T
  useSessions<T>(selector: (sessions: SessionList) => T): T
  actions: Record<string, (value?: unknown) => void>
  renderSlot(name: string): React.ReactNode
  SessionProvider: React.ComponentType<React.PropsWithChildren>
  t(key: string): string
}
interface RootRegistration { store(): Store; inject(actions: FrameProps['actions']): unknown }

function officialLayout() {
  let exports!: { apply(ctx: unknown): void }
  const require = createRequire(import.meta.url)
  const source = readFileSync(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-layout/package.json')), 'lib/client.js'), 'utf8')
  runInNewContext(source, { window: { innerWidth: 1440, __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): typeof exports }) => {
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

function harness() {
  const { Frame, registration, layout } = officialLayout()
  const store = registration.store()
  let panels = store.init()
  let session: SessionList = { current: 'root', byId: { root: { blank: false }, captain: { blank: false }, member: { blank: false }, other: { blank: false } },
    subagentsByParent: { captain: { state: 'ready', entries: [{ id: 'member', kind: 'child', mode: 'continuable' }] } } }
  const panelListeners = new Set<() => void>()
  const sessionListeners = new Set<() => void>()
  const trace: string[] = []
  let onClose: (() => void) | undefined
  const actions = Object.fromEntries(Object.entries(store.actions).map(([name, reduce]) => [name, (value?: unknown) => {
    panels = { ...panels }; reduce(panels, value)
    if (name.endsWith('Details')) trace.push(`${name}:${session.current}`)
    if (name === 'closeDetails') { const callback = onClose; onClose = undefined; callback?.() }
    panelListeners.forEach(listener => listener())
  }]))
  registration.inject(actions)
  const navigate = (current: string) => { session = { ...session, current }; sessionListeners.forEach(listener => listener()) }
  const sessions = { list: { getSnapshot: () => session, subscribe: (fn: () => void) => { sessionListeners.add(fn); return () => { sessionListeners.delete(fn) } } },
    refreshSubagents: async () => {}, openSubagent: (address: { childSessionId: string }) => { navigate(address.childSessionId) } }
  let state = { open: false, phase: 'closed' } as TeamDashboardState
  const controllerListeners = new Set<() => void>()
  const controller = { getSnapshot: () => state, subscribe: (fn: () => void) => { controllerListeners.add(fn); return () => { controllerListeners.delete(fn) } },
    open: (id: string) => { state = id === 'other' ? { open: true, phase: 'error', targetSessionId: id } : { open: true, phase: 'ready', targetSessionId: id, data: {
      projection: { binding: { rootSessionId: 'captain', teamId: 'team' } }, captainMembers: { members: [{ name: 'worker', sessionId: 'member', phase: 'active' }] },
    } } as unknown as TeamDashboardState; controllerListeners.forEach(fn => fn()) },
    close: () => { state = { open: false, phase: 'closed' }; controllerListeners.forEach(fn => fn()) }, dispose: () => {},
    openMemberChat: async (_name: string, _id: string, open: (captain: string, member: string, signal: AbortSignal) => Promise<void>) => { await open('captain', 'member', new AbortController().signal) },
  }
  let entry: object | undefined
  const slots = { entries: () => entry === undefined ? [] : [entry], entriesOfSlot: () => entry === undefined ? [] : [entry],
    register: () => { entry = {}; return () => { entry = undefined } }, onEntryError: () => () => {}, subscribe: () => () => {} }
  const coordinator = new TeamDashboardSurfaceCoordinator({ slots, sessions, controller, locale: { getLocale: () => ({ active: 'en' }) }, anchorRef: { current: null } } as never)
  const unmount = coordinator.mount(); coordinator.bindLayout(layout); coordinator.bindDetailsDeclaration()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Details() {
    const current = React.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot).current
    return <TeamDashboardDetails {...({ controller, coordinator, localeTag: coordinator.localeTag, sessionId: current, t: (key: string) => key } as unknown as TeamDashboardDetailsProps)} />
  }
  const frameProps: FrameProps = {
    useStore: selector => selector(React.useSyncExternalStore(fn => { panelListeners.add(fn); return () => { panelListeners.delete(fn) } }, () => panels)),
    useSessions: selector => selector(React.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)),
    actions, renderSlot: name => name === 'details' ? <Details /> : null, SessionProvider: React.Fragment, t: key => key,
  }
  return { coordinator, navigate, trace, onClose: (callback: () => void) => { onClose = callback }, panels: () => panels,
    mount: async () => { await React.act(async () => { root.render(<Frame {...frameProps} />) }) },
    dispose: async () => { await React.act(async () => { root.unmount(); unmount() }) },
  }
}

afterEach(() => { document.body.replaceChildren() })

describe('Team navigation in the installed official AppFrame', () => {
  it('does not reopen a Team closed between official layout and passive effects', async () => {
    const f = harness()
    try {
      await f.mount()
      expect(f.panels().details).toBe(360) // automatically visible on first mount
      f.trace.length = 0
      f.onClose(() => { f.coordinator.closeAndRestoreFocus() })
      await React.act(async () => { await f.coordinator.openMemberChat('worker', 'member') })
      expect(f.coordinator.getSnapshot().mode).toBe('inactive')
      expect(f.trace).not.toContain('openDetails:member')
      expect(f.panels().details).toBe(0)
      expect(document.querySelector('[data-details-collapsed]')).not.toBeNull()
    } finally { await f.dispose() }
  })

  it('restores nonzero Details geometry after the official session layout effect closes it', async () => {
    const f = harness()
    try {
      await f.mount()
      f.trace.length = 0
      await React.act(async () => { await f.coordinator.openMemberChat('worker', 'member') })
      expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'member' })
      expect([...f.trace]).toEqual(['closeDetails:member', 'openDetails:member'])
      expect(f.panels().details).toBe(360)
      const panel = document.querySelector('[data-swarm-team-panel]')!
      const frame = panel.closest<HTMLElement>('[style*="grid-template-columns"]')!
      expect(frame.hasAttribute('data-details-collapsed')).toBe(false)
      expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 360px')
      // The DOM survives width-zero closure in official AppFrame; existence alone
      // would falsely pass the original bug. Assert the computed track authority.
      await React.act(async () => { f.navigate('other') })
      expect(f.coordinator.getSnapshot().mode).toBe('inactive')
      expect(f.panels().details).toBe(0)
    } finally { await f.dispose() }
  })
})
