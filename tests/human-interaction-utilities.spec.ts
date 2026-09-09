import { describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { HumanInteractionRequest } from '../src/index.js'
import { truncateUtf8 } from '../src/human/human-control-gateway.js'

describe('semantic utilities', () => {
  it('sameHumanInteractionRequest compares schemaVersion and createdAt', () => {
    const base: HumanInteractionRequest = {
      schemaVersion: 1,
      requestId: 'human-semantic-utils-00000001',
      teamId: AgentSwarm.TeamId('team-semantic-utils'),
      source: { kind: 'captain-mediated', captainSessionId: 'captain-util' },
      target: { kind: 'member', memberName: 'worker' },
      intent: 'wake-member',
      expectedTeamRevision: 1,
      createdAt: 10,
    }
    expect(AgentSwarm.sameHumanInteractionRequest(base, { ...base })).toBe(true)
    expect(AgentSwarm.sameHumanInteractionRequest(base, { ...base, createdAt: 11 })).toBe(false)
    expect(AgentSwarm.sameHumanInteractionRequest(base, {
      ...base,
      schemaVersion: 2,
    } as unknown as HumanInteractionRequest)).toBe(false)
    const reorderedTarget = { memberName: 'worker', kind: 'member' } as const
    const withOrigin: HumanInteractionRequest = {
      ...base,
      target: reorderedTarget,
      origin: { kind: 'member', memberSessionId: 'member-util', memberName: 'worker' },
    }
    const reorderedOrigin = { memberName: 'worker', memberSessionId: 'member-util', kind: 'member' } as const
    expect(AgentSwarm.sameHumanInteractionRequest(withOrigin, {
      ...withOrigin,
      target: { kind: 'member', memberName: 'worker' },
      origin: reorderedOrigin,
    })).toBe(true)
  })

  it('truncateUtf8 accumulates code points linearly and never splits a character', () => {
    expect(truncateUtf8('a😀b', 5)).toBe('a😀')
    expect(truncateUtf8('😀x', 4)).toBe('😀')
    expect(truncateUtf8('😀😀', 3)).toBe('')
    expect(truncateUtf8('hello', 5)).toBe('hello')
    const huge = '😀'.repeat(50_000) + 'x'
    expect([...truncateUtf8(huge, 20_000)]).toHaveLength(5_000)
  })
})
