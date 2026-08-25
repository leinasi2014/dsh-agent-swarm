import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamV2InitialOutcomeDomain } from '../domain/team-domain-v2-initial-outcome.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { currentFreshV2InitialAttempt, findFreshV2Membership, initialCheckpointOf } from './fresh-v2-initial-support.js'
import { foldEnteredInitialOutcome } from './fresh-v2-initial-outcome-fold.js'

const PREPARE_TIMEOUT_MS = 15_000

/** Online and cold durable-result folding for initial dispatches that entered Provider. */
export class FreshV2InitialOutcomeRecovery {
  private readonly domain: TeamV2InitialOutcomeDomain

  constructor(
    private readonly ctx: Context,
    private readonly store: StorageDomainTeamStoreV2,
  ) {
    this.domain = new TeamV2InitialOutcomeDomain(store)
  }

  async foldTurnEnd(session: Session, event: SessionEvent<'turn/end'>): Promise<void> {
    const scope = resolve(session.header.cwd ?? process.cwd())
    const membership = findFreshV2Membership(this.store, scope, session.id)
    if (membership === undefined || membership.role === 'captain') return
    const current = currentFreshV2InitialAttempt(membership.team, session.id)
    const dispatch = current?.dispatch
    if (current === undefined || dispatch?.phase !== 'dispatch-entered' || dispatch.turn !== event.data.turn) return
    const common = {
      memberSessionId: session.id,
      taskId: current.task.id,
      attemptId: current.attempt.id,
      checkpoint: initialCheckpointOf(current.member, dispatch),
    }
    const evidence = foldEnteredInitialOutcome(session.events, common.checkpoint)
    if (evidence.kind === 'assistant') {
      await this.domain.settleAssistantAndPark(scope, membership.team.id, {
        ...common,
        assistantEventSeq: evidence.assistantEventSeq,
        turnEndSeq: evidence.turnEndSeq,
      })
    } else if (evidence.kind === 'turn-end') {
      await this.domain.settleTurnEnd(scope, membership.team.id, {
        ...common,
        eventSeq: evidence.eventSeq,
        reason: evidence.reason,
      })
    } else {
      await this.domain.markUnknown(scope, membership.team.id, { ...common, diagnostic: evidence.reason })
    }
  }

  async reconcileColdDispatches(): Promise<void> {
    for (const { scope, team } of this.store.listAll()) {
      for (const attempt of team.attempts) {
        const dispatch = attempt.dispatchEpochs[0]
        const entered = dispatch?.kind === 'initial' && dispatch.phase === 'dispatch-entered'
        const settledAssistant = dispatch?.kind === 'initial' && dispatch.phase === 'settled'
          && dispatch.assistantEvidenceSeq !== undefined && attempt.phase === 'running'
        if (!entered && !settledAssistant) continue
        const member = team.members.find(candidate => candidate.sessionId === attempt.memberSessionId)
        const task = team.tasks.find(candidate => candidate.currentAttemptId === attempt.id)
        if (member === undefined || task === undefined) continue
        const sessionId = SessionId(attempt.memberSessionId)
        if (this.ctx.agents.get(sessionId) !== undefined || this.ctx.sessions.get(sessionId) !== undefined) continue
        let preparation: Awaited<ReturnType<Context['sessionPersistence']['prepare']>>
        try {
          preparation = await this.ctx.sessionPersistence.prepare(
            sessionId,
            AbortSignal.timeout(PREPARE_TIMEOUT_MS),
          )
        } catch (error: unknown) {
          if (this.ctx.agents.get(sessionId) === undefined && this.ctx.sessions.get(sessionId) === undefined) {
            this.ctx.logger.warn(`agent-swarm: cold initial outcome preparation failed for ${sessionId}: ${String(error)}`)
          }
          continue
        }
        try {
          if (this.ctx.agents.get(sessionId) !== undefined || this.ctx.sessions.get(sessionId) !== undefined) continue
          const checkpoint = initialCheckpointOf(member, dispatch)
          const evidence = foldEnteredInitialOutcome(preparation.session.events, checkpoint)
          const common = {
            memberSessionId: attempt.memberSessionId,
            taskId: task.id,
            attemptId: attempt.id,
            checkpoint,
          }
          if (evidence.kind === 'assistant') {
            await this.domain.settleAssistantAndPark(scope, team.id, {
              ...common,
              assistantEventSeq: evidence.assistantEventSeq,
              turnEndSeq: evidence.turnEndSeq,
            })
          } else if (settledAssistant) {
            this.ctx.logger.warn(`agent-swarm: cold settled initial outcome remains blocked: ${evidence.reason}`)
          } else if (evidence.kind === 'turn-end') {
            await this.domain.settleTurnEnd(scope, team.id, {
              ...common,
              eventSeq: evidence.eventSeq,
              reason: evidence.reason,
            })
          } else {
            await this.domain.markUnknown(scope, team.id, { ...common, diagnostic: evidence.reason })
          }
        } finally {
          preparation[Symbol.dispose]()
        }
      }
    }
  }
}
