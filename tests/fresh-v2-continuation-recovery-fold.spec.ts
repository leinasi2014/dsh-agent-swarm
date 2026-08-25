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

  it('fails closed for every ambiguous or conflicting physical recovery boundary', () => {
    const exact = () => {
      const session = enteredSession()
      const before = [...session.events]
      session.append('step/end', { turn: 2, step: 1 })
      session.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
      return { before, after: [...session.events] }
    }
    const prefix = exact()
    expect(foldPendingContinuationRecovery(
      prefix.before,
      [{ ...prefix.after[0]!, seq: 99 }, ...prefix.after.slice(1)],
      checkpoint,
      continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('prefix changed') })

    const missingStep = exact()
    expect(foldPendingContinuationRecovery(
      missingStep.before, missingStep.after, { ...checkpoint, step: 2 }, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('step is missing or ambiguous') })

    const ambiguousStart = enteredSession()
    ambiguousStart.append('step/start', { turn: 2, step: 1 })
    const ambiguousStartBefore = [...ambiguousStart.events]
    ambiguousStart.append('step/end', { turn: 2, step: 1 })
    ambiguousStart.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      ambiguousStartBefore, ambiguousStart.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('step is missing or ambiguous') })

    const wrongFrame = exact()
    expect(foldPendingContinuationRecovery(
      wrongFrame.before, wrongFrame.after, { ...checkpoint, frameMessageId: 'wrong-frame' },
      continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('frame fence') })

    const duplicateFrame = enteredSession()
    duplicateFrame.append('user/message', {
      id: MessageId('message-recovery-duplicate'), role: 'user', content: [{ type: 'text', text: frame }],
      source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
    }, { surfaceOp: 'append' })
    const duplicateBefore = [...duplicateFrame.events]
    duplicateFrame.append('step/end', { turn: 2, step: 1 })
    duplicateFrame.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      duplicateBefore, duplicateFrame.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('duplicated') })

    const missingBoundary = enteredSession()
    const missingBoundaryBefore = [...missingBoundary.events]
    missingBoundary.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      missingBoundaryBefore, missingBoundary.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('step boundary') })

    const ambiguousBoundary = enteredSession()
    const ambiguousBoundaryBefore = [...ambiguousBoundary.events]
    ambiguousBoundary.append('step/end', { turn: 2, step: 1 })
    ambiguousBoundary.append('step/end', { turn: 2, step: 1 })
    ambiguousBoundary.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      ambiguousBoundaryBefore, ambiguousBoundary.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('step boundary') })

    const duplicateEnd = enteredSession()
    const duplicateEndBefore = [...duplicateEnd.events]
    duplicateEnd.append('step/end', { turn: 2, step: 1 })
    duplicateEnd.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    duplicateEnd.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      duplicateEndBefore, duplicateEnd.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('one exact cold interrupted') })

    const nonTail = enteredSession()
    const nonTailBefore = [...nonTail.events]
    nonTail.append('step/end', { turn: 2, step: 1 })
    nonTail.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    nonTail.append('step/end', { turn: 99, step: 1 })
    expect(foldPendingContinuationRecovery(
      nonTailBefore, nonTail.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('physical tail') })

    const unexpectedRepair = enteredSession()
    const unexpectedRepairBefore = [...unexpectedRepair.events]
    unexpectedRepair.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial',
    })
    unexpectedRepair.append('step/end', { turn: 2, step: 1 })
    unexpectedRepair.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(foldPendingContinuationRecovery(
      unexpectedRepairBefore, unexpectedRepair.events, checkpoint, continuationFrameDigest(frame),
    )).toMatchObject({ kind: 'not-proven', reason: expect.stringContaining('unexpected physical event') })
  })
})
