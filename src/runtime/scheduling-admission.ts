/** Private scheduling queue and the review tool's admission completion boundary. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamTask } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'

export class SchedulingAdmission {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly context = new AsyncLocalStorage<string>()
  private readonly abort = new AbortController()

  constructor(private readonly deps: {
    run(scope: TeamScope, teamId: TeamId, captain: Agent): Promise<void>
    failed(scope: TeamScope, teamId: TeamId, error: unknown): void
  }) {}

  request(scope: TeamScope, teamId: TeamId, captain: Agent, propagateFailure = false): Promise<void> {
    const key = `${scope}\0${teamId}`
    const previous = this.pending.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => { await this.context.run(key, () => this.deps.run(scope, teamId, captain)) })
    const next = operation.catch(error => this.deps.failed(scope, teamId, error))
      .finally(() => { if (this.pending.get(key) === next) this.pending.delete(key) })
    this.pending.set(key, next)
    return propagateFailure ? operation : next
  }

  /** Only the post-commit checks and admission belong inside this error boundary. */
  async committedReview<T extends { task: TeamTask }>(result: T, callerSignal: AbortSignal, admit: () => Promise<void>): Promise<T> {
    try { await admit(); return result }
    catch (cause) {
      throw new TeamDomainError(
        `review of task ${JSON.stringify(result.task.id)} committed as ${result.task.status}; admission failed or interrupted, re-read the task board`,
        callerSignal.aborted || this.abort.signal.aborted ? 'TEAM_REVIEW_ADMISSION_INTERRUPTED' : 'TEAM_REVIEW_ADMISSION_FAILED', { cause },
      )
    }
  }

  async afterReview(scope: TeamScope, teamId: TeamId, captain: Agent, callerSignal: AbortSignal): Promise<void> {
    const pass = this.request(scope, teamId, captain, true)
    // A continuable Captain can settle immediately after its tool returns.
    // Await this admission pass, never member completion or queue quiescence.
    // A Provider reviewing inside the current pass queues a successor without
    // awaiting itself; its queued failure still reaches the failure observer.
    if (this.context.getStore() === `${scope}\0${teamId}`) return
    const signal = AbortSignal.any([callerSignal, this.abort.signal])
    await new Promise<void>((resolveWait, rejectWait) => {
      const abort = (): void => { rejectWait(signal.reason) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      void pass.then(resolveWait, rejectWait).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  close(): void { this.abort.abort(new Error('Team orchestrator disposal')) }
  async wait(): Promise<void> { await Promise.allSettled(this.pending.values()) }
}
