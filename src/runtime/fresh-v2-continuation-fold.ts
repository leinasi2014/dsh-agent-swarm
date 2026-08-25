import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import type { ContinuationDispatchCheckpoint } from '../domain/team-domain-v2-continuation.js'
import type { ContinuationIntent, ModelDispatchEpoch, TaskAttemptV2, TeamStateV2 } from '../domain/team-state-v2.js'
import type { TeamTask } from '../domain/types.js'
import { canonicalV2, canonicalV2Digest } from '../protocol/canonical-v2.js'
import { currentOpenStepStartSeq } from './fresh-v2-session-step.js'

interface ContinuationFrameIdentity {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly continuationEffectId: string
  readonly resumeEffectId: string
  readonly dispatchId: string
  readonly ordinal: number
}

interface ContinuationRecoveryFrameIdentity extends ContinuationFrameIdentity {
  readonly recoveryOf: string
  readonly recoveryProofDigest: string
}

export function continuationFrame(identity: ContinuationFrameIdentity): string {
  const envelope = canonicalV2({
    type: 'agent-swarm/continue-attempt',
    version: 1,
    teamId: identity.teamId,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    continuationEffectId: identity.continuationEffectId,
    resumeEffectId: identity.resumeEffectId,
    dispatchId: identity.dispatchId,
    ordinal: identity.ordinal,
  })
  return `<agent-swarm-continuation>${envelope}</agent-swarm-continuation>\nContinue the exact same Team task and Attempt. Re-read durable Team state and stay within the existing authority envelope. Submit with agent_swarm_submit_task when the task is finished; otherwise request another continuation before this turn settles.`
}

function continuationRecoveryFrame(identity: ContinuationRecoveryFrameIdentity): string {
  const envelope = canonicalV2({
    type: 'agent-swarm/recover-attempt',
    version: 1,
    teamId: identity.teamId,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    continuationEffectId: identity.continuationEffectId,
    recoveryEffectId: identity.resumeEffectId,
    recoveryDispatchId: identity.dispatchId,
    recoveryOf: identity.recoveryOf,
    ordinal: identity.ordinal,
    recoveryProofDigest: identity.recoveryProofDigest,
  })
  return `<agent-swarm-recovery>${envelope}</agent-swarm-recovery>\nRecover the exact same Team task and Attempt after a proven non-entry boundary. Re-read durable Team state and continue only under the recovery dispatch authority; submit only when the task is finished.`
}

export function continuationFrameDigest(text: string): string {
  return canonicalV2Digest('dsh-agent-swarm/a2a/continuation-frame/v1', { text })
}

export function continuationPluginFrameText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'plugin'
    || event.data.source.plugin !== 'dsh-agent-swarm' || event.data.content.length !== 1) return undefined
  const block = event.data.content[0]
  return block?.type === 'text' ? block.text : undefined
}

/** Detect any plugin-owned continuation/recovery frame in the current open step. */
export function currentStepContainsContinuationFrame(session: Session, turn: number, step: number): boolean {
  const startSeq = currentOpenStepStartSeq(session, turn, step)
  if (startSeq === undefined) return false
  return session.events.some(event => {
    if (event.seq <= startSeq) return false
    const text = continuationPluginFrameText(event)
    return text?.startsWith('<agent-swarm-continuation>') === true
      || text?.startsWith('<agent-swarm-recovery>') === true
  })
}

export interface ClaimedContinuationFrame {
  readonly messageId: string
  readonly messageSeq: number
  readonly turn: number
  readonly step: number
  readonly frameDigest: string
}

/** Fold one exact plugin-owned continuation frame from the current open step. */
export function claimedContinuationFrame(
  session: Session,
  turn: number,
  step: number,
  expectedFrameDigest: string,
  expectedMessageId?: string,
): ClaimedContinuationFrame {
  const starts = session.events.filter(event => event.type === 'step/start'
    && event.data.turn === turn && event.data.step === step)
  if (starts.length !== 1) throw new TeamDomainError('continuation step is missing or ambiguous', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  const start = starts[0]!
  if (session.events.some(event => event.seq > start.seq && event.type === 'step/end'
    && event.data.turn === turn && event.data.step === step)) {
    throw new TeamDomainError('continuation step is already closed', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  const matches = session.events.flatMap(event => {
    if (event.seq <= start.seq || event.type !== 'user/message') return []
    const text = continuationPluginFrameText(event)
    if (text === undefined || continuationFrameDigest(text) !== expectedFrameDigest
      || (expectedMessageId !== undefined && event.data.id !== expectedMessageId)) return []
    return [{ event, text }]
  })
  if (matches.length !== 1) {
    throw new TeamDomainError('current step does not contain one exact continuation frame', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  const match = matches[0]!
  if (match.event.type !== 'user/message') throw new TeamDomainError('continuation frame is not a user message', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  return {
    messageId: match.event.data.id,
    messageSeq: match.event.seq,
    turn,
    step,
    frameDigest: continuationFrameDigest(match.text),
  }
}

/** Fold one exact recovery user frame from durable history, including an already-closed cold step. */
export function durableClaimedContinuationFrame(
  events: readonly SessionEvent[],
  expectedFrameDigest: string,
): ClaimedContinuationFrame | undefined {
  const matches = events.flatMap(event => {
    const text = continuationPluginFrameText(event)
    return text !== undefined && continuationFrameDigest(text) === expectedFrameDigest ? [event] : []
  })
  if (matches.length === 0) return undefined
  if (matches.length !== 1 || matches[0]!.type !== 'user/message') {
    throw new TeamDomainError('durable recovery frame is duplicated or ambiguous', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  const message = matches[0]!
  const starts = events.flatMap(event => event.type === 'step/start' && event.seq < message.seq ? [event] : [])
  const start = starts.at(-1)
  if (start === undefined || events.some(event => event.type === 'step/end'
    && event.seq > start.seq && event.seq < message.seq
    && event.data.turn === start.data.turn && event.data.step === start.data.step)) {
    throw new TeamDomainError('durable recovery frame lacks one containing step', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  return {
    messageId: message.data.id,
    messageSeq: message.seq,
    turn: start.data.turn,
    step: start.data.step,
    frameDigest: expectedFrameDigest,
  }
}

export interface CurrentContinuationAttempt {
  readonly team: TeamStateV2
  readonly task: TeamTask
  readonly attempt: TaskAttemptV2
  readonly intent: ContinuationIntent
  readonly dispatch: ModelDispatchEpoch
}

export interface StagedContinuationRecovery {
  readonly current: CurrentContinuationAttempt
  readonly recovery: ModelDispatchEpoch
}

export function currentContinuationAttempt(team: TeamStateV2, sessionId: string): CurrentContinuationAttempt | undefined {
  const task = team.tasks.find(candidate => candidate.ownerSessionId === sessionId
    && candidate.status === 'in_progress' && candidate.currentAttemptId !== undefined)
  if (task === undefined) return undefined
  const attempt = team.attempts.find(candidate => candidate.id === task.currentAttemptId)
  const intent = attempt?.currentContinuationIntent
  const dispatch = intent?.currentDispatchId === undefined
    ? undefined
    : attempt?.dispatchEpochs.find(candidate => candidate.dispatchId === intent.currentDispatchId)
  if (attempt === undefined || intent === undefined || dispatch === undefined) return undefined
  return { team, task, attempt, intent, dispatch }
}

export function stagedContinuationRecovery(
  team: TeamStateV2,
  sessionId: string,
): StagedContinuationRecovery | undefined {
  const current = currentContinuationAttempt(team, sessionId)
  if (current === undefined || current.intent.phase !== 'dispatch-pending'
    || current.dispatch.phase !== 'dispatch-pending') return undefined
  const recoveries = current.attempt.dispatchEpochs.filter(epoch => epoch.kind === 'recovery'
    && epoch.phase === 'frame-pending' && epoch.recoveryOf === current.dispatch.dispatchId)
  return recoveries.length === 1 ? { current, recovery: recoveries[0]! } : undefined
}

export function frameOfContinuation(current: CurrentContinuationAttempt): string {
  const identity = {
    teamId: current.team.id,
    taskId: current.task.id,
    attemptId: current.attempt.id,
    continuationEffectId: current.intent.continuationEffectId,
    resumeEffectId: current.intent.resumeEffectId!,
    dispatchId: current.dispatch.dispatchId,
    ordinal: current.dispatch.ordinal,
  }
  if (current.dispatch.kind !== 'recovery') return continuationFrame(identity)
  if (current.dispatch.recoveryOf === undefined || current.dispatch.recoveryProofDigest === undefined) {
    throw new TeamDomainError('active recovery dispatch lacks its proof identity', 'TEAM_STATE_CORRUPT')
  }
  return continuationRecoveryFrame({
    ...identity,
    recoveryOf: current.dispatch.recoveryOf,
    recoveryProofDigest: current.dispatch.recoveryProofDigest,
  })
}

export function frameOfStagedRecovery(staged: StagedContinuationRecovery): string {
  const { current, recovery } = staged
  if (recovery.recoveryOf === undefined || recovery.recoveryProofDigest === undefined) {
    throw new TeamDomainError('staged recovery lacks its proof identity', 'TEAM_STATE_CORRUPT')
  }
  return continuationRecoveryFrame({
    teamId: current.team.id,
    taskId: current.task.id,
    attemptId: current.attempt.id,
    continuationEffectId: current.intent.continuationEffectId,
    resumeEffectId: recovery.effectId,
    dispatchId: recovery.dispatchId,
    recoveryOf: recovery.recoveryOf,
    ordinal: recovery.ordinal,
    recoveryProofDigest: recovery.recoveryProofDigest,
  })
}

export function continuationCheckpointOf(current: CurrentContinuationAttempt): ContinuationDispatchCheckpoint {
  const { task, attempt, intent, dispatch } = current
  if (intent.resumeEffectId === undefined || dispatch.frameMessageId === undefined
    || dispatch.messageSeq === undefined || dispatch.turn === undefined || dispatch.step === undefined) {
    throw new TeamDomainError('continuation dispatch lacks its complete Session/effect fence', 'TEAM_STATE_CORRUPT')
  }
  return {
    taskId: task.id,
    attemptId: attempt.id,
    continuationEffectId: intent.continuationEffectId,
    dispatchId: dispatch.dispatchId,
    resumeEffectId: intent.resumeEffectId,
    frameMessageId: dispatch.frameMessageId,
    messageSeq: dispatch.messageSeq,
    turn: dispatch.turn,
    step: dispatch.step,
    witnessCapabilityDigest: dispatch.witnessCapabilityDigest,
  }
}
