/**
 * A tiny process-local commit sequence: serializes operations that must resolve in
 * call order (each op awaits its predecessor's settlement). Shared by the
 * human-interaction overlay and the member-private-memory store to guarantee
 * durable append order within one process. Explicitly not a cross-process claim.
 */
export class CommitSequence {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.tail = previous.then(() => current)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
