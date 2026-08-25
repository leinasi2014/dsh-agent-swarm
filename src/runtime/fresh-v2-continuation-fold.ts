import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import type { ContinuationDispatchCheckpoint } from '../domain/team-domain-v2-continuation.js'
import type { ContinuationIntent, ModelDispatchEpoch, TaskAttemptV2, TeamStateV2 } from '../domain/team-state-v2.js'
import type { TeamTask } from '../domain/types.js'
import { canonicalV2, canonicalV2Digest } from '../protocol/canonical-v2.js'

interface ContinuationFrameIdentity {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly continuationEffectId: string
  readonly resumeEffectId: string
  readonly dispatchId: string
  readonly ordinal: number
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
  return `<agent-swarm-continuation>${envelope}</agent-swarm-continuation>\nContinue the exact same Team task and Attempt. Re-read durable Team state and stay within the existing authority envelope. Request another continuation before this turn settles if more work remains; task submission is not available in this experimental slice.`
}

export function continuationFrameDigest(text: string): string {
  return canonicalV2Digest('dsh-agent-swarm/a2a/continuation-frame/v1', { text })
}

function pluginFrameText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'plugin'
    || event.data.source.plugin !== 'dsh-agent-swarm' || event.data.content.length !== 1) return undefined
  const block = event.data.content[0]
  return block?.type === 'text' ? block.text : undefined
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
    const text = pluginFrameText(event)
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

export interface CurrentContinuationAttempt {
  readonly team: TeamStateV2
  readonly task: TeamTask
  readonly attempt: TaskAttemptV2
  readonly intent: ContinuationIntent
  readonly dispatch: ModelDispatchEpoch
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
