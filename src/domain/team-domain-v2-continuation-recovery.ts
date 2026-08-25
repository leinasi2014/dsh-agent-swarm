import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { TeamDomainError } from './error.js'
import {
  requireContinuationCheckpointTuple,
  requireText,
  settleContinuationEpoch,
  type ContinuationTuple,
  type ContinuationDispatchCheckpoint,
} from './team-domain-v2-continuation.js'
import type { ModelDispatchEpoch, TaskAttemptV2 } from './team-state-v2.js'
import type { TeamScope } from './team-domain-port.js'
import { replaceV2Attempt } from './team-domain-v2-shared.js'
import type { TeamId } from './types.js'

function parkRecoveredTurn(
  tuple: ContinuationTuple,
  settled: ModelDispatchEpoch,
  turnEndSeq: number,
  timestamp: number,
  evidence: readonly string[],
): TaskAttemptV2 {
  const { currentContinuationIntent: _intent, ...withoutIntent } = tuple.attempt
  const { currentContinuationIntentId: _intentId, ...parkedBase } = tuple.attempt.parked!
  void _intent; void _intentId
  return {
    ...withoutIntent,
    phase: 'parked',
    parked: { ...parkedBase, parkedAt: timestamp, parkedReason: 'turn-settled', lastSessionSeq: turnEndSeq },
    dispatchEpochs: tuple.attempt.dispatchEpochs.map(epoch => epoch.dispatchId === settled.dispatchId ? settled : epoch),
    evidence: [...tuple.attempt.evidence, ...evidence],
    updatedAt: timestamp,
  }
}

/** Cold-recovery-only continuation transitions, separate from the online path. */
export class TeamV2ContinuationRecoveryDomain {
  constructor(
    private readonly store: StorageDomainTeamStoreV2,
    private readonly now: () => number = Date.now,
  ) {}

  async markDispatchUnknown(scope: TeamScope, teamId: TeamId, input: {
    readonly checkpoint: ContinuationDispatchCheckpoint
    readonly diagnostic: string
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    const diagnostic = requireText(input.diagnostic, 'dispatch-unknown diagnostic', 2_048)
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const tuple = requireContinuationCheckpointTuple(team, input.checkpoint)
      if (tuple.dispatch.phase === 'dispatch-unknown' && tuple.intent.phase === 'dispatch-unknown') {
        result = { attempt: tuple.attempt, dispatch: tuple.dispatch }
        return
      }
      if (tuple.dispatch.phase !== 'dispatch-entered' || tuple.intent.phase !== 'dispatch-entered') {
        throw new TeamDomainError('only an entered continuation may become delivery-unknown', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const unknown: ModelDispatchEpoch = { ...tuple.dispatch, phase: 'dispatch-unknown', updatedAt: timestamp }
      const attempt: TaskAttemptV2 = {
        ...tuple.attempt,
        phase: 'parked',
        parked: { ...tuple.attempt.parked!, parkedAt: timestamp, parkedReason: 'migration-unknown' },
        currentContinuationIntent: { ...tuple.intent, phase: 'dispatch-unknown' },
        dispatchEpochs: tuple.attempt.dispatchEpochs.map(epoch => epoch.dispatchId === unknown.dispatchId ? unknown : epoch),
        diagnostic,
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, attempt)
      result = { attempt, dispatch: unknown }
    })
    return structuredClone(result)
  }

  async settleTurnEndEvidence(scope: TeamScope, teamId: TeamId, input: {
    readonly checkpoint: ContinuationDispatchCheckpoint
    readonly eventSeq: number
    readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens'
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0) {
      throw new TeamDomainError('turn-end evidence sequence is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const timestamp = this.now()
      const { tuple, settled } = settleContinuationEpoch(team, input.checkpoint, {
        turnEndEvidenceSeq: input.eventSeq,
        turnEndEvidenceReason: input.reason,
      }, timestamp)
      const parked = parkRecoveredTurn(tuple, settled, input.eventSeq, timestamp, [
        `session:${tuple.attempt.memberSessionId}:event:${input.eventSeq}:turn/end`,
      ])
      replaceV2Attempt(team, parked)
      result = { attempt: parked, dispatch: settled }
    })
    return structuredClone(result)
  }

  /** Atomically settle exact assistant evidence and the already-durable terminal turn boundary. */
  async settleAssistantAndPark(scope: TeamScope, teamId: TeamId, input: {
    readonly checkpoint: ContinuationDispatchCheckpoint
    readonly assistantEventSeq: number
    readonly turnEndSeq: number
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    if (!Number.isSafeInteger(input.assistantEventSeq) || input.assistantEventSeq < 0
      || !Number.isSafeInteger(input.turnEndSeq) || input.turnEndSeq <= input.assistantEventSeq) {
      throw new TeamDomainError('assistant/turn-end recovery evidence sequence is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const timestamp = this.now()
      const { tuple, settled } = settleContinuationEpoch(team, input.checkpoint, {
        assistantEvidenceSeq: input.assistantEventSeq,
        assistantEvidenceType: 'assistant/message',
      }, timestamp)
      const parked = parkRecoveredTurn(tuple, settled, input.turnEndSeq, timestamp, [
        `session:${tuple.attempt.memberSessionId}:event:${input.assistantEventSeq}:assistant/message`,
        `session:${tuple.attempt.memberSessionId}:event:${input.turnEndSeq}:turn/end`,
      ])
      replaceV2Attempt(team, parked)
      result = { attempt: parked, dispatch: settled }
    })
    return structuredClone(result)
  }
}
