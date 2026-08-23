import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type {
  SwarmReadBindingV1,
  SwarmReadCapabilitiesV1,
  SwarmReadPageKind,
  SwarmReadPageV1,
} from '../rpc/read-rpc-contract.js'
import { SwarmReadClient, type SwarmReadClientMount } from './read-client.js'

export type TeamDashboardPhase = 'closed' | 'loading' | 'ready' | 'stale' | 'reconnecting' | 'error'

export interface TeamDashboardData {
  readonly capabilities: SwarmReadCapabilitiesV1
  readonly projection: SwarmHostReadProjectionV1
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

  /** Re-prove the exact Host binding, then delegate navigation to the official Session service. */
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
    const [tasks, attempts, pendingInteractions] = await Promise.all([
      this.readAllPages('tasks', target, snapshot.cursor, signal),
      this.readAllPages('attempts', target, snapshot.cursor, signal),
      this.readAllPages('pendingInteractions', target, snapshot.cursor, signal),
    ])
    return {
      capabilities,
      projection: Object.freeze({ ...snapshot, tasks, attempts, pendingInteractions }),
    }
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
    cursor: string,
    signal: AbortSignal,
  ): Promise<PageEntries[K]> {
    const entries: unknown[] = []
    let offset = 0
    for (;;) {
      const page = await this.value({
        schemaVersion: 1,
        method: 'page',
        target,
        afterCursor: cursor,
        page: { kind, offset, limit: 50 },
      }, signal) as SwarmReadPageV1
      if (page.kind !== kind || page.cursor !== cursor || page.offset !== offset) {
        throw new DashboardReadError('SWARM_UI_CURSOR_CHANGED', 'Team projection changed while paging')
      }
      entries.push(...page.entries)
      if (page.nextOffset === undefined) return Object.freeze(entries) as PageEntries[K]
      if (page.nextOffset !== offset + page.entries.length || page.nextOffset <= offset) {
        throw new DashboardReadError('SWARM_UI_PAGE_INVALID', 'Team page did not advance exactly')
      }
      offset = page.nextOffset
    }
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

function assertIdentity(binding: SwarmReadBindingV1, snapshot: SwarmHostReadProjectionV1): void {
  if (binding.binding.rootSessionId !== snapshot.binding.rootSessionId
    || binding.binding.teamId !== snapshot.binding.teamId
    || binding.team.id !== snapshot.team.id) {
    throw new DashboardReadError('SWARM_UI_BINDING_CHANGED', 'Team binding changed while loading')
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
