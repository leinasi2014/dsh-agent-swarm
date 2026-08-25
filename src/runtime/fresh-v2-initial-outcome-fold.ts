import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InitialDispatchCheckpoint } from '../domain/team-domain-v2-start.js'
import { initialFrameText, initialPromptDigest } from './fresh-v2-session-fold.js'

export type InitialEnteredOutcome =
  | { readonly kind: 'assistant'; readonly assistantEventSeq: number; readonly turnEndSeq: number }
  | {
    readonly kind: 'turn-end'
    readonly eventSeq: number
    readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens'
  }
  | { readonly kind: 'unknown'; readonly reason: string }

/** Classify only exact durable outcome evidence after an initial dispatch entered Provider. */
export function foldEnteredInitialOutcome(
  events: readonly SessionEvent[],
  checkpoint: InitialDispatchCheckpoint,
): InitialEnteredOutcome {
  const starts = events.filter(event => event.type === 'step/start'
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step)
  if (starts.length !== 1) return { kind: 'unknown', reason: 'entered initial step is missing or ambiguous after restart' }
  const frame = events.find(event => event.seq === checkpoint.messageSeq)
  const text = frame === undefined ? undefined : initialFrameText(frame)
  if (frame?.type !== 'user/message' || text === undefined
    || initialPromptDigest(text) !== checkpoint.initialPromptDigest || frame.seq <= starts[0]!.seq) {
    return { kind: 'unknown', reason: 'entered initial frame fence conflicts with persisted Session' }
  }
  const matchingFrames = events.filter(event => {
    const candidate = initialFrameText(event)
    return candidate !== undefined && initialPromptDigest(candidate) === checkpoint.initialPromptDigest
  })
  if (matchingFrames.length !== 1) return { kind: 'unknown', reason: 'entered initial frame is duplicated after restart' }
  const assistants = events.filter(event => event.type === 'assistant/message'
    && event.seq > checkpoint.messageSeq
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step)
  const turnEnds = events.flatMap(event => event.type === 'turn/end'
    && event.seq > checkpoint.messageSeq && event.data.turn === checkpoint.turn ? [event] : [])
  const partialOutputs = events.filter(event => event.type === 'assistant/chunk'
    && event.seq > checkpoint.messageSeq
    && event.data.turn === checkpoint.turn && event.data.step === checkpoint.step
    && ['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(event.data.chunk.type))
  if (turnEnds.length > 1) return { kind: 'unknown', reason: 'entered initial turn-end evidence is ambiguous' }
  if (partialOutputs.length > 0 && assistants.length === 0) {
    return { kind: 'unknown', reason: 'initial model dispatch has partial assistant output without an exact durable result' }
  }
  if (assistants.length === 0 && turnEnds.length === 1 && turnEnds[0]!.data.reason.kind !== 'interrupted') {
    return {
      kind: 'turn-end',
      eventSeq: turnEnds[0]!.seq,
      reason: turnEnds[0]!.data.reason.kind,
    }
  }
  if (assistants.length !== 1) {
    return {
      kind: 'unknown',
      reason: assistants.length === 0
        ? 'initial model dispatch entered but no exact assistant result is durable'
        : 'initial model dispatch assistant result evidence is ambiguous',
    }
  }
  const turnEnd = turnEnds[0]
  if (turnEnd === undefined || turnEnd.seq <= assistants[0]!.seq) {
    return { kind: 'unknown', reason: 'entered initial assistant evidence lacks one later terminal turn boundary' }
  }
  return { kind: 'assistant', assistantEventSeq: assistants[0]!.seq, turnEndSeq: turnEnd.seq }
}
