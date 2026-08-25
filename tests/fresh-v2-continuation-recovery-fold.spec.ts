import { createMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { ContinuationDispatchCheckpoint } from '../src/domain/team-domain-v2-continuation.js'
import { ContinuationEffectId, DispatchId, TeamEffectId } from '../src/domain/team-state-v2.js'
import { AttemptId, TaskId } from '../src/domain/types.js'
import { continuationFrame, continuationFrameDigest } from '../src/runtime/fresh-v2-continuation-fold.js'
import {
  foldEnteredContinuationRecovery,
  foldPendingContinuationRecovery,
} from '../src/runtime/fresh-v2-continuation-recovery-fold.js'

const frame = continuationFrame({
  teamId: 'team-recovery', taskId: 'task-recovery', attemptId: 'attempt-recovery',
  continuationEffectId: 'continuation-recovery', resumeEffectId: 'effect-recovery',
  dispatchId: 'dispatch-recovery', ordinal: 2,
})

const checkpoint: ContinuationDispatchCheckpoint = {
  taskId: TaskId('task-recovery'),
  attemptId: AttemptId('attempt-recovery'),
  continuationEffectId: ContinuationEffectId('continuation-recovery'),
  resumeEffectId: TeamEffectId('effect-recovery'),
  dispatchId: DispatchId('dispatch-recovery'),
  frameMessageId: 'message-recovery',
  messageSeq: 2,
  turn: 2,
  step: 1,
  witnessCapabilityDigest: 'a'.repeat(64),
}

function enteredSession(): Session {
  const session = Session.create(SessionId('member-recovery'))
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', {
    id: MessageId(checkpoint.frameMessageId), role: 'user', content: [{ type: 'text', text: frame }],
    source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
  }, { surfaceOp: 'append' })
  return session
}

describe('A2a cold entered-continuation recovery fold', () => {
  it('accepts one exact persisted assistant result and its turn settlement', () => {
    const session = enteredSession()
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: 'durable result' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(foldEnteredContinuationRecovery(session.events, checkpoint, continuationFrameDigest(frame)))
      .toEqual({ kind: 'assistant-evidence', eventSeq: 3, turnEndSeq: 5 })
  })

  it('classifies missing, ambiguous, or conflicting evidence as dispatch-unknown', () => {
    const missing = enteredSession()
    missing.append('step/end', { turn: 2, step: 1 })
    missing.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldEnteredContinuationRecovery(missing.events, checkpoint, continuationFrameDigest(frame)))
      .toMatchObject({ kind: 'dispatch-unknown', reason: expect.stringContaining('no exact assistant') })

    const wrongFrame = enteredSession()
    expect(foldEnteredContinuationRecovery(
      wrongFrame.events, { ...checkpoint, frameMessageId: 'other-message' }, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'dispatch-unknown', reason: expect.stringContaining('frame fence') })

    const duplicate = enteredSession()
    for (const text of ['one', 'two']) {
      duplicate.append('assistant/message', {
        turn: 2,
        step: 1,
        message: createMessage({
          role: 'assistant', content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
    }
    expect(foldEnteredContinuationRecovery(duplicate.events, checkpoint, continuationFrameDigest(frame)))
      .toMatchObject({ kind: 'dispatch-unknown', reason: expect.stringContaining('ambiguous') })
  })

  it('classifies an exact non-repair turn end without output as a known terminal result', () => {
    const session = enteredSession()
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })
    expect(foldEnteredContinuationRecovery(session.events, checkpoint, continuationFrameDigest(frame)))
      .toEqual({ kind: 'turn-end-evidence', eventSeq: 4, reason: 'blocked' })
  })
})

describe('A2a cold pending-continuation recovery fold', () => {
  it('requires the exact frame and one interrupted cold boundary with no assistant evidence', () => {
    const exact = enteredSession()
    const exactBefore = [...exact.events]
    exact.append('step/end', { turn: 2, step: 1 })
    exact.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(exactBefore, exact.events, checkpoint, continuationFrameDigest(frame)))
      .toMatchObject({ kind: 'proven-not-entered', interruptedTurnEndSeq: 4, proofDigest: expect.any(String) })

    const assistant = enteredSession()
    assistant.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: 'unexpected' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    const assistantBefore = [...assistant.events]
    assistant.append('step/end', { turn: 2, step: 1 })
    assistant.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      assistantBefore, assistant.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('downstream') })

    const ordinaryEnd = enteredSession()
    const ordinaryBefore = [...ordinaryEnd.events]
    ordinaryEnd.append('step/end', { turn: 2, step: 1 })
    ordinaryEnd.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(foldPendingContinuationRecovery(
      ordinaryBefore, ordinaryEnd.events, checkpoint, continuationFrameDigest(frame),
    ))
      .toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('interrupted') })
  })
})
