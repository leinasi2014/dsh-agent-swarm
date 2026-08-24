import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefObject } from 'react'
import { TeamDashboardDetails } from './TeamDashboardDetails.js'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export const TEAM_DASHBOARD_SURFACE_ID = 'swarm-team-surface'

type TeamDashboardSurfaceMode = 'inactive' | 'docked'
export type TeamDashboardView = 'overview' | 'members' | 'work' | 'diagnostics'
export type TeamDashboardAnnouncement = 'tool-selected' | 'tool-unavailable-runtime' | undefined

export interface TeamDashboardSurfaceState {
  readonly mode: TeamDashboardSurfaceMode
  readonly view: TeamDashboardView
  readonly targetSessionId: string | undefined
  readonly announcement: TeamDashboardAnnouncement
  readonly announcementRevision: number
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
  readonly frames?: TeamDashboardFrameSchedule
}

const browserFrames: TeamDashboardFrameSchedule = {
  request: callback => globalThis.requestAnimationFrame(callback),
  cancel: handle => globalThis.cancelAnimationFrame(handle as number),
}

const INACTIVE: TeamDashboardSurfaceState = Object.freeze({
  mode: 'inactive',
  view: 'overview',
  targetSessionId: undefined,
  announcement: undefined,
  announcementRevision: 0,
})

/** One non-React owner for the reversible official-details lease. */
export class TeamDashboardSurfaceCoordinator {
  private readonly listeners = new Set<() => void>()
  private readonly frames: TeamDashboardFrameSchedule
  private state: TeamDashboardSurfaceState = INACTIVE
  private declarationLive = false
  private declarationEpoch = 0
  private layoutEpoch = 0
  private layout: ILayout | undefined
  private entry: StoredEntry | undefined
  private disposeEntry: (() => void) | undefined
  private announcementFrame: unknown
  private mounted = false
  private disposed = false
  private offController = (): void => {}
  private offSessions = (): void => {}
  private offEntryError = (): void => {}
  private offSlot = (): void => {}

  constructor(private readonly options: SurfaceCoordinatorOptions) {
    this.frames = options.frames ?? browserFrames
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
    return () => {
      if (epoch !== this.layoutEpoch) return
      this.layoutEpoch += 1
      this.layout = undefined
      this.failClosedAfterReplacement()
    }
  }

  /** Declaration-lifetime callback used only through slots.inject('details'). */
  bindDetailsDeclaration(): () => void {
    if (this.disposed) return () => {}
    const epoch = ++this.declarationEpoch
    this.declarationLive = true
    return () => {
      if (epoch !== this.declarationEpoch) return
      this.declarationEpoch += 1
      this.declarationLive = false
      this.failClosedAfterReplacement()
    }
  }

  private failClosedAfterReplacement(): void {
    const hadFocus = this.dashboardHasFocus()
    const target = this.options.controller.getSnapshot().targetSessionId
    this.releaseEntry()
    this.options.controller.close()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    this.restoreTriggerAfterReplacement(hadFocus, target)
  }

  toggle(targetSessionId: string): void {
    this.assertLive()
    const current = this.options.controller.getSnapshot()
    if (current.open && current.targetSessionId === targetSessionId) {
      this.closeTeam(false)
      return
    }
    if (current.open) this.closeTeam(false)
    if (!this.acquireForFreshOpen(targetSessionId)) this.announce('tool-unavailable-runtime')
  }

  showToolDetails(): void {
    this.assertLive()
    const layout = this.layout
    if (layout === undefined) {
      this.announce('tool-unavailable-runtime')
      return
    }
    const previous = this.options.controller.getSnapshot()
    const previousTarget = previous.targetSessionId
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    if (previous.open) this.options.controller.close()
    try {
      // Keep the official column open during the Team -> Tool occupant handoff.
      layout.openDetails()
    } catch {
      if (previous.open && previousTarget !== undefined) this.restoreAfterFailedHandoff(previousTarget)
      this.announce('tool-unavailable-runtime')
      return
    }
    this.announce('tool-selected')
  }

  selectView(view: TeamDashboardView): void {
    if (this.state.mode === 'inactive' || this.state.view === view) return
    this.publish({ view })
  }

  closeAndRestoreFocus(): void {
    this.closeTeam(true)
  }

  async openCaptainChat(): Promise<void> {
    const target = this.state.targetSessionId
    await this.options.controller.openCaptainChat((rootSessionId) => {
      const sessions = this.options.sessions.list.getSnapshot()
      if (!Object.hasOwn(sessions.byId, rootSessionId)) {
        throw new Error('Captain Session is no longer in the official Session list')
      }
      try {
        this.closeDetailsBestEffort()
        this.releaseEntry()
        this.publish({ mode: 'inactive', targetSessionId: undefined })
        this.options.sessions.open(rootSessionId as SessionId)
      } catch (error) {
        if (target !== undefined && this.options.controller.getSnapshot().open) this.restoreAfterFailedHandoff(target)
        throw error
      }
    })
  }

  private acquireForFreshOpen(targetSessionId: string): boolean {
    const layout = this.layout
    if (!this.declarationLive || layout === undefined || !this.registerTentative()) return false
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

  private onSessionsChange(): void {
    const target = this.state.targetSessionId
    if (target === undefined || !this.options.controller.getSnapshot().open) return
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
    this.closeDetailsBestEffort()
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
  }

  private closeTeam(restoreFocus: boolean): void {
    const wasOpen = this.options.controller.getSnapshot().open
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    this.options.controller.close()
    if (wasOpen) this.closeDetailsBestEffort()
    if (restoreFocus) queueMicrotask(() => {
      this.options.anchorRef.current?.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')?.focus()
    })
  }

  private restoreAfterFailedHandoff(targetSessionId: string): void {
    if (!this.declarationLive || this.layout === undefined || !this.registerTentative()) return
    try {
      if (!this.options.controller.getSnapshot().open) this.options.controller.open(targetSessionId)
      this.layout.openDetails()
      this.publish({ mode: 'docked', targetSessionId })
    } catch {
      this.releaseEntry()
      this.options.controller.close()
      this.publish({ mode: 'inactive' })
    }
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
    const hadFocus = this.dashboardHasFocus()
    this.releaseEntry()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
    this.options.controller.close()
    this.restoreTriggerAfterReplacement(hadFocus, this.options.sessions.list.getSnapshot().current)
  }

  private closeDetailsBestEffort(): void {
    try { this.layout?.closeDetails() } catch { /* Cleanup still converges during Layout replacement. */ }
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
    this.state = Object.freeze({ ...this.state, ...change })
    for (const listener of this.listeners) listener()
  }

  private releaseEntry(): void {
    const dispose = this.disposeEntry
    this.disposeEntry = undefined
    this.entry = undefined
    dispose?.()
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.declarationEpoch += 1
    this.declarationLive = false
    if (this.announcementFrame !== undefined) {
      this.frames.cancel(this.announcementFrame)
      this.announcementFrame = undefined
    }
    this.offEntryError()
    this.offSlot()
    this.offSessions()
    this.offController()
    this.layoutEpoch += 1
    this.layout = undefined
    this.releaseEntry()
    this.options.controller.dispose()
    this.state = INACTIVE
    this.listeners.clear()
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Team dashboard surface coordinator is disposed')
  }
}
