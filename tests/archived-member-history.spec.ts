import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { readCaptainSection } from '../src/host/captain-section-read.js'
import type { TeamState } from '../src/domain/types.js'
import type { SwarmReadCaptainMembersV1 } from '../src/rpc/read-rpc-contract.js'
import { assertSwarmReadRpcValue, SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'

function archiveFixture() {
  const ids = ['valid', 'missing', 'foreign', 'wrong-id', 'wrong-origin', 'wrong-workspace', 'broken']
  const team = { id: 'archived-team', name: 'Archive', captainSessionId: 'captain', phase: 'archived', tasks: [], attempts: [],
    members: ids.map(name => ({ name, role: 'Writer', sessionId: name, phase: 'removed', provider: 'mock', createdAt: 1 })) } as unknown as TeamState
  const stat = vi.fn(async (id: string) => {
    if (id === 'missing') return undefined
    if (id === 'broken') throw new Error('unreadable row')
    return { header: { id: id === 'wrong-id' ? 'other-id' : id, origin: id === 'wrong-origin' ? 'user' : 'subagent',
      parentSession: id === 'foreign' ? 'other-captain' : 'captain', cwd: id === 'wrong-workspace' ? '/elsewhere' : '/fixture' } }
  })
  const resume = vi.fn(), open = vi.fn()
  const ctx = { sessionPersistence: { stat, open }, agents: { get: vi.fn(), resume }, sessions: { get: vi.fn() } } as unknown as Context
  return { team, stat, resume, open, ctx }
}

it('discloses archived history per removed row only after its exact durable Session header is verified', async () => {
  const fixture = archiveFixture()
  const result = await readCaptainSection(fixture.ctx, fixture.team, { schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: 'captain', teamId: fixture.team.id } }) as SwarmReadCaptainMembersV1
  expect(result.members[0]).toMatchObject({ name: 'valid', historySessionId: 'valid', phase: 'removed', composition: { state: 'unavailable', reason: 'removed' } })
  expect(result.members.every(row => row.sessionId === undefined)).toBe(true)
  expect(result.members.slice(1).every(row => !Object.hasOwn(row, 'historySessionId'))).toBe(true)
  expect(fixture.resume).not.toHaveBeenCalled(); expect(fixture.open).not.toHaveBeenCalled()
})

it('does not give ordinary removed members of an active Team a history or active navigation id', async () => {
  const fixture = archiveFixture()
  const result = await readCaptainSection(fixture.ctx, { ...fixture.team, phase: 'active' }, { schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: 'captain', teamId: fixture.team.id } }) as SwarmReadCaptainMembersV1
  expect(result.members.every(row => row.sessionId === undefined && !Object.hasOwn(row, 'historySessionId'))).toBe(true)
  expect(fixture.stat).not.toHaveBeenCalled(); expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.resume).not.toHaveBeenCalled()
})

it('keeps archived history ids separate from active navigation in the strict client read contract', () => {
  const base = SWARM_READ_RPC_FIXTURES_V1.values.captainMembers
  const row = { ...base.members[0], phase: 'removed', historySessionId: 'member-history', composition: { state: 'unavailable', reason: 'removed', runtimeProvider: 'mock' } }
  const value = (members: unknown[]) => ({ ...base, members })
  expect(() => assertSwarmReadRpcValue('captainMembers', value([row]))).not.toThrow()
  for (const patch of [{ phase: 'active' }, { phase: 'failed' }, { sessionId: 'member-history' }, { historySessionId: '' }, { historySessionId: ' ' }]) {
    expect(() => assertSwarmReadRpcValue('captainMembers', value([{ ...row, ...patch }]))).toThrow()
  }
  expect(() => assertSwarmReadRpcValue('captainMembers', value([row, { ...row, name: 'duplicate-history' }]))).toThrow()
})
