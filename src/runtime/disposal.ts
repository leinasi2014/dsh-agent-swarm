/**
 * Bounded disposal settlement (F4).
 *
 * `AbortSignal.timeout` plus `Promise.race` hold one in-flight disposal
 * settle inside `disposalTimeoutMs`, matching the official experimental
 * `TEAM_DISPOSAL_TIMEOUT` semantics (same code vocabulary, bounded settle).
 * A timeout records a diagnostic and becomes a visible failure in the
 * caller's disposal `AggregateError` — fail loud, never a silently abandoned
 * recycle. The losing operation keeps running and its eventual rejection is
 * observed so it can never surface as an unhandled rejection.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TeamDomainError } from '../domain/error.js'

/**
 * Bound one disposal settlement step (admitted provisioning/delivery
 * operations, scheduling passes, accounting chains, child drains, store
 * closes), recording a `TEAM_DISPOSAL_TIMEOUT` failure on timeout.
 */
export async function boundedSettle<T>(
  ctx: Context,
  disposalTimeoutMs: number,
  label: string,
  operation: Promise<T>,
  failures: unknown[],
): Promise<void> {
  const signal = AbortSignal.timeout(disposalTimeoutMs)
  const timeout = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new TeamDomainError(
        `Team orchestrator disposal step "${label}" exceeded ${disposalTimeoutMs}ms`,
        'TEAM_DISPOSAL_TIMEOUT',
      ))
    }, { once: true })
  })
  // The timeout settles after the race whenever the operation wins; observe
  // it so it can never surface as an unhandled rejection.
  timeout.catch(() => {})
  try {
    await Promise.race([operation, timeout])
  } catch (error) {
    failures.push(error)
    ctx.logger.error(`agent-swarm: disposal step "${label}" did not settle within ${disposalTimeoutMs}ms: ${String(error)}`)
    Promise.resolve(operation).catch(() => {})
  }
}
