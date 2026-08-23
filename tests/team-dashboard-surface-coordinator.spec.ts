// @vitest-environment jsdom
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  TeamDashboardSurfaceCoordinator,
  type TeamDashboardFrameSchedule,
  type TeamDashboardViewport,
} from '../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

class FakeViewport implements TeamDashboardViewport {
  private readonly listeners = new Set<() => void>()
  constructor(private safe: boolean) {}
  getSnapshot = (): boolean => this.safe
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(safe: boolean): void {
    this.safe = safe
    for (const listener of this.listeners) listener()
  }
}

class FakeFrames implements TeamDashboardFrameSchedule {
  private next = 0
  private readonly callbacks = new Map<number, () => void>()
  request = (callback: () => void): number => {
    const handle = ++this.next
    this.callbacks.set(handle, callback)
    return handle
  }
  cancel = (handle: unknown): void => { this.callbacks.delete(handle as number) }
  flush(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }
  get pending(): number { return this.callbacks.size }
}

class FakeController {
  readonly dispose = vi.fn()
  readonly refresh = vi.fn()
  readonly reconnect = vi.fn()
  private readonly listeners = new Set<() => void>()
  private state: TeamDashboardState = { open: false, phase: 'closed' }

  getSnapshot = (): TeamDashboardState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  open = (targetSessionId: string): void => {
    this.state = { open: true, phase: 'loading', presentation: 'expanded', targetSessionId }
    this.emit()
  }
  cycle = (targetSessionId: string): void => {
    if (!this.state.open || this.state.targetSessionId !== targetSessionId) this.open(targetSessionId)
    else if (this.state.presentation === 'expanded') {
      this.state = { ...this.state, presentation: 'compact' }
      this.emit()
    } else this.close()
  }
  close = (): void => {
    this.state = { open: false, phase: 'closed' }
    this.emit()
  }
  openCaptainChat = async (handoff: (rootSessionId: string) => void): Promise<void> => { handoff('root') }
  private emit(): void { for (const listener of this.listeners) listener() }
}

interface FakeEntry { readonly priority: number; readonly component?: unknown }

class FakeSlots {
  readonly official: FakeEntry = { priority: 0 }
  private team: FakeEntry | undefined
  private intruder: FakeEntry | undefined
  private errorListener: ((key: string, entry: FakeEntry) => void) | undefined
  private readonly listeners = new Set<() => void>()
  register = (options: { priority: number }, component: unknown): (() => void) => {
    if (this.team !== undefined) throw new Error('duplicate Team entry')
    const entry = { priority: options.priority, component }
    this.team = entry
    this.emit()
    return () => {
      if (this.team !== entry) return
      this.team = undefined
      this.emit()
    }
  }
  entries = (): readonly FakeEntry[] => [this.official, this.team, this.intruder].filter((entry): entry is FakeEntry => entry !== undefined)
  entriesOfSlot = (): readonly FakeEntry[] => [...this.entries()].toSorted((left, right) => left.priority - right.priority)
  onEntryError = (listener: (key: string, entry: FakeEntry) => void): (() => void) => {
    this.errorListener = listener
    return () => { this.errorListener = undefined }
  }
  subscribe = (_key: string, listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  failTeam(): void { if (this.team !== undefined) this.errorListener?.('details', this.team) }
  addIntruder(priority = -2): void {
    this.intruder = { priority }
    this.emit()
  }
  get hasTeam(): boolean { return this.team !== undefined }
  private emit(): void { for (const listener of this.listeners) listener() }
}

class FakeSessions {
  private readonly listeners = new Set<() => void>()
  private current = 'root'
  readonly open = vi.fn()
  readonly list = {
    getSnapshot: (): { current: string; byId: Record<string, object> } => ({
      current: this.current,
      byId: { root: {}, other: {} },
    }),
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  select(current: string): void {
    this.current = current
    for (const listener of this.listeners) listener()
  }
}

function fixture(safe: boolean): {
  coordinator: TeamDashboardSurfaceCoordinator
  controller: FakeController
  frames: FakeFrames
  layout: { openDetails: ReturnType<typeof vi.fn>; closeDetails: ReturnType<typeof vi.fn>; toggleSidebar: ReturnType<typeof vi.fn> }
  sessions: FakeSessions
  slots: FakeSlots
  trigger: HTMLButtonElement
  viewport: FakeViewport
  releaseLayout: () => void
  unmount: () => void
} {
  const controller = new FakeController()
  const frames = new FakeFrames()
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn(), toggleSidebar: vi.fn() }
  const sessions = new FakeSessions()
  const slots = new FakeSlots()
  const viewport = new FakeViewport(safe)
  const anchor = document.createElement('span')
  anchor.dataset.swarmTeamSession = 'root'
  const trigger = document.createElement('button')
  trigger.dataset.swarmTeamTrigger = ''
  anchor.append(trigger)
  document.body.append(anchor)
  const coordinator = new TeamDashboardSurfaceCoordinator({
    anchorRef: { current: anchor } as RefObject<HTMLSpanElement>,
    controller,
    frames,
    layout,
    locale: { getLocale: () => ({ active: 'en' }) },
    sessions,
    slots,
    viewport,
  } as never)
  const dispose = coordinator.mount()
  const releaseLayout = coordinator.bindLayout(layout)
  const unmount = (): void => { dispose(); anchor.remove() }
  return { coordinator, controller, frames, layout, releaseLayout, sessions, slots, trigger, viewport, unmount }
}

describe('TeamDashboardSurfaceCoordinator', () => {
  it('leases the official details slot for Team and restores Tool Details without closing the panel', () => {
    const f = fixture(true)
    const releaseDeclaration = f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    expect(f.slots.hasTeam).toBe(true)
    expect(f.layout.openDetails).toHaveBeenCalledTimes(1)

    f.layout.openDetails.mockImplementation(() => {
      expect(f.slots.hasTeam).toBe(false)
      expect(f.controller.getSnapshot().open).toBe(false)
    })
    f.coordinator.showToolDetails()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.slots.hasTeam).toBe(false)
    expect(f.layout.openDetails).toHaveBeenCalledTimes(2)
    expect(f.layout.closeDetails).not.toHaveBeenCalled()
    expect(f.controller.getSnapshot().open).toBe(false)
    releaseDeclaration()
    f.unmount()
  })

  it('cycles expanded, compact, and closed without a close button', () => {
    const f = fixture(true)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    f.coordinator.cycle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('compact')
    expect(f.slots.hasTeam).toBe(false)
    expect(f.layout.closeDetails).toHaveBeenCalledTimes(1)
    f.coordinator.cycle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(false)
    f.unmount()
  })

  it('keeps narrow Tool Details a focusable announced no-op', () => {
    const f = fixture(false)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    f.coordinator.showToolDetails()
    f.frames.flush()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(f.coordinator.getSnapshot().announcement).toBe('tool-unavailable-width')
    expect(f.layout.openDetails).not.toHaveBeenCalled()
    expect(f.controller.getSnapshot().open).toBe(true)
    f.unmount()
  })

  it('migrates between Peek and the official details column at the safe-width boundary', async () => {
    const f = fixture(false)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    const dashboard = document.createElement('aside')
    dashboard.dataset.swarmTeamDashboard = ''
    const focusedControl = document.createElement('button')
    dashboard.append(focusedControl)
    document.body.append(dashboard)
    focusedControl.focus()
    f.viewport.set(true)
    await Promise.resolve()
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    expect(f.slots.hasTeam).toBe(true)
    expect(f.layout.openDetails).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(f.trigger)
    f.viewport.set(false)
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(f.slots.hasTeam).toBe(false)
    expect(f.layout.closeDetails).toHaveBeenCalledTimes(1)
    dashboard.remove()
    f.unmount()
  })

  it('uses a null-rendering tentative lease across declaration rebind and fails closed on entry errors or Session changes', () => {
    const f = fixture(true)
    const release = f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    release()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    const releaseAgain = f.coordinator.bindDetailsDeclaration()
    expect(f.slots.hasTeam).toBe(true)
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(f.frames.pending).toBe(1)
    f.frames.flush()
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    f.slots.failTeam()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(false)
    expect(f.layout.closeDetails).not.toHaveBeenCalled()

    f.coordinator.cycle('root')
    f.sessions.select('other')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.slots.hasTeam).toBe(false)
    releaseAgain()
    f.unmount()
  })

  it('releases a hidden loser when a later details occupant takes priority', () => {
    const f = fixture(true)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    f.slots.addIntruder()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.slots.hasTeam).toBe(false)
    expect(f.controller.getSnapshot().open).toBe(false)

    f.unmount()
  })

  it('converges its lease and reads even when the current Layout close face throws', () => {
    const f = fixture(true)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    f.layout.closeDetails.mockImplementation(() => { throw new Error('layout face is unwired') })
    f.coordinator.cycle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('compact')
    expect(f.slots.hasTeam).toBe(false)
    f.coordinator.cycle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(false)
    f.unmount()
  })

  it('keeps Peek and reads alive when a tentative rebind entry fails before commit', () => {
    const f = fixture(true)
    const release = f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    release()
    f.coordinator.bindDetailsDeclaration()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    f.slots.failTeam()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(f.controller.getSnapshot().open).toBe(true)
    expect(f.slots.hasTeam).toBe(false)
    f.frames.flush()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    f.unmount()
  })

  it('survives official Layout service replacement and rebinds through the new face', () => {
    const f = fixture(true)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    f.releaseLayout()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(f.controller.getSnapshot().open).toBe(true)
    expect(f.slots.hasTeam).toBe(false)

    const replacement = { openDetails: vi.fn(), closeDetails: vi.fn(), toggleSidebar: vi.fn() }
    f.coordinator.bindLayout(replacement)
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(f.slots.hasTeam).toBe(true)
    f.frames.flush()
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    expect(replacement.openDetails).toHaveBeenCalledTimes(1)
    f.unmount()
  })

  it('moves focus only after a successful two-phase Peek-to-docked rebind', async () => {
    const f = fixture(false)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    f.releaseLayout()
    f.viewport.set(true)
    const dashboard = document.createElement('aside')
    dashboard.dataset.swarmTeamDashboard = ''
    const focusedControl = document.createElement('button')
    dashboard.append(focusedControl)
    document.body.append(dashboard)
    focusedControl.focus()

    const replacement = { openDetails: vi.fn(), closeDetails: vi.fn(), toggleSidebar: vi.fn() }
    f.coordinator.bindLayout(replacement)
    expect(document.activeElement).toBe(focusedControl)
    f.frames.flush()
    await Promise.resolve()
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    expect(document.activeElement).toBe(f.trigger)
    dashboard.remove()
    f.unmount()
  })

  it('retains Peek focus when a two-phase rebind cannot open the official column', () => {
    const f = fixture(false)
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.cycle('root')
    f.releaseLayout()
    f.viewport.set(true)
    const dashboard = document.createElement('aside')
    dashboard.dataset.swarmTeamDashboard = ''
    const focusedControl = document.createElement('button')
    dashboard.append(focusedControl)
    document.body.append(dashboard)
    focusedControl.focus()

    const replacement = {
      openDetails: vi.fn(() => { throw new Error('replacement face not wired') }),
      closeDetails: vi.fn(),
      toggleSidebar: vi.fn(),
    }
    f.coordinator.bindLayout(replacement)
    f.frames.flush()
    expect(f.coordinator.getSnapshot().mode).toBe('peek')
    expect(document.activeElement).toBe(focusedControl)
    dashboard.remove()
    f.unmount()
  })

  it('clears and re-emits identical live announcements on separate frames', () => {
    const f = fixture(false)
    const seen: Array<string | undefined> = []
    const off = f.coordinator.subscribe(() => { seen.push(f.coordinator.getSnapshot().announcement) })
    f.coordinator.showToolDetails()
    f.frames.flush()
    f.coordinator.showToolDetails()
    expect(f.coordinator.getSnapshot().announcement).toBeUndefined()
    f.frames.flush()
    expect(seen.filter(value => value === 'tool-unavailable-width')).toHaveLength(2)
    expect(seen.at(-2)).toBeUndefined()
    off()
    f.unmount()
  })
})
