/**
 * Cumulative Team token accounting folded from Session events.
 *
 * Consecutive usage events are coalesced per scope+session into one batched
 * durable write (M1C usage write coalescing): events observed while a chain
 * is in flight accumulate and fold with the next run, and each chain is
 * strictly serialized. Writes stay idempotent per event seq through the
 * domain's one usage cursor per session, so replay and reload recovery never
 * double-count. This is the seam the official `ctx.tokenMeter` adapter will
 * own in M4 — it must stay the single measurement path for the Team budget.
 *
 * Issue #92, loss-face hardening — the delivery-order contract and the two
 * writer lanes are NOT loss faces: the official session firehose publishes
 * `session/event` synchronously inside `Session.append`, in strict per-session
 * seq order (constructor seeds never publish), and every writer here submits
 * a contiguous suffix of usage events above its snapshot cursor, so whichever
 * lane commits first, a later batch can only skip seqs that were already
 * counted. The proven faces were (a) a flush resolving membership through the
 * authority-facing active-phase-only lookup while the member's roster row was
 * still `provisioning` (or draining after archive) — the entries were
 * silently discarded — and (b) events appended during runtime disposal being
 * dropped at the entry gate with no reload-time fold to heal them. Fixes: the
 * flush resolves through `findAccountingMembership` (exactly the Teams the
 * fold itself accepts), the entry gate is gone (a closing-time flush fails
 * contained exactly like a failed write, and the roster recovery below is the
 * net), and {@link UsageAccountant.recoverTeamUsage} refolds every roster
 * session — live agent or persisted history — so no drop survives a reload.
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState } from '../domain/types.js'

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

/** Usage entries of one event log above `afterSeq`, in ascending seq order. */
function usageEntriesAbove(events: readonly SessionEvent[], afterSeq: number): UsageEntry[] {
  const entries: UsageEntry[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    entries.push({ seq: event.seq, tokens: billedTokens(event.data.usage) })
  }
  return entries
}

/** One session's persisted history through the official inspect seam, or `undefined` when unreadable. */
async function persistedHistory(ctx: Context, sessionId: string): Promise<readonly SessionEvent[] | undefined> {
  try {
    return (await ctx.sessionPersistence.inspect(SessionId(sessionId), AbortSignal.timeout(30_000))).events
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      ctx.logger.warn(`agent-swarm: usage recovery cannot read session ${sessionId}: ${String(error)}`)
    }
    return undefined
  }
}

/** Serialized, replay-safe event folding into the authoritative Team budget. */
export class UsageAccountant {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, UsageEntry[]>()
  private readonly agents: { get(id: SessionId): Agent | undefined }
  private readonly history: (sessionId: string) => Promise<readonly SessionEvent[] | undefined>

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      isClosing: () => boolean
      /** Live-agent registry (defaults to `ctx.agents`); test seam for cold folds. */
      agents?: { get(id: SessionId): Agent | undefined }
      /** Persisted-history reader (defaults to the official inspect seam); test seam. */
      history?: (sessionId: string) => Promise<readonly SessionEvent[] | undefined>
    },
  ) {
    this.agents = deps.agents ?? ctx.agents
    this.history = deps.history ?? (sessionId => persistedHistory(ctx, sessionId))
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return
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
    // Billing resolution, not authority resolution (issue #92): the
    // active-phase-only authority lookup returned undefined for a member
    // whose roster row was still `provisioning` — its first-turn usage was
    // silently discarded. Resolve exactly the ledger the fold accepts. The
    // store filters canonical participant metadata before deep-reading
    // candidates; unrelated Team histories are not validated/cloned per flush.
    const membership = await this.deps.domain().findAccountingMembership(scope, sessionId)
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
    const entries = usageEntriesAbove(agent.session.events, afterSeq)
    if (entries.length === 0) return
    await this.deps.domain().recordSessionUsageBatch(
      scope, teamId, agent.id,
      entries.map(entry => ({ eventSeq: entry.seq, tokens: entry.tokens })),
    )
  }

  /**
   * Refold one whole Team roster's usage from the durable truth (issue #92's
   * recovery net): the captain and every roster session, live agents through
   * their in-process log and cold sessions through persisted history. The
   * per-session cursor makes this exactly-once — refolding after live
   * accounting only picks up events the live path dropped, and running it
   * repeatedly never double-counts (the M1B replay guarantee, unchanged).
   * Best-effort per session: a session that cannot be read is skipped with a
   * warning, never blocking the rest of recovery.
   */
  async recoverTeamUsage(scope: TeamScope, team: TeamState): Promise<void> {
    const snapshot = await this.deps.domain().snapshot(scope, team.id, team.captainSessionId)
    for (const sessionId of [team.captainSessionId, ...team.members.map(member => member.sessionId)]) {
      try {
        const agent = this.agents.get(SessionId(sessionId))
        if (agent !== undefined) {
          await this.accountAgentUsage(scope, team.id, agent)
          continue
        }
        const events = await this.history(sessionId)
        if (events === undefined) continue
        const afterSeq = snapshot.team.usageCursors[sessionId] ?? -1
        const entries = usageEntriesAbove(events, afterSeq)
        if (entries.length === 0) continue
        await this.deps.domain().recordSessionUsageBatch(
          scope, team.id, sessionId,
          entries.map(entry => ({ eventSeq: entry.seq, tokens: entry.tokens })),
        )
      } catch (error) {
        this.ctx.logger.warn(`agent-swarm: usage recovery skipped session ${sessionId}: ${String(error)}`)
      }
    }
  }

  /** Wait for every in-flight accounting chain (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<void>>> {
    return Promise.allSettled(this.chains.values())
  }
}
