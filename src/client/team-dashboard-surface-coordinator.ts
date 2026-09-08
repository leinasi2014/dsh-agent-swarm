import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent/client'
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
  private entrySessionId: string | undefined
  private navigationSessions = new Set<string>()
  private layout: ILayout | undefined
  private declarationLive = false
  private layoutEpoch = 0
  private declarationEpoch = 0
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
      const current = this.options.sessions.list.getSnapshot().current
      if (target === undefined || current === target) return
      const data = this.options.controller.getSnapshot().data
      if (data !== undefined) {
        this.navigationSessions = new Set([data.projection.binding.rootSessionId,
          ...data.captainMembers.members.flatMap(member => member.phase === 'active' && member.sessionId !== undefined ? [member.sessionId] : [])])
      }
      const sameTeam = current !== undefined && (current === this.entrySessionId
        || this.navigationSessions.has(current))
      if (!sameTeam || current === undefined) return this.close(false)
      this.publish({ ...this.state, targetSessionId: current })
      this.options.controller.open(current)
    })
    this.offEntryError = this.options.slots.onEntryError((key, entry) => { if (key === 'details' && entry === this.entry) this.close(false) })
    this.offSlot = this.options.slots.subscribe('details', () => { if (this.entry !== undefined && !this.isWinner(this.entry)) this.close(false) })
    return () => { this.dispose() }
  }

  bindLayout(layout: ILayout): () => void {
    if (this.disposed) return () => {}
    const epoch = ++this.layoutEpoch
    this.layout = layout
    return () => {
      if (epoch !== this.layoutEpoch) return
      this.layoutEpoch += 1
      this.layout = undefined
      this.close(false)
    }
  }
  bindDetailsDeclaration(): () => void {
    if (this.disposed) return () => {}
    const epoch = ++this.declarationEpoch
    this.declarationLive = true
    return () => {
      if (epoch !== this.declarationEpoch) return
      this.declarationEpoch += 1
      this.declarationLive = false
      this.close(false)
    }
  }
  toggle(targetSessionId: string): void {
    this.assertLive()
    if (this.state.mode === 'docked' && this.state.targetSessionId === targetSessionId) return this.close(true)
    this.close(false)
    if (!this.acquire()) return
    try {
      this.entrySessionId = targetSessionId
      this.options.controller.open(targetSessionId)
      this.layout?.openDetails()
      this.publish({ mode: 'docked', targetSessionId, view: 'overview' })
    } catch { this.close(false) }
  }
  selectView(view: TeamDashboardView): void { if (this.state.mode === 'docked' && this.state.view !== view) this.publish({ ...this.state, view }) }
  closeAndRestoreFocus(): void { this.close(true) }
  /** Team yields Details; official Tool Details remains the sole Tool renderer. */
  showToolDetails(): void {
    this.assertLive()
    const layout = this.layout
    if (layout === undefined) return
    this.releaseTeamLease()
    this.publish(INACTIVE)
    this.options.controller.close()
    try { layout.openDetails() } catch { this.publish(INACTIVE) }
  }
  async openCaptainChat(): Promise<void> {
    await this.options.controller.openCaptainChat((id, signal) => this.openOfficialCaptain(id, signal))
    this.publish(INACTIVE)
  }

  private async openOfficialCaptain(id: string, signal?: AbortSignal): Promise<void> {
    this.assertLive()
    const sessions = this.options.sessions
    const before = sessions.list.getSnapshot()
    const row = before.byId[id as SessionId]
    if (row === undefined) throw new Error('Dedicated Captain is no longer in the official Session list')
    if (row.origin !== 'subagent') { sessions.open(id as SessionId); return }
    if (row.parentId === undefined) throw new Error('Dedicated Captain has no official parent child catalog')
    await sessions.refreshSubagents(row.parentId)
    signal?.throwIfAborted()
    this.assertLive()
    const after = sessions.list.getSnapshot()
    if (after.current !== before.current) throw new Error('Captain Chat handoff was superseded')
    const current = after.byId[id as SessionId]
    const catalog = after.subagentsByParent[row.parentId]
    const child = catalog?.state === 'ready' ? catalog.entries.find((entry: SubagentListEntry) => entry.id === id) as SubagentListEntry | undefined : undefined
    if (current?.origin !== 'subagent' || current.parentId !== row.parentId || child?.kind !== 'child' || child.mode !== 'continuable') {
      throw new Error('Dedicated Captain is not in the official parent child catalog')
    }
    sessions.openSubagent({ parentSessionId: row.parentId, childSessionId: child.id, mode: child.mode })
  }

  async openMemberChat(name: string, sessionId: string): Promise<void> {
    this.assertLive()
    const target = this.state.targetSessionId
    await this.options.controller.openMemberChat(name, sessionId, async (captainId, memberId, signal) => {
      const sessions = this.options.sessions
      await sessions.refreshSubagents(captainId as SessionId)
      signal.throwIfAborted()
      if (this.state.mode !== 'docked' || this.state.targetSessionId !== target
        || sessions.list.getSnapshot().current !== target) throw new Error('Member Chat handoff was superseded')
      const catalog = sessions.list.getSnapshot().subagentsByParent[captainId as SessionId]
      const child = catalog?.state === 'ready' ? catalog.entries.find((entry: SubagentListEntry) => entry.id === memberId) as SubagentListEntry | undefined : undefined
      if (child?.kind !== 'child' || child.mode !== 'continuable') {
        throw new Error('Member Session is not in the official Captain child catalog')
      }
      // subagentAddress is a retained-navigation lookup, empty on first open.
      // This address comes from the fresh public direct-parent catalog instead.
      sessions.openSubagent({ parentSessionId: captainId as SessionId, childSessionId: child.id, mode: child.mode })
    })
  }

  /** Open the official Session of a specific Team's dedicated Captain from the enumerated selector.
   *  The official Catalog is the only authority: a Session that is absent (or not live) degrades to
   *  an explicit unavailable, never a fabricated chat. */
  async openTeamCaptain(captainSessionId: string): Promise<void> {
    await this.openOfficialCaptain(captainSessionId)
    this.releaseTeamLease()
    this.publish(INACTIVE)
    this.options.controller.close()
  }

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
    this.entrySessionId = undefined
    this.navigationSessions.clear()
    if (this.state.mode === 'docked') { try { this.layout?.closeDetails() } catch { /* teardown still releases the Team lease */ } }
    this.releaseTeamLease()
    this.publish(INACTIVE)
    this.options.controller.close()
    if (restoreFocus) queueMicrotask(() => { this.options.anchorRef.current?.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')?.focus() })
  }
  private releaseTeamLease(): void { const release = this.release; this.release = undefined; this.entry = undefined; release?.() }
  private publish(state: TeamDashboardSurfaceState): void { this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.layoutEpoch += 1
    this.declarationEpoch += 1
    this.offSlot(); this.offEntryError(); this.offSessions(); this.offController()
    this.close(false)
    this.options.controller.dispose()
    this.listeners.clear()
  }
  private assertLive(): void { if (this.disposed) throw new Error('Team dashboard surface coordinator is disposed') }
}
