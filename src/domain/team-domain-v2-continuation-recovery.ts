import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { TeamDomainError } from './error.js'
import {
  requireContinuationCheckpointTuple,
  requireText,
  settleContinuationEpoch,
  type ContinuationTuple,
  type ContinuationDispatchCheckpoint,
} from './team-domain-v2-continuation.js'
import {
  MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT,
  MAX_V2_EFFECT_RECEIPTS,
  type DispatchId,
  type ModelDispatchEpoch,
  type TaskAttemptV2,
  type TeamEffectId,
} from './team-state-v2.js'
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

  /**
   * Reserve one deterministic recovery trigger after cold proof that the
   * current dispatch never crossed the model-entry witness.  The old epoch
   * deliberately remains current until a later, durably claimed recovery
   * frame performs the authority hand-off.
   */
  async reserveProvenNotEntered(scope: TeamScope, teamId: TeamId, input: {
    readonly checkpoint: ContinuationDispatchCheckpoint
    readonly recoveryEffectId: TeamEffectId
    readonly recoveryDispatchId: DispatchId
    readonly recoveryProofTurnEndSeq: number
    readonly recoveryProofDigest: string
  }): Promise<{ attempt: TaskAttemptV2; recovery: ModelDispatchEpoch }> {
    if (!Number.isSafeInteger(input.recoveryProofTurnEndSeq) || input.recoveryProofTurnEndSeq < 0
      || !/^[0-9a-f]{64}$/.test(input.recoveryProofDigest)) {
      throw new TeamDomainError('cold continuation recovery proof fence is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; recovery: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const tuple = requireContinuationCheckpointTuple(team, input.checkpoint)
      const existing = tuple.attempt.dispatchEpochs.find(epoch => epoch.recoveryOf === tuple.dispatch.dispatchId)
      if (existing !== undefined) {
        const receipt = team.interactionEffects.find(effect => effect.effectId === existing.effectId)
        if (existing.kind !== 'recovery' || existing.phase !== 'frame-pending'
          || existing.dispatchId !== input.recoveryDispatchId || existing.effectId !== input.recoveryEffectId
          || receipt?.kind !== 'continuation-recovery' || receipt.status !== 'applied'
          || receipt.dispatchId !== existing.dispatchId || receipt.recoveryOf !== tuple.dispatch.dispatchId
          || existing.recoveryProofTurnEndSeq !== input.recoveryProofTurnEndSeq
          || existing.recoveryProofDigest !== input.recoveryProofDigest
          || receipt.recoveryProofTurnEndSeq !== input.recoveryProofTurnEndSeq
          || receipt.recoveryProofDigest !== input.recoveryProofDigest) {
          throw new TeamDomainError('cold continuation recovery reservation conflicts with durable state', 'TEAM_STATE_CORRUPT')
        }
        result = { attempt: tuple.attempt, recovery: existing }
        return
      }
      if (tuple.intent.phase !== 'dispatch-pending' || tuple.dispatch.phase !== 'dispatch-pending') {
        throw new TeamDomainError('only a pending continuation dispatch may reserve cold recovery', 'TEAM_ATTEMPT_STALE')
      }
      if (tuple.attempt.dispatchEpochs.length >= MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT) {
        throw new TeamDomainError('Attempt exhausted its bounded dispatch history', 'TEAM_RESOURCE_LIMIT')
      }
      if (team.interactionEffects.length >= MAX_V2_EFFECT_RECEIPTS) {
        throw new TeamDomainError(
          'Team exhausted its bounded effect receipt ledger before recovery reservation',
          'TEAM_RESOURCE_LIMIT',
        )
      }
      if (team.interactionEffects.some(effect => effect.effectId === input.recoveryEffectId)
        || tuple.attempt.dispatchEpochs.some(epoch => epoch.dispatchId === input.recoveryDispatchId)) {
        throw new TeamDomainError('cold continuation recovery identity is already occupied', 'TEAM_CONTINUATION_CONFLICT')
      }
      const timestamp = this.now()
      const recovery: ModelDispatchEpoch = {
        dispatchId: input.recoveryDispatchId,
        kind: 'recovery',
        ordinal: tuple.attempt.dispatchEpochs.length + 1,
        effectId: input.recoveryEffectId,
        recoveryOf: tuple.dispatch.dispatchId,
        recoveryProofTurnEndSeq: input.recoveryProofTurnEndSeq,
        recoveryProofDigest: input.recoveryProofDigest,
        targetSessionId: tuple.attempt.memberSessionId,
        witnessCapabilityDigest: tuple.dispatch.witnessCapabilityDigest,
        phase: 'frame-pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const attempt: TaskAttemptV2 = {
        ...tuple.attempt,
        dispatchEpochs: [...tuple.attempt.dispatchEpochs, recovery],
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, attempt)
      team.interactionEffects.push({
        effectId: input.recoveryEffectId,
        kind: 'continuation-recovery',
        status: 'applied',
        appliedAt: timestamp,
        resultingTeamRevision: team.revision + 1,
        requestId: `recovery:${tuple.dispatch.dispatchId}`,
        taskId: tuple.task.id,
        attemptId: tuple.attempt.id,
        dispatchId: recovery.dispatchId,
        recoveryOf: tuple.dispatch.dispatchId,
        recoveryProofTurnEndSeq: input.recoveryProofTurnEndSeq,
        recoveryProofDigest: input.recoveryProofDigest,
      })
      result = { attempt, recovery }
    })
    return structuredClone(result)
  }

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
