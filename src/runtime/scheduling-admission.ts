/** Private scheduling queue and committed tool operations' admission boundary. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamTask } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'

export class SchedulingAdmission {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly context = new AsyncLocalStorage<{ key: string; active: boolean }>()
  private readonly abort = new AbortController()

  constructor(private readonly deps: {
    run(scope: TeamScope, teamId: TeamId, captain: Agent): Promise<void>
    failed(scope: TeamScope, teamId: TeamId, error: unknown): void
  }) {}

  request(scope: TeamScope, teamId: TeamId, captain: Agent, propagateFailure = false): Promise<void> {
    const key = `${scope}\0${teamId}`
    const previous = this.pending.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => { await this.context.exit(() => this.deps.run(scope, teamId, captain)) })
    const next = operation.catch(error => this.deps.failed(scope, teamId, error))
      .finally(() => { if (this.pending.get(key) === next) this.pending.delete(key) })
    this.pending.set(key, next)
    return propagateFailure ? operation : next
  }

  /** Only an awaited Provider callback can need to avoid waiting on its own pass. */
  async duringProvider<T>(scope: TeamScope, teamId: TeamId, operation: () => T | Promise<T>): Promise<T> {
    const token = { key: `${scope}\0${teamId}`, active: true }
    try { return await this.context.run(token, operation) }
    finally { token.active = false }
  }

  committedReview<T extends { task: TeamTask }>(result: T, signal: AbortSignal, admit: () => Promise<void>): Promise<T> {
    return this.committed(result, signal, { codePrefix: 'TEAM_REVIEW_ADMISSION',
      description: `review of task ${JSON.stringify(result.task.id)} committed as ${result.task.status}`,
    }, admit)
  }

  /** Only the post-commit checks and admission belong inside this error boundary. */
  async committed<T>(result: T, callerSignal: AbortSignal,
    commit: { description: string; codePrefix: string }, admit: () => Promise<void>): Promise<T> {
    try { await admit(); return result }
    catch (cause) {
      throw new TeamDomainError(
        `${commit.description}; admission failed or interrupted, re-read the task board`,
        `${commit.codePrefix}_${callerSignal.aborted || this.abort.signal.aborted ? 'INTERRUPTED' : 'FAILED'}`, { cause },
      )
    }
  }

  async afterCommit(scope: TeamScope, teamId: TeamId, captain: Agent, callerSignal: AbortSignal): Promise<void> {
    const pass = this.request(scope, teamId, captain, true)
    // A continuable Captain can settle immediately after its tool returns.
    // Await this admission pass, never member completion or queue quiescence.
    // A Provider reviewing inside the current pass queues a successor without
    // awaiting itself; its queued failure still reaches the failure observer.
    const provider = this.context.getStore()
    if (provider?.active && provider.key === `${scope}\0${teamId}`) return
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
  async waitTeam(scope: TeamScope, teamId: TeamId): Promise<void> { await this.pending.get(`${scope}\0${teamId}`) }
}
