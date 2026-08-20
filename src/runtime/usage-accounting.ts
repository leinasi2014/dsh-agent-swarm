/**
 * Cumulative Team token accounting folded from Session events.
 *
 * Every accounting chain is keyed by scope+session and strictly serialized;
 * writes are idempotent per event seq (the domain keeps one usage cursor per
 * session). This is the seam the official `ctx.tokenMeter` adapter will own
 * in M4 — it must stay the single measurement path for the Team budget.
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId } from '../domain/types.js'

function billedTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/** Serialized, replay-safe event folding into the authoritative Team budget. */
export class UsageAccountant {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      isClosing: () => boolean
    },
  ) {}

  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.deps.isClosing() || event.type !== 'assistant/message' || event.data.usage === undefined) return
    const tokens = billedTokens(event.data.usage)
    const scope = resolve(session.header.cwd ?? process.cwd())
    const key = `${scope}\0${session.id}`
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      const membership = await this.deps.domain().findMembership(scope, session.id)
      if (membership === undefined) return
      await this.deps.domain().recordSessionUsage(scope, membership.team.id, session.id, event.seq, tokens)
    }).catch(error => {
      if (!this.deps.isClosing()) this.ctx.logger.warn(`agent-swarm: token accounting failed: ${String(error)}`)
    }).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
  }

  /** Fold an agent's session history from its usage cursor (recovery path). */
  async accountAgentUsage(scope: TeamScope, teamId: TeamId, agent: Agent): Promise<void> {
    const snapshot = await this.deps.domain().snapshot(scope, teamId, agent.id)
    const afterSeq = snapshot.team.usageCursors[agent.id] ?? -1
    for (const event of agent.session.events) {
      if (event.seq <= afterSeq) continue
      if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
      const tokens = billedTokens(event.data.usage)
      await this.deps.domain().recordSessionUsage(scope, teamId, agent.id, event.seq, tokens)
    }
  }

  /** Wait for every in-flight accounting chain (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<void>>> {
    return Promise.allSettled(this.chains.values())
  }
}
