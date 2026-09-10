import { draftDashboardConnection, adoptPersistedDraft } from './draft-controller-helpers.js'
import type { TeamDashboardState } from './team-dashboard-controller.js'
import { GoalClient, GoalRpcError } from './goal-rpc-client.js'
import { GoalDraftStore, emptyGoalDraft, goalDraftFromSnapshot, goalDefinitionFromDraft,
  type GoalDraft, type GoalPending, type GoalDraftRecord, type GoalDraftOutcome } from './goal-draft-store.js'
import { goalDefinitionSchema, goalTokenBudgetSchema } from '../shared/goal-lifecycle.js'
import type { GoalReadResponse, GoalControlRequest } from '../rpc/goal-rpc-contract.js'

export type GoalDraftPersistence = Pick<GoalDraftStore, 'read' | 'writeDraft' | 'freeze' | 'settle' | 'close'>
interface GoalSelection { key: string; main: string; team: string; captain: string; viewer: string; revision: number }
type DraftStatus = 'loading' | 'ready' | 'saving' | 'conflict' | 'unavailable'
interface Editor {
  draft: GoalDraft; persisted: GoalDraft; record: GoalDraftRecord; versionFloor: number; status: DraftStatus
  write: Promise<void>; hydrate: Promise<void> | undefined; expanded: boolean; editing: boolean
}
export interface GoalState {
  readonly selection: GoalSelection | undefined; readonly verified: boolean; readonly response: GoalReadResponse | undefined
  readonly loading: boolean; readonly error: string | undefined; readonly draft: GoalDraft; readonly draftStatus: DraftStatus
  readonly pending: GoalPending | undefined; readonly outcome: GoalDraftOutcome | undefined; readonly sending: boolean
  readonly expanded: boolean; readonly editing: boolean
}
const blank: GoalState = Object.freeze({ selection: undefined, verified: false, response: undefined, loading: false, error: undefined,
  draft: emptyGoalDraft(), draftStatus: 'loading', pending: undefined, outcome: undefined, sending: false, expanded: false, editing: false })
const errorText = (error: unknown): string => error instanceof GoalRpcError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
const definiteRejections = new Set(['TEAM_GOAL_STALE_REVISION', 'TEAM_GOAL_CONFLICT', 'TEAM_GOAL_NOT_CONFIGURED', 'TEAM_GOAL_PHASE_INVALID',
  'TEAM_GOAL_UNSUPPORTED', 'TEAM_GOAL_BUDGET_REQUIRED', 'TEAM_GOAL_BUDGET_CONFLICT', 'TEAM_GOAL_ORIGIN_INVALID', 'TEAM_MAIN_REQUIRED',
  'TEAM_CAPTAIN_REQUIRED', 'TEAM_ARCHIVED', 'TEAM_INPUT_INVALID', 'TEAM_INPUT_LIMIT', 'TEAM_BUDGET_INVALID', 'TEAM_BUDGET_DEADLINE',
  'TEAM_BUDGET_REQUESTS', 'TEAM_BUDGET_TOKENS', 'TEAM_BUDGET_RETRIES', 'TEAM_MAILBOX_FULL', 'SWARM_RPC_INVALID_REQUEST'])

/** Goal reads follow the existing dashboard subscription. This controller owns no refresh timer or Host facts. */
export class GoalController {
  private value = blank
  private readonly watchers = new Set<() => void>()
  private readonly editors = new Map<string, Editor>()
  private readonly inFlight = new Set<string>()
  private readonly closed = new AbortController()
  private readJob: { abort: AbortController; promise: Promise<void>; repeat: boolean } | undefined
  private seenDashboard: TeamDashboardState['data']
  constructor(private readonly client: Pick<GoalClient, 'read' | 'save' | 'control' | 'requestResult'>, private readonly host: string,
    private readonly drafts: GoalDraftPersistence = new GoalDraftStore(), private readonly nextId: () => string = () => crypto.randomUUID()) {}
  getSnapshot = (): GoalState => this.value
  subscribe = (watcher: () => void): (() => void) => { this.watchers.add(watcher); return () => { this.watchers.delete(watcher) } }
  connect = draftDashboardConnection(this)

  bind(dashboard: TeamDashboardState): void {
    const data = dashboard.data, binding = data?.projection.binding, viewer = dashboard.targetSessionId, main = data?.teams.binding.mainSessionId
    const prior = this.value.selection
    const available = dashboard.phase === 'ready' && dashboard.open && data?.teams.complete && binding !== undefined && viewer !== undefined
      && main !== undefined && data.teams.binding.rootSessionId === viewer && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === binding.teamId)
    if (!available) {
      this.abortRead()
      const related = prior !== undefined && data !== undefined && binding?.rootSessionId === prior.captain && binding.teamId === prior.team
        && main === prior.main && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === prior.team)
        && ['ready', 'stale', 'reconnecting'].includes(dashboard.phase) && (viewer === prior.viewer || viewer === prior.main || viewer === prior.captain
          || data.captainMembers.members.some(member => member.sessionId === viewer && member.phase === 'active'))
      this.emit(related ? { verified: false, loading: false } : blank)
      return
    }
    const selected: GoalSelection = { key: `swarm.goal.v1:${JSON.stringify([this.host, main, binding.teamId])}`, main, team: binding.teamId, captain: binding.rootSessionId,
      viewer, revision: data.projection.team.revision }
    const changed = prior?.key !== selected.key || prior.captain !== selected.captain
    const reread = changed || prior?.viewer !== viewer || !this.value.verified || data !== this.seenDashboard
    this.seenDashboard = data
    if (changed || prior?.viewer !== viewer) this.abortRead()
    const editor = this.editor(selected.key)
    this.emit({ ...(changed ? blank : {}), selection: selected, verified: true })
    this.syncEditor(selected.key, editor)
    editor.hydrate ??= this.hydrate(selected.key, editor)
    if (reread) void this.refresh()
  }
  setExpanded(expanded: boolean): void { const selected = this.value.selection; if (selected) { const editor = this.editor(selected.key); editor.expanded = expanded; this.syncEditor(selected.key, editor) } }
  beginEdit(useLatest = false): void {
    const selected = this.value.selection, response = this.value.response
    if (!selected || !response || !this.value.verified) return
    const editor = this.editor(selected.key)
    if (!['ready', 'saving'].includes(editor.status) || (useLatest && editor.record.pending)) return
    editor.expanded = true; editor.editing = true
    if (!editor.draft.initialized || !editor.draft.dirty || useLatest) {
      this.replaceDraft(selected.key, editor, goalDraftFromSnapshot(response.snapshot, Math.max(editor.draft.version, editor.versionFloor) + 1))
    }
    this.syncEditor(selected.key, editor)
  }
  closeEditor(): void { const selected = this.value.selection; if (selected) { const editor = this.editor(selected.key); editor.editing = false; this.syncEditor(selected.key, editor) } }
  edit(field: 'text' | 'acceptanceCriteria' | 'constraints' | 'mode' | 'intervalSeconds' | 'tokenLimit', text: string): void {
    const selected = this.value.selection
    if (!selected || this.value.draftStatus === 'loading' || (field === 'mode' && text !== 'finite' && text !== 'maintenance')) return
    const editor = this.editor(selected.key)
    this.replaceDraft(selected.key, editor, { ...editor.draft, [field]: text, initialized: true, dirty: true, version: Math.max(editor.draft.version, editor.versionFloor) + 1 })
  }
  private replaceDraft(key: string, editor: Editor, draft: GoalDraft): void {
    editor.draft = draft; editor.versionFloor = draft.version
    if (['ready', 'saving'].includes(editor.status)) {
      editor.status = 'saving'
      void this.persist(key, editor, () => this.drafts.writeDraft(key, draft, editor.persisted.version), draft.version)
    }
    this.syncEditor(key, editor)
  }
  async refresh(): Promise<void> {
    const selected = this.value.selection
    if (!selected || !this.value.verified || this.closed.signal.aborted) return
    if (this.readJob) { this.readJob.repeat = true; return await this.readJob.promise }
    const job = { abort: new AbortController(), promise: Promise.resolve(), repeat: false }
    this.readJob = job; this.emit({ loading: true })
    job.promise = (async () => {
      try {
        const response = await this.client.read({ schemaVersion: 1, target: { rootSessionId: selected.captain, teamId: selected.team } }, job.abort.signal)
        this.checkResponse(response, selected); job.abort.signal.throwIfAborted()
        if (this.matches(selected) && this.value.selection?.viewer === selected.viewer && this.value.verified) this.acceptResponse(response)
      } catch (error) {
        if (!job.abort.signal.aborted && this.matches(selected)) this.emit({ error: errorText(error) })
      } finally {
        if (this.readJob === job) {
          this.readJob = undefined
          if (this.matches(selected)) this.emit({ loading: false })
          if (job.repeat && !job.abort.signal.aborted && this.matches(selected)) void this.refresh()
        }
      }
    })()
    await job.promise
  }
  async save(start: boolean): Promise<void> {
    const selected = this.writable()
    if (!selected) return
    const editor = this.editor(selected.key), draft = editor.draft
    try {
      if (!draft.initialized) return
      const goal = goalDefinitionSchema.parse(goalDefinitionFromDraft(draft))
      const limit = draft.tokenLimit.trim(), changedBudget = limit !== '' && Number(limit) !== draft.baseTokenLimit
      const tokenBudget = changedBudget ? goalTokenBudgetSchema.parse({ tokenLimit: Number(limit), expectedTokenLimit: draft.baseTokenLimit }) : undefined
      const pending: GoalPending = { kind: 'save', version: draft.version, request: { schemaVersion: 1, target: { rootSessionId: selected.captain, teamId: selected.team },
        requestId: this.nextId(), expectedLifecycleRevision: draft.baseLifecycleRevision, goal, start, ...(tokenBudget ? { tokenBudget } : {}) } }
      await this.freezeAndSend(selected, editor, pending)
    } catch (error) { if (this.matches(selected)) this.emit({ error: errorText(error) }) }
  }
  async control(action: GoalControlRequest['action']): Promise<void> {
    const selected = this.writable(), snapshot = this.value.response?.snapshot
    if (!selected || !snapshot) return
    const editor = this.editor(selected.key)
    await this.freezeAndSend(selected, editor, { kind: 'control', version: editor.draft.version, request: { schemaVersion: 1,
      target: { rootSessionId: selected.captain, teamId: selected.team }, requestId: this.nextId(), expectedLifecycleRevision: snapshot.lifecycle?.revision ?? 0, action } })
  }
  private writable(): GoalSelection | undefined {
    const selected = this.value.selection
    return selected && this.value.verified && this.value.response?.snapshot.eligibility.state === 'available' && !this.value.pending
      && !this.inFlight.has(selected.key) && ['ready', 'saving'].includes(this.value.draftStatus) ? selected : undefined
  }
  private async freezeAndSend(selected: GoalSelection, editor: Editor, pending: GoalPending): Promise<void> {
    this.inFlight.add(selected.key); this.syncEditor(selected.key, editor)
    try {
      const record = await this.persist(selected.key, editor, () => this.drafts.freeze(selected.key, pending, editor.persisted.version), pending.version)
      if (record?.pending) await this.dispatch(selected, editor, record.pending, false)
    } finally { this.inFlight.delete(selected.key); this.syncEditor(selected.key, editor) }
  }
  async recover(): Promise<void> {
    const selected = this.value.selection
    if (!selected || !this.value.verified || !this.value.pending || this.inFlight.has(selected.key)) return
    const editor = this.editor(selected.key)
    if (!['ready', 'saving'].includes(editor.status)) return
    this.inFlight.add(selected.key); this.syncEditor(selected.key, editor)
    try { await editor.write; if (editor.record.pending) await this.dispatch(selected, editor, editor.record.pending, true) }
    finally { this.inFlight.delete(selected.key); this.syncEditor(selected.key, editor) }
  }
  private async dispatch(selected: GoalSelection, editor: Editor, pending: GoalPending, recover: boolean): Promise<void> {
    const request = pending.request
    let definite = false
    try {
      if (request.target.teamId !== selected.team || request.target.rootSessionId !== selected.captain) throw new Error('Stored goal operation has another Captain binding')
      const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(60_000)])
      const known = recover ? await this.client.requestResult({ schemaVersion: 1, target: request.target, requestId: request.requestId,
        expectedLifecycleRevision: request.expectedLifecycleRevision }, signal) : undefined
      if (known) this.checkResponse(known, selected)
      if (known?.state === 'expired') {
        await this.persist(selected.key, editor, () => this.drafts.settle(selected.key, pending, { requestId: request.requestId, state: 'expired' }), pending.version)
        if (this.matches(selected)) this.acceptResponse(known)
        return
      }
      let response
      try {
        response = known?.state === 'committed' ? known : pending.kind === 'save' ? await this.client.save(pending.request, signal) : await this.client.control(pending.request, signal)
      } catch (error) { definite = error instanceof GoalRpcError && definiteRejections.has(error.code); throw error }
      this.checkResponse(response, selected)
      const current = this.matches(selected) ? this.value.response : undefined
      const latest = current && (current.snapshot.lifecycle?.revision ?? 0) > (response.snapshot.lifecycle?.revision ?? 0) ? current.snapshot : response.snapshot
      const replacement = pending.kind === 'save' || !editor.draft.dirty ? goalDraftFromSnapshot(latest, pending.version + 1) : undefined
      await this.persist(selected.key, editor, () => this.drafts.settle(selected.key, pending,
        { requestId: request.requestId, state: 'committed', operationRevision: response.operationRevision }, replacement), pending.version)
      if (this.matches(selected)) { this.acceptResponse(response); void this.refresh() }
    } catch (error) {
      if (definite) await this.persist(selected.key, editor, () => this.drafts.settle(selected.key, pending, { requestId: request.requestId, state: 'rejected' }), pending.version)
      if (this.matches(selected)) this.emit({ error: errorText(error) })
    }
  }
  private checkResponse(response: GoalReadResponse, selected: GoalSelection): void {
    if (response.binding.teamId !== selected.team || response.binding.rootSessionId !== selected.captain || response.teamRevision < selected.revision) throw new Error('Goal response binding or Team revision changed')
  }
  private acceptResponse(response: GoalReadResponse): void {
    const current = this.value.response
    if (current && ((response.snapshot.lifecycle?.revision ?? 0) < (current.snapshot.lifecycle?.revision ?? 0)
      || ((response.snapshot.lifecycle?.revision ?? 0) === (current.snapshot.lifecycle?.revision ?? 0) && response.observedAt < current.observedAt))) return
    this.emit({ response, error: undefined })
  }
  private matches(selected: GoalSelection): boolean { return !this.closed.signal.aborted && this.value.selection?.key === selected.key && this.value.selection.captain === selected.captain }
  private abortRead(): void { this.readJob?.abort.abort(); this.readJob = undefined }
  private editor(key: string): Editor {
    let editor = this.editors.get(key)
    if (!editor) {
      const draft = emptyGoalDraft()
      editor = { draft, persisted: draft, record: { schemaVersion: 1, draft }, versionFloor: 0, status: 'loading', write: Promise.resolve(), hydrate: undefined, expanded: false, editing: false }
      this.editors.set(key, editor)
    }
    return editor
  }
  private async hydrate(key: string, editor: Editor): Promise<void> {
    try {
      const record = await this.drafts.read(key)
      editor.record = record; editor.draft = record.draft; editor.persisted = record.draft
      editor.versionFloor = record.draft.version; editor.status = 'ready'
    } catch { editor.status = 'unavailable' }
    this.syncEditor(key, editor)
  }
  private persist(key: string, editor: Editor, operation: () => Promise<GoalDraftRecord>, version: number): Promise<GoalDraftRecord | undefined> {
    const write = editor.write.then(async () => {
      if (!['ready', 'saving'].includes(editor.status)) return undefined
      try {
        const stored = await operation()
        editor.record = stored
        const externalEdit = stored.draft.version !== editor.persisted.version && stored.draft.version !== version && stored.draft.version !== version + 1
        if (externalEdit) editor.status = 'conflict'
        else adoptPersistedDraft(editor, stored.draft, version)
        this.syncEditor(key, editor); return stored
      } catch (error) {
        editor.status = /revision conflict|pending operation already exists/u.test(errorText(error)) ? 'conflict' : 'unavailable'
        this.syncEditor(key, editor); return undefined
      }
    })
    editor.write = write.then(() => {}); return write
  }
  async retryStorage(): Promise<void> {
    const selected = this.value.selection
    if (!selected) return
    const editor = this.editor(selected.key); await editor.write
    if (editor.status !== 'unavailable') return
    if (editor.draft.version === editor.persisted.version) { editor.status = 'loading'; this.syncEditor(selected.key, editor); await this.hydrate(selected.key, editor) }
    else { editor.status = 'saving'; await this.persist(selected.key, editor, () => this.drafts.writeDraft(selected.key, editor.draft, editor.persisted.version), editor.draft.version) }
  }
  async useStoredDraft(): Promise<void> {
    const selected = this.value.selection
    if (!selected || this.inFlight.has(selected.key)) return
    const editor = this.editor(selected.key); await editor.write
    editor.status = 'loading'; this.syncEditor(selected.key, editor); await this.hydrate(selected.key, editor)
  }
  private syncEditor(key: string, editor: Editor): void {
    if (this.value.selection?.key !== key) return
    this.emit({ draft: editor.draft, draftStatus: editor.status, pending: editor.record.pending, outcome: editor.record.outcome,
      sending: this.inFlight.has(key), expanded: editor.expanded, editing: editor.editing })
  }
  private emit(patch: Partial<GoalState>): void {
    if (this.closed.signal.aborted) return
    this.value = Object.freeze({ ...this.value, ...patch }); this.watchers.forEach(watcher => watcher())
  }
  dispose(): void {
    this.abortRead(); this.closed.abort(); this.watchers.clear()
    void Promise.all([...this.editors.values()].map(editor => editor.write)).then(() => this.drafts.close())
  }
}
