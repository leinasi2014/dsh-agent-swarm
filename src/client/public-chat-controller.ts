import { z } from 'zod'
import type { DirectoryResponse, DirectoryEntry } from '../rpc/directory-contract.js'
import { MAX_PUBLIC_CONTENT_SEGMENTS, publicSegmentSchema, hasUnconfirmedPublicMention, normalizePublicContent } from '../shared/public-content.js'
import { draftContent, editDraft, replaceDraftRange, type PublicDraft } from './public-draft.js'
import { mergePublicMessages as merge } from './public-v2-schema.js'
import type { PublicChatAppendRequest, PublicChatV2AppendRequest, PublicChatV2HistoryResponse as PublicChatHistoryResponse, PublicChatV2Message as PublicChatMessage, PublicChatV2Response, PublicChatResponse, PublicChatMessage as LegacyMessage } from '../rpc/public-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import { PublicChatRpcError, type PublicChatClient } from './public-rpc-client.js'

interface Selection { readonly key: string; readonly viewer: string; readonly captain: string; readonly team: string; readonly revision: number }
type Draft = PublicDraft
interface Pending { readonly request: PublicChatAppendRequest | PublicChatV2AppendRequest; readonly upgradedLegacy?: boolean; readonly legacyRequest?: PublicChatAppendRequest; readonly legacyVersion?: number; readonly version: number; readonly captain: string }
interface Saved { draft: Draft; pending?: Pending; legacyUpgrade?: boolean }
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
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const emptyDraft: Draft = Object.freeze({ text: '', version: 0, tokens: [] })
const initial: PublicChatState = Object.freeze({ selection: undefined, entries: [], history: undefined, draft: emptyDraft, sending: false, pending: false, loading: false, error: undefined, directory: undefined, directoryLoading: false, directoryError: undefined, legacyUpgrade: false })
const savedTarget = z.object({ rootSessionId: z.string().min(1), teamId: z.string().min(1) })
const savedRequest = { requestId: z.string().min(1), replyTo: z.string().optional(), target: savedTarget }
const savedSchema = z.object({
  draft: z.object({ text: z.string(), version: z.number().int().nonnegative(), replyTo: z.string().optional(), tokens: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), memberId: z.string().min(1), label: z.string() })).default([]) }),
  legacyUpgrade: z.boolean().optional(),
  pending: z.object({ version: z.number().int().nonnegative(), captain: z.string(), upgradedLegacy: z.boolean().optional(), legacyVersion: z.number().int().nonnegative().optional(), legacyRequest: z.object({ ...savedRequest, schemaVersion: z.literal(1), text: z.string() }).optional(), request: z.discriminatedUnion('schemaVersion', [
    z.object({ ...savedRequest, schemaVersion: z.literal(1), text: z.string() }),
    z.object({ ...savedRequest, schemaVersion: z.literal(2), content: z.array(publicSegmentSchema).min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS) }),
  ]) }).optional(),
})

/** View state only. Team facts remain in the shared dashboard and messages in public RPC. */
export class PublicChatController {
  private state = initial
  private readonly listeners = new Set<() => void>()
  private readonly saved = new Map<string, Saved>()
  private readonly busy = new Set<string>()
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
  constructor(private readonly client: Pick<PublicChatClient, 'historyV2' | 'appendV2' | 'requestResultV2'> & Partial<Pick<PublicChatClient, 'requestResult' | 'directory'>>,
    private readonly environment: string, private readonly storage?: StoragePort,
    private readonly requestId: () => string = () => crypto.randomUUID()) {}
  getSnapshot = (): PublicChatState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  connect(dashboard: Pick<TeamDashboardController, 'subscribe' | 'getSnapshot'>): () => void {
    const sync = (): void => { this.bind(dashboard.getSnapshot()) }
    const off = dashboard.subscribe(sync); sync()
    return () => { off(); this.dispose() }
  }
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
      this.directoryRead?.abort(); this.read?.abort(); this.historyCursor = undefined; this.publish({ ...initial })
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
    this.historyCursor = undefined
    const saved = this.readSaved(next.key)
    this.publish({ ...initial, selection: next, draft: saved.draft, legacyUpgrade: saved.legacyUpgrade === true, pending: saved.pending !== undefined, sending: this.busy.has(next.key) })
    void this.refresh()
  }
  edit(text: string, replyTo = this.state.draft.replyTo): void {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key)
    saved.draft = { ...editDraft(saved.draft, text), ...(replyTo === undefined ? {} : { replyTo }) }
    this.persist(key, saved)
    this.publish({ ...this.state, draft: saved.draft })
  }
  reply(messageId: string | undefined): void {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key)
    saved.draft = { text: saved.draft.text, tokens: saved.draft.tokens, version: saved.draft.version + 1, ...(messageId === undefined ? {} : { replyTo: messageId }) }
    this.persist(key, saved); this.publish({ ...this.state, draft: saved.draft })
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
    const request = { schemaVersion: 2 as const, target: { rootSessionId: selected.viewer, teamId: selected.team } }
    try {
      const page = await this.client.historyV2({ ...request, limit: 50,
        ...(direction === 'earlier' && old[0] !== undefined ? { beforeSequence: old[0].sequence } : {}),
        ...(direction !== 'earlier' && this.historyCursor !== undefined ? { afterSequence: this.historyCursor } : {}),
      }, read.signal)
      this.checkBinding(page, selected)
      let entries = merge(old, page.entries)
      // Re-read only already displayed ranges: delivery can change on old messages.
      if (direction === 'refresh') {
        for (let index = 0; index < old.length; index += 100) {
          const visible = old.slice(index, index + 100)
          const range = await this.client.historyV2({ ...request, afterSequence: visible[0]!.sequence - 1, limit: visible.length }, read.signal)
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
    if (saved.pending !== undefined || this.busy.has(selected.key) || saved.draft.text.trim() === '') return
    if (!this.draftAllowed(saved.draft)) return
    const pending: Pending = { version: saved.draft.version, captain: selected.captain, request: { schemaVersion: 2, target: { rootSessionId: selected.viewer, teamId: selected.team }, requestId: this.requestId(), content: normalizePublicContent(draftContent(saved.draft)), ...(saved.draft.replyTo === undefined ? {} : { replyTo: saved.draft.replyTo }) } }
    saved.pending = pending
    // Save before dispatch, including the frozen viewer address and draft version.
    if (!this.persist(selected.key, saved)) { delete saved.pending; return }
    await this.submit(selected, saved, pending, false)
  }
  private draftAllowed(draft: Draft): boolean {
    const limits = this.state.history?.limits
    const content = draftContent(draft)
    if (limits === undefined || draft.text.trim() === '' || hasUnconfirmedPublicMention(content) || content.length > limits.maxSegments || new TextEncoder().encode(draft.text).length > limits.maxTextBytes) return false
    if (draft.tokens.length > 0 && (this.state.directory === undefined || this.state.directoryError !== undefined || draft.tokens.some(token => !this.state.directory?.entries.some(entry => entry.memberId === token.memberId && entry.phase === 'active')))) return false
    return true
  }
  replaceText(start: number, end: number, text: string): void {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key)
    saved.draft = replaceDraftRange(saved.draft, start, end, text)
    this.persist(key, saved); this.publish({ ...this.state, draft: saved.draft })
  }
  chooseMention(start: number, end: number, memberId: string): void {
    const selected = this.state.selection, entry = this.state.directory?.entries.find(row => row.memberId === memberId)
    if (!this.bindingReady || selected === undefined || entry?.phase !== 'active' || this.state.directoryError !== undefined) return
    const saved = this.readSaved(selected.key)
    saved.draft = replaceDraftRange(saved.draft, start, end, `@${entry.label}`, { memberId, label: entry.label })
    this.persist(selected.key, saved); this.publish({ ...this.state, draft: saved.draft })
  }
  removeMention(start: number, reselect = false): void {
    const selected = this.state.selection
    if (selected === undefined) return
    const saved = this.readSaved(selected.key), token = saved.draft.tokens.find(row => row.start === start)
    if (token === undefined) return
    saved.draft = replaceDraftRange(saved.draft, token.start, token.end, reselect ? '@' : '')
    this.persist(selected.key, saved); this.publish({ ...this.state, draft: saved.draft })
  }
  async upgradeLegacy(): Promise<void> {
    const selected = this.state.selection
    if (!this.bindingReady || selected === undefined || this.busy.has(selected.key)) return
    const saved = this.readSaved(selected.key), old = saved.pending
    if (this.state.history?.appendEligibility.state !== 'available' || !saved.legacyUpgrade || old?.request.schemaVersion !== 1 || !this.draftAllowed(saved.draft)) return
    const pending: Pending = { ...old, upgradedLegacy: true, legacyRequest: old.request, legacyVersion: old.legacyVersion ?? old.version, version: saved.draft.version, request: { schemaVersion: 2, target: old.request.target, requestId: old.request.requestId, content: normalizePublicContent(draftContent(saved.draft)), ...(saved.draft.replyTo === undefined ? {} : { replyTo: saved.draft.replyTo }) } }
    saved.pending = pending; delete saved.legacyUpgrade
    if (!this.persist(selected.key, saved)) { saved.pending = old; saved.legacyUpgrade = true; return }
    await this.submit(selected, saved, pending, true)
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
    if (saved.pending === undefined) return
    await this.submit(selected, saved, saved.pending, true)
  }
  private async submit(selected: Selection, saved: Saved, pending: Pending, recover: boolean): Promise<void> {
    this.busy.add(selected.key)
    this.updateOperation(selected, saved)
    let definiteAppendRejection = false
    try {
      if (pending.request.target.teamId !== selected.team || pending.captain !== selected.captain) throw new Error('Stored operation belongs to a different Team binding')
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
      const resultRequest = { schemaVersion: 2 as const, target: pending.request.target, requestId: pending.request.requestId }
      let outcome
      if (pending.request.schemaVersion === 1 && this.client.requestResult !== undefined) {
        // Preserve the legacy query version. A not-found result only offers an explicit upgrade.
        try {
          const legacy = await this.client.requestResult({ ...resultRequest, schemaVersion: 1 }, signal)
          this.checkBinding(legacy, selected)
          outcome = legacy.state === 'committed' ? { ...legacy, schemaVersion: 2 as const, message: projectLegacy(legacy.message) } : legacy
        } catch (error) {
          if (!(error instanceof PublicChatRpcError) || error.code !== 'SWARM_PUBLIC_VERSION_REQUIRED') throw error
          outcome = await this.client.requestResultV2(resultRequest, signal)
        }
      } else if (recover || pending.request.schemaVersion === 1) outcome = await this.client.requestResultV2(resultRequest, signal)
      if (outcome !== undefined) this.checkBinding(outcome, { ...selected, captain: pending.captain })
      if (pending.request.schemaVersion === 1 && outcome?.state !== 'committed') { saved.legacyUpgrade = true; this.persist(selected.key, saved); return }
      let response
      try {
        response = outcome?.state === 'committed' ? outcome : await this.client.appendV2(pending.request as PublicChatV2AppendRequest, signal)
      } catch (error) {
        definiteAppendRejection = error instanceof PublicChatRpcError && ['TEAM_PUBLIC_CAPACITY', 'TEAM_PUBLIC_RECIPIENT_INVALID', 'TEAM_PUBLIC_MENTION_UNCONFIRMED', 'SWARM_RPC_INVALID_REQUEST'].includes(error.code)
        if (!(error instanceof PublicChatRpcError) || error.code !== 'TEAM_PUBLIC_REQUEST_CONFLICT' || !pending.upgradedLegacy) throw error
        const original = await this.client.requestResultV2(resultRequest, signal)
        if (original.state !== 'committed' || original.message.formatVersion !== 1) throw error
        response = original
      }
      this.checkBinding(response, { ...selected, captain: pending.captain })
      if (saved.pending !== pending) return
      delete saved.pending; delete saved.legacyUpgrade
      if (saved.draft.version === pending.version && !(pending.upgradedLegacy && response.message.formatVersion === 1)) saved.draft = { text: '', tokens: [], version: saved.draft.version + 1 }
      this.persist(selected.key, saved)
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, entries: merge(this.state.entries, [response.message]), error: undefined })
    } catch (error) {
      // Capacity is checked before the aggregate changes. Other failures can
      // conceal a committed result and must retain the original request.
      if (definiteAppendRejection && saved.pending === pending) {
        if (pending.legacyRequest !== undefined) {
          // Restore the original operation's draft version, while retaining the upgrade
          // provenance: a later legacy commit must never consume this v2 draft.
          const legacyVersion = pending.legacyVersion ?? pending.version
          saved.pending = { request: pending.legacyRequest, version: legacyVersion, legacyVersion, upgradedLegacy: true, captain: pending.captain }
          saved.legacyUpgrade = true
        }
        else delete saved.pending
      }
      this.persist(selected.key, saved)
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, error: errorText(error) })
    } finally { this.busy.delete(selected.key); this.updateOperation(selected, saved) }
  }
  private updateOperation(selected: Selection, saved: Saved): void {
    if (this.isOperationCurrent(selected)) this.publish({ ...this.state, draft: saved.draft, legacyUpgrade: saved.legacyUpgrade === true, pending: saved.pending !== undefined, sending: this.busy.has(selected.key) })
  }
  private checkBinding(response: PublicChatResponse | PublicChatV2Response, selected: Selection): void {
    if (response.binding.teamId !== selected.team || response.binding.rootSessionId !== selected.captain || response.teamRevision < selected.revision) throw new Error('Public conversation binding or revision changed')
  }
  private isCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.viewer === selected.viewer }
  private isOperationCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.captain === selected.captain }
  private readSaved(key: string): Saved {
    const existing = this.saved.get(key)
    if (existing !== undefined) return existing
    let value: Saved = { draft: emptyDraft }
    try { const raw = this.storage?.getItem(key); if (raw) value = savedSchema.parse(JSON.parse(raw)) as Saved } catch { /* Invalid browser cache is never authority. */ }
    if (value.draft.tokens.some((token, index) => token.end > value.draft.text.length || token.start >= token.end || token.start < (value.draft.tokens[index - 1]?.end ?? 0) || value.draft.text.slice(token.start, token.end) !== `@${token.label}`)) value.draft = { ...value.draft, tokens: [] }
    this.saved.set(key, value)
    return value
  }
  private persist(key: string, saved: Saved): boolean {
    this.saved.set(key, saved)
    try { this.storage?.setItem(key, JSON.stringify(saved)); return true } catch {
      if (this.state.selection?.key === key) this.publish({ ...this.state, error: 'Draft storage is unavailable; message was not dispatched.' })
      return false
    }
  }
  private publish(state: PublicChatState): void { if (this.disposed) return; this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  dispose(): void { this.disposed = true; this.directoryRead?.abort(); this.read?.abort(); this.lifetime.abort(); this.listeners.clear() }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Public conversation unavailable' }

function projectLegacy(message: LegacyMessage): PublicChatMessage {
  const delivery = message.delivery
  return { ...message, formatVersion: 1, content: [{ type: 'text', text: message.text }], mentionLabels: [], delivery: delivery.state === 'not-requested' ? { kind: 'not-requested' } : { kind: 'requested', recipients: [delivery] } }
}
