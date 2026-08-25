import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { claimedInitialFrame, initialPromptDigest } from '../src/runtime/fresh-v2-session-fold.js'

function openStep(id: string, turn = 1, step = 1): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  return session
}

function appendUser(session: Session, id: string, text: string): void {
  session.append('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}

describe('A1b exact initial-frame fold', () => {
  it('returns the unique exact user frame from the current open step', () => {
    const session = openStep('fold-exact')
    appendUser(session, 'assignment-1', 'exact assignment')
    expect(claimedInitialFrame(session, 1, 1, initialPromptDigest('exact assignment'))).toMatchObject({
      turn: 1,
      step: 1,
      stepStartSeq: 1,
      messageSeq: 2,
      messageId: 'assignment-1',
    })
  })

  it('rejects an old-step frame, duplicate frame, wrong digest and closed step', () => {
    const old = openStep('fold-old')
    appendUser(old, 'old', 'assignment')
    old.append('step/end', { turn: 1, step: 1 })
    old.append('step/start', { turn: 1, step: 2 })
    expect(() => claimedInitialFrame(old, 1, 2, initialPromptDigest('assignment')))
      .toThrow(/one exact initial-assignment frame/)

    const duplicate = openStep('fold-duplicate')
    appendUser(duplicate, 'first', 'assignment')
    appendUser(duplicate, 'second', 'assignment')
    expect(() => claimedInitialFrame(duplicate, 1, 1, initialPromptDigest('assignment')))
      .toThrow(/one exact initial-assignment frame/)

    const wrong = openStep('fold-wrong')
    appendUser(wrong, 'wrong', 'other')
    expect(() => claimedInitialFrame(wrong, 1, 1, initialPromptDigest('assignment')))
      .toThrow(/one exact initial-assignment frame/)

    const closed = openStep('fold-closed')
    appendUser(closed, 'closed', 'assignment')
    closed.append('step/end', { turn: 1, step: 1 })
    expect(() => claimedInitialFrame(closed, 1, 1, initialPromptDigest('assignment')))
      .toThrow(/already closed/)
  })

  it('rejects plugin-origin and multi-block lookalikes', () => {
    const plugin = openStep('fold-plugin')
    plugin.append('user/message', {
      id: MessageId('plugin-lookalike'),
      role: 'user',
      content: [{ type: 'text', text: 'assignment' }],
      source: { kind: 'plugin', plugin: 'test' },
    }, { surfaceOp: 'append' })
    expect(() => claimedInitialFrame(plugin, 1, 1, initialPromptDigest('assignment')))
      .toThrow(/one exact initial-assignment frame/)

    const multi = openStep('fold-multi')
    multi.append('user/message', {
      id: MessageId('multi-lookalike'),
      role: 'user',
      content: [{ type: 'text', text: 'assignment' }, { type: 'text', text: 'extra' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(() => claimedInitialFrame(multi, 1, 1, initialPromptDigest('assignment')))
      .toThrow(/one exact initial-assignment frame/)
  })
})
