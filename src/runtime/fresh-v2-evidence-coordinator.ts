import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'

interface EvidenceCallbacks {
  readonly assistant: (session: Session, event: SessionEvent<'assistant/message'>) => Promise<void>
  readonly turnEnd: (session: Session, event: SessionEvent<'turn/end'>) => Promise<void>
  readonly inboxClaimed: (agent: Agent, message: UserMessage) => Promise<void>
  readonly agentIdle: (agent: Agent) => Promise<void>
  readonly isClosing: () => boolean
  readonly describeError: (error: unknown) => string
}

/** Serializes official Session/inbox/idle evidence per member Session. */
export class FreshV2EvidenceCoordinator {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly failures: Array<{ readonly sessionId: string; readonly error: unknown }> = []

  constructor(private readonly ctx: Context, private readonly callbacks: EvidenceCallbacks) {}

  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.callbacks.isClosing() || (event.type !== 'assistant/message' && event.type !== 'turn/end')) return
    const durability = this.ctx.sessions.flush(session)
    this.enqueue(session.id, async () => {
      if (this.callbacks.isClosing()) return
      if (!await durability) {
        const kind = event.type === 'assistant/message' ? 'assistant evidence' : 'turn-end evidence'
        throw new TeamDomainError(`${kind} requires durable Session persistence`, 'TEAM_RUNTIME_NOT_STARTED')
      }
      if (event.type === 'assistant/message') await this.callbacks.assistant(session, event)
      else await this.callbacks.turnEnd(session, event)
    })
  }

  observeInboxClaimed(agent: Agent, message: UserMessage): void {
    this.enqueue(agent.id, async () => { await this.callbacks.inboxClaimed(agent, message) })
  }

  observeAgentIdle(agent: Agent): void {
    if (agent.status !== 'idle') return
    this.enqueue(agent.id, async () => { await this.callbacks.agentIdle(agent) })
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.chains.values())
    if (this.failures.length > 0) {
      const details = this.failures.map(failure => this.callbacks.describeError(failure.error)).join('; ')
      const label = details.includes('assistant evidence') ? 'fresh-v2 assistant evidence fold failed' : 'fresh-v2 evidence fold failed'
      throw new AggregateError(
        this.failures.map(failure => failure.error),
        `${label}: ${details}`,
      )
    }
  }

  async drainSession(sessionId: string): Promise<void> {
    await this.chains.get(sessionId)
    const failures = this.failures.filter(failure => failure.sessionId === sessionId)
    if (failures.length > 0) {
      throw new AggregateError(failures.map(failure => failure.error), `fresh-v2 evidence for ${sessionId} is not durable`)
    }
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): void {
    if (this.callbacks.isClosing()) return
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const chain = previous.then(operation).catch((error: unknown) => {
      this.failures.push({ sessionId, error })
      this.ctx.logger.error(`agent-swarm: fresh-v2 evidence fold failed: ${this.callbacks.describeError(error)}`)
    })
    this.chains.set(sessionId, chain)
    void chain.finally(() => {
      if (this.chains.get(sessionId) === chain) this.chains.delete(sessionId)
    })
  }
}
