// @vitest-environment jsdom
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: populated, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
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
      // Execution summaries cap at 2, team activity caps at 3.
      expect(document.querySelectorAll('[data-swarm-exec-summaries] [data-swarm-summary-task]')).toHaveLength(2)
      expect(document.querySelectorAll('[data-swarm-team-activity] [data-swarm-activity-attempt]')).toHaveLength(3)
      // Layout geometry: two-column 56px desks above 520px, single column at ≤520px via container query.
      expect(stylesheet).toMatch(/__workroom \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u)
      expect(stylesheet).toContain('@container (max-width: 520px) { [data-swarm-team-dashboard] .swarm-team-workspace__workroom { grid-template-columns:1fr; } }')
      expect(stylesheet).toMatch(/__desk \{[^}]*min-block-size:56px/u)
      expect(stylesheet).toMatch(/__desk \.swarm-team-workspace__avatar \{ grid-row:1 \/ 3/u)
      expect(stylesheet).toMatch(/__avatar \{[^}]*inline-size:32px/u)
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

  it('renders four mutually exclusive tab views with correct tablist/tab/tabpanel semantics and keyboard support', async () => {
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    const tablist = document.querySelector<HTMLElement>('[data-swarm-view-tabs]')!
    expect(tablist.getAttribute('role')).toBe('tablist')
    const tabs = [...document.querySelectorAll('[data-swarm-view-tab]')]
    expect(tabs.map(tab => tab.getAttribute('data-swarm-view-tab'))).toEqual(['workspace', 'tasks', 'notices', 'manage'])
    expect(activePanel()).toBe('workspace')
    expect(tabButton('workspace').getAttribute('aria-selected')).toBe('true')
    // Tasks view replaces the workspace panel (mutually exclusive).
    await act(async () => { tabButton('tasks').click() })
    expect(activePanel()).toBe('tasks')
    expect(document.querySelector('[data-swarm-panel="workspace"]')).toBeNull()
    expect(document.querySelectorAll('[data-swarm-task-rows] [data-swarm-task-id]')).toHaveLength(0)
    expect(document.querySelector('[data-swarm-task-empty]')).not.toBeNull()
    // Notices view: exactly one full announcement list; the goal card still exists exactly once.
    await act(async () => { tabButton('notices').click() })
    expect(activePanel()).toBe('notices')
    expect(document.querySelectorAll('[data-swarm-announcements-list]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-swarm-announcement-entry]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Welcome to the Fixture Team.')
    expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(1)
    // Manage view: the four honest management entries.
    await act(async () => { tabButton('manage').click() })
    expect(activePanel()).toBe('manage')
    expect(document.querySelector('[data-swarm-manage-members]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-manage-growth]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-manage-overview]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-manage-diagnostics]')).not.toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-manage-overview] button')!.click() })
    expect(document.querySelector('[data-swarm-overview-metrics]')).not.toBeNull()
    await pressEscape()
    // Arrow-key navigation wraps across the four tabs.
    tabButton('manage').focus()
    await act(async () => { tabButton('manage').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(tabButton('workspace'))
    await act(async () => { tabButton('workspace').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(document.activeElement).toBe(tabButton('manage'))
    // Overview/growth/diagnostics overlays are real read projections.
    await act(async () => { tabButton('manage').click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-manage-diagnostics] button')!.click() })
    const overlay = detailOverlay()!
    expect(overlay.querySelector('[data-swarm-diagnostics-detail]')?.textContent).toContain('session-fixture')
    expect(overlay.querySelector('[data-swarm-diagnostics-detail]')?.textContent).toContain('team-domain')
    await pressEscape()
    // Member management routes through the official Captain chat seam.
    await act(async () => { document.querySelector<HTMLElement>('[data-swarm-manage-members] button')!.click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
  })

  it('derives the title-bar Team selector from the real teams[] enumeration and switches Teams in place via controller.selectTeam; never jumps to a Captain Session', async () => {
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: railController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // Teams deduplicate by teamId. The title-bar selector contains the live
    // authority IDs but does not take a permanent slice from the Details panel.
    expect(document.querySelector('[data-swarm-team-rail]')).toBeNull()
    const selector = document.querySelector<HTMLSelectElement>('[data-swarm-team-switcher]')!
    expect([...selector.options].map(option => option.value)).toEqual(['team-alpha', 'team-beta'])
    expect(selector.value).toBe('team-alpha')
    await act(async () => { selector.value = 'team-alpha'; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(railController.selectTeam).not.toHaveBeenCalled()
    // Another Team selection switches the CURRENT sidebar through controller.selectTeam
    // with its real id — it never opens or jumps to any Captain Session.
    await act(async () => { selector.value = 'team-beta'; selector.dispatchEvent(new Event('change', { bubbles: true })) })
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
    expect(document.querySelector<HTMLSelectElement>('[data-swarm-team-switcher]')!.value).toBe('team-beta')
    expect(document.querySelector<HTMLElement>('.swarm-team-workspace__title')?.textContent).toBe('Beta Team')
    expect(document.querySelector<HTMLElement>('[data-swarm-goal-text]')?.textContent).toBe('Beta team goal')
    // The Captain conversation entry stays on the selected Team's Captain desk and still routes
    // through the official Captain Chat seam exactly once.
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-captain-desk]')!).click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // Zero Teams renders an honest empty rail, never a fabricated dot.
    const emptyState: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, SWARM_READ_RPC_FIXTURES_V1.values.snapshot), teams: { ...multiTeams, teams: [] } as never } }
    const emptyController = { getSnapshot: (): TeamDashboardState => emptyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn(), selectTeam: vi.fn() }
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: emptyController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: longNameController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    await act(async () => { tabButton('tasks').click() })
    const owner = document.querySelector<HTMLElement>('[data-swarm-task-owner]')!
    expect(owner.getAttribute('data-swarm-task-owner')).toBe(`Owner: ${memberName}`)
    expect(owner.getAttribute('title')).toBe(`Owner: ${memberName}`)
    const stylesheet = document.querySelector('style')?.textContent ?? ''
    expect(stylesheet).toMatch(/__table-copy strong \{ overflow:hidden; font-size:11px; white-space:nowrap; text-overflow:ellipsis/u)
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-task-id="task-long-name"]')!.click() })
    const overlay = detailOverlay()!
    expect(overlay.querySelector('[data-swarm-task-detail]')?.textContent).toContain('Owner')
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: historyController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: activityController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: liveController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
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
    const facts = [...detailOverlay()!.querySelectorAll('.swarm-team-workspace__fact')]
    const createdFact = facts.find(fact => fact.textContent!.includes(taskTime))!
    expect(createdFact).toBeDefined()
    expect(createdFact.querySelector('dt')?.textContent).toBe('Created')
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: emptyGoalController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    const goalCard = document.querySelector<HTMLElement>('[data-swarm-goal-card]')!
    expect(goalCard).not.toBeNull()
    expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(1)
    expect(goalCard.getAttribute('data-swarm-goal-state')).toBe('not_generated')
    expect(goalCard.querySelector('[data-swarm-goal-not-set]')?.textContent).toBe('No public goal has been set yet.')
    expect(goalCard.querySelector('[data-swarm-goal-text]')).toBeNull()
    // The generated goal renders its real canonical text exactly once across the whole panel.
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
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
