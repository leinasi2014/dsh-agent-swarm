import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type {
  SwarmReadBindingV1,
  SwarmReadCapabilitiesV1,
  SwarmReadCaptainAnnouncementsV1,
  SwarmReadCaptainDiagnosticsV1,
  SwarmReadCaptainMembersV1,
  SwarmReadCaptainSectionMethod,
  SwarmReadPageKind,
  SwarmReadPageV1,
  SwarmReadTeamsV1,
} from '../rpc/read-rpc-contract.js'
import { SwarmReadClient, type SwarmReadClientMount } from './read-client.js'

export type TeamDashboardPhase = 'closed' | 'loading' | 'ready' | 'stale' | 'reconnecting' | 'error'

export interface TeamDashboardData {
  readonly capabilities: SwarmReadCapabilitiesV1
  readonly projection: SwarmHostReadProjectionV1
  readonly teams: SwarmReadTeamsV1
  readonly captainAnnouncements: SwarmReadCaptainAnnouncementsV1
  readonly captainDiagnostics: SwarmReadCaptainDiagnosticsV1
  readonly captainMembers: SwarmReadCaptainMembersV1
}

export interface TeamDashboardState {
  readonly open: boolean
  readonly phase: TeamDashboardPhase
  readonly targetSessionId?: string
  readonly data?: TeamDashboardData
  readonly error?: { readonly code: string; readonly message: string }
}

export interface TeamDashboardSchedule {
  set(delayMs: number, callback: () => void): unknown
  clear(handle: unknown): void
}

type PageEntries = {
  tasks: SwarmHostReadProjectionV1['tasks']
  attempts: SwarmHostReadProjectionV1['attempts']
  pendingInteractions: SwarmHostReadProjectionV1['pendingInteractions']
}

const PAGE_LIMIT = 50
const PAGE_CEILINGS: Readonly<Record<SwarmReadPageKind, number>> = Object.freeze({
  tasks: 100,
  attempts: 200,
  pendingInteractions: 100,
})

const browserSchedule: TeamDashboardSchedule = {
  set: (delayMs, callback) => globalThis.setTimeout(callback, delayMs),
  clear: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const CLOSED: TeamDashboardState = Object.freeze({ open: false, phase: 'closed' })

class DashboardReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** One client-plugin lifetime. It performs no read until a user opens the Team surface. */
export class TeamDashboardController {
  private readonly mount: SwarmReadClientMount
  private readonly listeners = new Set<() => void>()
  private state: TeamDashboardState = CLOSED
  private requestAbort: AbortController | undefined
  private timer: unknown
  private generation = 0
  private disposed = false

  constructor(
    client: SwarmReadClient = new SwarmReadClient(),
    private readonly schedule: TeamDashboardSchedule = browserSchedule,
    private readonly pollMs = 5_000,
    private readonly retryMs = 3_000,
  ) {
    this.mount = client.mount()
  }

  getSnapshot = (): TeamDashboardState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(targetSessionId: string): void {
    this.assertLive()
    if (targetSessionId.length === 0) throw new Error('Team dashboard target Session is empty')
    this.stopActive()
    this.publish({ open: true, phase: 'loading', targetSessionId })
    void this.load(targetSessionId, false)
  }

  close(): void {
    if (this.disposed) return
    this.stopActive()
    this.publish(CLOSED)
  }

  refresh(): void {
    this.assertLive()
    const target = this.state.targetSessionId
    if (!this.state.open || target === undefined) return
    this.stopActive()
    this.publish(withoutError(this.state, this.state.data === undefined ? 'loading' : 'reconnecting'))
    void this.load(target, false)
  }

  reconnect(): void {
    this.refresh()
  }

  /** A connection generation reset makes cached data stale until a fresh Host projection succeeds. */
  connectionReset(): void {
    if (!this.state.open || this.state.targetSessionId === undefined) return
    this.stopActive()
    this.publish({ ...this.state, phase: this.state.data === undefined ? 'reconnecting' : 'stale' })
    this.scheduleLoad(this.state.targetSessionId, 0, true)
  }

  /** Re-prove the exact Host binding, then delegate navigation to the official Session service.
   *  binding.rootSessionId is the host-resolved dedicated Captain Session id (the Team root of this
   *  read), not the system Main Brain / owner main Chat. */
  async openCaptainChat(openOfficialSession: (rootSessionId: string) => void): Promise<void> {
    this.assertLive()
    const current = this.state
    const target = current.targetSessionId
    const expected = current.data?.projection.binding
    if (!current.open || target === undefined || expected === undefined) {
      throw new Error('Captain Chat handoff requires a current Team binding')
    }
    this.stopActive()
    const abort = new AbortController()
    this.requestAbort = abort
    try {
      const binding = await this.readBinding(target, expected.teamId, abort.signal)
      if (binding.binding.rootSessionId !== expected.rootSessionId || binding.binding.teamId !== expected.teamId) {
        throw new DashboardReadError('SWARM_UI_BINDING_CHANGED', 'Team binding changed before Captain Chat handoff')
      }
      openOfficialSession(binding.binding.rootSessionId)
      this.close()
    } catch (error) {
      if (abort.signal.aborted) throw error
      const failure = normalizeError(error)
      this.publish({ ...this.state, phase: this.state.data === undefined ? 'error' : 'stale', error: failure })
      throw error
    } finally {
      if (this.requestAbort === abort) this.requestAbort = undefined
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.stopActive()
    this.disposed = true
    this.mount.dispose()
    this.state = CLOSED
    this.listeners.clear()
  }

  private async load(targetSessionId: string, reconnecting: boolean): Promise<void> {
    const generation = ++this.generation
    const abort = new AbortController()
    this.requestAbort = abort
    if (reconnecting && this.state.open) {
      this.publish(withoutError(this.state, 'reconnecting'))
    }
    try {
      let data: TeamDashboardData
      try {
        data = await this.readComplete(targetSessionId, abort.signal)
      } catch (error) {
        if (!(error instanceof DashboardReadError) || error.code !== 'SWARM_UI_CURSOR_CHANGED') throw error
        data = await this.readComplete(targetSessionId, abort.signal)
      }
      if (!this.isCurrent(generation, targetSessionId, abort)) return
      this.publish({ open: true, phase: 'ready', targetSessionId, data })
      this.scheduleLoad(targetSessionId, this.pollMs, false)
    } catch (error) {
      if (abort.signal.aborted || !this.isCurrent(generation, targetSessionId, abort)) return
      const failure = normalizeError(error)
      this.publish({
        ...this.state,
        open: true,
        phase: this.state.data === undefined ? 'error' : 'stale',
        targetSessionId,
        error: failure,
      })
      this.scheduleLoad(targetSessionId, this.retryMs, true)
    } finally {
      if (this.requestAbort === abort) this.requestAbort = undefined
    }
  }

  private async readComplete(targetSessionId: string, signal: AbortSignal): Promise<TeamDashboardData> {
    const capabilities = await this.readCapabilities(signal)
    const binding = await this.readBinding(targetSessionId, undefined, signal)
    const target = { rootSessionId: binding.binding.rootSessionId, teamId: binding.binding.teamId }
    const previousCursor = this.state.targetSessionId === targetSessionId
      ? this.state.data?.projection.cursor : undefined
    const snapshot = await this.readSnapshot(target, previousCursor, signal)
    assertIdentity(binding, snapshot)
    const teams = await this.readTeams(binding.binding.rootSessionId, signal)
    // Captain board sections are real reads against the same binding; today the host answers
    // announcements with an explicit bounded unavailable, never a stub or fabricated posts.
    const sectionTarget = { rootSessionId: binding.binding.rootSessionId, teamId: binding.binding.teamId }
    const [captainAnnouncements, captainDiagnostics, captainMembers] = await Promise.all([
      this.readCaptainSection('captainAnnouncements', sectionTarget, signal) as Promise<SwarmReadCaptainAnnouncementsV1>,
      this.readCaptainSection('captainDiagnostics', sectionTarget, signal) as Promise<SwarmReadCaptainDiagnosticsV1>,
      this.readCaptainSection('captainMembers', sectionTarget, signal) as Promise<SwarmReadCaptainMembersV1>,
    ])
    assertSectionBinding(binding, captainAnnouncements.binding, 'captainAnnouncements')
    assertSectionBinding(binding, captainDiagnostics.binding, 'captainDiagnostics')
    assertSectionBinding(binding, captainMembers.binding, 'captainMembers')
    const [tasks, attempts, pendingInteractions] = await Promise.all([
      this.readAllPages('tasks', target, snapshot, signal),
      this.readAllPages('attempts', target, snapshot, signal),
      this.readAllPages('pendingInteractions', target, snapshot, signal),
    ])
    return {
      capabilities,
      projection: Object.freeze({ ...snapshot, tasks, attempts, pendingInteractions }),
      teams,
      captainAnnouncements,
      captainDiagnostics,
      captainMembers,
    }
  }

  private async readCaptainSection(
    method: SwarmReadCaptainSectionMethod,
    target: { readonly rootSessionId: string; readonly teamId: string },
    signal: AbortSignal,
  ): Promise<SwarmReadCaptainAnnouncementsV1 | SwarmReadCaptainDiagnosticsV1 | SwarmReadCaptainMembersV1> {
    return await this.value({ schemaVersion: 1, method, target }, signal) as SwarmReadCaptainAnnouncementsV1 | SwarmReadCaptainDiagnosticsV1 | SwarmReadCaptainMembersV1
  }

  private async readTeams(rootSessionId: string, signal: AbortSignal): Promise<SwarmReadTeamsV1> {
    return await this.value({
      schemaVersion: 1,
      method: 'teams',
      target: { rootSessionId },
    }, signal) as SwarmReadTeamsV1
  }

  private async readCapabilities(signal: AbortSignal): Promise<SwarmReadCapabilitiesV1> {
    const value = await this.value({ schemaVersion: 1, method: 'capabilities' }, signal) as SwarmReadCapabilitiesV1
    if (value.trust.listener !== 'loopback' || value.trust.principalBound !== false
      || value.trust.mode !== 'local-single-user-target-bound') {
      throw new DashboardReadError('SWARM_UI_TRUST_UNAVAILABLE', 'The local read-only trust boundary is unavailable')
    }
    return value
  }

  private async readBinding(
    rootSessionId: string,
    teamId: string | undefined,
    signal: AbortSignal,
  ): Promise<SwarmReadBindingV1> {
    return await this.value({
      schemaVersion: 1,
      method: 'binding',
      target: { rootSessionId, ...(teamId === undefined ? {} : { teamId }) },
    }, signal) as SwarmReadBindingV1
  }

  private async readSnapshot(
    target: { readonly rootSessionId: string; readonly teamId: string },
    afterCursor: string | undefined,
    signal: AbortSignal,
  ): Promise<SwarmHostReadProjectionV1> {
    return await this.value({
      schemaVersion: 1,
      method: 'snapshot',
      target,
      ...(afterCursor === undefined ? {} : { afterCursor }),
    }, signal) as SwarmHostReadProjectionV1
  }

  private async readAllPages<K extends SwarmReadPageKind>(
    kind: K,
    target: { readonly rootSessionId: string; readonly teamId: string },
    snapshot: SwarmHostReadProjectionV1,
    signal: AbortSignal,
  ): Promise<PageEntries[K]> {
    const entries: unknown[] = []
    const ids = new Set<string>()
    const ceiling = PAGE_CEILINGS[kind]
    const expectedVisible = snapshot[kind].length
    const expectedAuthoritative = snapshot.totals[kind]
    const expectedTruncated = snapshot.truncated[kind]
    if (expectedVisible > ceiling) throw new DashboardReadError('SWARM_UI_PAGE_LIMIT', 'Snapshot exceeds the read projection ceiling')
    let offset = 0
    for (let pageNumber = 1; pageNumber <= Math.ceil(ceiling / PAGE_LIMIT); pageNumber += 1) {
      const page = await this.value({
        schemaVersion: 1,
        method: 'page',
        target,
        afterCursor: snapshot.cursor,
        page: { kind, offset, limit: PAGE_LIMIT },
      }, signal) as SwarmReadPageV1
      if (page.kind !== kind || page.cursor !== snapshot.cursor || page.offset !== offset) {
        throw new DashboardReadError('SWARM_UI_CURSOR_CHANGED', 'Team projection changed while paging')
      }
      if (page.limit !== PAGE_LIMIT || page.visibleTotal !== expectedVisible
        || page.authoritativeTotal !== expectedAuthoritative || page.projectionTruncated !== expectedTruncated) {
        throw new DashboardReadError('SWARM_UI_PAGE_INVALID', 'Team page totals drifted from the snapshot')
      }
      for (const entry of page.entries) {
        const id = pageEntryId(kind, entry)
        if (ids.has(id)) throw new DashboardReadError('SWARM_UI_PAGE_INVALID', 'Team pages repeated a stable row id')
        ids.add(id)
      }
      entries.push(...page.entries)
      if (entries.length > ceiling) throw new DashboardReadError('SWARM_UI_PAGE_LIMIT', 'Team pages exceed the read projection ceiling')
      if (page.nextOffset === undefined) {
        if (entries.length !== expectedVisible) {
          throw new DashboardReadError('SWARM_UI_PAGE_INVALID', 'Terminal Team page did not complete the visible projection')
        }
        return Object.freeze(entries) as PageEntries[K]
      }
      if (page.nextOffset !== offset + page.entries.length || page.nextOffset <= offset) {
        throw new DashboardReadError('SWARM_UI_PAGE_INVALID', 'Team page did not advance exactly')
      }
      offset = page.nextOffset
    }
    throw new DashboardReadError('SWARM_UI_PAGE_LIMIT', 'Team paging exceeded the bounded projection page count')
  }

  private async value(request: Parameters<SwarmReadClientMount['request']>[0], signal: AbortSignal): Promise<unknown> {
    const envelope = await this.mount.request(request, signal)
    if (!envelope.ok) throw new DashboardReadError(envelope.error.code, envelope.error.message)
    return envelope.value
  }

  private scheduleLoad(targetSessionId: string, delayMs: number, reconnecting: boolean): void {
    this.clearTimer()
    this.timer = this.schedule.set(delayMs, () => {
      this.timer = undefined
      if (this.state.open && this.state.targetSessionId === targetSessionId) {
        void this.load(targetSessionId, reconnecting)
      }
    })
  }

  private stopActive(): void {
    this.generation += 1
    this.requestAbort?.abort()
    this.requestAbort = undefined
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    this.schedule.clear(this.timer)
    this.timer = undefined
  }

  private isCurrent(generation: number, targetSessionId: string, abort: AbortController): boolean {
    return !this.disposed && !abort.signal.aborted && generation === this.generation
      && this.state.open && this.state.targetSessionId === targetSessionId
  }

  private publish(next: TeamDashboardState): void {
    this.state = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Team dashboard controller is disposed')
  }
}

function pageEntryId(kind: SwarmReadPageKind, entry: SwarmReadPageV1['entries'][number]): string {
  if (kind === 'tasks') return (entry as PageEntries['tasks'][number]).id
  if (kind === 'attempts') return (entry as PageEntries['attempts'][number]).id
  return (entry as PageEntries['pendingInteractions'][number]).requestId
}

function assertIdentity(binding: SwarmReadBindingV1, snapshot: SwarmHostReadProjectionV1): void {
  if (binding.binding.rootSessionId !== snapshot.binding.rootSessionId
    || binding.binding.teamId !== snapshot.binding.teamId
    || binding.team.id !== snapshot.team.id) {
    throw new DashboardReadError('SWARM_UI_BINDING_CHANGED', 'Team binding changed while loading')
  }
}

/** A captain section bound to a different root/team is stale authority, never mergeable data. */
function assertSectionBinding(
  binding: SwarmReadBindingV1,
  section: { readonly rootSessionId: string; readonly teamId: string },
  method: SwarmReadCaptainSectionMethod,
): void {
  if (binding.binding.rootSessionId !== section.rootSessionId || binding.binding.teamId !== section.teamId) {
    throw new DashboardReadError('SWARM_UI_BINDING_CHANGED', `${method} section binding changed while loading`)
  }
}

function normalizeError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof DashboardReadError) return Object.freeze({ code: error.code, message: error.message })
  if (error instanceof Error) return Object.freeze({ code: 'SWARM_UI_READ_FAILED', message: error.message })
  return Object.freeze({ code: 'SWARM_UI_READ_FAILED', message: String(error) })
}

function withoutError(state: TeamDashboardState, phase: TeamDashboardPhase): TeamDashboardState {
  const { error: _error, ...rest } = state
  return { ...rest, phase }
}
