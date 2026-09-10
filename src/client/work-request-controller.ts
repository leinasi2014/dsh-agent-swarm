import { draftDashboardConnection, adoptPersistedDraft } from './draft-controller-helpers.js'
import type { WorkActivity, WorkRequest } from '../shared/work-request.js'
import type { WorkActivityResponse, WorkResponse } from '../rpc/work-rpc-contract.js'
import type { TeamDashboardState } from './team-dashboard-controller.js'
import { WorkRequestDraftStore, emptyWorkDraft, type WorkRequestDraft, type WorkRequestPending, type WorkRequestDraftSnapshot } from './work-request-draft-store.js'
import { WorkRpcError, type WorkRequestClient } from './work-rpc-client.js'

interface Selection { readonly key: string; readonly viewer: string; readonly main: string; readonly captain: string; readonly team: string; readonly revision: number }
type StorageStatus = 'loading' | 'ready' | 'saving' | 'conflict' | 'unavailable'
export type WorkDraftPersistence = Pick<WorkRequestDraftStore, 'read' | 'writeDraft' | 'freeze' | 'settle' | 'close'>
interface Saved {
  draft: WorkRequestDraft; persisted: WorkRequestDraft; pending?: WorkRequestPending; lastSubmitted?: WorkRequest
  status: StorageStatus; write: Promise<void>; hydrate?: Promise<void>; versionFloor: number; formOpen: boolean
}
export interface WorkRequestState {
  readonly selection: Selection | undefined; readonly verified: boolean
  readonly draft: WorkRequestDraft; readonly draftStatus: StorageStatus; readonly formOpen: boolean
  readonly pending: boolean; readonly sending: boolean; readonly lastSubmitted: WorkRequest | undefined
  readonly entries: readonly WorkActivity[]; readonly referencedRequests: readonly WorkRequest[]
  readonly activity: WorkActivityResponse | undefined; readonly loading: boolean; readonly error: string | undefined
}
const initial: WorkRequestState = Object.freeze({ selection: undefined, verified: false, draft: emptyWorkDraft(), draftStatus: 'loading', formOpen: false,
  pending: false, sending: false, lastSubmitted: undefined, entries: [], referencedRequests: [], activity: undefined, loading: false, error: undefined })

/** View and operation ownership only. The dashboard owns refresh timing; the Host owns work facts. */
export class WorkRequestController {
  private state = initial
  private readonly listeners = new Set<() => void>()
  private readonly saved = new Map<string, Saved>()
  private readonly busy = new Set<string>()
  private readonly lifetime = new AbortController()
  private read: AbortController | undefined
  private reading: Promise<void> | undefined
  private refreshPending = false
  private dashboardData: TeamDashboardState['data']
  private activityCursor = 0
  private disposed = false
  constructor(private readonly client: Pick<WorkRequestClient, 'submit' | 'requestResult' | 'activity'>,
    private readonly environment: string, private readonly drafts: WorkDraftPersistence = new WorkRequestDraftStore(),
    private readonly requestId: () => string = () => crypto.randomUUID()) {}
  getSnapshot = (): WorkRequestState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  connect = draftDashboardConnection(this)
  bind(dashboard: TeamDashboardState): void {
    const data = dashboard.data, viewer = dashboard.targetSessionId, main = data?.teams.binding.mainSessionId
    const binding = data?.projection.binding
    const next: Selection | undefined = dashboard.phase === 'ready' && data !== undefined && viewer !== undefined && main !== undefined
      && binding !== undefined && data.teams.complete && data.teams.binding.rootSessionId === viewer
      && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === binding.teamId)
      ? { key: `swarm.work.v1:${JSON.stringify([this.environment, main, binding.teamId])}`, viewer, main, captain: binding.rootSessionId, team: binding.teamId, revision: data.projection.team.revision } : undefined
    const previous = this.state.selection
    if (next === undefined) {
      this.read?.abort(); this.refreshPending = false
      const sameTeam = previous !== undefined && data !== undefined && binding?.rootSessionId === previous.captain && binding.teamId === previous.team
        && main === previous.main && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === previous.team)
        && ['ready', 'stale', 'reconnecting'].includes(dashboard.phase) && (viewer === previous.viewer || viewer === main || viewer === previous.captain
          || data.captainMembers.members.some(member => member.sessionId === viewer && member.phase === 'active'))
      this.publish(sameTeam ? { ...this.state, verified: false, loading: false } : { ...initial })
      return
    }
    const changed = previous?.key !== next.key || previous.captain !== next.captain
    const reread = changed || previous?.viewer !== next.viewer || !this.state.verified || this.dashboardData !== data
    this.dashboardData = data
    if (changed || previous?.viewer !== next.viewer) { this.read?.abort(); this.reading = undefined; this.refreshPending = false }
    if (changed) this.activityCursor = 0
    const saved = this.readSaved(next.key)
    this.publish({ ...(changed ? initial : this.state), selection: next, verified: true,
      draft: saved.draft, draftStatus: saved.status, formOpen: saved.formOpen, pending: saved.pending !== undefined,
      sending: this.busy.has(next.key), lastSubmitted: saved.lastSubmitted })
    if (saved.hydrate === undefined) saved.hydrate = this.hydrate(next.key, saved)
    if (reread) void this.refresh()
  }
  setFormOpen(open: boolean): void {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key); saved.formOpen = open; this.updateSaved(key, saved)
  }
  edit(field: 'description' | 'acceptanceCriteria', text: string): void {
    const key = this.state.selection?.key
    if (key === undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(key)
    const draft = { ...saved.draft, [field]: text, version: Math.max(saved.draft.version, saved.versionFloor) + 1 }
    saved.draft = draft; saved.versionFloor = draft.version; delete saved.lastSubmitted
    if (saved.status === 'ready' || saved.status === 'saving') {
      saved.status = 'saving'; void this.queueWrite(key, saved, version => this.drafts.writeDraft(key, draft, version), draft)
    }
    this.updateSaved(key, saved)
  }
  async refresh(): Promise<void> {
    const selected = this.state.selection
    if (!this.state.verified || selected === undefined || this.disposed) return
    if (this.reading !== undefined && !this.read?.signal.aborted) { this.refreshPending = true; return await this.reading }
    const read = this.read = new AbortController()
    const afterSequence = this.activityCursor
    this.publish({ ...this.state, loading: true })
    const operation = (async () => {
      try {
        const page = await this.client.activity({ schemaVersion: 1, target: { rootSessionId: selected.captain, teamId: selected.team }, afterSequence, limit: 100 }, read.signal)
        this.checkBinding(page, selected); read.signal.throwIfAborted()
        if (!this.isReadCurrent(selected)) return
        const merged = new Map(this.state.entries.map(row => [row.id, row]))
        for (const row of page.entries) {
          const old = merged.get(row.id)
          if (old !== undefined && JSON.stringify(old) !== JSON.stringify(row)) throw new Error('Work activity identity changed')
          merged.set(row.id, row)
        }
        const entries = [...merged.values()].filter(row => row.sequence >= page.retainedFromSequence).toSorted((a, b) => a.sequence - b.sequence)
        const referenced = new Map(this.state.referencedRequests.map(row => [row.id, row]))
        for (const request of page.referencedRequests) if ((referenced.get(request.id)?.revision ?? -1) <= request.revision) referenced.set(request.id, request)
        const visibleRequestIds = new Set(entries.map(row => row.workRequestId))
        // Only the page advances its cursor; submit receipts never skip activity.
        this.activityCursor = page.entries.at(-1)?.sequence ?? (page.hasMore ? afterSequence : page.throughSequence)
        this.publish({ ...this.state, loading: false, error: undefined, activity: page, entries,
          referencedRequests: [...referenced.values()].filter(row => visibleRequestIds.has(row.id)) })
      } catch (error) {
        if (!read.signal.aborted && this.isReadCurrent(selected)) this.publish({ ...this.state, loading: false, error: errorText(error) })
      }
    })()
    this.reading = operation
    try { await operation } finally {
      if (this.read === read) {
        this.reading = undefined
        const refresh = this.refreshPending; this.refreshPending = false
        if (refresh && !read.signal.aborted && this.isReadCurrent(selected)) void this.refresh()
      }
    }
  }
  async more(): Promise<void> { if (!this.state.loading && this.state.activity?.hasMore) await this.refresh() }
  async send(): Promise<void> {
    const selected = this.state.selection, limits = this.state.activity?.limits
    if (!this.state.verified || selected === undefined || this.state.activity?.submitEligibility.state !== 'available' || limits === undefined) return
    const saved = this.readSaved(selected.key), draft = saved.draft
    if (saved.pending !== undefined || this.busy.has(selected.key) || !['ready', 'saving'].includes(saved.status)
      || !draft.description.trim() || draft.description.trim().length > limits.maxDescriptionChars || draft.acceptanceCriteria.trim().length > limits.maxAcceptanceCriteriaChars) return
    const pending: WorkRequestPending = { version: draft.version, request: { schemaVersion: 1, target: { rootSessionId: selected.captain, teamId: selected.team },
      requestId: this.requestId(), description: draft.description.trim(), ...(draft.acceptanceCriteria.trim() ? { acceptanceCriteria: draft.acceptanceCriteria.trim() } : {}) } }
    this.busy.add(selected.key); this.updateSaved(selected.key, saved)
    try {
      const frozen = await this.queueWrite(selected.key, saved, version => this.drafts.freeze(selected.key, draft, pending, version), draft)
      if (frozen?.pending !== undefined) await this.submit(selected, saved, frozen.pending, false)
    } finally { this.busy.delete(selected.key); this.updateSaved(selected.key, saved) }
  }
  async recover(): Promise<void> {
    const selected = this.state.selection
    if (!this.state.verified || selected === undefined || this.busy.has(selected.key)) return
    const saved = this.readSaved(selected.key)
    if (saved.pending === undefined || !['ready', 'saving'].includes(saved.status)) return
    this.busy.add(selected.key); this.updateSaved(selected.key, saved)
    try { await saved.write; if (saved.pending !== undefined && ['ready', 'saving'].includes(saved.status)) await this.submit(selected, saved, saved.pending, true) }
    finally { this.busy.delete(selected.key); this.updateSaved(selected.key, saved) }
  }
  private async submit(selected: Selection, saved: Saved, pending: WorkRequestPending, recover: boolean): Promise<void> {
    let rejectedBeforeCommit = false
    try {
      if (pending.request.target.teamId !== selected.team || pending.request.target.rootSessionId !== selected.captain) throw new Error('Stored work belongs to a different Captain binding')
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)])
      const outcome = recover ? await this.client.requestResult({ schemaVersion: 1, target: pending.request.target, requestId: pending.request.requestId }, signal) : undefined
      if (outcome !== undefined) this.checkBinding(outcome, selected)
      let response
      try { response = outcome?.state === 'committed' ? outcome : await this.client.submit(pending.request, signal) }
      catch (error) {
        rejectedBeforeCommit = error instanceof WorkRpcError && ['TEAM_MAILBOX_FULL', 'TEAM_WORK_REQUEST_CAPACITY', 'TEAM_INPUT_INVALID', 'TEAM_INPUT_LIMIT',
          'TEAM_WORK_REQUEST_SOURCE_INVALID', 'TEAM_WORK_REQUEST_ORIGIN_INVALID', 'TEAM_REVISION_CONFLICT', 'SWARM_RPC_INVALID_REQUEST'].includes(error.code)
        throw error
      }
      this.checkBinding(response, selected)
      const request = response.request
      if (request.requestId !== pending.request.requestId || request.origin.kind !== 'local-operator' || request.description !== pending.request.description
        || (request.acceptanceCriteria ?? '') !== (pending.request.acceptanceCriteria ?? '')) throw new Error('Work request receipt differs from frozen operation')
      saved.versionFloor = Math.max(saved.versionFloor, pending.version + 1)
      const settled = await this.queueWrite(selected.key, saved, () => this.drafts.settle(selected.key, pending.request.requestId, pending.version, true), undefined, pending.version)
      if (settled !== undefined) saved.lastSubmitted = request
      if (this.isOperationCurrent(selected)) { this.publish({ ...this.state, error: undefined }); void this.refresh() }
    } catch (error) {
      if (rejectedBeforeCommit) await this.queueWrite(selected.key, saved, () => this.drafts.settle(selected.key, pending.request.requestId, pending.version, false))
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, error: errorText(error) })
    } finally { this.updateSaved(selected.key, saved) }
  }
  private checkBinding(response: WorkResponse, selected: Selection): void {
    if (response.binding.rootSessionId !== selected.captain || response.binding.teamId !== selected.team || response.teamRevision < selected.revision) throw new Error('Work binding or revision changed')
  }
  private isReadCurrent(selected: Selection): boolean { return this.isOperationCurrent(selected) && this.state.verified && this.state.selection?.viewer === selected.viewer }
  private isOperationCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.captain === selected.captain }
  private readSaved(key: string): Saved {
    const existing = this.saved.get(key)
    if (existing !== undefined) return existing
    const saved: Saved = { draft: emptyWorkDraft(), persisted: emptyWorkDraft(), status: 'loading', write: Promise.resolve(), versionFloor: 0, formOpen: false }
    this.saved.set(key, saved); return saved
  }
  private async hydrate(key: string, saved: Saved): Promise<void> {
    try {
      const stored = await this.drafts.read(key)
      saved.draft = stored.draft; saved.persisted = stored.draft
      if (stored.pending === undefined) delete saved.pending; else saved.pending = stored.pending
      saved.versionFloor = Math.max(saved.versionFloor, stored.draft.version); saved.status = 'ready'
    } catch { saved.status = 'unavailable' }
    this.updateSaved(key, saved)
  }
  private queueWrite(key: string, saved: Saved, write: (version: number) => Promise<WorkRequestDraftSnapshot>, draft?: WorkRequestDraft, clearVersion?: number): Promise<WorkRequestDraftSnapshot | undefined> {
    const operation = saved.write.then(async () => {
      if (!['ready', 'saving'].includes(saved.status)) return undefined
      const prior = saved.persisted
      try {
        const value = await write(prior.version)
        if (value.pending === undefined) delete saved.pending; else saved.pending = value.pending
        const ownClear = clearVersion === prior.version && value.draft.version === prior.version + 1 && value.draft.description === '' && value.draft.acceptanceCriteria === ''
        if (draft === undefined && value.draft.version !== prior.version && !ownClear && saved.draft.version !== prior.version) saved.status = 'conflict'
        else {
          adoptPersistedDraft(saved, value.draft, (draft ?? prior).version)
        }
        this.updateSaved(key, saved); return value
      } catch (error) {
        saved.status = /revision conflict|pending operation already exists/u.test(errorText(error)) ? 'conflict' : 'unavailable'
        this.updateSaved(key, saved); return undefined
      }
    })
    saved.write = operation.then(() => {}); return operation
  }
  async retryDraftStorage(): Promise<void> {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key); await saved.write
    if (saved.status !== 'unavailable') return
    if (saved.draft.version === saved.persisted.version) { saved.status = 'loading'; this.updateSaved(key, saved); await this.hydrate(key, saved); return }
    saved.status = 'saving'
    const draft = saved.draft
    await this.queueWrite(key, saved, version => this.drafts.writeDraft(key, draft, version), draft)
  }
  async useStoredDraft(): Promise<void> {
    const key = this.state.selection?.key
    if (key === undefined || this.busy.has(key)) return
    const saved = this.readSaved(key); await saved.write
    saved.status = 'loading'; this.updateSaved(key, saved); await this.hydrate(key, saved)
  }
  private updateSaved(key: string, saved: Saved): void {
    if (this.state.selection?.key === key) this.publish({ ...this.state, draft: saved.draft, draftStatus: saved.status,
      pending: saved.pending !== undefined, sending: this.busy.has(key), lastSubmitted: saved.lastSubmitted, formOpen: saved.formOpen })
  }
  private publish(state: WorkRequestState): void { if (this.disposed) return; this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  dispose(): void {
    this.disposed = true; this.read?.abort(); this.lifetime.abort(); this.listeners.clear()
    void Promise.all([...this.saved.values()].map(saved => saved.write)).then(() => { this.drafts.close() })
  }
}
function errorText(error: unknown): string { return error instanceof WorkRpcError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error) }
