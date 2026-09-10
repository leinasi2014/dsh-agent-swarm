import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent/client'
import type { SidebarRightNavigator, SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RefObject } from 'react'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import { queueCommunicationChange, type CaptainHumanPrompt } from './team-communication-command.js'
import type { TeamCommunicationChoice } from './TeamCommunicationControl.js'
import type { DetailSelection } from './team-dashboard-view-helpers.js'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'

export interface TeamWorkspaceSelection {
  readonly view: 'tasks' | 'members' | 'info'
  readonly detail?: DetailSelection | undefined
  readonly taskView: 'overview' | 'trace'
  readonly rounds: Readonly<Record<string, boolean>>
  readonly historyOpen: boolean
}
export const EMPTY_TEAM_SELECTION: TeamWorkspaceSelection = Object.freeze({ view: 'tasks', taskView: 'overview', rounds: Object.freeze({}), historyOpen: false })
type TeamBinding = SwarmHostReadProjectionV1['binding']

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
  readonly sendCaptainPrompt?: (request: CaptainHumanPrompt, signal: AbortSignal) => Promise<void>
}
/** Official exported target-addressed navigation, independent of the mounted seat. */
type TeamSidebar = Pick<SidebarRightNavigator, 'openTabIn'>
type Tab = SidebarRightTabInfo['tab']
interface ObservedTab { sessionId: string; tab: Tab; mounted: boolean; mount: object; offAbort(): void }
const INACTIVE: TeamDashboardSurfaceState = Object.freeze({ mode: 'inactive', view: 'overview', targetSessionId: undefined })

/** Coordinates the Team's own official Sidebar tab; never owns column layout or Team data. */
export class TeamDashboardSurfaceCoordinator {
  private readonly listeners = new Set<() => void>()
  private readonly tabs = new Map<string, ObservedTab>()
  private readonly dismissed = new Map<string, string | undefined>()
  /** View preferences only; task/attempt facts always come from the current Host projection. */
  private readonly workspaceSelections = new Map<string, TeamWorkspaceSelection>()
  private state: TeamDashboardSurfaceState = INACTIVE
  private sidebar: TeamSidebar | undefined
  private sidebarEpoch = 0
  private navigationEpoch = 0
  private disposed = false
  private mounted = false
  private observedSessionId: string | undefined
  private offController = (): void => {}
  private offSessions = (): void => {}

  constructor(private readonly options: Options) {}
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'zh-CN' | 'en-US' => this.options.locale.getLocale().active === 'zh' ? 'zh-CN' : 'en-US'

  getWorkspaceSelection(binding: TeamBinding): TeamWorkspaceSelection {
    return this.workspaceSelections.get(JSON.stringify([binding.rootSessionId, binding.teamId])) ?? EMPTY_TEAM_SELECTION
  }
  updateWorkspaceSelection(binding: TeamBinding, patch: Partial<TeamWorkspaceSelection>): void {
    if (this.disposed) return
    const active = this.options.controller.getSnapshot().data?.projection.binding
    if (active?.rootSessionId !== binding.rootSessionId || active.teamId !== binding.teamId) return
    const previous = this.getWorkspaceSelection(binding)
    if (Object.entries(patch).every(([key, value]) => previous[key as keyof TeamWorkspaceSelection] === value)) return
    this.workspaceSelections.set(JSON.stringify([binding.rootSessionId, binding.teamId]), Object.freeze({ ...previous, ...patch }))
    for (const listener of this.listeners) listener()
  }

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
      this.navigationEpoch++
      if (current === undefined) this.options.controller.close()
      else {
        this.options.controller.open(current)
        if (this.options.controller.getSnapshot().phase !== 'ready') this.publish(INACTIVE)
      }
    })
    this.observedSessionId = this.options.sessions.list.getSnapshot().current
    if (this.observedSessionId !== undefined) this.options.controller.open(this.observedSessionId)
    return () => { this.dispose() }
  }

  bindSidebar(sidebar: TeamSidebar): () => void {
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
    const check = this.navigationGuard()
    await this.options.controller.openCaptainChat((id, signal) => this.openOfficialCaptain(id, signal, check))
  }

  async requestCommunication(choice: TeamCommunicationChoice): Promise<void> {
    this.assertLive()
    const send = this.options.sendCaptainPrompt
    if (send === undefined) throw new Error('Official Captain prompt service is unavailable')
    await queueCommunicationChange({ sessions: this.options.sessions, controller: this.options.controller, choice, send })
  }

  async openMainChat(): Promise<void> {
    const check = this.navigationGuard()
    await this.options.controller.openMainChat((id, signal) => {
      signal.throwIfAborted()
      check()
      const sessions = this.options.sessions
      const list = sessions.list.getSnapshot()
      const row = list.byId[id as SessionId]
      if (list.current !== this.observedSessionId || row === undefined || row.origin === 'subagent' || row.parentId !== undefined) {
        throw new Error('Main conversation is not in the current official root Session list')
      }
      sessions.open(id as SessionId)
    })
  }

  private async openOfficialCaptain(id: string, signal: AbortSignal | undefined, check: () => void): Promise<void> {
    check()
    const sessions = this.options.sessions
    const before = sessions.list.getSnapshot()
    const row = before.byId[id as SessionId]
    if (row === undefined) throw new Error('Dedicated Captain is no longer in the official Session list')
    if (row.origin !== 'subagent') { sessions.open(id as SessionId); return }
    if (row.parentId === undefined) throw new Error('Dedicated Captain has no official parent child catalog')
    await sessions.refreshSubagents(row.parentId)
    signal?.throwIfAborted()
    check()
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
    const check = this.navigationGuard()
    const target = this.options.sessions.list.getSnapshot().current
    await this.options.controller.openMemberChat(name, sessionId, async (captainId, memberId, signal) => {
      const sessions = this.options.sessions
      await sessions.refreshSubagents(captainId as SessionId)
      signal.throwIfAborted()
      check()
      if (sessions.list.getSnapshot().current !== target) throw new Error('Member Chat handoff was superseded')
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
    await this.openOfficialCaptain(captainSessionId, undefined, this.navigationGuard())
  }

  private navigationGuard(): () => void {
    const epoch = this.navigationEpoch
    const target = this.options.sessions.list.getSnapshot().current
    const binding = this.options.controller.getSnapshot().data?.projection.binding
    return () => {
      this.assertLive()
      const read = this.options.controller.getSnapshot()
      if (this.navigationEpoch !== epoch || read.phase !== 'ready'
        || target === undefined || read.targetSessionId !== target
        || binding === undefined || read.data?.projection.binding.teamId !== binding.teamId
        || read.data?.projection.binding.rootSessionId !== binding.rootSessionId
        || this.options.sessions.list.getSnapshot().current !== target) {
        throw new Error('Team Chat handoff was superseded')
      }
    }
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
    // Session selection can precede the official seat's React binding. Address
    // the adopted Session store exactly; never borrow the previous seat. A first
    // visit may not be adopted yet, so only observeTab confirms the lease and
    // the existing authoritative read cadence can retry until it is mounted.
    try { this.sidebar.openTabIn(sessionId as SessionId, TEAM_TAB_KIND) } catch { this.publish(INACTIVE) }
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
    this.tabs.clear(); this.dismissed.clear(); this.workspaceSelections.clear()
    this.publish(INACTIVE)
    this.options.controller.dispose()
    this.listeners.clear()
  }
  private assertLive(): void { if (this.disposed) throw new Error('Team dashboard surface coordinator is disposed') }
}
