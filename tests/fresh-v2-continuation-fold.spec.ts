import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  claimedContinuationFrame,
  continuationFrame,
  continuationFrameDigest,
} from '../src/runtime/fresh-v2-continuation-fold.js'

const identity = {
  teamId: 'team-continuation-fold',
  taskId: 'task-continuation-fold',
  attemptId: 'attempt-continuation-fold',
  continuationEffectId: 'continuation-continuation-fold',
  resumeEffectId: 'effect-continuation-fold',
  dispatchId: 'dispatch-continuation-fold',
  ordinal: 2,
}

function openStep(id: string, turn = 2, step = 1): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  return session
}

function appendFrame(session: Session, id: string, text: string, plugin = 'dsh-agent-swarm'): void {
  session.append('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }, { surfaceOp: 'append' })
}

describe('A2a exact continuation-frame fold', () => {
  it('builds one deterministic typed frame and claims its exact official inbox identity', () => {
    const text = continuationFrame(identity)
    expect(continuationFrame(identity)).toBe(text)
    expect(text).toContain('<agent-swarm-continuation>{')
    expect(text).toContain('"type":"agent-swarm/continue-attempt"')
    const session = openStep('continuation-fold-exact')
    appendFrame(session, 'continuation-message-1', text)
    expect(claimedContinuationFrame(session, 2, 1, continuationFrameDigest(text), 'continuation-message-1'))
      .toMatchObject({ messageId: 'continuation-message-1', messageSeq: 2, turn: 2, step: 1 })
  })

  it('rejects wrong source, plugin, message identity, content shape, digest, and duplicates', () => {
    const text = continuationFrame(identity)
    const user = openStep('continuation-fold-user')
    user.append('user/message', {
      id: MessageId('user-lookalike'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(() => claimedContinuationFrame(user, 2, 1, continuationFrameDigest(text))).toThrow(/one exact continuation frame/)

    const plugin = openStep('continuation-fold-plugin')
    appendFrame(plugin, 'wrong-plugin', text, 'another-plugin')
    expect(() => claimedContinuationFrame(plugin, 2, 1, continuationFrameDigest(text))).toThrow(/one exact continuation frame/)

    const multi = openStep('continuation-fold-multi')
    multi.append('user/message', {
      id: MessageId('multi-block'), role: 'user',
      content: [{ type: 'text', text }, { type: 'text', text: 'extra' }],
      source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
    }, { surfaceOp: 'append' })
    expect(() => claimedContinuationFrame(multi, 2, 1, continuationFrameDigest(text))).toThrow(/one exact continuation frame/)

    const exact = openStep('continuation-fold-wrong-identity')
    appendFrame(exact, 'right-message', text)
    expect(() => claimedContinuationFrame(exact, 2, 1, continuationFrameDigest(text), 'wrong-message'))
      .toThrow(/one exact continuation frame/)
    expect(() => claimedContinuationFrame(exact, 2, 1, continuationFrameDigest(`${text} changed`)))
      .toThrow(/one exact continuation frame/)
    appendFrame(exact, 'duplicate-message', text)
    expect(() => claimedContinuationFrame(exact, 2, 1, continuationFrameDigest(text)))
      .toThrow(/one exact continuation frame/)
  })

  it('rejects old-step and closed-step frames', () => {
    const text = continuationFrame(identity)
    const old = openStep('continuation-fold-old')
    appendFrame(old, 'old-message', text)
    old.append('step/end', { turn: 2, step: 1 })
    old.append('step/start', { turn: 2, step: 2 })
    expect(() => claimedContinuationFrame(old, 2, 2, continuationFrameDigest(text))).toThrow(/one exact continuation frame/)
    expect(() => claimedContinuationFrame(old, 2, 1, continuationFrameDigest(text))).toThrow(/already closed/)
  })
})
