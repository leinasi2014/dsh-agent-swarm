import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { confirmedRunawayTool } from '../src/runtime/member-control.js'

const NOW = 2_000_000
const MIN_AGE = 600_000

function events(...rows: Array<Record<string, unknown>>): SessionEvent[] {
  return rows as unknown as SessionEvent[]
}

describe('model interrupt admission', () => {
  it('admits only a host-observed unmatched tool call older than the threshold', () => {
    const open = events(
      { type: 'turn/start', seq: 1, time: 1_000_000, data: { turn: 1 } },
      {
        type: 'tool/call', seq: 2, time: NOW - MIN_AGE, data: {
          turn: 1, step: 1, callId: 'call-old', name: 'pwsh', arguments: '{}',
        },
      },
    )
    expect(confirmedRunawayTool(open, NOW, MIN_AGE)).toEqual({
      callId: 'call-old', toolName: 'pwsh', ageMs: MIN_AGE,
    })
  })

  it('rejects silence, a recent call, a settled call and a closed turn', () => {
    expect(confirmedRunawayTool(events(
      { type: 'turn/start', seq: 1, time: NOW - MIN_AGE, data: { turn: 1 } },
    ), NOW, MIN_AGE)).toBeUndefined()

    const recent = events(
      { type: 'turn/start', seq: 1, time: NOW - 1_000, data: { turn: 1 } },
      {
        type: 'tool/call', seq: 2, time: NOW - 1_000, data: {
          turn: 1, step: 1, callId: 'call-recent', name: 'pwsh', arguments: '{}',
        },
      },
    )
    expect(confirmedRunawayTool(recent, NOW, MIN_AGE)).toBeUndefined()

    const settled = events(
      { type: 'turn/start', seq: 1, time: 1_000_000, data: { turn: 1 } },
      {
        type: 'tool/call', seq: 2, time: NOW - MIN_AGE, data: {
          turn: 1, step: 1, callId: 'call-settled', name: 'pwsh', arguments: '{}',
        },
      },
      {
        type: 'tool/result', seq: 3, time: NOW - MIN_AGE + 1, data: {
          turn: 1, step: 1, message: { source: { callId: 'call-settled' } },
        },
      },
    )
    expect(confirmedRunawayTool(settled, NOW, MIN_AGE)).toBeUndefined()

    const closed = events(
      ...recent,
      { type: 'turn/end', seq: 3, time: NOW, data: { turn: 1, reason: { kind: 'completed' } } },
    )
    expect(confirmedRunawayTool(closed, NOW, MIN_AGE)).toBeUndefined()
  })
})
