import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentHeaderDisplayOwner } from '@deepseek-ai/dsh-client-ui-subagent/client'
import type { TeamDashboardData, TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { projectTeamLineage } from '../src/client/TeamLineageDisplay.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'

const fixture = SWARM_READ_RPC_FIXTURES_V1.values as unknown as Omit<TeamDashboardData, 'projection'> & { snapshot: TeamDashboardData['projection'] }
const state: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'member-session', data: {
  capabilities: fixture.capabilities,
  projection: fixture.snapshot,
  captainAnnouncements: fixture.captainAnnouncements,
  captainDiagnostics: fixture.captainDiagnostics,
  teams: { ...fixture.teams, binding: { ...fixture.teams.binding, mainSessionId: 'main-session' },
    teams: fixture.teams.teams.map(team => ({ ...team, name: '伊丽丝头部重构新轮次', displayName: '北辰' })) },
  captainMembers: { ...fixture.captainMembers, members: fixture.captainMembers.members.map(member => ({
    ...member, sessionId: member.name === 'worker' ? 'member-session' : 'other-member', displayName: member.name === 'worker' ? '衡准' : '丹青',
  })) },
} }
const captain: SubagentHeaderDisplayOwner = { kind: 'label', placement: 'switcher', defaultText: 'old Team · Captain',
  address: { parentSessionId: 'main-session' as SessionId, childSessionId: 'session-fixture' as SessionId, mode: 'continuable' } }
const member: SubagentHeaderDisplayOwner = { kind: 'label', placement: 'row', defaultText: 'old Team · worker',
  address: { parentSessionId: 'session-fixture' as SessionId, childSessionId: 'member-session' as SessionId, mode: 'continuable' } }

it('shows a compact Team and self-named Captain, then the exact member name, with full hover text', () => {
  expect(projectTeamLineage(captain, state)).toEqual({ text: '伊丽丝头部重… · 北辰', title: '伊丽丝头部重构新轮次 · 北辰' })
  expect(projectTeamLineage(member, state)).toEqual({ text: '衡准', title: '伊丽丝头部重构新轮次 · 北辰 → 衡准' })
})

it('uses the official descendant count even when it differs from the Team roster length', () => {
  expect(projectTeamLineage({ kind: 'count', parentSessionId: 'session-fixture' as SessionId, count: 7, defaultText: '7 subagents' }, state))
    .toEqual({ text: 'x7', title: '7 subagents' })
  expect(projectTeamLineage({ kind: 'count', parentSessionId: 'unrelated' as SessionId, count: 7, defaultText: '7 subagents' }, state)).toBeUndefined()
})

it.each(['loading', 'stale', 'reconnecting', 'closed', 'error'] as const)('keeps original labels for %s projections', phase => {
  expect(projectTeamLineage(captain, { ...state, phase })).toBeUndefined()
  expect(projectTeamLineage(member, { ...state, phase })).toBeUndefined()
})

it('does not infer a Team from matching labels, unrelated parents, missing addresses or incomplete reads', () => {
  expect(projectTeamLineage({ ...member, address: { ...member.address!, parentSessionId: 'other-parent' as SessionId } }, state)).toBeUndefined()
  expect(projectTeamLineage({ ...captain, address: { ...captain.address!, parentSessionId: 'other-parent' as SessionId } }, state)).toBeUndefined()
  expect(projectTeamLineage({ ...member, address: undefined }, state)).toBeUndefined()
  expect(projectTeamLineage(member, { ...state, data: { ...state.data!, teams: { ...state.data!.teams, complete: false } } })).toBeUndefined()
  expect(projectTeamLineage(member, { ...state, data: { ...state.data!, captainMembers: {
    ...state.data!.captainMembers, binding: { rootSessionId: 'session-fixture', teamId: 'other-team' },
  } } })).toBeUndefined()
})

it('follows newly read self-names and drops a removed roster member without changing catalog identity', () => {
  const changed = { ...state, data: { ...state.data!, captainMembers: { ...state.data!.captainMembers,
    members: state.data!.captainMembers.members.map(row => ({ ...row, displayName: '新名字' })),
  } } }
  expect(projectTeamLineage(member, changed)?.text).toBe('新名字')
  const removed = { ...changed, data: { ...changed.data, captainMembers: { ...changed.data.captainMembers,
    members: changed.data.captainMembers.members.map(row => ({ ...row, phase: 'removed' as const })),
  } } }
  expect(projectTeamLineage(member, removed)).toBeUndefined()
  expect(member.address?.childSessionId).toBe('member-session')
})
