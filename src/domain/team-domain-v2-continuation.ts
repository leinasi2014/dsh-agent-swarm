import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { TeamDomainError } from './error.js'
import {
  ContinuationEffectId,
  DispatchId,
  MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT,
  MAX_V2_EFFECT_RECEIPTS,
  TeamEffectId,
  type ContinuationIntent,
  type ContinuationPrincipal,
  type ModelDispatchEpoch,
  type TaskAttemptV2,
  type TeamStateV2,
} from './team-state-v2.js'
import { AttemptId, TaskId, TeamId, type TeamTask } from './types.js'
import type { TeamScope } from './team-domain-port.js'
import { replaceV2Attempt } from './team-domain-v2-shared.js'

const requireText = (value: string, label: string, maximum = 512): string => {
  const normalized = value.trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new TeamDomainError(`${label} is empty or too large`, 'TEAM_INPUT_INVALID')
  }
  return normalized
}

const requireDigest = (value: string, label: string): string => {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TeamDomainError(`${label} is not a canonical SHA-256 digest`, 'TEAM_INPUT_INVALID')
  }
  return value
}

function currentTuple(team: TeamStateV2, taskId: TaskId, attemptId: AttemptId): {
  task: TeamTask
  attempt: TaskAttemptV2
} {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  const attempt = team.attempts.find(candidate => candidate.id === attemptId)
  if (task === undefined) throw new TeamDomainError(`task "${taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
  if (attempt === undefined || task.currentAttemptId !== attempt.id || attempt.taskId !== task.id
    || task.ownerSessionId !== attempt.memberSessionId) {
    throw new TeamDomainError(`attempt "${attemptId}" is stale`, 'TEAM_ATTEMPT_STALE')
  }
  return { task, attempt }
}

function sameMemberPrincipal(left: ContinuationPrincipal, right: ContinuationPrincipal): boolean {
  return left.kind === 'member' && right.kind === 'member'
    && left.memberId === right.memberId && left.memberSessionId === right.memberSessionId
}

function requireMemberPrincipal(team: TeamStateV2, principal: ContinuationPrincipal, attempt: TaskAttemptV2): void {
  if (principal.kind !== 'member' || principal.memberSessionId !== attempt.memberSessionId) {
    throw new TeamDomainError('continuation requester does not own the Attempt', 'TEAM_TASK_OWNER_REQUIRED')
  }
  const member = team.members.find(candidate => candidate.sessionId === principal.memberSessionId)
  if (member === undefined || member.name !== principal.memberId || member.phase !== 'active') {
    throw new TeamDomainError('continuation requester is not the active Attempt owner', 'TEAM_TASK_OWNER_REQUIRED')
  }
}

function sameContinuationReceipt(
  receipt: TeamStateV2['interactionEffects'][number],
  intent: ContinuationIntent,
  taskId: TaskId,
  attemptId: AttemptId,
  effectId: TeamEffectId,
  dispatchId: DispatchId,
): boolean {
  return receipt.effectId === effectId
    && receipt.kind === 'continuation'
    && receipt.requestId === intent.continuationEffectId
    && receipt.taskId === taskId
    && receipt.attemptId === attemptId
    && receipt.dispatchId === dispatchId
    && receipt.continuationEffectId === intent.continuationEffectId
    && receipt.continuationRequestedAt === intent.requestedAt
    && receipt.continuationExpectedTaskRevision === intent.expectedTaskRevision
    && receipt.continuationCheckpointDigest === intent.checkpointDigest
    && receipt.continuationWakeCondition === intent.wakeCondition
    && receipt.continuationRequestedBy !== undefined
    && sameMemberPrincipal(receipt.continuationRequestedBy, intent.requestedBy)
}

function requireContinuationTuple(
  team: TeamStateV2,
  taskId: TaskId,
  attemptId: AttemptId,
  continuationEffectId: ContinuationEffectId,
  dispatchId: DispatchId,
): { task: TeamTask; attempt: TaskAttemptV2; intent: ContinuationIntent; dispatch: ModelDispatchEpoch } {
  const { task, attempt } = currentTuple(team, taskId, attemptId)
  const intent = attempt.currentContinuationIntent
  const dispatch = attempt.dispatchEpochs.find(candidate => candidate.dispatchId === dispatchId)
  if (task.status !== 'in_progress' || attempt.phase !== 'parked'
    || intent?.continuationEffectId !== continuationEffectId || intent.currentDispatchId !== dispatchId
    || dispatch === undefined || dispatch.kind !== 'continuation' || dispatch.targetSessionId !== attempt.memberSessionId) {
    throw new TeamDomainError('continuation tuple is stale', 'TEAM_ATTEMPT_STALE')
  }
  return { task, attempt, intent, dispatch }
}

export interface ContinuationDispatchCheckpoint {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly continuationEffectId: ContinuationEffectId
  readonly dispatchId: DispatchId
  readonly resumeEffectId: TeamEffectId
  readonly frameMessageId: string
  readonly messageSeq: number
  readonly turn: number
  readonly step: number
  readonly witnessCapabilityDigest: string
}

export class TeamV2ContinuationDomain {
  constructor(
    private readonly store: StorageDomainTeamStoreV2,
    private readonly now: () => number = Date.now,
  ) {}

  async requestMemberContinuation(scope: TeamScope, teamId: TeamId, input: {
    readonly taskId: TaskId
    readonly expectedTaskRevision: number
    readonly attemptId: AttemptId
    readonly continuationEffectId: ContinuationEffectId
    readonly principal: Extract<ContinuationPrincipal, { readonly kind: 'member' }>
    readonly checkpointDigest?: string
    readonly wakeCondition?: string
  }): Promise<ContinuationIntent> {
    const requestedCheckpointDigest = input.checkpointDigest === undefined
      ? undefined : requireDigest(input.checkpointDigest, 'checkpoint digest')
    const requestedWakeCondition = input.wakeCondition === undefined
      ? undefined : requireText(input.wakeCondition, 'wake condition', 2_048)
    let result!: ContinuationIntent
    await this.store.transact(scope, teamId, team => {
      const { task, attempt } = currentTuple(team, input.taskId, input.attemptId)
      if (task.revision !== input.expectedTaskRevision || task.status !== 'in_progress') {
        throw new TeamDomainError('continuation request carries a stale task revision', 'TEAM_TASK_STALE_REVISION')
      }
      requireMemberPrincipal(team, input.principal, attempt)
      const settledReceipt = team.interactionEffects.find(effect => effect.kind === 'continuation'
        && effect.requestId === input.continuationEffectId && effect.status === 'settled')
      if (settledReceipt !== undefined) {
        if (settledReceipt.continuationEffectId !== input.continuationEffectId
          || settledReceipt.continuationRequestedBy === undefined
          || !sameMemberPrincipal(settledReceipt.continuationRequestedBy, input.principal)
          || settledReceipt.attemptId !== attempt.id || settledReceipt.taskId !== task.id
          || settledReceipt.dispatchId === undefined
          || settledReceipt.continuationRequestedAt === undefined
          || settledReceipt.continuationExpectedTaskRevision === undefined
          || settledReceipt.continuationCheckpointDigest !== requestedCheckpointDigest
          || settledReceipt.continuationWakeCondition !== requestedWakeCondition) {
          throw new TeamDomainError('settled continuation identity conflicts with this request', 'TEAM_CONTINUATION_CONFLICT')
        }
        result = {
          continuationEffectId: input.continuationEffectId,
          taskId: task.id,
          attemptId: attempt.id,
          expectedTaskRevision: settledReceipt.continuationExpectedTaskRevision,
          requestedBy: settledReceipt.continuationRequestedBy,
          requestedAt: settledReceipt.continuationRequestedAt,
          ...(settledReceipt.continuationCheckpointDigest === undefined ? {} : {
            checkpointDigest: settledReceipt.continuationCheckpointDigest,
          }),
          ...(settledReceipt.continuationWakeCondition === undefined ? {} : {
            wakeCondition: settledReceipt.continuationWakeCondition,
          }),
          resumeEffectId: settledReceipt.effectId,
          currentDispatchId: settledReceipt.dispatchId,
          phase: 'settled',
        }
        return
      }
      const existing = attempt.currentContinuationIntent
      if (existing !== undefined) {
        if (existing.continuationEffectId !== input.continuationEffectId
          || !sameMemberPrincipal(existing.requestedBy, input.principal)
          || existing.checkpointDigest !== requestedCheckpointDigest
          || existing.wakeCondition !== requestedWakeCondition) {
          throw new TeamDomainError('another continuation intent already owns this Attempt slot', 'TEAM_CONTINUATION_CONFLICT')
        }
        result = existing
        return
      }
      if (attempt.phase !== 'running') {
        throw new TeamDomainError('only the running owner may request the next same-Attempt turn', 'TEAM_ATTEMPT_STALE')
      }
      const intent: ContinuationIntent = {
        continuationEffectId: ContinuationEffectId(requireText(input.continuationEffectId, 'continuation effect id')),
        taskId: task.id,
        attemptId: attempt.id,
        expectedTaskRevision: task.revision,
        requestedBy: input.principal,
        requestedAt: this.now(),
        ...(requestedCheckpointDigest === undefined ? {} : {
          checkpointDigest: requestedCheckpointDigest,
        }),
        ...(requestedWakeCondition === undefined ? {} : {
          wakeCondition: requestedWakeCondition,
        }),
        phase: 'requested',
      }
      replaceV2Attempt(team, { ...attempt, currentContinuationIntent: intent, updatedAt: this.now() })
      result = intent
    })
    return structuredClone(result)
  }

  async parkAfterTurn(scope: TeamScope, teamId: TeamId, input: {
    readonly taskId: TaskId
    readonly attemptId: AttemptId
    readonly memberSessionId: string
    readonly settledTurn: number
    readonly turnEndSeq: number
  }): Promise<TaskAttemptV2> {
    let result!: TaskAttemptV2
    await this.store.transact(scope, teamId, team => {
      const { task, attempt } = currentTuple(team, input.taskId, input.attemptId)
      if (task.status !== 'in_progress' || attempt.memberSessionId !== input.memberSessionId) {
        throw new TeamDomainError('turn settlement no longer owns the current task', 'TEAM_ATTEMPT_STALE')
      }
      if (attempt.phase === 'parked') {
        if (attempt.parked?.lastSessionSeq !== input.turnEndSeq) {
          throw new TeamDomainError('parked Attempt conflicts with this turn settlement', 'TEAM_ATTEMPT_STALE')
        }
        result = attempt
        return
      }
      const last = attempt.dispatchEpochs.at(-1)
      if (last?.phase !== 'settled' || last.turn !== input.settledTurn
        || !Number.isSafeInteger(input.turnEndSeq) || input.turnEndSeq < 0) {
        throw new TeamDomainError('turn settlement lacks the exact settled dispatch fence', 'TEAM_ATTEMPT_STALE')
      }
      if (attempt.phase !== 'running') throw new TeamDomainError('Attempt is not runnable', 'TEAM_ATTEMPT_STALE')
      const intent = attempt.currentContinuationIntent
      if (intent === undefined) {
        const parked: TaskAttemptV2 = {
          ...attempt,
          phase: 'parked',
          parked: {
            parkedAt: this.now(), parkedReason: 'turn-settled', lastSessionSeq: input.turnEndSeq,
            continuationPolicy: 'team-autonomous',
          },
          updatedAt: this.now(),
        }
        replaceV2Attempt(team, parked)
        result = parked
        return
      }
      const timestamp = this.now()
      const parked: TaskAttemptV2 = {
        ...attempt,
        phase: 'parked',
        parked: {
          parkedAt: timestamp, parkedReason: 'turn-settled', lastSessionSeq: input.turnEndSeq,
          continuationPolicy: 'team-autonomous', currentContinuationIntentId: intent.continuationEffectId,
        },
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, parked)
      result = parked
    })
    return structuredClone(result)
  }

  async admitRequested(scope: TeamScope, teamId: TeamId, input: {
    readonly taskId: TaskId
    readonly attemptId: AttemptId
    readonly memberSessionId: string
    readonly continuationEffectId: ContinuationEffectId
    readonly resumeEffectId: TeamEffectId
    readonly dispatchId: DispatchId
    readonly witnessCapabilityDigest: string
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const { task, attempt } = currentTuple(team, input.taskId, input.attemptId)
      const intent = attempt.currentContinuationIntent
      if (task.status !== 'in_progress' || attempt.phase !== 'parked'
        || attempt.memberSessionId !== input.memberSessionId || intent === undefined
        || intent.continuationEffectId !== input.continuationEffectId) {
        throw new TeamDomainError('parked continuation request is stale', 'TEAM_ATTEMPT_STALE')
      }
      if (intent.phase === 'admitted' && intent.resumeEffectId === input.resumeEffectId
        && intent.currentDispatchId === input.dispatchId) {
        const existing = attempt.dispatchEpochs.find(epoch => epoch.dispatchId === input.dispatchId)
        const reservation = team.interactionEffects.find(effect => effect.effectId === input.resumeEffectId)
        if (existing === undefined || existing.effectId !== input.resumeEffectId
          || reservation?.status !== 'applied'
          || !sameContinuationReceipt(reservation, intent, task.id, attempt.id, input.resumeEffectId, input.dispatchId)) {
          throw new TeamDomainError('admitted continuation lost its effect tuple', 'TEAM_STATE_CORRUPT')
        }
        result = { attempt, dispatch: existing }
        return
      }
      if (intent.phase !== 'requested') {
        throw new TeamDomainError('continuation slot is not request-admissible', 'TEAM_CONTINUATION_CONFLICT')
      }
      requireMemberPrincipal(team, intent.requestedBy, attempt)
      if (intent.expectedTaskRevision !== task.revision) {
        throw new TeamDomainError('continuation request became stale before admission', 'TEAM_TASK_STALE_REVISION')
      }
      if (attempt.dispatchEpochs.length >= MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT) {
        throw new TeamDomainError('Attempt exhausted its bounded dispatch history', 'TEAM_RESOURCE_LIMIT')
      }
      const resumeEffectId = TeamEffectId(requireText(input.resumeEffectId, 'resume effect id'))
      const dispatchId = DispatchId(requireText(input.dispatchId, 'dispatch id'))
      if (team.interactionEffects.some(effect => effect.effectId === resumeEffectId)) {
        throw new TeamDomainError('continuation resume effect identity is already occupied', 'TEAM_CONTINUATION_CONFLICT')
      }
      if (team.interactionEffects.length >= MAX_V2_EFFECT_RECEIPTS) {
        throw new TeamDomainError(
          'Team exhausted its bounded effect receipt ledger before continuation admission',
          'TEAM_RESOURCE_LIMIT',
        )
      }
      const timestamp = this.now()
      const dispatch: ModelDispatchEpoch = {
        dispatchId,
        kind: 'continuation',
        ordinal: attempt.dispatchEpochs.length + 1,
        effectId: resumeEffectId,
        targetSessionId: attempt.memberSessionId,
        witnessCapabilityDigest: requireDigest(input.witnessCapabilityDigest, 'witness capability digest'),
        phase: 'frame-pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const admitted: ContinuationIntent = {
        ...intent, resumeEffectId: dispatch.effectId, currentDispatchId: dispatch.dispatchId, phase: 'admitted',
      }
      const next: TaskAttemptV2 = {
        ...attempt,
        currentContinuationIntent: admitted,
        dispatchEpochs: [...attempt.dispatchEpochs, dispatch],
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, next)
      team.interactionEffects.push({
        effectId: resumeEffectId,
        kind: 'continuation',
        status: 'applied',
        appliedAt: timestamp,
        resultingTeamRevision: team.revision + 1,
        requestId: intent.continuationEffectId,
        taskId: task.id,
        attemptId: attempt.id,
        dispatchId,
        continuationEffectId: intent.continuationEffectId,
        continuationRequestedBy: intent.requestedBy,
        continuationRequestedAt: intent.requestedAt,
        continuationExpectedTaskRevision: intent.expectedTaskRevision,
        ...(intent.checkpointDigest === undefined ? {} : {
          continuationCheckpointDigest: intent.checkpointDigest,
        }),
        ...(intent.wakeCondition === undefined ? {} : {
          continuationWakeCondition: intent.wakeCondition,
        }),
      })
      result = { attempt: next, dispatch }
    })
    return structuredClone(result)
  }

  async recordFrameAccepted(scope: TeamScope, teamId: TeamId, input: {
    readonly taskId: TaskId
    readonly attemptId: AttemptId
    readonly continuationEffectId: ContinuationEffectId
    readonly dispatchId: DispatchId
    readonly frameMessageId: string
  }): Promise<ModelDispatchEpoch> {
    let result!: ModelDispatchEpoch
    await this.store.transact(scope, teamId, team => {
      const tuple = requireContinuationTuple(team, input.taskId, input.attemptId, input.continuationEffectId, input.dispatchId)
      if (tuple.intent.phase !== 'admitted' || tuple.dispatch.phase !== 'frame-pending') {
        throw new TeamDomainError('continuation frame is not awaiting admission evidence', 'TEAM_ATTEMPT_STALE')
      }
      const messageId = requireText(input.frameMessageId, 'official frame message id')
      if (tuple.dispatch.frameMessageId !== undefined && tuple.dispatch.frameMessageId !== messageId) {
        throw new TeamDomainError('continuation frame acceptance conflicts with the committed identity', 'TEAM_ATTEMPT_STALE')
      }
      const accepted: ModelDispatchEpoch = { ...tuple.dispatch, frameMessageId: messageId, updatedAt: this.now() }
      replaceV2Attempt(team, {
        ...tuple.attempt,
        dispatchEpochs: tuple.attempt.dispatchEpochs.map(epoch => epoch.dispatchId === accepted.dispatchId ? accepted : epoch),
        updatedAt: this.now(),
      })
      result = accepted
    })
    return structuredClone(result)
  }

  async claimFrame(scope: TeamScope, teamId: TeamId, input: ContinuationDispatchCheckpoint): Promise<ModelDispatchEpoch> {
    let result!: ModelDispatchEpoch
    await this.store.transact(scope, teamId, team => {
      const tuple = requireContinuationTuple(team, input.taskId, input.attemptId, input.continuationEffectId, input.dispatchId)
      if (tuple.intent.resumeEffectId !== input.resumeEffectId
        || tuple.dispatch.effectId !== input.resumeEffectId
        || tuple.dispatch.frameMessageId !== input.frameMessageId
        || tuple.dispatch.witnessCapabilityDigest !== requireDigest(input.witnessCapabilityDigest, 'witness capability digest')) {
        throw new TeamDomainError('claimed continuation frame conflicts with its admitted effect', 'TEAM_ATTEMPT_STALE')
      }
      if (!Number.isSafeInteger(input.messageSeq) || input.messageSeq < 0
        || !Number.isSafeInteger(input.turn) || input.turn < 1
        || !Number.isSafeInteger(input.step) || input.step < 1) {
        throw new TeamDomainError('continuation Session fence is invalid', 'TEAM_INPUT_INVALID')
      }
      if (tuple.dispatch.phase === 'dispatch-pending' && tuple.intent.phase === 'dispatch-pending') {
        if (tuple.dispatch.messageSeq !== input.messageSeq || tuple.dispatch.turn !== input.turn
          || tuple.dispatch.step !== input.step) {
          throw new TeamDomainError('continuation claim conflicts with the committed Session fence', 'TEAM_ATTEMPT_STALE')
        }
        result = tuple.dispatch
        return
      }
      if (tuple.dispatch.phase !== 'frame-pending' || tuple.intent.phase !== 'admitted') {
        throw new TeamDomainError('continuation frame is not claimable', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const claimed: ModelDispatchEpoch = {
        ...tuple.dispatch,
        turn: input.turn,
        step: input.step,
        messageSeq: input.messageSeq,
        phase: 'dispatch-pending',
        updatedAt: timestamp,
      }
      const intent: ContinuationIntent = { ...tuple.intent, phase: 'dispatch-pending' }
      replaceV2Attempt(team, {
        ...tuple.attempt,
        currentContinuationIntent: intent,
        dispatchEpochs: tuple.attempt.dispatchEpochs.map(epoch => epoch.dispatchId === claimed.dispatchId ? claimed : epoch),
        updatedAt: timestamp,
      })
      result = claimed
    })
    return structuredClone(result)
  }

  async enterDispatch(scope: TeamScope, teamId: TeamId, input: ContinuationDispatchCheckpoint): Promise<ModelDispatchEpoch> {
    let result!: ModelDispatchEpoch
    await this.store.transact(scope, teamId, team => {
      const tuple = requireContinuationTuple(team, input.taskId, input.attemptId, input.continuationEffectId, input.dispatchId)
      if (tuple.dispatch.effectId !== input.resumeEffectId
        || tuple.dispatch.frameMessageId !== input.frameMessageId
        || tuple.dispatch.turn !== input.turn || tuple.dispatch.step !== input.step
        || tuple.dispatch.messageSeq !== input.messageSeq
        || tuple.dispatch.witnessCapabilityDigest !== input.witnessCapabilityDigest) {
        throw new TeamDomainError('continuation model-dispatch tuple is stale', 'TEAM_ATTEMPT_STALE')
      }
      if (tuple.dispatch.phase === 'dispatch-entered' && tuple.intent.phase === 'dispatch-entered') {
        result = tuple.dispatch
        return
      }
      if (tuple.dispatch.phase !== 'dispatch-pending' || tuple.intent.phase !== 'dispatch-pending') {
        throw new TeamDomainError('continuation model dispatch is not pending', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const entered: ModelDispatchEpoch = { ...tuple.dispatch, phase: 'dispatch-entered', updatedAt: timestamp }
      replaceV2Attempt(team, {
        ...tuple.attempt,
        currentContinuationIntent: { ...tuple.intent, phase: 'dispatch-entered' },
        dispatchEpochs: tuple.attempt.dispatchEpochs.map(epoch => epoch.dispatchId === entered.dispatchId ? entered : epoch),
        updatedAt: timestamp,
      })
      result = entered
    })
    return structuredClone(result)
  }

  async settleAssistantEvidence(scope: TeamScope, teamId: TeamId, input: {
    readonly checkpoint: ContinuationDispatchCheckpoint
    readonly eventSeq: number
    readonly eventType: 'assistant/message'
  }): Promise<{ attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0) {
      throw new TeamDomainError('assistant evidence sequence is invalid', 'TEAM_INPUT_INVALID')
    }
    let result!: { attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const checkpoint = input.checkpoint
      const tuple = requireContinuationTuple(
        team, checkpoint.taskId, checkpoint.attemptId, checkpoint.continuationEffectId, checkpoint.dispatchId,
      )
      if (tuple.dispatch.phase !== 'dispatch-entered' || tuple.intent.phase !== 'dispatch-entered'
        || tuple.dispatch.effectId !== checkpoint.resumeEffectId
        || tuple.dispatch.frameMessageId !== checkpoint.frameMessageId
        || tuple.dispatch.turn !== checkpoint.turn || tuple.dispatch.step !== checkpoint.step
        || tuple.dispatch.messageSeq !== checkpoint.messageSeq
        || tuple.dispatch.witnessCapabilityDigest !== checkpoint.witnessCapabilityDigest) {
        throw new TeamDomainError('continuation assistant-evidence tuple is stale', 'TEAM_ATTEMPT_STALE')
      }
      const reservationIndex = team.interactionEffects.findIndex(effect => effect.effectId === checkpoint.resumeEffectId)
      const reservation = team.interactionEffects[reservationIndex]
      if (reservation?.status !== 'applied'
        || !sameContinuationReceipt(
          reservation, tuple.intent, checkpoint.taskId, checkpoint.attemptId,
          checkpoint.resumeEffectId, checkpoint.dispatchId,
        )) {
        throw new TeamDomainError('continuation dispatch lost its reserved receipt tuple', 'TEAM_STATE_CORRUPT')
      }
      const timestamp = this.now()
      const settled: ModelDispatchEpoch = {
        ...tuple.dispatch,
        phase: 'settled',
        assistantEvidenceSeq: input.eventSeq,
        assistantEvidenceType: input.eventType,
        updatedAt: timestamp,
      }
      const receipt = {
        ...reservation,
        status: 'settled' as const,
        resultingTeamRevision: team.revision + 1,
      }
      const { parked: _parked, currentContinuationIntent: _intent, ...unparked } = tuple.attempt
      void _parked; void _intent
      const running: TaskAttemptV2 = {
        ...unparked,
        phase: 'running',
        dispatchEpochs: tuple.attempt.dispatchEpochs.map(epoch => epoch.dispatchId === settled.dispatchId ? settled : epoch),
        evidence: [...tuple.attempt.evidence, `session:${tuple.attempt.memberSessionId}:event:${input.eventSeq}:${input.eventType}`],
        updatedAt: timestamp,
      }
      replaceV2Attempt(team, running)
      team.interactionEffects[reservationIndex] = receipt
      result = { attempt: running, dispatch: settled }
    })
    return structuredClone(result)
  }
}
