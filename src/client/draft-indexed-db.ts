/** Shared browser lifecycle only. Callers own database names, record formats and mutation rules. */
export class DraftIndexedDatabase {
  private database: Promise<IDBDatabase> | undefined
  private closed = false
  constructor(private readonly factory: IDBFactory, private readonly name: string, private readonly failure: (reason: string) => Error) {}

  close(): void { this.closed = true; void this.database?.then(database => { database.close() }).catch(() => {}) }
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(this.failure('closed'))
    if (this.database !== undefined) return this.database
    this.database = new Promise((resolve, reject) => {
      if (this.factory === undefined) { reject(this.failure('IndexedDB unavailable')); return }
      const request = this.factory.open(this.name, 1)
      let blocked = false
      request.addEventListener('upgradeneeded', () => { request.result.createObjectStore('scopes') })
      request.addEventListener('error', () => { reject(request.error ?? this.failure('open failed')) })
      request.addEventListener('blocked', () => { blocked = true; reject(this.failure('database upgrade blocked')) })
      request.addEventListener('success', () => {
        const database = request.result
        database.addEventListener('versionchange', () => { this.closed = true; database.close() })
        if (this.closed || blocked) { database.close(); reject(this.failure('closed')); return }
        resolve(database)
      })
    })
    const opening = this.database
    void opening.catch(() => { if (this.database === opening) this.database = undefined })
    return opening
  }
  async transaction<Result>(key: string, write: boolean, compute: (stored: unknown, exists: boolean) => Result): Promise<Result> {
    const database = await this.open()
    if (this.closed) throw this.failure('closed')
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('scopes', write ? 'readwrite' : 'readonly', { durability: 'strict' })
      const store = transaction.objectStore('scopes')
      let result: Result, error: unknown
      transaction.addEventListener('complete', () => { resolve(result) })
      transaction.addEventListener('abort', () => { reject(error ?? transaction.error ?? this.failure('transaction aborted')) })
      const request = store.get(key)
      request.addEventListener('success', () => {
        try {
          result = compute(request.result, request.result !== undefined)
          if (write) store.put(result, key)
        } catch (cause) { error = cause; transaction.abort() }
      })
    })
  }
}
