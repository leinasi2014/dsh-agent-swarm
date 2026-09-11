// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { ready, render, t } from './helpers/dashboard-ui.js'
import { TeamPublicChat } from '../src/client/TeamPublicChat.js'
import { TeamGroupNavigation } from '../src/client/TeamGroupNavigation.js'
import { GoalController } from '../src/client/goal-controller.js'
import { RetirementClient } from '../src/client/retirement-client.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

function archivedState(): TeamDashboardState {
  const data = ready.data!, row = data.teams.teams[0]!, member = data.captainMembers.members[0]!
  return { ...ready, data: { ...data,
    teams: { ...data.teams, binding: { ...data.teams.binding, mainSessionId: ready.targetSessionId! }, teams: [{ ...row, phase: 'archived' }] },
    projection: { ...data.projection, team: { ...data.projection.team, phase: 'archived' } },
    captainMembers: { ...data.captainMembers, members: [{ ...member, name: 'writer', phase: 'removed', sessionId: undefined,
      historySessionId: 'member-history', composition: { state: 'unavailable', reason: 'removed', runtimeProvider: 'mock' } } as never] },
  } }
}

it.each(['saved', 'empty'] as const)('renders the archived %s goal without the active goal controls', async kind => {
  const state = archivedState(), row = state.data!.teams.teams[0]!
  const goal = kind === 'saved' ? { state: 'generated' as const, text: '归档前确认的团队目标' } : { state: 'not_generated' as const, reason: 'goal_backend_not_implemented' as const }
  const team = { ...state, data: { ...state.data!, teams: { ...state.data!.teams, teams: [{ ...row, goal }] } } }
  const binding = team.data.projection.binding, send = vi.fn()
  const goalClient = { read: vi.fn(), save: vi.fn(), control: vi.fn(), requestResult: vi.fn() }
  const props = { t, goal: new GoalController(goalClient, 'archive-fixture'),
    useTeam: (select: (value: unknown) => unknown) => select(team), useSessions: (select: (value: unknown) => unknown) => select({ phase: 'ready', ids: [], byId: {} }),
    useSurface: (select: (value: unknown) => unknown) => select({ mode: 'docked' }),
    useChat: (select: (value: unknown) => unknown) => select({
      selection: { key: 'archived', viewer: team.targetSessionId, captain: binding.rootSessionId, team: binding.teamId },
      entries: [], draft: { text: 'cannot send', version: 1, tokens: [] }, draftStatus: 'ready', draftBlobs: {},
      history: { appendEligibility: { state: 'unavailable', reason: 'team_archived' }, limits: { maxTextBytes: 4096 } },
    }), send, latest: vi.fn(), image: vi.fn(),
  } as unknown as ComponentProps<typeof TeamPublicChat>
  await render(<TeamPublicChat {...props} />)
  const header = document.querySelector('.swarm-public__header')!
  expect(header.textContent).toContain(kind === 'saved' ? goal.text : t('public.goalEmpty'))
  expect(header.querySelector('[data-swarm-goal]')).toBeNull()
  expect(header.querySelector('[data-goal-edit]')).toBeNull()
  expect(document.querySelector<HTMLButtonElement>('[data-public-send]')?.disabled).toBe(true)
  await act(async () => { document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
  expect(send).not.toHaveBeenCalled()
  expect(goalClient.control).not.toHaveBeenCalled()
  expect(goalClient.save).not.toHaveBeenCalled()
})

it.each(['authorized', 'missing', 'active-id-only', 'team-binding', 'captain-binding'] as const)('checks the archived member history authority for %s before opening a cold transcript', async mode => {
  window.sessionStorage.clear()
  const state = archivedState(), team = state.data!.teams.teams[0]!, target = { rootSessionId: state.targetSessionId!, teamId: team.teamId }
  const members = state.data!.captainMembers
  if (mode === 'missing' || mode === 'active-id-only') {
    const { historySessionId: _history, ...member } = members.members[0]!
    Object.assign(members, { members: [{ ...member, ...(mode === 'active-id-only' ? { sessionId: 'member-history' } : {}) }] })
  } else if (mode === 'team-binding' || mode === 'captain-binding') {
    Object.assign(members, { binding: { ...members.binding, ...(mode === 'team-binding' ? { teamId: 'other-team' } : { rootSessionId: 'other-captain' }) } })
  }
  const rpc = vi.fn(async () => ({ ok: true, value: { schemaVersion: 1, target, teamName: team.name, readonly: true, sessionId: 'member-history',
    sessions: [{ id: 'member-history', label: 'Writer', role: 'member', available: true }], cursor: 0,
    entries: [{ sequence: 1, role: 'assistant', content: '已保存的成员工作记录', truncated: false }] } }))
  const openMember = vi.fn(), openCaptain = vi.fn(), openMain = vi.fn()
  const props = { t, wide: true, retirement: new RetirementClient({ call: rpc } as never, window.sessionStorage),
    useTeam: (select: (value: TeamDashboardState) => unknown) => select(state),
    usePanelInfo: (select: (value: unknown) => unknown) => select({ activePanelId: 'swarm.group' }),
    selectGroup: vi.fn(), expandSidebar: vi.fn(), openMember, openCaptain, openMain,
  } as unknown as ComponentProps<typeof TeamGroupNavigation>
  await render(<TeamGroupNavigation {...props} />)
  await act(async () => { document.querySelector<HTMLButtonElement>('.swarm-groups__archived')!.click() })
  await act(async () => { document.querySelector<HTMLButtonElement>(`[data-swarm-group="${team.teamId}"]`)!.click() })
  const member = document.querySelector<HTMLButtonElement>('[data-swarm-group-member="writer"]')!
  if (mode !== 'authorized') {
    if (mode === 'team-binding' || mode === 'captain-binding') expect(member).toBeNull()
    else expect(member.disabled).toBe(true)
    expect(rpc).not.toHaveBeenCalled(); expect(openMember).not.toHaveBeenCalled()
    return
  }
  expect(member.disabled).toBe(false)
  await act(async () => { member.click() })
  expect(document.querySelector('[data-history-role=assistant]')?.textContent).toContain('已保存的成员工作记录')
  expect(rpc).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'team/v1/history', expect.objectContaining({ target, sessionId: 'member-history' }), undefined)
  expect(openMember).not.toHaveBeenCalled(); expect(openCaptain).not.toHaveBeenCalled(); expect(openMain).not.toHaveBeenCalled()
})
