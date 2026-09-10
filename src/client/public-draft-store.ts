import type { PublicDraft } from './public-draft.js'
import type { PublicChatAppendRequest } from '../rpc/public-rpc-contract.js'

/** v3 request descriptors refer to Blob IDs; encoding to the RPC wire happens after commit. */
export interface PublicDraftRequest { readonly schemaVersion: 1 | 2 | 3; readonly requestId: string }
export interface PublicDraftPending<Request extends PublicDraftRequest = PublicDraftRequest> {
  readonly request: Request
  readonly version: number
  readonly captain: string
  readonly blobIds?: readonly string[]
  readonly upgradedLegacy?: boolean
  readonly legacyRequest?: PublicChatAppendRequest
  readonly legacyVersion?: number
}
export interface PublicDraftSnapshot<Request extends PublicDraftRequest = PublicDraftRequest> {
  readonly draft: PublicDraft
  readonly pending?: PublicDraftPending<Request>
  readonly legacyUpgrade?: boolean
  readonly blobs: Readonly<Record<string, Blob>>
}
const empty = (): PublicDraftSnapshot => ({ draft: { text: '', version: 0, tokens: [] }, blobs: {} })
const failure = (message: string): Error => new Error(`Public draft storage: ${message}`)

/** One record per existing Host/Main/Team key. All mutations read and write in one IDB transaction. */
export class PublicDraftStore {
  private database: Promise<IDBDatabase> | undefined
  private closed = false
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = 'swarm.public.drafts') {}

  async read<Request extends PublicDraftRequest = PublicDraftRequest>(key: string): Promise<PublicDraftSnapshot<Request>> {
    return this.transaction(key, undefined) as Promise<PublicDraftSnapshot<Request>>
  }
  /** expectedVersion is the last observed durable revision, not the new local edit count. */
  async writeDraft(key: string, draft: PublicDraft, expectedVersion: number, blobs: Readonly<Record<string, Blob>> = {}): Promise<PublicDraftSnapshot> {
    const copy = structuredClone({ draft, blobs })
    return this.transaction(key, current => mergeDraft(current, copy.draft, expectedVersion, copy.blobs))
  }
  /** Freezes the exact descriptor and Blob set before any RPC; an existing unknown operation cannot be replaced. */
  async freeze<Request extends PublicDraftRequest>(key: string, draft: PublicDraft, pending: PublicDraftPending<Request>, expectedVersion: number, blobs: Readonly<Record<string, Blob>> = {}): Promise<PublicDraftSnapshot<Request>> {
    const copy = structuredClone({ draft, pending, blobs })
    return this.transaction(key, current => {
      if (current.pending !== undefined) throw failure('pending operation already exists')
      if (copy.pending.version !== copy.draft.version || !copy.pending.request.requestId) throw failure('invalid pending revision or identity')
      return { ...mergeDraft(current, copy.draft, expectedVersion, copy.blobs), pending: copy.pending }
    }) as Promise<PublicDraftSnapshot<Request>>
  }
  /** A stale response is a no-op. A committed request clears only its original draft revision. */
  async settle(key: string, requestId: string, version: number, committed: boolean): Promise<PublicDraftSnapshot> {
    return this.transaction(key, current => {
      if (current.pending?.request.requestId !== requestId || current.pending.version !== version) return current
      const { pending: _pending, legacyUpgrade: _legacy, ...rest } = current
      return { ...rest, draft: committed && current.draft.version === version ? { text: '', tokens: [], version: version + 1 } : current.draft }
    })
  }
  /** An explicit legacy upgrade replaces pending atomically; its original payload remains recoverable. */
  async upgradePending<Request extends PublicDraftRequest>(key: string, draft: PublicDraft, pending: PublicDraftPending<Request>, expectedVersion: number, blobs: Readonly<Record<string, Blob>> = {}): Promise<PublicDraftSnapshot<Request>> {
    const copy = structuredClone({ draft, pending, blobs })
    return this.transaction(key, current => {
      const previous = current.pending, original = copy.pending.legacyRequest
      const target = (copy.pending.request as PublicDraftRequest & { target?: PublicChatAppendRequest['target'] }).target
      if (previous?.request.schemaVersion !== 1 || copy.pending.request.schemaVersion !== 3 || !current.legacyUpgrade
        || copy.pending.request.requestId !== previous.request.requestId || copy.pending.version !== copy.draft.version
        || copy.pending.legacyVersion !== (previous.legacyVersion ?? previous.version) || !copy.pending.upgradedLegacy
        || original === undefined || copy.pending.captain !== previous.captain || target?.rootSessionId !== original.target.rootSessionId || target?.teamId !== original.target.teamId
        || !sameLegacyRequest(original, previous.request as PublicChatAppendRequest)) throw failure('legacy pending changed')
      const { legacyUpgrade: _legacy, ...updated } = mergeDraft(current, copy.draft, expectedVersion, copy.blobs)
      return { ...updated, pending: copy.pending }
    }) as Promise<PublicDraftSnapshot<Request>>
  }
  async markLegacyUpgrade(key: string, requestId: string, version: number): Promise<PublicDraftSnapshot> {
    return this.transaction(key, current => current.pending?.request.schemaVersion === 1 && current.pending.request.requestId === requestId && current.pending.version === version ? { ...current, legacyUpgrade: true } : current)
  }
  /** A definite upgrade rejection restores provenance in the same transaction as releasing its v3 Blobs. */
  async restoreLegacyPending(key: string, requestId: string, version: number): Promise<PublicDraftSnapshot> {
    return this.transaction(key, current => {
      const pending = current.pending
      if (pending?.request.requestId !== requestId || pending.version !== version || pending.legacyRequest === undefined) return current
      const legacyVersion = pending.legacyVersion ?? pending.version
      return { ...current, legacyUpgrade: true, pending: { request: pending.legacyRequest, captain: pending.captain, version: legacyVersion, legacyVersion, upgradedLegacy: true } }
    })
  }
  /** Caller validates legacy JSON and removes it only after this promise resolves; existing IDB data wins. */
  async migrateLegacy<Request extends PublicDraftRequest>(key: string, saved: Omit<PublicDraftSnapshot<Request>, 'blobs'>): Promise<PublicDraftSnapshot<Request>> {
    const copy = structuredClone(saved)
    return this.transaction(key, (current, exists) => exists ? current : { ...copy, blobs: {} }) as Promise<PublicDraftSnapshot<Request>>
  }
  close(): void {
    this.closed = true
    void this.database?.then(database => database.close(), () => {})
  }
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(failure('closed'))
    if (this.database === undefined) this.database = new Promise((resolve, reject) => {
      if (this.factory === undefined) { reject(failure('IndexedDB unavailable')); return }
      const request = this.factory.open(this.name, 1)
      let blocked = false
      request.addEventListener('upgradeneeded', () => { request.result.createObjectStore('scopes') })
      request.addEventListener('error', () => { reject(request.error ?? failure('open failed')) })
      request.addEventListener('blocked', () => { blocked = true; reject(failure('database upgrade blocked')) })
      request.addEventListener('success', () => {
        const database = request.result
        database.addEventListener('versionchange', () => { this.closed = true; database.close() })
        if (this.closed || blocked) { database.close(); reject(failure('closed')); return }
        resolve(database)
      })
    })
    const opening = this.database
    void opening.catch(() => { if (this.database === opening) this.database = undefined })
    return opening
  }
  private async transaction(key: string, update: ((current: PublicDraftSnapshot, exists: boolean) => PublicDraftSnapshot) | undefined): Promise<PublicDraftSnapshot> {
    const database = await this.open()
    if (this.closed) throw failure('closed')
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('scopes', update === undefined ? 'readonly' : 'readwrite', { durability: 'strict' })
      const store = transaction.objectStore('scopes')
      let result: PublicDraftSnapshot, error: unknown
      transaction.addEventListener('complete', () => { resolve(result) })
      transaction.addEventListener('abort', () => { reject(error ?? transaction.error ?? failure('transaction aborted')) })
      const request = store.get(key)
      request.addEventListener('success', () => {
        try {
          const current = (request.result as PublicDraftSnapshot | undefined) ?? empty()
          result = update === undefined ? current : retainReferencedBlobs(update(current, request.result !== undefined))
          if (update !== undefined) store.put(result, key)
        } catch (cause) { error = cause; transaction.abort() }
      })
    })
  }
}

function mergeDraft(current: PublicDraftSnapshot, draft: PublicDraft, expectedVersion: number, blobs: Readonly<Record<string, Blob>>): PublicDraftSnapshot {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.draft.version
    || !Number.isSafeInteger(draft.version) || draft.version < 0 || draft.version < current.draft.version
    || (draft.version === current.draft.version && !sameDraft(draft, current.draft))) throw failure('draft revision conflict')
  for (const [id, blob] of Object.entries(blobs)) {
    if (!id || !(blob instanceof Blob)) throw failure('invalid Blob')
    if (Object.hasOwn(current.blobs, id)) throw failure('Blob identity cannot be replaced')
  }
  return { ...current, draft, blobs: { ...current.blobs, ...blobs } }
}
function sameDraft(a: PublicDraft, b: PublicDraft): boolean {
  return a.text === b.text && a.replyTo === b.replyTo
    && JSON.stringify(a.tokens.map(token => [token.start, token.end, token.memberId, token.label])) === JSON.stringify(b.tokens.map(token => [token.start, token.end, token.memberId, token.label]))
    && JSON.stringify((a.images ?? []).map(image => [image.blobId, image.mediaType, image.name, image.status, image.width, image.height, image.error])) === JSON.stringify((b.images ?? []).map(image => [image.blobId, image.mediaType, image.name, image.status, image.width, image.height, image.error]))
}
function sameLegacyRequest(a: PublicChatAppendRequest, b: PublicChatAppendRequest): boolean {
  return a.schemaVersion === b.schemaVersion && a.requestId === b.requestId && a.text === b.text && a.replyTo === b.replyTo
    && a.target.rootSessionId === b.target.rootSessionId && a.target.teamId === b.target.teamId
}
function retainReferencedBlobs(saved: PublicDraftSnapshot): PublicDraftSnapshot {
  const ids = new Set([...(saved.draft.images ?? []).map(image => image.blobId), ...saved.pending?.blobIds ?? []])
  const blobs: Record<string, Blob> = Object.create(null) as Record<string, Blob>
  for (const id of ids) {
    if (!id || !Object.hasOwn(saved.blobs, id) || !(saved.blobs[id] instanceof Blob)) throw failure('referenced Blob missing')
    blobs[id] = saved.blobs[id]!
  }
  return { ...saved, blobs }
}
