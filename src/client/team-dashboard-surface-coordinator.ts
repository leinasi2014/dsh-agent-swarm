import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent/client'
import type { ISidebarRight, SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RefObject } from 'react'
import type { TeamDashboardController } from './team-dashboard-controller.js'

export const TEAM_TAB_KIND = 'swarm-team'
export const TEAM_TAB_ID = 'dsh-agent-swarm/team'
export type TeamDashboardView = 'overview' | 'members' | 'tasks' | 'details'
export interface TeamDashboardSurfaceState {
  readonly mode: 'inactive' | 'docked'
  readonly view: TeamDashboardView
  readonly targetSessionId: string | undefined
}
interface Options {
  readonly sessions: ISessions
  readonly locale: LocaleRuntime
  readonly controller: TeamDashboardController
  readonly anchorRef: RefObject<HTMLSpanElement>
}
type Tab = SidebarRightTabInfo['tab']
interface ObservedTab { sessionId: string; tab: Tab; mounted: boolean; mount: object; offAbort(): void }
const INACTIVE: TeamDashboardSurfaceState = Object.freeze({ mode: 'inactive', view: 'overview', targetSessionId: undefined })

/** Coordinates the Team's own official Sidebar tab; never owns column layout or Team data. */
export class TeamDashboardSurfaceCoordinator {
  private readonly listeners = new Set<() => void>()
  private readonly tabs = new Map<string, ObservedTab>()
  private readonly dismissed = new Map<string, string | undefined>()
  private state: TeamDashboardSurfaceState = INACTIVE
  private sidebar: ISidebarRight | undefined
  private sidebarEpoch = 0
  private disposed = false
  private mounted = false
  private observedSessionId: string | undefined
  private offController = (): void => {}
  private offSessions = (): void => {}

  constructor(private readonly options: Options) {}
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'zh-CN' | 'en-US' => this.options.locale.getLocale().active === 'zh' ? 'zh-CN' : 'en-US'

  mount(): () => void {
    if (this.mounted) throw new Error('Team dashboard surface coordinator is already mounted')
    this.mounted = true
    this.offController = this.options.controller.subscribe(() => {
      if (!this.options.controller.getSnapshot().open) this.publish(INACTIVE)
      else this.revealAvailableTeam()
    })
    this.offSessions = this.options.sessions.list.subscribe(() => {
      const current = this.options.sessions.list.getSnapshot().current
      if (current === this.observedSessionId) return
      this.observedSessionId = current
      this.publish(INACTIVE)
      if (current === undefined) this.options.controller.close()
      else this.options.controller.open(current)
    })
    this.observedSessionId = this.options.sessions.list.getSnapshot().current
    if (this.observedSessionId !== undefined) this.options.controller.open(this.observedSessionId)
    return () => { this.dispose() }
  }

  bindSidebar(sidebar: ISidebarRight): () => void {
    if (this.disposed) return () => {}
    const epoch = ++this.sidebarEpoch
    this.sidebar = sidebar
    this.revealAvailableTeam()
    return () => {
      if (epoch !== this.sidebarEpoch) return
      this.sidebarEpoch++
      this.sidebar = undefined
      this.publish(INACTIVE)
    }
  }

  /** The official hook reports visibility; only its abort signal means actual removal. */
  observeTab(sessionId: string, tab: Tab): () => void {
    if (this.disposed || tab.signal.aborted) return () => {}
    const key = JSON.stringify([sessionId, tab.id])
    const mount = {}
    const previous = this.tabs.get(key)
    if (previous !== undefined && previous.tab.signal !== tab.signal) {
      previous.offAbort()
      this.tabs.delete(key)
    }
    let observed = this.tabs.get(key)
    if (observed === undefined) {
      const onAbort = (): void => {
        if (this.tabs.get(key)?.tab.signal !== tab.signal) return
        this.tabs.delete(key)
        if (this.disposed) return
        this.dismissCurrentTeam(sessionId)
        if (this.options.sessions.list.getSnapshot().current === sessionId) this.publish(INACTIVE)
      }
      tab.signal.addEventListener('abort', onAbort, { once: true })
      observed = { sessionId, tab, mounted: true, mount, offAbort: () => { tab.signal.removeEventListener('abort', onAbort) } }
      this.tabs.set(key, observed)
    } else { observed.tab = tab; observed.mounted = true; observed.mount = mount }
    if (this.options.sessions.list.getSnapshot().current === sessionId) {
      if (tab.visible) this.publish({ mode: 'docked', targetSessionId: sessionId, view: this.state.view })
      else if (this.state.targetSessionId === sessionId) this.publish(INACTIVE)
    }
    return () => {
      const current = this.tabs.get(key)
      if (current?.mount !== mount) return
      current.mounted = false
      // Official tab switches unmount the body without another visibility frame.
      // Retain the occurrence and abort listener until the actual tab is closed.
      if (this.state.targetSessionId === sessionId) this.publish(INACTIVE)
    }
  }

  toggle(targetSessionId: string): void {
    this.assertLive()
    if (this.options.sessions.list.getSnapshot().current !== targetSessionId) return
    if (this.state.mode === 'docked' && this.state.targetSessionId === targetSessionId) return this.closeAndRestoreFocus()
    this.dismissed.delete(targetSessionId)
    this.options.controller.open(targetSessionId)
    this.openTeamTab(targetSessionId)
  }
  selectView(view: TeamDashboardView): void { if (this.state.mode === 'docked' && this.state.view !== view) this.publish({ ...this.state, view }) }
  closeAndRestoreFocus(): void {
    const current = this.options.sessions.list.getSnapshot().current
    if (current === undefined) return
    this.dismissCurrentTeam(current)
    // Each action belongs to this exact tab/session, including late callbacks.
    const own = [...this.tabs.values()].find(value => value.sessionId === current && value.mounted && value.tab.visible)
    own?.tab.actions.close()
    this.publish(INACTIVE)
    queueMicrotask(() => { this.options.anchorRef.current?.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')?.focus() })
  }
  async openCaptainChat(): Promise<void> {
    await this.options.controller.openCaptainChat((id, signal) => this.openOfficialCaptain(id, signal))
  }

  async openMainChat(): Promise<void> {
    await this.options.controller.openMainChat((id, signal) => {
      signal.throwIfAborted()
      this.assertLive()
      const sessions = this.options.sessions
      const list = sessions.list.getSnapshot()
      const row = list.byId[id as SessionId]
      if (list.current !== this.state.targetSessionId || row === undefined || row.origin === 'subagent' || row.parentId !== undefined) {
        throw new Error('Main conversation is not in the current official root Session list')
      }
      sessions.open(id as SessionId)
    })
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
  }

  private revealAvailableTeam(): void {
    const read = this.options.controller.getSnapshot()
    const current = this.options.sessions.list.getSnapshot().current
    if (this.disposed || !read.open || read.phase !== 'ready' || read.data === undefined
      || current === undefined || read.targetSessionId !== current) return
    const own = [...this.tabs.values()].find(value => value.sessionId === current)
    if (own !== undefined) {
      if (own.mounted && own.tab.visible) this.publish({ mode: 'docked', targetSessionId: current, view: this.state.view })
      return // A hidden tab belongs to the user; polling must not focus it.
    }
    const teamId = read.data.projection.binding.teamId
    if (this.dismissed.has(current) && this.dismissed.get(current) === undefined) {
      this.dismissed.set(current, teamId)
      return
    }
    if (teamId === undefined || this.dismissed.get(current) === teamId
      || (this.state.mode === 'docked' && this.state.targetSessionId === current)) return
    this.openTeamTab(current)
  }
  private openTeamTab(sessionId: string): void {
    if (this.sidebar === undefined || this.options.sessions.list.getSnapshot().current !== sessionId) return
    this.publish({ mode: 'docked', targetSessionId: sessionId, view: 'overview' })
    try { this.sidebar.openTab(TEAM_TAB_KIND) } catch { this.publish(INACTIVE) }
  }
  private dismissCurrentTeam(sessionId: string): void {
    const read = this.options.controller.getSnapshot()
    const teamId = read.targetSessionId === sessionId ? read.data?.projection.binding.teamId : undefined
    this.dismissed.set(sessionId, teamId)
  }
  private publish(state: TeamDashboardSurfaceState): void {
    if (state.mode === this.state.mode && state.view === this.state.view && state.targetSessionId === this.state.targetSessionId) return
    this.state = Object.freeze(state)
    for (const listener of this.listeners) listener()
  }
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sidebarEpoch++
    this.offSessions(); this.offController()
    for (const observed of this.tabs.values()) observed.offAbort()
    this.tabs.clear(); this.dismissed.clear()
    this.publish(INACTIVE)
    this.options.controller.dispose()
    this.listeners.clear()
  }
  private assertLive(): void { if (this.disposed) throw new Error('Team dashboard surface coordinator is disposed') }
}
