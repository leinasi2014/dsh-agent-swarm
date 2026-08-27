import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefObject } from 'react'
import { TeamDashboardDetails } from './TeamDashboardDetails.js'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export type TeamDashboardView = 'overview' | 'members' | 'tasks' | 'details'
export interface TeamDashboardSurfaceState {
  readonly mode: 'inactive' | 'docked'
  readonly view: TeamDashboardView
  readonly targetSessionId: string | undefined
}
interface Options {
  readonly slots: ClientContext['slots']
  readonly sessions: ISessions
  readonly locale: LocaleRuntime
  readonly controller: TeamDashboardController
  readonly anchorRef: RefObject<HTMLSpanElement>
}
const INACTIVE: TeamDashboardSurfaceState = Object.freeze({ mode: 'inactive', view: 'overview', targetSessionId: undefined })

/** Owns one reversible public `details` priority lease; it never owns Team data. */
export class TeamDashboardSurfaceCoordinator {
  private readonly listeners = new Set<() => void>()
  private state: TeamDashboardSurfaceState = INACTIVE
  private layout: ILayout | undefined
  private declarationLive = false
  private entry: StoredEntry | undefined
  private release: (() => void) | undefined
  private disposed = false
  private mounted = false
  private offController = (): void => {}
  private offSessions = (): void => {}
  private offEntryError = (): void => {}
  private offSlot = (): void => {}

  constructor(private readonly options: Options) {}

  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'zh-CN' | 'en-US' => this.options.locale.getLocale().active === 'zh' ? 'zh-CN' : 'en-US'

  mount(): () => void {
    if (this.mounted) throw new Error('Team dashboard surface coordinator is already mounted')
    this.mounted = true
    this.offController = this.options.controller.subscribe(() => { if (!this.options.controller.getSnapshot().open && this.state.mode !== 'inactive') this.close(false) })
    this.offSessions = this.options.sessions.list.subscribe(() => {
      const target = this.state.targetSessionId
      if (target !== undefined && this.options.sessions.list.getSnapshot().current !== target) this.close(false)
    })
    this.offEntryError = this.options.slots.onEntryError((key, entry) => { if (key === 'details' && entry === this.entry) this.close(false) })
    this.offSlot = this.options.slots.subscribe('details', () => { if (this.entry !== undefined && !this.isWinner(this.entry)) this.close(false) })
    return () => { this.dispose() }
  }

  bindLayout(layout: ILayout): () => void {
    if (this.disposed) return () => {}
    this.layout = layout
    return () => { if (this.layout === layout) { this.layout = undefined; this.close(false) } }
  }
  bindDetailsDeclaration(): () => void {
    if (this.disposed) return () => {}
    this.declarationLive = true
    return () => { this.declarationLive = false; this.close(false) }
  }
  toggle(targetSessionId: string): void {
    this.assertLive()
    if (this.state.mode === 'docked' && this.state.targetSessionId === targetSessionId) return this.close(true)
    this.close(false)
    if (!this.acquire()) return
    try {
      this.options.controller.open(targetSessionId)
      this.layout?.openDetails()
      this.publish({ mode: 'docked', targetSessionId, view: 'overview' })
    } catch { this.close(false) }
  }
  selectView(view: TeamDashboardView): void { if (this.state.mode === 'docked' && this.state.view !== view) this.publish({ ...this.state, view }) }
  closeAndRestoreFocus(): void { this.close(true) }

  private acquire(): boolean {
    if (!this.declarationLive || this.layout === undefined) return false
    const before = new Set(this.options.slots.entries('details'))
    let release: (() => void) | undefined
    try {
      release = this.options.slots.register({ name: 'details', priority: -1, locale: TEAM_DASHBOARD_NS,
        inject: () => ({ anchorRef: this.options.anchorRef, controller: this.options.controller, coordinator: this, localeTag: this.localeTag }),
      }, TeamDashboardDetails)
      const entry = this.options.slots.entries('details').find(candidate => !before.has(candidate))
      if (entry === undefined || !this.isWinner(entry)) { release(); return false }
      this.entry = entry; this.release = release
      return true
    } catch { release?.(); return false }
  }
  private isWinner(entry: StoredEntry): boolean { return this.options.slots.entriesOfSlot('details')[0] === entry }
  private close(restoreFocus: boolean): void {
    if (this.state.mode === 'docked') { try { this.layout?.closeDetails() } catch { /* teardown still releases the Team lease */ } }
    const release = this.release
    this.release = undefined; this.entry = undefined
    release?.()
    this.publish(INACTIVE)
    this.options.controller.close()
    if (restoreFocus) queueMicrotask(() => { this.options.anchorRef.current?.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')?.focus() })
  }
  private publish(state: TeamDashboardSurfaceState): void { this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offSlot(); this.offEntryError(); this.offSessions(); this.offController()
    this.close(false)
    this.options.controller.dispose()
    this.listeners.clear()
  }
  private assertLive(): void { if (this.disposed) throw new Error('Team dashboard surface coordinator is disposed') }
}
