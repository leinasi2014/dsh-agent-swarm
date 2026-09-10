// @vitest-environment jsdom
import { useTabInfo } from './helpers/sidebar-tab.js'
import { t, ready, teamData, FakeCoordinator, controller, render, detailOverlay, pressEscape, tabButton } from './helpers/dashboard-ui.js'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { deriveMemberActivity, deriveMemberTone, TEAM_WORKSPACE_WIDE_MIN_WIDTH, teamWorkspaceLayoutForWidth } from '../src/client/TeamDashboardContent.js'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'

const activePanel = (): string | null => document.querySelector<HTMLElement>('[role="tabpanel"]')?.getAttribute('data-swarm-panel') ?? null
const signalOf = (id: string): string | null => document.querySelector<HTMLElement>(`[data-swarm-activity-attempt="${id}"] [data-swarm-signal]`)?.getAttribute('data-swarm-signal') ?? null

describe('Team workspace views and projection-derived activity', () => {
  it('shows root ownership, all Team summaries and the current member together after opening a member Chat (#225)', async () => {
    const base = ready.data!
    const alpha = base.teams.teams[0]!
    const member = { ...base.captainMembers.members[0]!, name: 'worker', sessionId: 'member-chat', displayName: '霁蓝', biography: '角色美术。', identityCard: { state: 'generated' as const } }
    const state: TeamDashboardState = { ...ready, targetSessionId: member.sessionId, data: {
      ...base,
      projection: { ...base.projection, roster: [{ name: member.name, role: 'Artist', phase: 'active', createdAt: 1 }] },
      teams: { ...base.teams, binding: { rootSessionId: member.sessionId, mainSessionId: 'main-brain', mainSessionTitle: '角色资产验收', currentTeamId: alpha.teamId }, teams: [
        { ...alpha, summary: { memberCount: 2, taskCount: 4, completedTaskCount: 2 } },
        { ...alpha, teamId: 'beta', name: '运行验证组', captainSessionId: 'captain-beta', summary: { memberCount: 1, taskCount: 3, completedTaskCount: 1 } },
      ] },
      captainMembers: { ...base.captainMembers, members: [member] },
    } }
    const coordinator = new FakeCoordinator()
    coordinator.set({ mode: 'docked', view: 'overview', targetSessionId: member.sessionId })
    await render(<TeamDashboardDetails {...({ controller: { ...controller, getSnapshot: () => state }, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: member.sessionId, t } as any)} />)
    expect(document.querySelector('[data-swarm-team-lineage]')?.textContent).toContain(`角色资产验收›${alpha.name}›霁蓝`)
    expect(document.querySelectorAll('[data-swarm-team-card]')).toHaveLength(2)
    expect(document.querySelector('[data-swarm-team-card="beta"]')?.textContent).toContain('Tasks 1 / 3')
    expect(document.querySelector('[data-swarm-current-team="true"]')?.getAttribute('data-swarm-team-card')).toBe(alpha.teamId)
    expect(document.querySelector('[data-swarm-detail-view]')?.closest('[data-swarm-member-branch]')?.getAttribute('data-swarm-member-branch')).toBe('worker')
    expect(document.querySelector('[data-swarm-member-name="worker"]')?.getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('[data-swarm-captain-desk]')?.closest('[hidden]')).toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-main-chat]')!.click() })
    expect(coordinator.openMainChat).toHaveBeenCalledOnce()
  })

  it('opens a member Chat on one click and shows that member on a reopened Chat sidebar (#221)', async () => {
    const coordinator = new FakeCoordinator()
    const member = { ...ready.data!.captainMembers.members[0]!, name: 'worker', sessionId: 'worker-session', displayName: '林砚', profession: '编剧', personality: '细致', biography: '核对动机与因果。', identityCard: { state: 'generated' as const } }
    const data = { ...ready.data!, projection: { ...ready.data!.projection, roster: [{ name: member.name, role: 'Writer', phase: 'active' as const, createdAt: 1 }] }, captainMembers: { ...ready.data!.captainMembers, members: [member] } }
    let state: TeamDashboardState = { ...ready, targetSessionId: 'main-brain', data }
    const live = { ...controller, getSnapshot: () => state }
    await render(<TeamDashboardDetails {...({ controller: live, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!.click() })
    expect(coordinator.openMemberChat).toHaveBeenCalledExactlyOnceWith('worker', 'worker-session')
    expect(document.querySelector('[data-swarm-detail-biography]')?.textContent).toBe(member.biography)
    expect(document.querySelector('[data-swarm-contact-disabled]')).toBeNull()
    // Reopening/reloading the member Chat must select its own details without
    // requiring another click or relying on the first component's local state.
    await act(async () => { coordinator.set({ mode: 'inactive', view: 'overview', targetSessionId: undefined }) })
    state = { ...state, targetSessionId: 'worker-session' }
    const reopened = new FakeCoordinator()
    reopened.set({ mode: 'docked', view: 'overview', targetSessionId: 'worker-session' })
    await render(<TeamDashboardDetails {...({ controller: live, coordinator: reopened, useTabInfo, localeTag: reopened.localeTag, sessionId: 'worker-session', t } as any)} />)
    expect(document.querySelector('[data-swarm-detail-personality]')?.textContent).toBe(member.personality)
    expect(document.querySelector('[data-swarm-detail-biography]')?.textContent).toBe(member.biography)
    expect(reopened.openMemberChat).not.toHaveBeenCalled()
    await pressEscape()
    expect(document.querySelector('[data-swarm-detail-view]')).toBeNull()
  })

  it('renders persisted personality and biography and refreshes a profile backfill in place', async () => {
    const coordinator = new FakeCoordinator()
    const data = teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Writer', phase: 'active', createdAt: 1 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 },
    })
    const member = { ...data.captainMembers!.members[0]!, name: 'worker', displayName: '林墨', profession: '编剧', personality: '沉静，注重人物动机。',
      identityCard: { state: 'generated' as const }, avatar: { state: 'not_generated' as const, reason: 'avatar_backend_not_implemented' as const } }
    let state: TeamDashboardState = { ...ready, data: { ...data, captainMembers: { ...data.captainMembers!, members: [member] } } }
    const listeners = new Set<() => void>()
    const profiles = { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ controller: profiles, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!.click() })
    expect(document.querySelector('[data-swarm-detail-personality]')?.textContent).toBe(member.personality)
    expect(document.querySelector('[data-swarm-detail-biography]')?.textContent).toBe(t('detail.unavailable'))
    const biography = '负责人物弧光与对白，通过场景行动检验人物选择。'
    await act(async () => {
      state = { ...state, data: { ...state.data!, captainMembers: { ...data.captainMembers!, members: [{ ...member, biography }] } } }
      listeners.forEach(fn => fn())
    })
    expect(document.querySelector('[data-swarm-detail-biography]')?.textContent).toBe(biography)
    expect(document.querySelector('[data-swarm-detail-personality]')?.textContent).toBe(member.personality)
    expect(document.querySelector('[data-swarm-detail-biography]')?.getAttribute('title')).toBe(biography)
    expect(document.querySelector('[data-swarm-detail-personality]')?.getAttribute('title')).toBe(member.personality)
    expect(document.querySelector('[data-swarm-detail-role]')?.getAttribute('title')).toBe('Writer')
    expect(document.querySelector('[data-swarm-detail-profession]')?.getAttribute('title')).toBe('编剧')
  })

  it('keeps the compact work-seat workroom with honest derived tones, stats, and capped summaries/activity', async () => {
    const coordinator = new FakeCoordinator()
    const t0 = 1_700_000_000_000
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [
        { name: 'worker', role: 'Implementation', phase: 'active', createdAt: t0 },
        { name: 'idler', role: 'Reviewer', phase: 'active', createdAt: t0 + 1 },
        { name: 'broken', role: 'QA', phase: 'failed', createdAt: t0 + 2 },
      ],
      tasks: [
        { id: 'task-1', revision: 1, subject: 'Check the panel', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId: 'attempt-1', createdAt: t0, updatedAt: t0 + 100 },
        { id: 'task-2', revision: 1, subject: 'Second summary', status: 'submitted', blockedBy: [], priority: 1, ownerName: 'idler', currentAttemptId: 'attempt-2', createdAt: t0, updatedAt: t0 + 90 },
        { id: 'task-3', revision: 1, subject: 'Third summary must not show', status: 'verifying', blockedBy: [], priority: 1, ownerName: 'idler', currentAttemptId: 'attempt-3', createdAt: t0, updatedAt: t0 + 80 },
      ],
      attempts: [
        { id: 'attempt-1', taskId: 'task-1', generation: 1, memberName: 'worker', phase: 'running', assignmentPhase: 'delivered', createdAt: t0, updatedAt: t0 + 100 },
        { id: 'attempt-2', taskId: 'task-2', generation: 1, memberName: 'idler', phase: 'submitted', assignmentPhase: 'delivered', createdAt: t0, updatedAt: t0 + 90 },
        { id: 'attempt-3', taskId: 'task-3', generation: 1, memberName: 'idler', phase: 'verifying', assignmentPhase: 'delivered', createdAt: t0, updatedAt: t0 + 80 },
        { id: 'attempt-4', taskId: 'task-1', generation: 1, memberName: 'worker', phase: 'stale', assignmentPhase: 'delivered', createdAt: t0, updatedAt: t0 + 60 },
      ],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 3, tasks: 3, attempts: 4 },
    }
    const populatedState: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const populated = { getSnapshot: (): TeamDashboardState => populatedState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: populated, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    const stylesheet = document.querySelector('style')?.textContent ?? ''
      // No persistent Team rail: the Details column is reserved for the active Team.
      expect(document.querySelectorAll('[data-swarm-team-panel] [data-swarm-team-rail]')).toHaveLength(0)
      expect(document.querySelectorAll('[data-swarm-captain-desk]')).toHaveLength(1)
      const worker = document.querySelector<HTMLElement>('[data-swarm-member-name="worker"]')!
      expect(worker.getAttribute('data-swarm-tone')).toBe('executing')
      expect(worker.getAttribute('data-swarm-identity-state')).toBe('not_generated')
      expect(worker.querySelector('[data-swarm-member-visible-name]')?.textContent).toBe('worker')
      expect(worker.querySelector('[data-swarm-member-visible-profession]')?.textContent).toBe('Implementation')
      expect(worker.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Executing')
      expect(document.querySelector('[data-swarm-member-name="idler"]')?.getAttribute('data-swarm-tone')).toBe('pending')
      expect(document.querySelector('[data-swarm-member-name="broken"]')?.getAttribute('data-swarm-tone')).toBe('failed')
      // The statistics line derives from the SAME tone map.
      expect(document.querySelector('[data-swarm-desk-stats]')?.textContent).toContain('1 Executing')
      expect(document.querySelector('[data-swarm-desk-stats]')?.textContent).toContain('1 Pending')
      expect(document.querySelector('[data-swarm-desk-stats]')?.textContent).toContain('1 Failed')
      // Current tasks live under their member; recent activity is folded and bounded.
      expect(document.querySelector('[data-swarm-exec-summaries]')).toBeNull()
      expect(document.querySelector('[data-swarm-member-branch="worker"] [data-swarm-tree-task]')?.getAttribute('data-swarm-tree-task')).toBe('task-1')
      expect(document.querySelector('[data-swarm-member-branch="idler"] [data-swarm-tree-task]')?.getAttribute('data-swarm-tree-task')).toBe('task-2')
      expect(document.querySelectorAll('[data-swarm-team-activity] [data-swarm-activity-attempt]')).toHaveLength(3)
      expect(document.querySelector<HTMLDetailsElement>('[data-swarm-history]')?.open).toBe(false)
      expect(document.querySelector('[data-swarm-workroom]')?.firstElementChild?.hasAttribute('data-swarm-captain-desk')).toBe(true)
      expect(stylesheet).toMatch(/__workroom \{ display:flex; flex-direction:column/u)
      // Theme stays on official alias tokens only.
      expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(stylesheet).not.toMatch(/rgb\(|rgba\(|hsl\(/)
  // Layout branch stays a pure function; the narrow branch is owned by the CSS container query.
  expect(teamWorkspaceLayoutForWidth(359)).toBe('compact')
  expect(teamWorkspaceLayoutForWidth(TEAM_WORKSPACE_WIDE_MIN_WIDTH)).toBe('wide')
  expect(document.querySelector('.swarm-team-workspace')?.getAttribute('data-swarm-team-layout')).toBe('workspace')
  // A single Captain desk click routes to the dedicated Captain Chat via the coordinator.
  await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-captain-desk]')!).click(); await Promise.resolve() })
  expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
  })

  it('renders three mutually exclusive tab views and retains announcements and management together in Team info', async () => {
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    const tablist = document.querySelector<HTMLElement>('[data-swarm-view-tabs]')!
    expect(tablist.getAttribute('role')).toBe('tablist')
    const tabs = [...document.querySelectorAll('[data-swarm-view-tab]')]
    expect(tabs.map(tab => tab.getAttribute('data-swarm-view-tab'))).toEqual(['tasks', 'members', 'info'])
    expect(activePanel()).toBe('tasks')
    expect(tabButton('tasks').getAttribute('aria-selected')).toBe('true')
    await act(async () => { tabButton('members').click() })
    expect(activePanel()).toBe('members')
    // Tasks view replaces the member panel (mutually exclusive).
    await act(async () => { tabButton('tasks').click() })
    expect(activePanel()).toBe('tasks')
    expect(document.querySelector('[data-swarm-panel="members"]')).toBeNull()
    expect(document.querySelectorAll('[data-swarm-task-rows] [data-swarm-task-id]')).toHaveLength(0)
    expect(document.querySelector('[data-swarm-task-empty]')).not.toBeNull()
    // Notices view: exactly one full announcement list; the goal card still exists exactly once.
    await act(async () => { tabButton('info').click() })
    expect(activePanel()).toBe('info')
    expect(document.querySelectorAll('[data-swarm-announcements-list]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-swarm-announcement-entry]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Welcome to the Fixture Team.')
    expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(1)
    // Manage view: the four honest management entries.
    await act(async () => { tabButton('info').click() })
    expect(activePanel()).toBe('info')
    expect(document.querySelector('[data-swarm-manage-members]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-manage-growth]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-manage-overview]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-manage-diagnostics]')).not.toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-manage-overview] button')!.click() })
    expect(document.querySelector('[data-swarm-overview-metrics]')).not.toBeNull()
    await pressEscape()
    // Arrow-key navigation wraps across the three tabs.
    tabButton('info').focus()
    await act(async () => { tabButton('info').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(tabButton('tasks'))
    await act(async () => { tabButton('tasks').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(document.activeElement).toBe(tabButton('info'))
    // Overview/growth/diagnostics overlays are real read projections.
    await act(async () => { tabButton('info').click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-manage-diagnostics] button')!.click() })
    const overlay = detailOverlay()!
    expect(overlay.querySelector('[data-swarm-diagnostics-detail]')?.textContent).toContain('session-fixture')
    expect(overlay.querySelector('[data-swarm-diagnostics-detail]')?.textContent).toContain('team-domain')
    await pressEscape()
    // Member management routes through the official Captain chat seam.
    await act(async () => { document.querySelector<HTMLElement>('[data-swarm-manage-members] button')!.click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
  })

  it('keeps one card per real Team visible while expanding a Team and opening member details (#225)', async () => {
    const coordinator = new FakeCoordinator()
    const multiTeams = {
      schemaVersion: 1,
      binding: { rootSessionId: 'root' },
      teams: [
        { teamId: 'team-alpha', name: 'Alpha Team', phase: 'active', captainSessionId: 'captain-alpha',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          goal: { state: 'not_generated', reason: 'goal_not_set' },
          endpoints: {
            members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
          } },
        { teamId: 'team-alpha', name: 'Alpha Team', phase: 'active', captainSessionId: 'captain-alpha',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          goal: { state: 'not_generated', reason: 'goal_not_set' },
          endpoints: {
            members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
          } },
        { teamId: 'team-beta', name: 'Beta Team', phase: 'active', captainSessionId: 'captain-beta',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          goal: { state: 'generated', text: 'Beta team goal' },
          endpoints: {
            members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-beta' } },
            announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-beta' } },
            diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-beta' } },
          } },
      ],
      observedAt: 5, complete: true,
    }
    const stateFor = (bindingTeamId: string): TeamDashboardState => ({
      ...ready,
      data: {
        ...teamData(
          SWARM_READ_RPC_FIXTURES_V1.values.capabilities,
          {
            ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
            binding: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.binding, teamId: bindingTeamId },
            team: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.team, name: multiTeams.teams.find(team => team.teamId === bindingTeamId)?.name ?? 'Fixture Team' },
          },
        ),
        teams: multiTeams as never,
      },
    })
    let current: TeamDashboardState = stateFor('team-alpha')
    const listeners = new Set<() => void>()
    const railController = {
      getSnapshot: (): TeamDashboardState => current,
      subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      refresh: vi.fn(), reconnect: vi.fn(),
      selectTeam: vi.fn((teamId: string): void => {
        current = stateFor(teamId)
        listeners.forEach(listener => listener())
      }),
    }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: railController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    // One Team owns one card. Duplicate directory rows cannot duplicate cards.
    expect(document.querySelector('[data-swarm-team-rail]')).toBeNull()
    expect(document.querySelector('[data-swarm-team-switcher]')).toBeNull()
    expect([...document.querySelectorAll('[data-swarm-team-card]')].map(card => card.getAttribute('data-swarm-team-card'))).toEqual(['team-alpha', 'team-beta'])
    const teamPanel = document.querySelector('[data-swarm-team-panel]')!
    const toggle = (id: string) => teamPanel.querySelector<HTMLButtonElement>(`[data-swarm-team-toggle="${id}"]`)!
    expect(toggle('team-alpha').getAttribute('aria-expanded')).toBe('true')
    expect(toggle('team-beta').getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle('team-alpha').click() })
    expect(toggle('team-alpha').getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-swarm-workroom]')).toBeNull()
    expect(railController.selectTeam).not.toHaveBeenCalled()
    // Another Team selection switches the CURRENT sidebar through controller.selectTeam
    // with its real id — it never opens or jumps to any Captain Session.
    await act(async () => { toggle('team-beta').click() })
    expect(railController.selectTeam).toHaveBeenCalledTimes(1)
    expect(railController.selectTeam).toHaveBeenLastCalledWith('team-beta')
    expect(coordinator.openTeamCaptain).not.toHaveBeenCalled()
    expect(coordinator.openCaptainChat).not.toHaveBeenCalled()
    // The same Team panel stays mounted in the sidebar: no Captain Session handoff, no second surface.
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(1)
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.querySelector('[role="dialog"][data-swarm-detail-overlay]')).toBeNull()
    // After the switch the panel renders the SECOND Team's bound data: the moved selection, the
    // Beta Team title, and Beta's real public goal from the same read contract.
    expect(toggle('team-beta').getAttribute('aria-expanded')).toBe('true')
    expect(toggle('team-alpha').getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelectorAll('[data-swarm-team-card]')).toHaveLength(2)
    expect(document.querySelector<HTMLElement>('[data-swarm-goal-text]')?.textContent).toBe('Beta team goal')
    // The Captain conversation entry stays on the selected Team's Captain desk and still routes
    // through the official Captain Chat seam exactly once.
    await act(async () => { tabButton('members').click() })
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-captain-desk]')!).click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // Polling may select another active Team while the archived card stays listed.
    await act(async () => {
      const next = stateFor('team-alpha')
      current = { ...next, data: { ...next.data!, teams: { ...next.data!.teams,
        teams: next.data!.teams.teams.map(team => team.teamId === 'team-beta' ? { ...team, phase: 'archived' } : team),
      } } }
      listeners.forEach(listener => listener())
    })
    expect(toggle('team-alpha').getAttribute('aria-expanded')).toBe('true')
    expect(toggle('team-beta').getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-swarm-workroom]')).not.toBeNull()
    expect(document.querySelector('.swarm-team-workspace__card-loading')).toBeNull()
    // An explicit all-collapsed choice survives a later verified binding change.
    await act(async () => { toggle('team-alpha').click() })
    await act(async () => { current = stateFor('team-beta'); listeners.forEach(listener => listener()) })
    expect(toggle('team-alpha').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('team-beta').getAttribute('aria-expanded')).toBe('false')
    // Zero Teams renders an honest empty rail, never a fabricated dot.
    const emptyState: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, SWARM_READ_RPC_FIXTURES_V1.values.snapshot), teams: { ...multiTeams, teams: [] } as never } }
    const emptyController = { getSnapshot: (): TeamDashboardState => emptyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn(), selectTeam: vi.fn() }
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: emptyController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    expect(document.querySelectorAll('[data-swarm-team-dot]')).toHaveLength(0)
  })

  it('keeps legal 64-character owner values bounded in task rows while retaining their titles and opens the real task overlay', async () => {
    const memberName = 'a'.repeat(64)
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      tasks: [{ id: 'task-long-name', revision: 1, subject: 'Task with long Host names', status: 'in_progress', blockedBy: [], priority: 1, ownerName: memberName, targetMemberName: memberName, createdAt: 1, updatedAt: 2 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, tasks: 1 },
    }
    const state: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const longNameController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: longNameController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('tasks').click() })
    const owner = document.querySelector<HTMLElement>('[data-swarm-task-owner]')!
    expect(owner.getAttribute('data-swarm-task-owner')).toBe(`Owner: ${memberName}`)
    expect(owner.getAttribute('title')).toBe(`Owner: ${memberName}`)
    const stylesheet = [...document.querySelectorAll('style')].map(el => el.textContent).join('\n')
    expect(stylesheet).toMatch(/\.swarm-task-owner[^}]*overflow-wrap:anywhere/u)
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-task-id="task-long-name"]')!.click() })
    const overlay = detailOverlay()!
    expect(overlay.textContent).toContain('Owner')
    expect(overlay.textContent).toContain(memberName)
  })

  it.each([
    ['submitted', 'submitted'], ['verifying', 'verifying'], ['stale', 'stale'],
    ['accepted', 'accepted'], ['rejected', 'rejected'], ['cancelled', 'cancelled'],
  ] as const)('does not present a %s current attempt as running', (phase, expected) => {
    const data = projectionForActivity({
      tasks: [activityTask('task-current', 'attempt-current')],
      attempts: [activityAttempt('attempt-current', phase, 'worker', 2)],
    })
    expect(deriveMemberActivity(data, 'worker', 'active')).toMatchObject({ state: expected, task: { id: 'task-current' }, attempt: { id: 'attempt-current', phase } })
  })

  it.each([
    ['failed', 'error'], ['provisioning', 'provisioning'], ['removed', 'removed'],
  ] as const)('makes the authoritative %s roster lifecycle outrank a running current attempt', (memberPhase, expected) => {
    const data = projectionForActivity({ tasks: [activityTask('task-current', 'attempt-current')], attempts: [activityAttempt('attempt-current', 'running', 'worker', 2)], memberPhase })
    expect(deriveMemberActivity(data, 'worker', memberPhase)).toMatchObject({ state: expected, task: { id: 'task-current' }, attempt: { id: 'attempt-current', phase: 'running' } })
  })

  it('chooses a running current attempt over a later terminal observation for an active member', () => {
    const data = projectionForActivity({
      tasks: [activityTask('task-old', 'attempt-old', 'failed'), activityTask('task-new', 'attempt-new')],
      attempts: [activityAttempt('attempt-old', 'stale', 'worker', 3), activityAttempt('attempt-new', 'running', 'worker', 2)],
    })
    expect(deriveMemberActivity(data, 'worker', 'active')).toMatchObject({ state: 'running', task: { id: 'task-new' }, attempt: { id: 'attempt-new', phase: 'running' } })
  })

  it('does not assign another member attempt as a current task', () => {
    const data = projectionForActivity({ tasks: [activityTask('task-other', 'attempt-other')], attempts: [activityAttempt('attempt-other', 'running', 'other-worker', 2)] })
    expect(deriveMemberActivity(data, 'worker', 'active')).toEqual({ state: 'idle', task: undefined, attempt: undefined })
  })

  it('maps an active member without a current attempt to no current task, not an online claim', () => {
    const data = projectionForActivity({ tasks: [], attempts: [] })
    expect(deriveMemberActivity(data, 'worker', 'active')).toEqual({ state: 'idle', task: undefined, attempt: undefined })
    expect(deriveMemberTone(data, 'worker', 'active')).toBe('standby')
    expect(deriveMemberTone(data, 'worker', 'removed')).toBe('offline')
    expect(deriveMemberTone(data, 'worker', 'provisioning')).toBe('pending')
  })

  it('keeps a terminal currentAttemptId as standby (never a running claim) and shows the honest detail', async () => {
    const coordinator = new FakeCoordinator()
    const projection = projectionForActivity({
      tasks: [activityTask('task-history', 'attempt-history', 'failed')],
      attempts: [activityAttempt('attempt-history', 'accepted', 'worker', 2)],
    })
    const state: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } }
    const historyController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: historyController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    const member = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    expect(member.getAttribute('data-swarm-tone')).toBe('standby')
    expect(member.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Standby')
    await act(async () => { member.click() })
    const overlay = detailOverlay()!
    expect(overlay.textContent).toContain('No current task')
    expect(overlay.textContent).not.toContain('Running')
  })

  it('maps only submitted/verifying attempts to pending; terminal attempts stay neutral unless another in-flight task remains', () => {
    const pending = projectionForActivity({ tasks: [activityTask('task-a', 'attempt-a')], attempts: [activityAttempt('attempt-a', 'submitted', 'worker', 2)] })
    expect(deriveMemberTone(pending, 'worker', 'active')).toBe('pending')
    const verifying = projectionForActivity({ tasks: [activityTask('task-v', 'attempt-v')], attempts: [activityAttempt('attempt-v', 'verifying', 'worker', 2)] })
    expect(deriveMemberTone(verifying, 'worker', 'active')).toBe('pending')
    for (const terminalPhase of ['accepted', 'rejected', 'cancelled', 'stale'] as const) {
      // A terminal current attempt with no other owned work is ended, never pending.
      const settled = projectionForActivity({ tasks: [activityTask(`task-${terminalPhase}`, `attempt-${terminalPhase}`, 'failed')], attempts: [activityAttempt(`attempt-${terminalPhase}`, terminalPhase, 'worker', 2)] })
      expect(deriveMemberTone(settled, 'worker', 'active')).toBe('standby')
    }
    // A terminal current attempt is outranked by another genuinely in-flight owned task.
    const carryInFlight = projectionForActivity({
      tasks: [activityTask('task-done', 'attempt-done', 'failed'), activityTask('task-live', 'attempt-live')],
      attempts: [activityAttempt('attempt-done', 'cancelled', 'worker', 3), activityAttempt('attempt-live', 'running', 'worker', 2)],
    })
    expect(deriveMemberTone(carryInFlight, 'worker', 'active')).toBe('executing')
    // An owned still-pending task keeps the desk pending even with a terminal current attempt.
    const carryPending = projectionForActivity({
      tasks: [activityTask('task-queued', 'attempt-queued', 'pending'), activityTask('task-done2', 'attempt-done2', 'failed')],
      attempts: [activityAttempt('attempt-done2', 'accepted', 'worker', 3), activityAttempt('attempt-queued', 'running', 'other-worker', 4)],
    })
    expect(deriveMemberTone(carryPending, 'worker', 'active')).toBe('pending')
  })

  it('renders team-activity signals honestly: running=executing, submitted/verifying=pending, terminal attempts neutral', async () => {
    const coordinator = new FakeCoordinator()
    const projection = projectionForActivity({
      tasks: [activityTask('task-r', 'attempt-r'), activityTask('task-s', 'attempt-s'), activityTask('task-x', 'attempt-x', 'failed')],
      attempts: [
        activityAttempt('attempt-r', 'running', 'worker', 4),
        activityAttempt('attempt-s', 'submitted', 'worker', 3),
        activityAttempt('attempt-x', 'rejected', 'worker', 2),
      ],
    })
    const state: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const activityController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: activityController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    expect(signalOf('attempt-r')).toBe('executing')
    expect(signalOf('attempt-s')).toBe('pending')
    expect(signalOf('attempt-x')).toBe('settled')
  })

  it('shows the member-detail start time from the matching current attempt.createdAt and relabels TaskDetail createdAt', async () => {
    const coordinator = new FakeCoordinator()
    const t0 = 1_700_000_000_000
    const projection = projectionForActivity({
      tasks: [{ ...activityTask('task-live', 'attempt-live'), createdAt: t0 }],
      attempts: [{ ...activityAttempt('attempt-live', 'running', 'worker', 2), createdAt: t0 + 3_600_000 }],
    })
    const state: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const liveController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: liveController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    await act(async () => { tabButton('members').click() })
    const attemptTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t0 + 3_600_000))
    const taskTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t0))
    // Member detail: start time = current attempt.createdAt, never the task creation time.
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!).click(); await Promise.resolve() })
    expect(document.querySelector('[data-swarm-detail-task-started]')?.textContent).toBe(attemptTime)
    expect(document.querySelector('[data-swarm-detail-task-started]')?.textContent).not.toBe(taskTime)
    await pressEscape()
    // TaskDetail: task.createdAt is labeled "Created", not "Started".
    await act(async () => { tabButton('tasks').click() })
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-task-id="task-live"]')!).click(); await Promise.resolve() })
    const createdLabel = [...detailOverlay()!.querySelectorAll('dt')].find(label => label.textContent === 'Created')!
    expect(createdLabel).toBeDefined()
    expect(createdLabel.nextElementSibling?.textContent).toBe(taskTime)
  })

  it('renders the goal card exactly once above the tabs with the honest empty state, and the announcement surfaces exactly once each', async () => {
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      binding: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.binding, teamId: 'team-empty-goal' },
      roster: [{ name: 'worker', role: 'writer', phase: 'active', createdAt: 1 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 },
    }
    const emptyGoalTeams = {
      schemaVersion: 1,
      binding: { rootSessionId: 'root' },
      teams: [{
        teamId: 'team-empty-goal', name: 'Empty Goal Team', phase: 'active', captainSessionId: 'root',
        displayName: 'Empty Captain', profession: 'Steward', personality: 'Calm',
        avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
        identityCard: { state: 'generated' },
        goal: { state: 'not_generated', reason: 'goal_not_set' },
        endpoints: {
          members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-empty-goal' } },
          announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-empty-goal' } },
          diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-empty-goal' } },
        },
      }],
      observedAt: 4, complete: true,
    }
    const state: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection), teams: emptyGoalTeams as never } }
    const emptyGoalController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: emptyGoalController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    const goalCard = document.querySelector<HTMLElement>('[data-swarm-goal-card]')!
    expect(goalCard).not.toBeNull()
    expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(1)
    expect(goalCard.getAttribute('data-swarm-goal-state')).toBe('not_generated')
    expect(goalCard.querySelector('[data-swarm-goal-not-set]')?.textContent).toBe('No public goal has been set yet.')
    expect(goalCard.querySelector('[data-swarm-goal-text]')).toBeNull()
    // The generated goal renders its real canonical text exactly once across the whole panel.
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
    expect(document.querySelectorAll('[data-swarm-goal-text]')).toHaveLength(1)
    expect(document.querySelector('[data-swarm-goal-text]')?.textContent).toBe('Deliver the Team UI.')
    expect(document.body.textContent!.split('Deliver the Team UI.')).toHaveLength(2)
  })
})

function activityTask(id: string, currentAttemptId: string, status: 'in_progress' | 'failed' | 'pending' = 'in_progress') {
  return { id, revision: 1, subject: id, status, blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId, createdAt: 1, updatedAt: 1 }
}
function activityAttempt(id: string, phase: 'running' | 'submitted' | 'verifying' | 'accepted' | 'rejected' | 'cancelled' | 'stale', memberName: string, updatedAt: number) {
  return { id, taskId: id.replace('attempt', 'task'), generation: 1, memberName, phase, assignmentPhase: 'delivered' as const, createdAt: 1, updatedAt }
}
function projectionForActivity({ tasks, attempts, memberPhase = 'active' }: { tasks: ReturnType<typeof activityTask>[]; attempts: ReturnType<typeof activityAttempt>[]; memberPhase?: 'provisioning' | 'active' | 'failed' | 'removed' }) {
  return { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot, roster: [{ name: 'worker', role: 'Verifier', phase: memberPhase, createdAt: 1 }], tasks, attempts, totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1, tasks: tasks.length, attempts: attempts.length } } as never
}
