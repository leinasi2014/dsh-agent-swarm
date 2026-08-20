/**
 * Durable-before-delivery Team mailbox delivery.
 *
 * Messages reach this collaborator only after the authoritative store has
 * committed them as queued. Delivery serializes per message id; the store
 * acknowledgement happens strictly after the target accepted the content.
 * The accepted-at-target / unacknowledged-in-store crash window (M1B/F2)
 * lands here: target-side stable-id de-duplication before resend.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamMessage, TeamMessageId, TeamState } from '../domain/types.js'

/** Serialized per-message delivery over the authoritative mailbox. */
export class MessageDelivery {
  private readonly chains = new Map<string, Promise<TeamMessage | undefined>>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      isClosing: () => boolean
      scopeOf: (agent: Agent) => TeamScope
      accountAgentUsage: (scope: TeamScope, teamId: TeamId, agent: Agent) => Promise<void>
    },
  ) {}

  /** Deliver one message body; `false` keeps it durably queued. */
  private async deliverMessage(team: TeamState, sender: Agent, message: TeamMessage, signal: AbortSignal): Promise<boolean> {
    try {
      if (message.targetSessionId === team.captainSessionId && sender.id !== team.captainSessionId) {
        await this.ctx.subagents.reportFrom(sender, [{ type: 'text', text: message.content }], {
          delivery: message.delivery === 'quiet' ? 'quiet' : 'next-step',
          signal,
        })
        return true
      }
      const captain = sender.id === team.captainSessionId
        ? sender
        : this.ctx.agents.get(SessionId(team.captainSessionId))
      if (captain === undefined) return false
      await this.ctx.subagents.followup(
        captain,
        SessionId(message.targetSessionId),
        [{ type: 'text', text: `Team message ${message.id} from ${message.senderName}:\n${message.content}` }],
        { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal },
      )
      const target = this.ctx.agents.get(SessionId(message.targetSessionId))
      if (target !== undefined) await this.deps.accountAgentUsage(this.deps.scopeOf(captain), team.id, target)
      return true
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: message ${message.id} remains queued: ${String(error)}`)
      return false
    }
  }

  /**
   * Run one message through its serialized chain: reread the authoritative
   * snapshot, deliver only if still queued, then acknowledge after target
   * acceptance.
   */
  async deliverQueuedMessage(
    scope: TeamScope,
    teamId: TeamId,
    captain: Agent,
    messageId: TeamMessageId,
    signal: AbortSignal,
  ): Promise<TeamMessage | undefined> {
    const key = `${scope}\0${teamId}\0${messageId}`
    const previous = this.chains.get(key) ?? Promise.resolve(undefined)
    const next = previous.then(async () => {
      if (this.deps.isClosing()) return undefined
      const snapshot = await this.deps.domain().snapshot(scope, teamId, captain.id)
      const message = snapshot.team.messages.find(candidate => candidate.id === messageId)
      if (message === undefined || message.phase !== 'queued') return message
      const sender = message.senderSessionId === captain.id
        ? captain
        : this.ctx.agents.get(SessionId(message.senderSessionId))
      if (sender === undefined && message.targetSessionId === captain.id) return undefined
      const delivered = await this.deliverMessage(snapshot.team, sender ?? captain, message, signal)
      if (!delivered) return undefined
      return await this.deps.domain().acknowledgeMessage(scope, teamId, message.id)
    }).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
    return await next
  }

  /** Wait for every in-flight delivery chain (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<TeamMessage | undefined>>> {
    return Promise.allSettled(this.chains.values())
  }
}
