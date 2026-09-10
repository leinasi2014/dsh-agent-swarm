import { z } from 'zod'
import type { PublicChatAppendRequest, PublicChatHistoryResponse, PublicChatMessage, PublicChatResponse } from '../rpc/public-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import { PublicChatRpcError, type PublicChatClient } from './public-rpc-client.js'

interface Selection { readonly key: string; readonly viewer: string; readonly captain: string; readonly team: string; readonly revision: number }
interface Draft { readonly text: string; readonly version: number; readonly replyTo?: string }
interface Pending { readonly request: PublicChatAppendRequest; readonly version: number; readonly captain: string }
interface Saved { draft: Draft; pending?: Pending }
export interface PublicChatState {
  readonly selection: Selection | undefined
  readonly entries: readonly PublicChatMessage[]
  readonly history: PublicChatHistoryResponse | undefined
  readonly draft: Draft
  readonly sending: boolean
  readonly pending: boolean
  readonly loading: boolean
  readonly error: string | undefined
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const emptyDraft: Draft = Object.freeze({ text: '', version: 0 })
const initial: PublicChatState = Object.freeze({ selection: undefined, entries: [], history: undefined, draft: emptyDraft, sending: false, pending: false, loading: false, error: undefined })
const savedSchema = z.object({
  draft: z.object({ text: z.string(), version: z.number().int().nonnegative(), replyTo: z.string().optional() }),
  pending: z.object({ version: z.number().int().nonnegative(), captain: z.string(), request: z.object({ schemaVersion: z.literal(1), requestId: z.string().min(1), text: z.string(), replyTo: z.string().optional(), target: z.object({ rootSessionId: z.string().min(1), teamId: z.string().min(1) }) }) }).optional(),
})

/** View state only. Team facts remain in the shared dashboard and messages in public RPC. */
export class PublicChatController {
  private state = initial
  private readonly listeners = new Set<() => void>()
  private readonly saved = new Map<string, Saved>()
  private readonly busy = new Set<string>()
  private read: AbortController | undefined
  /** Only a history page advances this cursor; an append receipt may be ahead of unread messages. */
  private historyCursor: number | undefined
  private readonly lifetime = new AbortController()
  private disposed = false
  constructor(private readonly client: Pick<PublicChatClient, 'history' | 'append' | 'requestResult'>,
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
    const data = dashboard.phase === 'ready' ? dashboard.data : undefined
    const main = data?.teams.binding.mainSessionId
    const team = data?.projection.binding.teamId
    const viewer = dashboard.targetSessionId
    const next: Selection | undefined = data !== undefined && main !== undefined && team !== undefined && viewer !== undefined
      && data.teams.binding.rootSessionId === viewer && data.teams.complete
      ? { key: `swarm.public.v1:${JSON.stringify([this.environment, main, team])}`, viewer, team, captain: data.projection.binding.rootSessionId, revision: data.projection.team.revision } : undefined
    if (next === undefined) {
      this.read?.abort(); this.historyCursor = undefined; this.publish({ ...initial })
      return
    }
    const previous = this.state.selection
    if (previous?.key === next.key && previous.viewer === next.viewer && previous.captain === next.captain) {
      if (previous.revision !== next.revision) { this.publish({ ...this.state, selection: next }); void this.refresh() }
      return
    }
    this.read?.abort()
    this.historyCursor = undefined
    const saved = this.readSaved(next.key)
    this.publish({ ...initial, selection: next, draft: saved.draft, pending: saved.pending !== undefined, sending: this.busy.has(next.key) })
    void this.refresh()
  }
  edit(text: string, replyTo = this.state.draft.replyTo): void {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key)
    saved.draft = { text, version: saved.draft.version + 1, ...(replyTo === undefined ? {} : { replyTo }) }
    this.persist(key, saved)
    this.publish({ ...this.state, draft: saved.draft })
  }
  reply(messageId: string | undefined): void {
    const key = this.state.selection?.key
    if (key === undefined) return
    const saved = this.readSaved(key)
    saved.draft = { text: saved.draft.text, version: saved.draft.version + 1, ...(messageId === undefined ? {} : { replyTo: messageId }) }
    this.persist(key, saved); this.publish({ ...this.state, draft: saved.draft })
  }
  async refresh(): Promise<void> {
    const selected = this.state.selection
    if (selected === undefined) return
    await this.load(selected, 'refresh')
  }
  async earlier(): Promise<void> {
    const selected = this.state.selection
    if (selected === undefined || this.state.loading || !this.state.history?.hasEarlier) return
    await this.load(selected, 'earlier')
  }
  async newer(): Promise<void> {
    const selected = this.state.selection
    if (selected === undefined || this.state.loading || !this.state.history?.hasMore) return
    await this.load(selected, 'newer')
  }
  private async load(selected: Selection, direction: 'refresh' | 'earlier' | 'newer'): Promise<void> {
    this.read?.abort()
    const read = this.read = new AbortController()
    const old = this.state.entries
    this.publish({ ...this.state, loading: true, error: undefined })
    const request = { schemaVersion: 1 as const, target: { rootSessionId: selected.viewer, teamId: selected.team } }
    try {
      const page = await this.client.history({ ...request, limit: 50,
        ...(direction === 'earlier' && old[0] !== undefined ? { beforeSequence: old[0].sequence } : {}),
        ...(direction !== 'earlier' && this.historyCursor !== undefined ? { afterSequence: this.historyCursor } : {}),
      }, read.signal)
      this.checkBinding(page, selected)
      let entries = merge(old, page.entries)
      // Re-read only already displayed ranges: delivery can change on old messages.
      if (direction === 'refresh') {
        for (let index = 0; index < old.length; index += 100) {
          const visible = old.slice(index, index + 100)
          const range = await this.client.history({ ...request, afterSequence: visible[0]!.sequence - 1, limit: visible.length }, read.signal)
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
    if (selected === undefined || this.state.history?.appendEligibility.state !== 'available') return
    const saved = this.readSaved(selected.key)
    if (saved.pending !== undefined || this.busy.has(selected.key) || saved.draft.text.trim() === '') return
    if (new TextEncoder().encode(saved.draft.text).length > this.state.history.limits.maxTextBytes) return
    const pending: Pending = { version: saved.draft.version, captain: selected.captain, request: { schemaVersion: 1, target: { rootSessionId: selected.viewer, teamId: selected.team }, requestId: this.requestId(), text: saved.draft.text, ...(saved.draft.replyTo === undefined ? {} : { replyTo: saved.draft.replyTo }) } }
    saved.pending = pending
    // Save before dispatch, including the frozen viewer address and draft version.
    if (!this.persist(selected.key, saved)) { delete saved.pending; return }
    await this.submit(selected, saved, pending, false)
  }
  async recover(): Promise<void> {
    const selected = this.state.selection
    if (selected === undefined || this.busy.has(selected.key)) return
    const saved = this.readSaved(selected.key)
    if (saved.pending === undefined) return
    await this.submit(selected, saved, saved.pending, true)
  }
  private async submit(selected: Selection, saved: Saved, pending: Pending, recover: boolean): Promise<void> {
    this.busy.add(selected.key)
    this.updateOperation(selected, saved)
    try {
      if (pending.request.target.teamId !== selected.team || pending.captain !== selected.captain) throw new Error('Stored operation belongs to a different Team binding')
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
      const outcome = recover ? await this.client.requestResult({ schemaVersion: 1, target: pending.request.target, requestId: pending.request.requestId }, signal) : undefined
      if (outcome !== undefined) this.checkBinding(outcome, { ...selected, captain: pending.captain })
      // A not-found read does not license a new ID or edited payload.
      const response = outcome?.state === 'committed' ? outcome : await this.client.append(pending.request, signal)
      this.checkBinding(response, { ...selected, captain: pending.captain })
      if (saved.pending !== pending) return
      delete saved.pending
      if (saved.draft.version === pending.version) saved.draft = { text: '', version: saved.draft.version + 1 }
      this.persist(selected.key, saved)
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, entries: merge(this.state.entries, [response.message]), error: undefined })
    } catch (error) {
      // Capacity is checked before the aggregate changes. Other failures can
      // conceal a committed result and must retain the original request.
      if (error instanceof PublicChatRpcError && error.code === 'TEAM_PUBLIC_CAPACITY' && saved.pending === pending) delete saved.pending
      this.persist(selected.key, saved)
      if (this.isOperationCurrent(selected)) this.publish({ ...this.state, error: errorText(error) })
    } finally { this.busy.delete(selected.key); this.updateOperation(selected, saved) }
  }
  private updateOperation(selected: Selection, saved: Saved): void {
    if (this.isOperationCurrent(selected)) this.publish({ ...this.state, draft: saved.draft, pending: saved.pending !== undefined, sending: this.busy.has(selected.key) })
  }
  private checkBinding(response: PublicChatResponse, selected: Selection): void {
    if (response.binding.teamId !== selected.team || response.binding.rootSessionId !== selected.captain || response.teamRevision < selected.revision) throw new Error('Public conversation binding or revision changed')
  }
  private isCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.viewer === selected.viewer }
  private isOperationCurrent(selected: Selection): boolean { return !this.disposed && this.state.selection?.key === selected.key && this.state.selection.captain === selected.captain }
  private readSaved(key: string): Saved {
    const existing = this.saved.get(key)
    if (existing !== undefined) return existing
    let value: Saved = { draft: emptyDraft }
    try { const raw = this.storage?.getItem(key); if (raw) value = savedSchema.parse(JSON.parse(raw)) as Saved } catch { /* Invalid browser cache is never authority. */ }
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
  dispose(): void { this.disposed = true; this.read?.abort(); this.lifetime.abort(); this.listeners.clear() }
}

function merge(old: readonly PublicChatMessage[], incoming: readonly PublicChatMessage[]): readonly PublicChatMessage[] {
  const entries = new Map(old.map(entry => [entry.id, entry]))
  for (const entry of incoming) {
    const previous = entries.get(entry.id)
    // A delayed append replay cannot downgrade a later claimed history row.
    if (previous?.delivery.state !== 'claimed' || entry.delivery.state !== 'queued') entries.set(entry.id, entry)
  }
  return [...entries.values()].toSorted((a, b) => a.sequence - b.sequence)
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Public conversation unavailable' }
