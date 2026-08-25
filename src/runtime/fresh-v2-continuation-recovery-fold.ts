import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContinuationDispatchCheckpoint } from '../domain/team-domain-v2-continuation.js'
import { continuationFrameDigest, continuationPluginFrameText } from './fresh-v2-continuation-fold.js'

export type EnteredContinuationRecoveryEvidence =
  | { readonly kind: 'assistant-evidence'; readonly eventSeq: number; readonly turnEndSeq?: number }
  | {
    readonly kind: 'turn-end-evidence'
    readonly eventSeq: number
    readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens'
  }
  | { readonly kind: 'dispatch-unknown'; readonly reason: string }

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
