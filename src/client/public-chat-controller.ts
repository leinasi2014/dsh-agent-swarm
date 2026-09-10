import { draftDashboardConnection, adoptPersistedDraft } from './draft-controller-helpers.js'
import type { DirectoryResponse, DirectoryEntry } from '../rpc/directory-contract.js'
import { hasUnconfirmedPublicMention } from '../shared/public-content.js'
import { addDraftImages, draftContent, editDraft, removeDraftImage, replaceDraftRange, replyDraft, type PublicDraft } from './public-draft.js'
import { PublicDraftStore } from './public-draft-store.js'
import { decodePublicDraft, encodePublicDraft, inspectDraftImage, publicDraftImageIssue, publicDraftRequest, publicImageBlob, type StoredPublicSnapshot } from './public-image-draft.js'
import { mergePublicMessages as merge } from './public-v2-schema.js'
import type { PublicChatV3HistoryResponse as PublicChatHistoryResponse, PublicChatV3Message as PublicChatMessage, PublicChatV2Response, PublicChatV3Response, PublicChatResponse, PublicChatMessage as LegacyMessage } from '../rpc/public-rpc-contract.js'
import type { TeamDashboardState } from './team-dashboard-controller.js'
import { PublicChatRpcError, type PublicChatClient } from './public-rpc-client.js'

interface Selection { readonly key: string; readonly viewer: string; readonly captain: string; readonly team: string; readonly revision: number }
type Draft = PublicDraft
type Pending = NonNullable<StoredPublicSnapshot['pending']>
type PublicDraftStatus = 'loading' | 'ready' | 'saving' | 'conflict' | 'unavailable'
export type PublicDraftPersistence = Pick<PublicDraftStore, 'read' | 'writeDraft' | 'freeze' | 'settle' | 'migrateLegacy' | 'upgradePending' | 'markLegacyUpgrade' | 'restoreLegacyPending' | 'close'>
interface Saved {
  draft: Draft; pending?: Pending; legacyUpgrade?: boolean; blobs: Readonly<Record<string, Blob>>
  persisted: Draft; status: PublicDraftStatus; write: Promise<void>; hydrate?: Promise<void>; versionFloor: number; hydrated: boolean; recoveryBase?: Draft
  newBlobs: Record<string, Blob>
}
export interface PublicChatState {
  readonly selection: Selection | undefined
  readonly entries: readonly PublicChatMessage[]
  readonly history: PublicChatHistoryResponse | undefined
  readonly draft: Draft
  readonly sending: boolean
  readonly pending: boolean
  readonly directory: (Omit<DirectoryResponse, 'page'> & { readonly totalCount: number }) | undefined
  readonly directoryLoading: boolean
  readonly directoryError: string | undefined
  readonly legacyUpgrade: boolean
  readonly loading: boolean
  readonly error: string | undefined
  readonly draftStatus: PublicDraftStatus
  readonly draftBlobs: Readonly<Record<string, Blob>>
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const emptyDraft: Draft = Object.freeze({ text: '', version: 0, tokens: [] })
const initial: PublicChatState = Object.freeze({ selection: undefined, entries: [], history: undefined, draft: emptyDraft, sending: false, pending: false, loading: false, error: undefined, directory: undefined, directoryLoading: false, directoryError: undefined, legacyUpgrade: false, draftStatus: 'loading', draftBlobs: {} })

/** View state only. Team facts remain in the shared dashboard and messages in public RPC. */
export class PublicChatController {
  private state = initial
  private readonly listeners = new Set<() => void>()
  private readonly saved = new Map<string, Saved>()
  private readonly busy = new Set<string>()
  private readonly inspecting = new Set<string>()
  private directorySelection: Selection | undefined
  private directoryRefreshPending = false
  private directoryRead: AbortController | undefined
  private dashboardData: TeamDashboardState['data']
  private read: AbortController | undefined
  /** Only a history page advances this cursor; an append receipt may be ahead of unread messages. */
  private historyCursor: number | undefined
  private bindingReady = false
  private readonly lifetime = new AbortController()
  private disposed = false
  constructor(private readonly client: Pick<PublicChatClient, 'historyV3' | 'appendV3' | 'requestResultV3' | 'appendV2' | 'requestResultV2' | 'requestResult' | 'image'> & Partial<Pick<PublicChatClient, 'directory'>>,
    private readonly environment: string, private readonly storage?: StoragePort,
    private readonly requestId: () => string = () => crypto.randomUUID(),
    private readonly drafts: PublicDraftPersistence = new PublicDraftStore(),
    private readonly inspectImage = inspectDraftImage) {}
  getSnapshot = (): PublicChatState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  connect = draftDashboardConnection(this)
  bind(dashboard: TeamDashboardState): void {
    const wasReady = this.bindingReady
    this.bindingReady = dashboard.phase === 'ready'
    const cached = this.state.selection
    if ((dashboard.phase === 'stale' || dashboard.phase === 'reconnecting') && cached !== undefined
      && dashboard.targetSessionId === cached.viewer && dashboard.data?.teams.binding.rootSessionId === cached.viewer
      && dashboard.data.teams.binding.mainSessionId !== undefined && dashboard.data.teams.complete
      && cached.key === `swarm.public.v1:${JSON.stringify([this.environment, dashboard.data.teams.binding.mainSessionId, cached.team])}`
      && dashboard.data.projection.binding.rootSessionId === cached.captain && dashboard.data.projection.binding.teamId === cached.team
      && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === cached.team)) {
      this.directoryRead?.abort(); this.read?.abort()
      this.publish({ ...this.state, loading: false, directoryLoading: false })
      return
    }
    const data = dashboard.phase === 'ready' ? dashboard.data : undefined
    const main = data?.teams.binding.mainSessionId
    const team = data?.projection.binding.teamId
    const viewer = dashboard.targetSessionId
    const next: Selection | undefined = data !== undefined && main !== undefined && team !== undefined && viewer !== undefined
      && data.teams.binding.rootSessionId === viewer && data.teams.complete
      ? { key: `swarm.public.v1:${JSON.stringify([this.environment, main, team])}`, viewer, team, captain: data.projection.binding.rootSessionId, revision: data.projection.team.revision } : undefined
    if (next === undefined) {
      this.bindingReady = false
      this.directoryRead?.abort(); this.read?.abort()
      // A same-Team navigation temporarily carries the previous viewer's
      // projection. Retain its display, but admit no RPC until the new viewer
      // is proved. Unrelated or pending Team selections still clear at once.
      const retained = dashboard.data
      const sameTeamNavigation = cached !== undefined && viewer !== undefined && retained !== undefined
        && ['ready', 'stale', 'reconnecting'].includes(dashboard.phase) && retained.projection.team.phase === 'active' && retained.teams.complete
        && retained.teams.binding.rootSessionId === cached.viewer
        && cached.key === `swarm.public.v1:${JSON.stringify([this.environment, retained.teams.binding.mainSessionId, cached.team])}`
        && retained.projection.binding.rootSessionId === cached.captain && retained.projection.binding.teamId === cached.team
        && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === cached.team)
        && (viewer === cached.captain || retained.captainMembers.members.some(member => member.sessionId === viewer && member.phase === 'active'))
      if (sameTeamNavigation) this.publish({ ...this.state, loading: false, directoryLoading: false })
      else { this.historyCursor = undefined; this.publish({ ...initial }) }
      return
    }
    const previous = this.state.selection
    if (previous?.key === next.key && previous.viewer === next.viewer && previous.captain === next.captain) {
      if (!wasReady || previous.revision !== next.revision) { this.publish({ ...this.state, selection: next }); void this.refresh() }
      else if (dashboard.data !== this.dashboardData) void this.refreshDirectory()
      this.dashboardData = dashboard.data
      return
    }
    this.directoryRead?.abort(); this.read?.abort()
    this.dashboardData = dashboard.data
    if (previous?.key === next.key && previous.captain === next.captain) {
      this.publish({ ...this.state, selection: next, loading: false, directoryLoading: false })
      void this.refresh()
      return
    }
    this.historyCursor = undefined
    const saved = this.readSaved(next.key)
    this.publish({ ...initial, selection: next, draft: saved.draft, legacyUpgrade: saved.legacyUpgrade === true, pending: saved.pending !== undefined, sending: this.busy.has(next.key), draftStatus: saved.status, draftBlobs: saved.blobs })
    if (saved.hydrate === undefined && saved.status === 'loading') saved.hydrate = this.hydrate(next.key, saved)
    void this.refresh()
  }
  edit(text: string, replyTo = this.state.draft.replyTo): void {
    const key = this.state.selection?.key
    if (key === undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(key)
    this.editSaved(key, saved, { ...editDraft(saved.draft, text), ...(replyTo === undefined ? {} : { replyTo }) })
  }
  reply(messageId: string | undefined): void {
    const key = this.state.selection?.key
    if (key === undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(key)
    this.editSaved(key, saved, replyDraft(saved.draft, messageId))
  }
  async refresh(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined) return
    await Promise.all([this.load(selected, 'refresh'), this.refreshDirectory()])
  }
  async earlier(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.state.loading || !this.state.history?.hasEarlier) return
    await this.load(selected, 'earlier')
  }
  async newer(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.state.loading || !this.state.history?.hasMore) return
    await this.load(selected, 'newer')
  }
  private async load(selected: Selection, direction: 'refresh' | 'earlier' | 'newer'): Promise<void> {
    this.read?.abort()
    const read = this.read = new AbortController()
    const old = this.state.entries
    this.publish({ ...this.state, loading: true, error: undefined })
    const request = { schemaVersion: 3 as const, target: { rootSessionId: selected.viewer, teamId: selected.team } }
    try {
      const page = await this.client.historyV3({ ...request, limit: 50,
        ...(direction === 'earlier' && old[0] !== undefined ? { beforeSequence: old[0].sequence } : {}),
        ...(direction !== 'earlier' && this.historyCursor !== undefined ? { afterSequence: this.historyCursor } : {}),
      }, read.signal)
      this.checkBinding(page, selected)
      let entries = merge(old, page.entries)
      // Re-read only already displayed ranges: delivery can change on old messages.
      if (direction === 'refresh') {
        for (let index = 0; index < old.length; index += 100) {
          const visible = old.slice(index, index + 100)
          const range = await this.client.historyV3({ ...request, afterSequence: visible[0]!.sequence - 1, limit: visible.length }, read.signal)
          this.checkBinding(range, selected)
          entries = merge(entries, range.entries)
        }
      }
      read.signal.throwIfAborted()
      if (!this.isCurrent(selected)) return
      if (direction !== 'earlier') this.historyCursor = page.lastSequence ?? this.historyCursor ?? 0
      const first = entries[0]?.sequence
      const last = entries.at(-1)?.sequence
      const previous = this.state.history
      const hasEarlier = direction === 'earlier' || old.length === 0 ? page.hasEarlier : previous?.hasEarlier ?? page.hasEarlier
      const hasMore = direction === 'earlier' ? previous?.hasMore ?? false : page.hasMore
      this.publish({ ...this.state, entries: merge(this.state.entries, entries), loading: false, history: { ...page, hasEarlier, hasMore, ...(first === undefined ? {} : { firstSequence: first }), ...(last === undefined ? {} : { lastSequence: last }) } })
    } catch (error) {
      if (!read.signal.aborted && this.isCurrent(selected)) this.publish({ ...this.state, loading: false, error: errorText(error) })
    }
  }
  async send(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.state.history?.appendEligibility.state !== 'available') return
    const saved = this.readSaved(selected.key)
    if (saved.pending !== undefined || this.busy.has(selected.key) || !this.draftAllowed(saved)) return
    const draft = saved.draft
    const pending: Pending = { version: draft.version, captain: selected.captain, request: publicDraftRequest(draft, { rootSessionId: selected.viewer, teamId: selected.team }, this.requestId()), blobIds: (draft.images ?? []).map(image => image.blobId) }
    this.busy.add(selected.key); this.updateOperation(selected, saved)
    try {
      // Queue this before later edits: it captures the clicked draft, while their writes retain pending.
      const frozen = await this.queueWrite(selected.key, saved, version => this.drafts.freeze(selected.key, draft, pending, version), draft)
      if (frozen?.pending !== undefined) await this.submit(selected, saved, frozen.pending, false)
    } finally { this.busy.delete(selected.key); this.updateOperation(selected, saved) }
  }
  private draftAllowed(saved: Saved): boolean {
    const draft = saved.draft
    const limits = this.state.history?.limits
    const content = draftContent(draft)
    if (!['ready', 'saving'].includes(saved.status) || limits === undefined || (draft.text.trim() === '' && !draft.images?.length) || hasUnconfirmedPublicMention(content)
      || content.length + (draft.images?.length ?? 0) > limits.maxSegments || new TextEncoder().encode(draft.text).length > limits.maxTextBytes
      || publicDraftImageIssue(draft, saved.blobs, this.state.history?.imageAvailability) !== undefined) return false
    if (draft.tokens.length > 0 && (this.state.directory === undefined || this.state.directoryError !== undefined || draft.tokens.some(token => !this.state.directory?.entries.some(entry => entry.memberId === token.memberId && entry.phase === 'active')))) return false
    return true
  }
  replaceText(start: number, end: number, text: string): void {
    const key = this.state.selection?.key
    if (key === undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(key)
    this.editSaved(key, saved, replaceDraftRange(saved.draft, start, end, text))
  }
  chooseMention(start: number, end: number, memberId: string): void {
    const selected = this.state.selection, entry = this.state.directory?.entries.find(row => row.memberId === memberId)
    if (!this.bindingReady || selected === undefined || entry?.phase !== 'active' || this.state.directoryError !== undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(selected.key)
    this.editSaved(selected.key, saved, replaceDraftRange(saved.draft, start, end, `@${entry.label}`, { memberId, label: entry.label }))
  }
  removeMention(start: number, reselect = false): void {
    const selected = this.state.selection
    if (selected === undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(selected.key), token = saved.draft.tokens.find(row => row.start === start)
    if (token === undefined) return
    this.editSaved(selected.key, saved, replaceDraftRange(saved.draft, token.start, token.end, reselect ? '@' : ''))
  }
  addImages(files: readonly File[]): void {
    const key = this.state.selection?.key
    if (key === undefined || this.state.draftStatus === 'loading' || files.length === 0) return
    const saved = this.readSaved(key), blobs: Record<string, Blob> = {}
    const images = files.map(file => { const blobId = crypto.randomUUID(); blobs[blobId] = file; return { blobId, mediaType: file.type, name: file.name, status: 'checking' as const } })
    this.editSaved(key, saved, addDraftImages(saved.draft, images), blobs)
    void this.checkImages(key, saved)
  }
  removeImage(blobId: string): void {
    const key = this.state.selection?.key
    if (key === undefined || this.state.draftStatus === 'loading') return
    const saved = this.readSaved(key), next = removeDraftImage(saved.draft, blobId)
    if (next !== saved.draft) this.editSaved(key, saved, next)
  }
  private async checkImages(key: string, saved: Saved): Promise<void> {
    await Promise.all((saved.draft.images ?? []).filter(image => image.status === 'checking' || image.status === undefined).map(async image => {
      const identity = `${key}:${image.blobId}`, blob = saved.blobs[image.blobId]
      if (blob === undefined || this.inspecting.has(identity)) return
      this.inspecting.add(identity)
      try {
        const checked = await this.inspectImage(blob, image)
        if (!this.disposed && saved.draft.images?.some(row => row.blobId === image.blobId)) this.editSaved(key, saved, { ...saved.draft, version: saved.draft.version + 1, images: saved.draft.images.map(row => row.blobId === image.blobId ? checked : row) })
      } finally { this.inspecting.delete(identity) }
    }))
  }
  async upgradeLegacy(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.busy.has(selected.key)) return
    const saved = this.readSaved(selected.key), old = saved.pending
    if (this.state.history?.appendEligibility.state !== 'available' || !saved.legacyUpgrade || old?.request.schemaVersion !== 1 || !this.draftAllowed(saved)) return
    const draft = saved.draft
    const pending: Pending = { ...old, upgradedLegacy: true, legacyRequest: old.request, legacyVersion: old.legacyVersion ?? old.version, version: draft.version, request: publicDraftRequest(draft, old.request.target, old.request.requestId), blobIds: (draft.images ?? []).map(image => image.blobId) }
    this.busy.add(selected.key); this.updateOperation(selected, saved)
    try {
      const frozen = await this.queueWrite(selected.key, saved, version => this.drafts.upgradePending(selected.key, draft, pending, version), draft)
      if (frozen?.pending !== undefined) await this.submit(selected, saved, frozen.pending, true)
    } finally { this.busy.delete(selected.key); this.updateOperation(selected, saved) }
  }
  async refreshDirectory(restarted = false): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.client.directory === undefined) return
    if (!restarted && this.directoryRead !== undefined && !this.directoryRead.signal.aborted && this.state.directoryLoading
      && this.directorySelection?.key === selected.key && this.directorySelection.viewer === selected.viewer && this.directorySelection.captain === selected.captain) {
      // Ordinary dashboard/focus refreshes share this healthy read. A changed
      // authoritative Team revision is read once more after it settles.
      this.directoryRefreshPending ||= this.directorySelection.revision !== selected.revision
      return
    }
    this.directoryRead?.abort()
    this.directorySelection = selected; this.directoryRefreshPending = false
    const read = this.directoryRead = new AbortController()
    this.publish({ ...this.state, directoryLoading: true })
    try {
      let first: DirectoryResponse | undefined, cursor: string | undefined
      const entries: DirectoryEntry[] = [], cursors = new Set<string>()
      do {
        const page = await this.client.directory({ schemaVersion: 2, target: { rootSessionId: selected.viewer, teamId: selected.team }, limit: 50, ...(cursor === undefined ? {} : { cursor }) }, read.signal)
        read.signal.throwIfAborted()
        if (page.binding.rootSessionId !== selected.captain || page.binding.teamId !== selected.team || page.page.offset !== entries.length || (first !== undefined && (page.directoryRevision !== first.directoryRevision || page.page.totalCount !== first.page.totalCount))) throw new Error('SWARM_DIRECTORY_STALE: directory binding or revision changed')
        first ??= page
        for (const row of page.entries) { if (entries.some(entry => entry.memberId === row.memberId)) throw new Error('Invalid duplicate directory identity'); entries.push(row) }
        cursor = page.page.hasMore ? page.page.nextCursor : undefined
        if (page.page.hasMore && (cursor === undefined || cursors.has(cursor))) throw new Error('Invalid directory cursor')
        if (cursor !== undefined) cursors.add(cursor)
      } while (cursor !== undefined)
      if (first === undefined || entries.length !== first.page.totalCount) throw new Error('Incomplete directory enumeration')
      if (!this.isCurrent(selected) || this.state.selection?.revision !== selected.revision) return
      this.publish({ ...this.state, directoryLoading: false, directoryError: undefined, directory: { schemaVersion: 2, binding: first!.binding, observedAt: first!.observedAt, directoryRevision: first!.directoryRevision, entries, totalCount: first!.page.totalCount } })
    } catch (error) {
      if (!read.signal.aborted && this.isCurrent(selected)) {
        this.publish({ ...this.state, directoryLoading: false, directory: undefined, directoryError: errorText(error) })
        if (!restarted && ((error instanceof PublicChatRpcError && error.code === 'SWARM_DIRECTORY_STALE') || errorText(error).startsWith('SWARM_DIRECTORY_STALE'))) await this.refreshDirectory(true)
      }
    } finally {
      if (this.directoryRead === read) {
        this.directoryRead = undefined; this.directorySelection = undefined
        const refreshPending = this.directoryRefreshPending; this.directoryRefreshPending = false
        if (refreshPending && !read.signal.aborted && this.isCurrent(selected)) await this.refreshDirectory()
      }
    }
  }
  async recover(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.busy.has(selected.key)) return
    const saved = this.readSaved(selected.key)
    if (saved.pending === undefined || !['ready', 'saving'].includes(saved.status)) return
    this.busy.add(selected.key); this.updateOperation(selected, saved)
    try { await saved.write; if (['ready', 'saving'].includes(saved.status) && saved.pending !== undefined) await this.submit(selected, saved, saved.pending, true) }
    finally { this.busy.delete(selected.key); this.updateOperation(selected, saved) }
  }
  private async submit(selected: Selection, saved: Saved, pending: Pending, recover: boolean): Promise<void> {
    let definiteAppendRejection = false
    try {
      if (pending.request.target.teamId !== selected.team || pending.captain !== selected.captain) throw new Error('Stored operation belongs to a different Team binding')
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)])
      const outcome = recover || pending.request.schemaVersion === 1 ? await this.findRequest(pending, selected, signal) : undefined
      if (pending.request.schemaVersion === 1 && outcome?.state !== 'committed') {
        await this.queueWrite(selected.key, saved, () => this.drafts.markLegacyUpgrade(selected.key, pending.request.requestId, pending.version)); return
      }
      let response
      try {
        if (outcome?.state === 'committed') response = outcome
        else if (pending.request.schemaVersion === 3) {
          const request = await encodePublicDraft(pending.request, saved.blobs)
          signal.throwIfAborted()
          response = await this.client.appendV3(request, signal)
        } else if (pending.request.schemaVersion === 2) response = await this.client.appendV2(pending.request, signal)
        else throw new Error('Legacy request requires explicit upgrade')
      } catch (error) {
        definiteAppendRejection = error instanceof PublicChatRpcError && ['TEAM_PUBLIC_CAPACITY', 'TEAM_PUBLIC_RECIPIENT_INVALID', 'TEAM_PUBLIC_MENTION_UNCONFIRMED', 'SWARM_RPC_INVALID_REQUEST', 'TEAM_PUBLIC_IMAGE_INVALID', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE'].includes(error.code)
        if (!(error instanceof PublicChatRpcError) || error.code !== 'TEAM_PUBLIC_REQUEST_CONFLICT' || !pending.upgradedLegacy) throw error
        const original = await this.findRequest(pending, selected, signal)
        if (original.state !== 'committed' || original.message.formatVersion !== 1) throw error
        response = original
      }
      this.checkBinding(response, { ...selected, captain: pending.captain })
      const clear = !(pending.upgradedLegacy && response.message.formatVersion === 1)
      // Reserve the possible clear revision so an edit during this commit cannot reuse it.
      if (clear) saved.versionFloor = Math.max(saved.versionFloor, pending.version + 1)
      await this.queueWrite(selected.key, saved, () => this.drafts.settle(selected.key, pending.request.requestId, pending.version, clear), undefined, clear ? pending.version : undefined)
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, entries: merge(this.state.entries, [response.message]), error: undefined })
    } catch (error) {
      // Only a decoded append rejection can release pending. Read failures and unknown outcomes retain it.
      if (definiteAppendRejection) await this.queueWrite(selected.key, saved, () => pending.legacyRequest === undefined
        ? this.drafts.settle(selected.key, pending.request.requestId, pending.version, false)
        : this.drafts.restoreLegacyPending(selected.key, pending.request.requestId, pending.version))
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, error: errorText(error) })
    } finally { this.updateOperation(selected, saved) }
  }
  private async findRequest(pending: Pending, selected: Selection, signal: AbortSignal) {
    const request = { target: pending.request.target, requestId: pending.request.requestId }
    if (pending.request.schemaVersion === 3) {
      const result = await this.client.requestResultV3({ ...request, schemaVersion: 3 }, signal); this.checkBinding(result, selected); return result
    }
    if (pending.request.schemaVersion === 1) {
      try {
        const result = await this.client.requestResult({ ...request, schemaVersion: 1 }, signal)
        this.checkBinding(result, selected)
        return result.state === 'committed' ? { ...result, message: projectLegacy(result.message) } : result
      } catch (error) { if (!(error instanceof PublicChatRpcError) || error.code !== 'SWARM_PUBLIC_VERSION_REQUIRED') throw error }
    }
    try {
      const result = await this.client.requestResultV2({ ...request, schemaVersion: 2 }, signal); this.checkBinding(result, selected); return result
    } catch (error) { if (!(error instanceof PublicChatRpcError) || error.code !== 'SWARM_PUBLIC_VERSION_REQUIRED') throw error }
    const result = await this.client.requestResultV3({ ...request, schemaVersion: 3 }, signal); this.checkBinding(result, selected); return result
  }
  async image(messageId: string, imageId: string, signal: AbortSignal): Promise<Blob> {
    const selected = this.state.selection
    const image = this.state.entries.find(row => row.id === messageId)?.content.find(segment => segment.type === 'image' && segment.imageId === imageId)
    if (!this.bindingReady || selected === undefined || image?.type !== 'image') throw new Error('Public image unavailable')
    const result = await this.client.image({ schemaVersion: 3, target: { rootSessionId: selected.viewer, teamId: selected.team }, messageId, imageId }, AbortSignal.any([signal, this.lifetime.signal]))
    this.checkBinding(result, selected); signal.throwIfAborted()
    if (!this.bindingReady || !this.isCurrent(selected) || result.image.mediaType !== image.mediaType || result.image.bytes !== image.bytes || result.image.width !== image.width || result.image.height !== image.height
      || result.image.name !== image.name || result.image.originalDimensions?.width !== image.originalDimensions?.width || result.image.originalDimensions?.height !== image.originalDimensions?.height) throw new Error('Public image binding changed')
    return publicImageBlob(result.image.data, result.image.mediaType)
  }
  private updateOperation(selected: Selection, saved: Saved): void {
    if (this.isOperationCurrent(selected)) this.publish({ ...this.state, draft: saved.draft, legacyUpgrade: saved.legacyUpgrade === true, pending: saved.pending !== undefined, sending: this.busy.has(selected.key), draftStatus: saved.status, draftBlobs: saved.blobs })
  }
  private checkBinding(response: PublicChatResponse | PublicChatV2Response | PublicChatV3Response, selected: Selection): void {
    if (response.binding.teamId !== selected.team || response.binding.rootSessionId !== selected.captain || response.teamRevision < selected.revision) throw new Error('Public conversation binding or revision changed')
  }
  private isCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.viewer === selected.viewer }
  private isOperationCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.captain === selected.captain }
  private readSaved(key: string): Saved {
    const existing = this.saved.get(key)
    if (existing !== undefined) return existing
    const value: Saved = { draft: emptyDraft, persisted: emptyDraft, blobs: {}, newBlobs: {}, status: 'loading', write: Promise.resolve(), versionFloor: 0, hydrated: false }
    this.saved.set(key, value)
    return value
  }
  private async hydrate(key: string, saved: Saved, preserveLocal = false): Promise<void> {
    let legacy: StoredPublicSnapshot | undefined
    try { const raw = this.storage?.getItem(key); if (raw) legacy = decodePublicDraft(JSON.parse(raw)) } catch { /* Invalid old cache is not a request authority. */ }
    try {
      const stored = legacy === undefined ? await this.drafts.read(key) : await this.drafts.migrateLegacy(key, legacy)
      const value = decodePublicDraft(stored, stored.blobs)
      const basis = saved.recoveryBase ?? saved.persisted, changed = preserveLocal && saved.draft.version !== basis.version
      this.acceptPending(saved, value); saved.hydrated = true
      if (changed && JSON.stringify(basis) !== JSON.stringify(value.draft)) {
        // A newly read revision is not permission to rebase stale local content onto another page.
        saved.status = 'conflict'; saved.blobs = { ...value.blobs, ...saved.blobs }; this.updateDraft(key, saved); return
      }
      saved.persisted = value.draft; saved.versionFloor = Math.max(saved.versionFloor, value.draft.version)
      if (changed) {
        saved.blobs = { ...value.blobs, ...saved.blobs }; saved.status = 'saving'
        const draft = saved.draft, blobs = { ...saved.newBlobs }
        await this.queueWrite(key, saved, version => this.drafts.writeDraft(key, draft, version, blobs), draft)
      } else { saved.draft = value.draft; saved.blobs = value.blobs; saved.newBlobs = {}; saved.status = 'ready' }
      delete saved.recoveryBase
      void this.checkImages(key, saved)
    } catch {
      if (!saved.hydrated && !preserveLocal) {
        if (legacy !== undefined) { saved.draft = legacy.draft; this.acceptPending(saved, legacy) }
        saved.recoveryBase = saved.draft
      }
      saved.status = 'unavailable'
    }
    this.updateDraft(key, saved)
  }
  private editSaved(key: string, saved: Saved, draft: Draft, blobs: Readonly<Record<string, Blob>> = {}): void {
    saved.draft = { ...draft, version: Math.max(draft.version, saved.versionFloor + 1) }; saved.versionFloor = saved.draft.version
    saved.blobs = { ...saved.blobs, ...blobs }; Object.assign(saved.newBlobs, blobs)
    const next = saved.draft
    if (saved.status === 'ready' || saved.status === 'saving') {
      saved.status = 'saving'
      void this.queueWrite(key, saved, version => this.drafts.writeDraft(key, next, version, blobs), next)
    }
    this.updateDraft(key, saved)
  }
  private queueWrite(key: string, saved: Saved, write: (version: number) => Promise<import('./public-draft-store.js').PublicDraftSnapshot>, draft?: Draft, clearVersion?: number): Promise<StoredPublicSnapshot | undefined> {
    const operation = saved.write.then(async () => {
      if (saved.status === 'conflict' || saved.status === 'unavailable' || saved.status === 'loading') return undefined
      const prior = saved.persisted
      try {
        const stored = await write(prior.version), value = decodePublicDraft(stored, stored.blobs)
        this.acceptPending(saved, value)
        const ownClear = clearVersion === prior.version && value.draft.version === prior.version + 1 && value.draft.text === '' && value.draft.tokens.length === 0 && !value.draft.images?.length
        const externalChange = draft === undefined && value.draft.version !== prior.version && !ownClear
        if (externalChange && saved.draft.version !== prior.version) saved.status = 'conflict'
        else {
          adoptPersistedDraft(saved, value.draft, (draft ?? prior).version)
        }
        for (const id of Object.keys(value.blobs)) delete saved.newBlobs[id]
        const keep = new Set([...(saved.draft.images ?? []).map(image => image.blobId), ...saved.pending?.blobIds ?? []])
        saved.blobs = Object.fromEntries(Object.entries({ ...saved.blobs, ...value.blobs }).filter(([id]) => keep.has(id)))
        this.updateDraft(key, saved)
        return value
      } catch (error) {
        saved.status = error instanceof Error && /revision conflict|pending operation already exists|legacy pending changed/u.test(error.message) ? 'conflict' : 'unavailable'
        this.updateDraft(key, saved); return undefined
      }
    })
    saved.write = operation.then(() => {})
    return operation
  }
  private acceptPending(saved: Saved, value: StoredPublicSnapshot): void {
    if (value.pending === undefined) delete saved.pending; else saved.pending = value.pending
    if (value.legacyUpgrade === undefined) delete saved.legacyUpgrade; else saved.legacyUpgrade = value.legacyUpgrade
  }
  private updateDraft(key: string, saved: Saved): void {
    const selected = this.state.selection
    if (selected?.key === key) this.updateOperation(selected, saved)
  }
  async retryDraftStorage(): Promise<void> {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key)
    await saved.write
    if (saved.status !== 'unavailable') return
    if (!saved.hydrated) { saved.hydrate = this.hydrate(key, saved, true); await saved.hydrate; return }
    saved.status = 'saving'
    const draft = saved.draft, blobs = { ...saved.newBlobs }
    await this.queueWrite(key, saved, version => this.drafts.writeDraft(key, draft, version, blobs), draft)
  }
  /** Explicit UI action: replace the local conflict draft with the saved draft, never overwrite another page. */
  async useStoredDraft(): Promise<void> {
    const key = this.state.selection?.key
    if (key === undefined || this.busy.has(key)) return
    const saved = this.readSaved(key)
    await saved.write
    saved.status = 'loading'; this.updateDraft(key, saved)
    saved.hydrate = this.hydrate(key, saved); await saved.hydrate
  }
  private publish(state: PublicChatState): void { if (this.disposed) return; this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  dispose(): void { this.disposed = true; this.directoryRead?.abort(); this.read?.abort(); this.lifetime.abort(); this.listeners.clear(); void Promise.all([...this.saved.values()].map(saved => saved.write)).then(() => { this.drafts.close() }) }
}

function errorText(error: unknown): string {
  if (error instanceof PublicChatRpcError && error.code === 'TEAM_PUBLIC_IMAGE_INVALID') return 'public.imageRejected'
  if (error instanceof PublicChatRpcError && error.code === 'TEAM_PUBLIC_IMAGE_UNAVAILABLE') return 'public.imageServiceUnavailable'
  return error instanceof Error ? error.message : 'Public conversation unavailable'
}

function projectLegacy(message: LegacyMessage): PublicChatMessage {
  const delivery = message.delivery
  return { ...message, formatVersion: 1, content: [{ type: 'text', text: message.text }], mentionLabels: [], delivery: delivery.state === 'not-requested' ? { kind: 'not-requested' } : { kind: 'requested', recipients: [delivery] } }
}
