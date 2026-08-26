import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { TeamDomainPort } from '../src/domain/team-domain-port.js'
import { interruptMember, interruptMemberFromModel, type MemberControlDeps } from '../src/runtime/member-control.js'

const SIGNAL = new AbortController().signal
const NOW = 1_000

function event(seq: number, time: number, type: string, data: unknown): SessionEvent {
  return { seq, time, type, data } as unknown as SessionEvent
}

function openCall(seq = 3, time = 900, name = 'slow-tool', callId = 'call-1'): SessionEvent[] {
  return [
    event(1, 800, 'turn/start', { turn: 7 }),
    event(2, 810, 'step/start', { turn: 7, step: 2 }),
    event(seq, time, 'tool/call', { turn: 7, step: 2, callId: CallId(callId), name, arguments: '{}' }),
  ]
}

function fixture(input: {
  events?: readonly SessionEvent[]
  firstLiveSeq?: number
  now?: number
  timeoutMs?: number | undefined
  status?: 'running' | 'idle'
} = {}) {
  const memberId = SessionId('member-session')
  const captain = { id: SessionId('captain-session') } as Agent
  const member = {
    id: memberId,
    status: input.status ?? 'running',
    session: { firstLiveSeq: input.firstLiveSeq ?? 0, events: input.events ?? openCall() },
  } as Agent
  const interrupt = vi.fn()
  const ctx = {
    agents: { get: vi.fn((id: string) => id === memberId ? member : undefined) },
    tools: { get: vi.fn(() => input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs }) },
    subagents: { interrupt },
  } as unknown as Context
  const membership = {
    role: 'captain' as const,
    name: 'captain',
    team: { members: [{ name: 'worker', sessionId: memberId, phase: 'active' }] },
  }
  const domain = { requireMembership: vi.fn().mockResolvedValue(membership) } as unknown as TeamDomainPort
  const deps: MemberControlDeps = {
    ctx,
    domain: () => domain,
    isClosing: () => false,
    scopeOf: () => 'scope',
    ensureReady: async () => {},
    now: () => input.now ?? NOW,
  }
  return { captain, member, interrupt, deps }
}

async function modelAttempt(input: Parameters<typeof fixture>[0] = {}) {
  const state = fixture(input)
  const result = await interruptMemberFromModel(state.deps, { agent: state.captain, signal: SIGNAL }, 'worker')
  return { ...state, result }
}

describe('model interrupt admission', () => {
  it('admits only an overdue live-suffix call and returns bounded evidence', async () => {
    const { result, interrupt } = await modelAttempt({ timeoutMs: 100 })
    expect(result).toEqual({ name: 'worker', previousStatus: 'running', evidenceKind: 'host-confirmed-tool-timeout' })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('ignores a timed-out seed call before firstLiveSeq', async () => {
    const events = [...openCall(3, 100), event(4, 900, 'turn/start', { turn: 8 })]
    const state = fixture({ events, firstLiveSeq: 4, timeoutMs: 100 })
    await expect(interruptMemberFromModel(state.deps, { agent: state.captain, signal: SIGNAL }, 'worker'))
      .rejects.toMatchObject({ code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' })
    expect(state.interrupt).not.toHaveBeenCalled()
  })

  it('requires an exact current turn, step, call tuple with no matching result', async () => {
    const mismatchedResult = event(4, 950, 'tool/result', {
      turn: 7, step: 3,
      message: { source: { callId: CallId('call-1') } },
    })
    const accepted = await modelAttempt({ events: [...openCall(), mismatchedResult], timeoutMs: 100 })
    expect(accepted.interrupt).toHaveBeenCalledTimes(1)

    const settledResult = event(4, 950, 'tool/result', {
      turn: 7, step: 2,
      message: { source: { callId: CallId('call-1') } },
    })
    const rejected = fixture({ events: [...openCall(), settledResult], timeoutMs: 100 })
    await expect(interruptMemberFromModel(rejected.deps, { agent: rejected.captain, signal: SIGNAL }, 'worker'))
      .rejects.toMatchObject({ code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' })
    expect(rejected.interrupt).not.toHaveBeenCalled()

    // A result recorded before the call cannot settle that later call even if
    // an adversarial/inconsistent log reuses the same call id.
    const preCallResult = event(3, 850, 'tool/result', {
      turn: 7, step: 2,
      message: { source: { callId: CallId('call-1') } },
    })
    const laterCall = openCall(4, 900)
    const ordered = await modelAttempt({ events: [...laterCall.slice(0, 2), preCallResult, laterCall[2]!], timeoutMs: 100 })
    expect(ordered.interrupt).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['future call time', { now: NOW, timeoutMs: 100, events: openCall(3, NOW + 1) }],
    ['recent call', { now: NOW, timeoutMs: 101, events: openCall(3, 900) }],
    ['missing declared timeout', { events: openCall(), timeoutMs: undefined }],
    ['closed step', { events: [...openCall(), event(4, 950, 'step/end', { turn: 7, step: 2 })], timeoutMs: 100 }],
    ['closed turn', { events: [...openCall(), event(4, 950, 'turn/end', { turn: 7, reason: { kind: 'completed' } })], timeoutMs: 100 }],
    ['old prior-step call', { events: [...openCall(), event(4, 950, 'step/end', { turn: 7, step: 2 }), event(5, 960, 'step/start', { turn: 7, step: 3 })], timeoutMs: 100 }],
    ['idle live member with stale call history', { events: openCall(), timeoutMs: 100, status: 'idle' as const }],
  ])('rejects %s without changing member state or interrupting', async (_label, input) => {
    const state = fixture(input)
    const previousStatus = state.member.status
    await expect(interruptMemberFromModel(state.deps, { agent: state.captain, signal: SIGNAL }, 'worker'))
      .rejects.toMatchObject({ code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' })
    expect(state.interrupt).not.toHaveBeenCalled()
    expect(state.member.status).toBe(previousStatus)
  })

  it('preserves the trusted Host/Human interrupt API without evidence', async () => {
    const state = fixture({ events: [], timeoutMs: undefined })
    const result = await interruptMember(state.deps, { agent: state.captain, signal: SIGNAL }, 'worker')
    expect(result).toEqual({ name: 'worker', previousStatus: 'running' })
    expect(state.interrupt).toHaveBeenCalledTimes(1)
  })
})
