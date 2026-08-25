import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { TeamDomainError } from './error.js'
import {
  requireInitialDispatchTuple,
  type InitialDispatchCheckpoint,
} from './team-domain-v2-start.js'
import { replaceV2Attempt } from './team-domain-v2-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { ModelDispatchEpoch, TaskAttemptV2 } from './team-state-v2.js'
import type { AttemptId, TaskId, TeamId } from './types.js'

type TerminalReason = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens'

/** Exact outcome transitions for an initial dispatch that already crossed Provider entry. */
export class TeamV2InitialOutcomeDomain {
  constructor(
    private readonly store: StorageDomainTeamStoreV2,
    private readonly now: () => number = Date.now,
  ) {}

  async settleTurnEnd(scope: TeamScope, teamId: TeamId, input: {
    readonly memberSessionId: string
    readonly taskId: TaskId
    readonly attemptId: AttemptId
    readonly checkpoint: InitialDispatchCheckpoint
    readonly eventSeq: number
    readonly reason: TerminalReason
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0) {
      throw new TeamDomainError('initial turn-end evidence sequence is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const { attempt, dispatch } = requireInitialDispatchTuple(
        team, input.memberSessionId, input.taskId, input.attemptId, input.checkpoint,
        'initial turn-end tuple is stale',
      )
      if (dispatch.phase === 'settled' && attempt.phase === 'parked') {
        if (dispatch.turnEndEvidenceSeq !== input.eventSeq
          || dispatch.turnEndEvidenceReason !== input.reason
          || attempt.parked?.lastSessionSeq !== input.eventSeq) {
          throw new TeamDomainError('initial turn-end evidence conflicts with the committed tuple', 'TEAM_ATTEMPT_STALE')
        }
        result = { attempt, dispatch }
        return
      }
      if (dispatch.phase !== 'dispatch-entered' || attempt.phase !== 'reserved') {
        throw new TeamDomainError('initial model-dispatch has no open entered outcome', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const settled: ModelDispatchEpoch = {
        ...dispatch,
        phase: 'settled',
        turnEndEvidenceSeq: input.eventSeq,
        turnEndEvidenceReason: input.reason,
        updatedAt: timestamp,
      }
      const next: TaskAttemptV2 = {
        ...attempt,
        phase: 'parked',
        parked: {
          parkedAt: timestamp,
          parkedReason: 'turn-settled',
          lastSessionSeq: input.eventSeq,
          continuationPolicy: 'team-autonomous',
        },
        dispatchEpochs: [settled, ...attempt.dispatchEpochs.slice(1)],
        evidence: [...attempt.evidence, `session:${input.memberSessionId}:event:${input.eventSeq}:turn/end`],
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, next)
      result = { attempt: next, dispatch: settled }
    })
    return structuredClone(result)
  }

  async markUnknown(scope: TeamScope, teamId: TeamId, input: {
    readonly memberSessionId: string
    readonly taskId: TaskId
    readonly attemptId: AttemptId
    readonly checkpoint: InitialDispatchCheckpoint
    readonly diagnostic: string
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    const diagnostic = input.diagnostic.trim()
    if (diagnostic.length === 0 || Buffer.byteLength(diagnostic, 'utf8') > 2_048) {
      throw new TeamDomainError('initial dispatch-unknown diagnostic is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const { attempt, dispatch } = requireInitialDispatchTuple(
        team, input.memberSessionId, input.taskId, input.attemptId, input.checkpoint,
        'initial dispatch-unknown tuple is stale',
      )
      if (dispatch.phase === 'dispatch-unknown' && attempt.phase === 'reserved') {
        if (attempt.diagnostic !== diagnostic) {
          throw new TeamDomainError('initial dispatch-unknown evidence conflicts with the committed tuple', 'TEAM_ATTEMPT_STALE')
        }
        result = { attempt, dispatch }
        return
      }
      if (dispatch.phase !== 'dispatch-entered' || attempt.phase !== 'reserved') {
        throw new TeamDomainError('only an entered initial dispatch may become unknown', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const unknown: ModelDispatchEpoch = { ...dispatch, phase: 'dispatch-unknown', updatedAt: timestamp }
      const next: TaskAttemptV2 = {
        ...attempt,
        dispatchEpochs: [unknown, ...attempt.dispatchEpochs.slice(1)],
        diagnostic,
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, next)
      result = { attempt: next, dispatch: unknown }
    })
    return structuredClone(result)
  }

  async settleAssistantAndPark(scope: TeamScope, teamId: TeamId, input: {
    readonly memberSessionId: string
    readonly taskId: TaskId
    readonly attemptId: AttemptId
    readonly checkpoint: InitialDispatchCheckpoint
    readonly assistantEventSeq: number
    readonly turnEndSeq: number
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    if (!Number.isSafeInteger(input.assistantEventSeq) || input.assistantEventSeq < 0
      || !Number.isSafeInteger(input.turnEndSeq) || input.turnEndSeq <= input.assistantEventSeq) {
      throw new TeamDomainError('initial assistant/turn-end recovery fence is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const { attempt, dispatch } = requireInitialDispatchTuple(
        team, input.memberSessionId, input.taskId, input.attemptId, input.checkpoint,
        'initial assistant recovery tuple is stale',
      )
      if (dispatch.phase === 'settled' && attempt.phase === 'parked') {
        if (dispatch.assistantEvidenceSeq !== input.assistantEventSeq
          || dispatch.assistantEvidenceType !== 'assistant/message'
          || attempt.parked?.lastSessionSeq !== input.turnEndSeq) {
          throw new TeamDomainError('initial assistant recovery evidence conflicts with the committed tuple', 'TEAM_ATTEMPT_STALE')
        }
        result = { attempt, dispatch }
        return
      }
      if (dispatch.phase === 'settled' && attempt.phase === 'running') {
        if (dispatch.assistantEvidenceSeq !== input.assistantEventSeq
          || dispatch.assistantEvidenceType !== 'assistant/message') {
          throw new TeamDomainError('initial assistant recovery conflicts with committed evidence', 'TEAM_ATTEMPT_STALE')
        }
        const timestamp = this.now()
        const parked: TaskAttemptV2 = {
          ...attempt,
          phase: 'parked',
          parked: {
            parkedAt: timestamp,
            parkedReason: 'turn-settled',
            lastSessionSeq: input.turnEndSeq,
            continuationPolicy: 'team-autonomous',
          },
          evidence: [...attempt.evidence, `session:${input.memberSessionId}:event:${input.turnEndSeq}:turn/end`],
          updatedAt: timestamp,
        }
        replaceV2Attempt(team, parked)
        result = { attempt: parked, dispatch }
        return
      }
      if (dispatch.phase !== 'dispatch-entered' || attempt.phase !== 'reserved') {
        throw new TeamDomainError('initial model-dispatch has no recoverable assistant outcome', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const settled: ModelDispatchEpoch = {
        ...dispatch,
        phase: 'settled',
        assistantEvidenceSeq: input.assistantEventSeq,
        assistantEvidenceType: 'assistant/message',
        updatedAt: timestamp,
      }
      const parked: TaskAttemptV2 = {
        ...attempt,
        phase: 'parked',
        parked: {
          parkedAt: timestamp,
          parkedReason: 'turn-settled',
          lastSessionSeq: input.turnEndSeq,
          continuationPolicy: 'team-autonomous',
        },
        dispatchEpochs: [settled, ...attempt.dispatchEpochs.slice(1)],
        evidence: [
          ...attempt.evidence,
          `session:${input.memberSessionId}:event:${input.assistantEventSeq}:assistant/message`,
          `session:${input.memberSessionId}:event:${input.turnEndSeq}:turn/end`,
        ],
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, parked)
      result = { attempt: parked, dispatch: settled }
    })
    return structuredClone(result)
  }
}
