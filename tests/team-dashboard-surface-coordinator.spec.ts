// @vitest-environment jsdom
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  TeamDashboardSurfaceCoordinator,
  type TeamDashboardFrameSchedule,
} from '../src/client/team-dashboard-surface-coordinator.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

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
    this.state = { open: true, phase: 'loading', targetSessionId }
    this.emit()
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
  addIntruder(priority = -2): void { this.intruder = { priority }; this.emit() }
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

function fixture(): {
  coordinator: TeamDashboardSurfaceCoordinator
  controller: FakeController
  frames: FakeFrames
  layout: { openDetails: ReturnType<typeof vi.fn>; closeDetails: ReturnType<typeof vi.fn>; toggleSidebar: ReturnType<typeof vi.fn> }
  sessions: FakeSessions
  slots: FakeSlots
  trigger: HTMLButtonElement
  releaseLayout: () => void
  unmount: () => void
} {
  const controller = new FakeController()
  const frames = new FakeFrames()
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn(), toggleSidebar: vi.fn() }
  const sessions = new FakeSessions()
  const slots = new FakeSlots()
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
    locale: { getLocale: () => ({ active: 'en' }) },
    sessions,
    slots,
  } as never)
  const dispose = coordinator.mount()
  const releaseLayout = coordinator.bindLayout(layout)
  const unmount = (): void => { dispose(); anchor.remove() }
  return { coordinator, controller, frames, layout, releaseLayout, sessions, slots, trigger, unmount }
}

describe('TeamDashboardSurfaceCoordinator', () => {
  it('uses the official details slot and toggles Team directly between docked and closed', () => {
    const f = fixture()
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'root' })
    expect(f.slots.hasTeam).toBe(true)
    expect(f.layout.openDetails).toHaveBeenCalledTimes(1)

    f.coordinator.toggle('root')
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.slots.hasTeam).toBe(false)
    expect(f.layout.closeDetails).toHaveBeenCalledTimes(1)
    expect(f.controller.getSnapshot()).toEqual({ open: false, phase: 'closed' })
    f.unmount()
  })

  it('hands Team to official Tool Details without an intermediate close', () => {
    const f = fixture()
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    f.layout.openDetails.mockImplementation(() => {
      expect(f.slots.hasTeam).toBe(false)
      expect(f.controller.getSnapshot().open).toBe(false)
    })
    f.coordinator.showToolDetails()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.layout.openDetails).toHaveBeenCalledTimes(2)
    expect(f.layout.closeDetails).not.toHaveBeenCalled()
    f.unmount()
  })

  it('does not start reads when the details declaration or Layout service is unavailable', () => {
    const f = fixture()
    f.coordinator.toggle('root')
    f.frames.flush()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.coordinator.getSnapshot().announcement).toBe('tool-unavailable-runtime')
    expect(f.controller.getSnapshot().open).toBe(false)
    f.coordinator.bindDetailsDeclaration()
    f.releaseLayout()
    f.coordinator.toggle('root')
    expect(f.controller.getSnapshot().open).toBe(false)
    f.unmount()
  })

  it('fails closed when the details declaration or Layout face is replaced', () => {
    const f = fixture()
    const releaseDeclaration = f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    releaseDeclaration()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(false)

    f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    f.releaseLayout()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.slots.hasTeam).toBe(false)
    expect(f.controller.getSnapshot().open).toBe(false)
    f.unmount()
  })

  it('fails closed on entry error, priority loss, or Session replacement', () => {
    const f = fixture()
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    f.slots.failTeam()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(false)

    f.coordinator.toggle('root')
    f.slots.addIntruder()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.slots.hasTeam).toBe(false)

    const f2 = fixture()
    f2.coordinator.bindDetailsDeclaration()
    f2.coordinator.toggle('root')
    f2.sessions.select('other')
    expect(f2.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f2.layout.closeDetails).toHaveBeenCalledTimes(1)
    f.unmount()
    f2.unmount()
  })

  it('converges when closeDetails throws and restores focus on Escape close', async () => {
    const f = fixture()
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    f.layout.closeDetails.mockImplementation(() => { throw new Error('layout face is unwired') })
    f.coordinator.closeAndRestoreFocus()
    await Promise.resolve()
    expect(f.coordinator.getSnapshot().mode).toBe('inactive')
    expect(f.controller.getSnapshot().open).toBe(false)
    expect(document.activeElement).toBe(f.trigger)
    f.unmount()
  })

  it('restores Team if the Tool handoff fails after releasing the slot', () => {
    const f = fixture()
    f.coordinator.bindDetailsDeclaration()
    f.coordinator.toggle('root')
    f.layout.openDetails.mockImplementationOnce(() => { throw new Error('tool face unavailable') })
    f.coordinator.showToolDetails()
    expect(f.coordinator.getSnapshot().mode).toBe('docked')
    expect(f.slots.hasTeam).toBe(true)
    expect(f.controller.getSnapshot().open).toBe(true)
    f.unmount()
  })

  it('re-emits identical runtime announcements on distinct frames', () => {
    const f = fixture()
    f.releaseLayout()
    const seen: Array<string | undefined> = []
    const off = f.coordinator.subscribe(() => { seen.push(f.coordinator.getSnapshot().announcement) })
    f.coordinator.showToolDetails()
    f.frames.flush()
    f.coordinator.showToolDetails()
    f.frames.flush()
    expect(seen.filter(value => value === 'tool-unavailable-runtime')).toHaveLength(2)
    off()
    f.unmount()
  })
})
