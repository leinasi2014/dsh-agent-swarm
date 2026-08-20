/**
 * Cumulative Team token accounting folded from Session events.
 *
 * Consecutive usage events are coalesced per scope+session into one batched
 * durable write (M1C usage write coalescing): events observed while a chain
 * is in flight accumulate and fold with the next run, and each chain is
 * strictly serialized. Writes stay idempotent per event seq through the
 * domain's one usage cursor per session, so replay and reload recovery never
 * double-count. A failed batch write is dropped with a warning exactly like
 * the pre-coalescing per-event write — the durable cursor plus the recovery
 * refold below remain the correctness net. This is the seam the official
 * `ctx.tokenMeter` adapter will own in M4 — it must stay the single
 * measurement path for the Team budget.
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId } from '../domain/types.js'

/** One coalesced usage entry: the billed tokens of one event seq. */
interface UsageEntry {
  readonly seq: number
  readonly tokens: number
}

function billedTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/** Serialized, replay-safe event folding into the authoritative Team budget. */
export class UsageAccountant {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, UsageEntry[]>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      isClosing: () => boolean
    },
  ) {}

  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.deps.isClosing() || event.type !== 'assistant/message' || event.data.usage === undefined) return
    const entry: UsageEntry = { seq: event.seq, tokens: billedTokens(event.data.usage) }
    const scope = resolve(session.header.cwd ?? process.cwd())
    const key = `${scope}\0${session.id}`
    const queue = this.pending.get(key) ?? []
    queue.push(entry)
    this.pending.set(key, queue)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(() => this.flush(key, scope, session.id)).catch(error => {
      if (!this.deps.isClosing()) this.ctx.logger.warn(`agent-swarm: token accounting failed: ${String(error)}`)
    }).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
  }

  /** Drain one session's accumulated entries into a single batched write. */
  private async flush(key: string, scope: TeamScope, sessionId: string): Promise<void> {
    const entries = this.pending.get(key)
    this.pending.delete(key)
    if (entries === undefined || entries.length === 0) return
    const membership = await this.deps.domain().findMembership(scope, sessionId)
    if (membership === undefined) return
    await this.deps.domain().recordSessionUsageBatch(
      scope, membership.team.id, sessionId,
      entries.map(entry => ({ eventSeq: entry.seq, tokens: entry.tokens })),
    )
  }

  /** Fold an agent's session history from its usage cursor (recovery path). */
  async accountAgentUsage(scope: TeamScope, teamId: TeamId, agent: Agent): Promise<void> {
    const snapshot = await this.deps.domain().snapshot(scope, teamId, agent.id)
    const afterSeq = snapshot.team.usageCursors[agent.id] ?? -1
    const entries: UsageEntry[] = []
    for (const event of agent.session.events) {
      if (event.seq <= afterSeq) continue
      if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
      entries.push({ seq: event.seq, tokens: billedTokens(event.data.usage) })
    }
    if (entries.length === 0) return
    await this.deps.domain().recordSessionUsageBatch(
      scope, teamId, agent.id,
      entries.map(entry => ({ eventSeq: entry.seq, tokens: entry.tokens })),
    )
  }

  /** Wait for every in-flight accounting chain (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<void>>> {
    return Promise.allSettled(this.chains.values())
  }
}
