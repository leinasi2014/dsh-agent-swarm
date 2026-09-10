import { DraftIndexedDatabase } from './draft-indexed-db.js'
import type { WorkSubmitRequest } from '../rpc/work-rpc-contract.js'

export interface WorkRequestDraft { readonly description: string; readonly acceptanceCriteria: string; readonly version: number }
export interface WorkRequestPending { readonly request: WorkSubmitRequest; readonly version: number }
export interface WorkRequestDraftSnapshot { readonly schemaVersion: 1; readonly draft: WorkRequestDraft; readonly pending?: WorkRequestPending }
export const emptyWorkDraft = (): WorkRequestDraft => ({ description: '', acceptanceCriteria: '', version: 0 })
const empty = (): WorkRequestDraftSnapshot => ({ schemaVersion: 1, draft: emptyWorkDraft() })
const failure = (reason: string): Error => new Error(`Work request draft storage: ${reason}`)

/** Text-only drafts and unknown submissions, committed together per Host/Main/Team. */
export class WorkRequestDraftStore {
  private readonly storage: DraftIndexedDatabase
  constructor(factory: IDBFactory = globalThis.indexedDB, name = 'swarm.work.drafts') {
    this.storage = new DraftIndexedDatabase(factory, name, failure)
  }

  async read(key: string): Promise<WorkRequestDraftSnapshot> { return await this.transaction(key) }
  async writeDraft(key: string, draft: WorkRequestDraft, expectedVersion: number): Promise<WorkRequestDraftSnapshot> {
    const copy = structuredClone(draft)
    return await this.transaction(key, current => mergeDraft(current, copy, expectedVersion))
  }
  async freeze(key: string, draft: WorkRequestDraft, pending: WorkRequestPending, expectedVersion: number): Promise<WorkRequestDraftSnapshot> {
    const copy = structuredClone({ draft, pending })
    return await this.transaction(key, current => {
      if (current.pending !== undefined) throw failure('pending operation already exists')
      if (copy.pending.version !== copy.draft.version || copy.pending.request.description !== copy.draft.description.trim()
        || (copy.pending.request.acceptanceCriteria ?? '') !== copy.draft.acceptanceCriteria.trim()) throw failure('frozen payload differs from draft')
      return { ...mergeDraft(current, copy.draft, expectedVersion), pending: copy.pending }
    })
  }
  async settle(key: string, requestId: string, version: number, committed: boolean): Promise<WorkRequestDraftSnapshot> {
    return await this.transaction(key, current => {
      if (current.pending?.request.requestId !== requestId || current.pending.version !== version) return current
      const { pending: _pending, ...rest } = current
      return { ...rest, draft: committed && current.draft.version === version ? { ...emptyWorkDraft(), version: version + 1 } : current.draft }
    })
  }
  close(): void { this.storage.close() }
  private async transaction(key: string, update?: (current: WorkRequestDraftSnapshot) => WorkRequestDraftSnapshot): Promise<WorkRequestDraftSnapshot> {
    return await this.storage.transaction(key, update !== undefined, stored => {
      const current = stored === undefined ? empty() : decode(stored)
      return update === undefined ? current : decode(update(current))
    })
  }
}

function mergeDraft(current: WorkRequestDraftSnapshot, draft: WorkRequestDraft, expectedVersion: number): WorkRequestDraftSnapshot {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.draft.version
    || !Number.isSafeInteger(draft.version) || draft.version < current.draft.version
    || (draft.version === current.draft.version && (draft.description !== current.draft.description || draft.acceptanceCriteria !== current.draft.acceptanceCriteria))) throw failure('draft revision conflict')
  return { ...current, draft }
}
function decode(value: unknown): WorkRequestDraftSnapshot {
  if (typeof value !== 'object' || value === null) throw failure('invalid saved draft')
  const saved = value as WorkRequestDraftSnapshot
  if (saved.schemaVersion !== 1 || typeof saved.draft?.description !== 'string' || typeof saved.draft.acceptanceCriteria !== 'string'
    || !Number.isSafeInteger(saved.draft.version) || saved.draft.version < 0) throw failure('invalid saved draft')
  const pending = saved.pending
  if (pending !== undefined && (!Number.isSafeInteger(pending.version) || pending.version < 0 || pending.version > saved.draft.version
    || pending.request?.schemaVersion !== 1 || typeof pending.request.requestId !== 'string' || !pending.request.requestId
    || typeof pending.request.description !== 'string' || !pending.request.description.trim() || pending.request.description.length > 8192
    || (pending.request.acceptanceCriteria !== undefined && (typeof pending.request.acceptanceCriteria !== 'string' || pending.request.acceptanceCriteria.length > 4096))
    || typeof pending.request.target?.rootSessionId !== 'string' || !pending.request.target.rootSessionId
    || typeof pending.request.target.teamId !== 'string' || !pending.request.target.teamId)) throw failure('invalid saved operation')
  return saved
}
