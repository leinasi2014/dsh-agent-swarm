import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContinuationDispatchCheckpoint } from '../domain/team-domain-v2-continuation.js'
import { canonicalV2Digest } from '../protocol/canonical-v2.js'
import { continuationFrameDigest, continuationPluginFrameText } from './fresh-v2-continuation-fold.js'

export type EnteredContinuationRecoveryEvidence =
  | { readonly kind: 'assistant-evidence'; readonly eventSeq: number; readonly turnEndSeq?: number }
  | {
    readonly kind: 'turn-end-evidence'
    readonly eventSeq: number
    readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens'
  }
  | { readonly kind: 'dispatch-unknown'; readonly reason: string }

export type PendingContinuationRecoveryEvidence =
  | {
    readonly kind: 'proven-not-entered'
    readonly interruptedTurnEndSeq: number
    readonly proofDigest: string
  }
  | { readonly kind: 'not-proven'; readonly reason: string }

/**
 * Prove that one exact pending dispatch was durably fenced by the plugin but
 * never crossed its model-entry witness.  `interrupted` proves cold
 * quiescence; the durable Team phase plus the still-current witness digest is
 * what proves Provider non-entry.
 */
export function foldPendingContinuationRecovery(
  beforeRepair: readonly SessionEvent[],
  afterRepair: readonly SessionEvent[],
  checkpoint: ContinuationDispatchCheckpoint,
  expectedFrameDigest: string,
): PendingContinuationRecoveryEvidence {
  if (afterRepair.length < beforeRepair.length
    || JSON.stringify(afterRepair.slice(0, beforeRepair.length)) !== JSON.stringify(beforeRepair)) {
    return { kind: 'not-proven', reason: 'pending continuation physical prefix changed during cold repair' }
  }
  const starts = afterRepair.filter(event => event.type === 'step/start'
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step)
  if (starts.length !== 1) {
    return { kind: 'not-proven', reason: 'pending continuation step is missing or ambiguous after restart' }
  }
  const frame = afterRepair.find(event => event.seq === checkpoint.messageSeq)
  const frameText = frame === undefined ? undefined : continuationPluginFrameText(frame)
  if (frame?.type !== 'user/message' || frame.data.id !== checkpoint.frameMessageId
    || frameText === undefined || continuationFrameDigest(frameText) !== expectedFrameDigest
    || frame.seq <= starts[0]!.seq) {
    return { kind: 'not-proven', reason: 'pending continuation frame fence conflicts with persisted Session' }
  }
  const duplicateFrames = afterRepair.filter(event => {
    const text = continuationPluginFrameText(event)
    return text !== undefined && continuationFrameDigest(text) === expectedFrameDigest
  })
  if (duplicateFrames.length !== 1) {
    return { kind: 'not-proven', reason: 'pending continuation frame is duplicated after restart' }
  }
  const suffix = afterRepair.filter(event => event.seq > checkpoint.messageSeq)
  const allowed = new Set(['request/header', 'request/context', 'step/end', 'turn/end'])
  if (suffix.some(event => !allowed.has(event.type))) {
    return { kind: 'not-proven', reason: 'pending continuation has downstream execution evidence after its frame' }
  }
  const stepEnds = suffix.flatMap(event => event.type === 'step/end'
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step ? [event] : [])
  if (stepEnds.length !== 1) {
    return { kind: 'not-proven', reason: 'pending continuation lacks one exact repaired step boundary' }
  }
  const ends = afterRepair.flatMap(event => event.type === 'turn/end'
    && event.seq > checkpoint.messageSeq && event.data.turn === checkpoint.turn ? [event] : [])
  if (ends.length !== 1 || ends[0]!.data.reason.kind !== 'interrupted') {
    return { kind: 'not-proven', reason: 'pending continuation lacks one exact cold interrupted boundary' }
  }
  if (stepEnds[0]!.seq >= ends[0]!.seq || afterRepair.at(-1)?.seq !== ends[0]!.seq) {
    return { kind: 'not-proven', reason: 'pending continuation cold repair boundary is not the physical tail' }
  }
  const repairSuffix = afterRepair.slice(beforeRepair.length)
  if (repairSuffix.some(event => event.type !== 'step/end' && event.type !== 'turn/end')) {
    return { kind: 'not-proven', reason: 'pending continuation cold repair appended an unexpected physical event' }
  }
  const proofDigest = canonicalV2Digest('dsh-agent-swarm/a2a/pending-recovery-proof/v1', {
    checkpoint: {
      taskId: checkpoint.taskId,
      attemptId: checkpoint.attemptId,
      continuationEffectId: checkpoint.continuationEffectId,
      dispatchId: checkpoint.dispatchId,
      resumeEffectId: checkpoint.resumeEffectId,
      frameMessageId: checkpoint.frameMessageId,
      messageSeq: checkpoint.messageSeq,
      turn: checkpoint.turn,
      step: checkpoint.step,
      witnessCapabilityDigest: checkpoint.witnessCapabilityDigest,
    },
    interruptedTurnEndSeq: ends[0]!.seq,
    physicalTail: suffix.map(event => ({ seq: event.seq, type: event.type })),
  })
  return { kind: 'proven-not-entered', interruptedTurnEndSeq: ends[0]!.seq, proofDigest }
}

/**
 * Classify one cold persisted continuation that durably crossed the model-entry witness.
 * No result evidence means unknown external delivery, never permission to resend.
 */
export function foldEnteredContinuationRecovery(
  events: readonly SessionEvent[],
  checkpoint: ContinuationDispatchCheckpoint,
  expectedFrameDigest: string,
): EnteredContinuationRecoveryEvidence {
  const starts = events.filter(event => event.type === 'step/start'
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step)
  if (starts.length !== 1) {
    return { kind: 'dispatch-unknown', reason: 'entered continuation step is missing or ambiguous after restart' }
  }
  const frame = events.find(event => event.seq === checkpoint.messageSeq)
  const frameText = frame === undefined ? undefined : continuationPluginFrameText(frame)
  if (frame?.type !== 'user/message' || frame.data.id !== checkpoint.frameMessageId
    || frameText === undefined || continuationFrameDigest(frameText) !== expectedFrameDigest
    || frame.seq <= starts[0]!.seq) {
    return { kind: 'dispatch-unknown', reason: 'entered continuation frame fence conflicts with persisted Session' }
  }
  const assistants = events.filter(event => event.type === 'assistant/message'
    && event.seq > checkpoint.messageSeq
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step)
  const turnEnds = events.flatMap(event => event.type === 'turn/end'
    && event.data.turn === checkpoint.turn && event.seq > checkpoint.messageSeq ? [event] : [])
  if (assistants.length === 0 && turnEnds.length === 1 && turnEnds[0]!.data.reason.kind !== 'interrupted') {
    return {
      kind: 'turn-end-evidence',
      eventSeq: turnEnds[0]!.seq,
      reason: turnEnds[0]!.data.reason.kind,
    }
  }
  if (assistants.length !== 1) {
    return {
      kind: 'dispatch-unknown',
      reason: assistants.length === 0
        ? 'model dispatch entered before restart but no exact assistant result is durable'
        : 'model dispatch entered before restart but assistant result evidence is ambiguous',
    }
  }
  const laterTurnEnds = turnEnds.filter(event => event.seq > assistants[0]!.seq)
  return {
    kind: 'assistant-evidence',
    eventSeq: assistants[0]!.seq,
    ...(laterTurnEnds.length === 1 ? { turnEndSeq: laterTurnEnds[0]!.seq } : {}),
  }
}
