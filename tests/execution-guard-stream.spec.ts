import { TextProgress } from '../src/runtime/execution-guard-text.js'
import { describe, expect, it } from 'vitest'
import { GuardAdapter, mountGuard, prompt } from './helpers/execution-guard.js'

const PERIOD = 'Let me run. Executing. '
describe('single-generation visible text containment', () => {
  it.each([1, 7, 131_072])('aborts periodic text across %i-character chunks before the finite adapter completes', async chunkSize => {
    let finished = false
    let aborted = false
    const source = PERIOD.repeat(chunkSize > 1_000 ? 8_000 : 100)
    const adapter = new GuardAdapter(async function* (options) {
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (let offset = 0; offset < source.length; offset += chunkSize) {
          options.signal?.throwIfAborted()
          yield { type: 'text-delta', index: 0, text: source.slice(offset, offset + chunkSize) }
        }
        options.signal?.throwIfAborted()
        finished = true
        yield { type: 'block-end', index: 0, block: { type: 'text', text: source } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { aborted = options.signal?.aborted === true }
    })
    const stack = await mountGuard(adapter)
    try {
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      expect(finished).toBe(false)
      expect(aborted).toBe(true)
      expect(adapter.requests).toHaveLength(1)
      const events = stack.agent.session.events
      expect(events.some(event => event.type === 'tool/call')).toBe(false)
      expect(events.findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'aborted', reason: { kind: 'hook', reason: expect.stringContaining('visible-text') } })
      // No next step exists: a pending WARNING was not shown to the model.
      expect(events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Execution guard WARNING'))).toBe(false)
      await stack.ctx.sessions.flush(stack.agent.session)
      const stored = await stack.ctx.sessionPersistence.inspect(stack.agent.id, new AbortController().signal)
      expect(stored.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    } finally { await stack.dispose() }
  })

  it('finds a degenerate suffix after a long changing prefix in the same chunk', async () => {
    const prefix = Array.from({ length: 2_000 }, (_, index) => `Distinct observation ${index}: value=${index * 73}. `).join('')
    let finished = false
    const adapter = new GuardAdapter(async function* (options) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: prefix + PERIOD.repeat(100) }
      // The official stream may prefetch one item. Keep actual finite work
      // beyond that slot so early producer completion is a meaningful assertion.
      for (let index = 0; index < 4; index += 1) {
        options.signal?.throwIfAborted()
        yield { type: 'text-delta', index: 0, text: `Remaining ${index}. ` }
      }
      options.signal?.throwIfAborted()
      finished = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const stack = await mountGuard(adapter)
    try {
      stack.agent.followup(prompt()); await stack.agent.whenIdle()
      expect(finished).toBe(false)
      expect(stack.agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    } finally { await stack.dispose() }
  })

  it.each(['changing', 'fenced', 'reasoning'])('allows %s output to finish', async kind => {
    const source = kind === 'changing' ? Array.from({ length: 100 }, (_, index) => `Observation ${index}: working on item ${index * 19}. `).join('')
      : kind === 'fenced' ? `\`\`\`text\n${PERIOD.repeat(100)}\n\`\`\`\nDone.` : PERIOD.repeat(100)
    const adapter = new GuardAdapter(async function* () {
      const blockType = kind === 'reasoning' ? 'reasoning' : 'text'
      yield { type: 'block-start', index: 0, blockType }
      for (const character of source) yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: 0, text: character }
      yield { type: 'block-end', index: 0, block: { type: blockType, text: source } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const stack = await mountGuard(adapter)
    try {
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      expect(stack.agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally { await stack.dispose() }
  })
})

describe('visible-text rolling work bound', () => {
  it('computes UTF-8 length once per visible code point, including long whitespace', () => {
    const source = ' '.repeat(512)
    const original = Buffer.byteLength
    let calls = 0
    let notices: ReturnType<TextProgress['feed']> = []
    Buffer.byteLength = (input, encoding) => { calls += 1; return original(input, encoding) }
    try { notices = new TextProgress().feed(source) }
    finally { Buffer.byteLength = original }
    expect(notices).toEqual([])
    expect(calls).toBeLessThanOrEqual(source.length)
  })

  it('keeps whitespace inexpensive and finds its repeating Unicode suffix under either chunking', () => {
    for (const bytes of [8_192, 32_768]) {
      const source = ' '.repeat(bytes)
      const text = new TextProgress()
      const started = performance.now()
      expect(text.feed(source)).toEqual([])
      console.info('TEXT_WHITESPACE_COST', JSON.stringify({ bytes, elapsedMs: performance.now() - started, retainedBytes: text.retainedBytes }))
      const suffix = '执行下一步操作，现在继续。'.repeat(40)
      const whole = new TextProgress().feed(source + suffix)
      const fragmented = new TextProgress()
      const pieces: ReturnType<TextProgress['feed']> = []
      for (const character of source + suffix) {
        pieces.push(...fragmented.feed(character))
        if (pieces.at(-1)?.level === 'CRITICAL') break
      }
      expect(whole.some(notice => notice.level === 'CRITICAL')).toBe(true)
      expect(pieces).toEqual(whole)
      expect(fragmented.retainedBytes).toBeLessThanOrEqual(8_192)
    }
  })
})
