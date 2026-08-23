import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefObject } from 'react'
import { TeamDashboardDetails } from './TeamDashboardDetails.js'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

const TEAM_DASHBOARD_SAFE_WIDTH = 1440
export const TEAM_DASHBOARD_SURFACE_ID = 'swarm-team-surface'

export type TeamDashboardSurfaceMode = 'inactive' | 'peek' | 'compact' | 'docked'
export type TeamDashboardView = 'overview' | 'members' | 'work' | 'diagnostics'
export type TeamDashboardAnnouncement = 'tool-shown' | 'tool-unavailable-width' | 'tool-unavailable-runtime' | undefined

export interface TeamDashboardSurfaceState {
  readonly mode: TeamDashboardSurfaceMode
  readonly view: TeamDashboardView
  readonly safeWidth: boolean
  readonly targetSessionId: string | undefined
  readonly announcement: TeamDashboardAnnouncement
  readonly announcementRevision: number
}

export interface TeamDashboardViewport {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
}

export interface TeamDashboardFrameSchedule {
  request(callback: () => void): unknown
  cancel(handle: unknown): void
}

interface SurfaceCoordinatorOptions {
  readonly slots: ClientContext['slots']
  readonly sessions: ISessions
  readonly locale: LocaleRuntime
  readonly controller: TeamDashboardController
  readonly anchorRef: RefObject<HTMLSpanElement>
  readonly viewport?: TeamDashboardViewport
  readonly frames?: TeamDashboardFrameSchedule
}

const browserFrames: TeamDashboardFrameSchedule = {
  request: callback => globalThis.requestAnimationFrame(callback),
  cancel: handle => globalThis.cancelAnimationFrame(handle as number),
}

class BrowserTeamDashboardViewport implements TeamDashboardViewport {
  private readonly query = globalThis.matchMedia(`(min-width: ${String(TEAM_DASHBOARD_SAFE_WIDTH)}px)`)

  getSnapshot = (): boolean => this.query.matches

  subscribe = (listener: () => void): (() => void) => {
    this.query.addEventListener('change', listener)
    return () => { this.query.removeEventListener('change', listener) }
  }
}

const initialState = (safeWidth: boolean): TeamDashboardSurfaceState => Object.freeze({
  mode: 'inactive',
  view: 'overview',
  safeWidth,
  targetSessionId: undefined,
  announcement: undefined,
  announcementRevision: 0,
})

/** One non-React owner for the reversible details lease and Team surface transitions. */
export class TeamDashboardSurfaceCoordinator {
  private readonly listeners = new Set<() => void>()
  private readonly viewport: TeamDashboardViewport
  private readonly frames: TeamDashboardFrameSchedule
  private state: TeamDashboardSurfaceState
  private declarationLive = false
  private declarationEpoch = 0
  private layoutEpoch = 0
  private layout: ILayout | undefined
  private entry: StoredEntry | undefined
  private disposeEntry: (() => void) | undefined
  private pendingFrame: unknown
  private announcementFrame: unknown
  private mounted = false
  private disposed = false
  private offController = (): void => {}
  private offViewport = (): void => {}
  private offSessions = (): void => {}
  private offEntryError = (): void => {}
  private offSlot = (): void => {}

  constructor(private readonly options: SurfaceCoordinatorOptions) {
    this.viewport = options.viewport ?? new BrowserTeamDashboardViewport()
    this.frames = options.frames ?? browserFrames
    this.state = initialState(this.viewport.getSnapshot())
  }

  getSnapshot = (): TeamDashboardSurfaceState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  localeTag = (): 'zh-CN' | 'en-US' => this.options.locale.getLocale().active === 'zh' ? 'zh-CN' : 'en-US'

  mount(): () => void {
    if (this.mounted) throw new Error('Team dashboard surface coordinator is already mounted')
    this.mounted = true
    this.offController = this.options.controller.subscribe(() => { this.onControllerChange() })
    this.offViewport = this.viewport.subscribe(() => { this.onViewportChange() })
    this.offSessions = this.options.sessions.list.subscribe(() => { this.onSessionsChange() })
    this.offEntryError = this.options.slots.onEntryError((key, entry) => {
      if (key !== 'details' || entry !== this.entry) return
      this.onTeamEntryLoss()
    })
    this.offSlot = this.options.slots.subscribe('details', () => { this.onDetailsMutation() })
    return () => { this.dispose() }
  }

  /** Lease the current public Layout face without tying coordinator lifetime to ui-layout HMR. */
  bindLayout(layout: ILayout): () => void {
    if (this.disposed) return () => {}
    const epoch = ++this.layoutEpoch
    this.layout = layout
    if (this.declarationLive && this.shouldDock()) this.acquireDocked(true, this.declarationEpoch, epoch)
    return () => {
      if (epoch !== this.layoutEpoch) return
      this.layoutEpoch += 1
      this.layout = undefined
      this.cancelPendingFrame()
      if (this.state.mode !== 'docked') return
      const hadFocus = this.dashboardHasFocus()
      this.releaseEntry()
      this.publish({ mode: 'peek', targetSessionId: this.options.controller.getSnapshot().targetSessionId })
      this.restoreTriggerAfterReplacement(hadFocus, this.state.targetSessionId)
    }
  }

  /** Declaration-lifetime callback used only through slots.inject('details'). */
  bindDetailsDeclaration(): () => void {
    if (this.disposed) return () => {}
    const epoch = ++this.declarationEpoch
    this.declarationLive = true
    if (this.shouldDock() && this.layout !== undefined) this.acquireDocked(true, epoch, this.layoutEpoch)
    return () => {
      if (epoch !== this.declarationEpoch) return
      this.declarationEpoch += 1
      this.declarationLive = false
      this.cancelPendingFrame()
      const wasDocked = this.state.mode === 'docked'
      const hadFocus = this.dashboardHasFocus()
      this.releaseEntry()
      if (wasDocked && this.options.controller.getSnapshot().open) {
        this.publish({ mode: 'peek', targetSessionId: this.state.targetSessionId })
        this.restoreTriggerAfterReplacement(hadFocus, this.state.targetSessionId)
      }
    }
  }

  cycle(targetSessionId: string): void {
    this.assertLive()
    const current = this.options.controller.getSnapshot()
    if (!current.open || current.targetSessionId !== targetSessionId) {
      if (current.open) this.closeTeam(false)
      if (this.state.safeWidth) {
        if (!this.acquireForFreshOpen(targetSessionId)) return
      } else {
        this.options.controller.open(targetSessionId)
        this.publish({ mode: 'peek', targetSessionId, view: 'overview' })
      }
      return
    }
    if (current.presentation !== 'compact') {
      if (this.state.mode === 'docked') {
        this.closeDetailsBestEffort()
      }
      this.releaseEntry()
      this.options.controller.cycle(targetSessionId)
      this.publish({ mode: 'compact', targetSessionId })
      return
    }
    this.closeTeam(false)
  }

  showToolDetails(): void {
    this.assertLive()
    if (!this.state.safeWidth) {
      this.announce('tool-unavailable-width')
      return
    }
    const layout = this.layout
    if (layout === undefined) {
      this.announce('tool-unavailable-runtime')
      return
    }
    const previous = this.options.controller.getSnapshot()
    const previousMode = this.state.mode
    const previousTarget = this.state.targetSessionId
    this.cancelPendingFrame()
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    if (previous.open) this.options.controller.close()
    try {
      layout.openDetails()
    } catch {
      if (previous.open && previousTarget !== undefined) {
        this.options.controller.open(previousTarget)
        this.publish({
          mode: previousMode === 'compact' ? 'compact' : 'peek',
          targetSessionId: previousTarget,
        })
      }
      this.announce('tool-unavailable-runtime')
      return
    }
    this.announce('tool-shown')
  }

  dismiss(): void {
    this.closeTeam(false)
  }

  selectView(view: TeamDashboardView): void {
    if (this.state.mode === 'inactive' || this.state.view === view) return
    this.publish({ view })
  }

  closeAndRestoreFocus(): void {
    this.closeTeam(true)
  }

  async openCaptainChat(): Promise<void> {
    const previousMode = this.state.mode
    const target = this.state.targetSessionId
    await this.options.controller.openCaptainChat((rootSessionId) => {
      const sessions = this.options.sessions.list.getSnapshot()
      if (!Object.hasOwn(sessions.byId, rootSessionId)) {
        throw new Error('Captain Session is no longer in the official Session list')
      }
      try {
        if (previousMode === 'docked') this.closeDetailsBestEffort()
        this.releaseEntry()
        this.publish({ mode: 'inactive', targetSessionId: undefined })
        this.options.sessions.open(rootSessionId as SessionId)
      } catch (error) {
        if (target !== undefined && this.options.controller.getSnapshot().open) {
          this.restoreAfterFailedHandoff(previousMode, target)
        }
        throw error
      }
    })
  }

  private acquireForFreshOpen(targetSessionId: string): boolean {
    const layout = this.layout
    if (!this.declarationLive || layout === undefined) return false
    if (!this.registerTentative()) return false
    try {
      this.options.controller.open(targetSessionId)
      layout.openDetails()
      this.publish({ mode: 'docked', targetSessionId, view: 'overview' })
      return true
    } catch {
      this.releaseEntry()
      this.options.controller.close()
      this.publish({ mode: 'inactive', targetSessionId: undefined })
      return false
    }
  }

  private acquireDocked(rebinding: boolean, epoch = this.declarationEpoch, layoutEpoch = this.layoutEpoch): boolean {
    if (!this.declarationLive || !this.shouldDock() || !this.registerTentative()) return false
    const layout = this.layout
    const controllerTarget = this.options.controller.getSnapshot().targetSessionId
    const restoreFocusAfterCommit = rebinding && this.state.mode === 'peek' && this.dashboardHasFocus()
    if (layout === undefined || layoutEpoch !== this.layoutEpoch) {
      this.releaseEntry()
      return false
    }
    if (!rebinding) {
      try {
        layout.openDetails()
        this.publish({ mode: 'docked', targetSessionId: controllerTarget })
        return true
      } catch {
        this.releaseEntry()
        return false
      }
    }
    this.cancelPendingFrame()
    this.pendingFrame = this.frames.request(() => {
      this.pendingFrame = undefined
      if (this.disposed || epoch !== this.declarationEpoch || layoutEpoch !== this.layoutEpoch || !this.shouldDock() || this.entry === undefined) {
        this.releaseEntry()
        return
      }
      try {
        layout.openDetails()
        this.publish({ mode: 'docked', targetSessionId: controllerTarget })
        this.restoreTriggerAfterReplacement(restoreFocusAfterCommit, controllerTarget)
      } catch {
        this.releaseEntry()
      }
    })
    return false
  }

  private registerTentative(): boolean {
    if (this.entry !== undefined) return this.isWinner(this.entry)
    const before = new Set(this.options.slots.entries('details'))
    let dispose: (() => void) | undefined
    try {
      dispose = this.options.slots.register({
        name: 'details',
        priority: -1,
        locale: TEAM_DASHBOARD_NS,
        inject: () => ({
          anchorRef: this.options.anchorRef,
          controller: this.options.controller,
          coordinator: this,
          localeTag: this.localeTag,
        }),
      }, TeamDashboardDetails)
      const entry = this.options.slots.entries('details').find(candidate => !before.has(candidate))
      if (entry === undefined || !this.isWinner(entry)) {
        dispose()
        return false
      }
      this.entry = entry
      this.disposeEntry = dispose
      return true
    } catch {
      dispose?.()
      return false
    }
  }

  private isWinner(entry: StoredEntry): boolean {
    return this.options.slots.entriesOfSlot('details')[0] === entry
  }

  private shouldDock(): boolean {
    const controller = this.options.controller.getSnapshot()
    return controller.open && controller.presentation === 'expanded' && this.state.safeWidth
  }

  private onViewportChange(): void {
    if (this.disposed) return
    const safeWidth = this.viewport.getSnapshot()
    if (safeWidth === this.state.safeWidth) return
    this.publish({ safeWidth })
    const controller = this.options.controller.getSnapshot()
    if (!controller.open || controller.presentation !== 'expanded') return
    if (!safeWidth && this.state.mode === 'docked') {
      const hadFocus = this.dashboardHasFocus()
      this.closeDetailsBestEffort()
      this.releaseEntry()
      this.publish({ mode: 'peek', targetSessionId: controller.targetSessionId })
      this.restoreTriggerAfterReplacement(hadFocus, controller.targetSessionId)
      return
    }
    if (safeWidth && this.state.mode === 'peek') {
      const hadFocus = this.dashboardHasFocus()
      if (this.acquireDocked(false)) {
        this.restoreTriggerAfterReplacement(hadFocus, controller.targetSessionId)
      }
    }
  }

  private onSessionsChange(): void {
    const target = this.state.targetSessionId
    if (target === undefined || this.state.mode === 'inactive') return
    const sessions = this.options.sessions.list.getSnapshot()
    if (sessions.current === target && Object.hasOwn(sessions.byId, target)) return
    const hadFocus = this.dashboardHasFocus()
    this.closeTeam(false)
    this.restoreTriggerAfterReplacement(hadFocus, sessions.current)
  }

  private onControllerChange(): void {
    if (this.disposed) return
    const controller = this.options.controller.getSnapshot()
    if (controller.open || this.state.mode === 'inactive') return
    if (this.state.mode === 'docked') this.closeDetailsBestEffort()
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
  }

  private closeTeam(restoreFocus: boolean): void {
    if (this.state.mode === 'docked') this.closeDetailsBestEffort()
    this.cancelPendingFrame()
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    this.options.controller.close()
    if (restoreFocus) queueMicrotask(() => {
      this.options.anchorRef.current?.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')?.focus()
    })
  }

  private restoreAfterFailedHandoff(mode: TeamDashboardSurfaceMode, targetSessionId: string): void {
    if (mode === 'docked' && this.state.safeWidth && this.declarationLive) {
      if (this.registerTentative()) {
        try {
          const layout = this.layout
          if (layout === undefined) throw new Error('Layout service is unavailable')
          layout.openDetails()
          this.publish({ mode: 'docked', targetSessionId })
          return
        } catch {
          this.releaseEntry()
        }
      }
    }
    this.publish({ mode: mode === 'compact' ? 'compact' : 'peek', targetSessionId })
  }

  private announce(announcement: Exclude<TeamDashboardAnnouncement, undefined>): void {
    const revision = this.state.announcementRevision + 1
    if (this.announcementFrame !== undefined) this.frames.cancel(this.announcementFrame)
    this.publish({ announcement: undefined, announcementRevision: revision })
    this.announcementFrame = this.frames.request(() => {
      this.announcementFrame = undefined
      if (this.disposed || this.state.announcementRevision !== revision) return
      this.publish({ announcement, announcementRevision: revision + 1 })
    })
  }

  private onDetailsMutation(): void {
    const entry = this.entry
    if (entry === undefined || this.isWinner(entry)) return
    this.onTeamEntryLoss()
  }

  private onTeamEntryLoss(): void {
    const wasDocked = this.state.mode === 'docked'
    const hadFocus = this.dashboardHasFocus()
    this.cancelPendingFrame()
    this.releaseEntry()
    if (!wasDocked) return
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    this.options.controller.close()
    this.restoreTriggerAfterReplacement(hadFocus, this.options.sessions.list.getSnapshot().current)
  }

  private closeDetailsBestEffort(): void {
    try { this.layout?.closeDetails() } catch { /* Resource cleanup must still converge during layout HMR. */ }
  }

  private dashboardHasFocus(): boolean {
    const dashboard = document.querySelector<HTMLElement>('[data-swarm-team-dashboard]')
    return dashboard?.contains(document.activeElement) === true
  }

  private restoreTriggerAfterReplacement(hadFocus: boolean, expectedSessionId: string | undefined): void {
    if (!hadFocus) return
    queueMicrotask(() => {
      const anchor = this.options.anchorRef.current
      if (anchor === null || (expectedSessionId !== undefined && anchor.dataset.swarmTeamSession !== expectedSessionId)) return
      anchor.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')?.focus()
    })
  }

  private publish(change: Partial<TeamDashboardSurfaceState>): void {
    const next: TeamDashboardSurfaceState = Object.freeze({ ...this.state, ...change })
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private releaseEntry(): void {
    const dispose = this.disposeEntry
    this.disposeEntry = undefined
    this.entry = undefined
    dispose?.()
  }

  private cancelPendingFrame(): void {
    if (this.pendingFrame === undefined) return
    this.frames.cancel(this.pendingFrame)
    this.pendingFrame = undefined
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.declarationEpoch += 1
    this.declarationLive = false
    this.cancelPendingFrame()
    if (this.announcementFrame !== undefined) {
      this.frames.cancel(this.announcementFrame)
      this.announcementFrame = undefined
    }
    this.offEntryError()
    this.offSlot()
    this.offSessions()
    this.offViewport()
    this.offController()
    this.layoutEpoch += 1
    this.layout = undefined
    this.releaseEntry()
    this.options.controller.dispose()
    this.state = initialState(this.state.safeWidth)
    this.listeners.clear()
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Team dashboard surface coordinator is disposed')
  }
}
