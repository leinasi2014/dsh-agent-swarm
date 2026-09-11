// @vitest-environment jsdom
import { useTabInfo } from './helpers/sidebar-tab.js'
//
// Roster/Captain interaction slice — workspace-V3 contract.
//
// Pins the exact observable contract of the work-seat surface against the REAL backend
// read fixture (SWARM_READ_RPC_FIXTURES_V1) and the authoritative roster domain fields:
//   1. real member safe pixel avatar / name / profession / derived tone from the Host fixture,
//   2. an unambiguous Captain desk with the 队长 badge (never a member identity),
//   3. a single Captain-desk click routes to the bound main Chat and never leaves a second surface,
//   4. the team rail enumerates real teams[] and switches the bound Team in place through
//      controller.selectTeam (never a Captain Session jump),
//   5. an un-generated Captain identity is never impersonated by the technical Team name,
//   6. theme (official alias tokens, no hardcoded color) + en/zh copy.
import { act, useSyncExternalStore, type ReactNode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import { TeamGroupNavigation } from '../src/client/TeamGroupNavigation.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { TeamDashboardSurfaceState } from '../src/client/team-dashboard-surface-coordinator.js'
import { EMPTY_TEAM_SELECTION, type TeamWorkspaceSelection } from '../src/client/team-dashboard-surface-coordinator.js'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import { en, zh } from '../src/client/team-dashboard-locales.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    Button: ({ children, icon: _icon, ...props }: Record<string, unknown>) => react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    IconUserOutline16: () => react.createElement('svg', { 'data-icon': 'user' }), IconCodeOutline16: () => react.createElement('svg', { 'data-icon': 'code' }), IconCloseOutline16: () => react.createElement('svg', { 'data-icon': 'close' }), IconRefreshOutline16: () => react.createElement('svg', { 'data-icon': 'refresh' }),
    Pill: ({ children }: { children?: ReactNode }) => react.createElement('span', {}, children), StateDot: ({ state }: { state?: string }) => react.createElement('span', { 'data-swarm-dot': state }),
  }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mounted: Root[] = []
const t = (key: keyof typeof en, params?: Record<string, unknown>): string => en[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
const tZh = (key: keyof typeof en, params?: Record<string, unknown>): string => zh[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
const toneOf = (name: string): string | null => document.querySelector<HTMLElement>(`[data-swarm-member-name="${name}"]`)?.getAttribute('data-swarm-tone') ?? null
const activityOf = (name: string): string | null => document.querySelector<HTMLElement>(`[data-swarm-member-name="${name}"] [data-swarm-member-visible-activity]`)?.textContent ?? null

/** Real backend roster rows carrying the authoritative domain fields (name/role/phase/createdAt). */
const REAL_ROSTER = [
  { name: '海宝', role: 'Read-only auditor', phase: 'active', createdAt: 1_700_000_000_000 },
  { name: 'e\u0301clair', role: 'Component test author', phase: 'active', createdAt: 1_700_000_000_100 },
  { name: 'boot', role: 'Captain liaison', phase: 'provisioning', createdAt: 1_700_000_000_200 },
] as const

function readyWithRoster(roster: readonly typeof REAL_ROSTER[number][]) {
  const projection = {
    ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
    roster,
    totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: roster.length },
  }
  return { open: true, phase: 'ready', targetSessionId: 'main-brain', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } } as TeamDashboardState
}

class FakeCoordinator {
  private readonly selections = new Map<string, TeamWorkspaceSelection>()
  getWorkspaceSelection(binding: SwarmHostReadProjectionV1['binding']): TeamWorkspaceSelection { return this.selections.get(JSON.stringify(binding)) ?? EMPTY_TEAM_SELECTION }
  updateWorkspaceSelection(binding: SwarmHostReadProjectionV1['binding'], patch: Partial<TeamWorkspaceSelection>): void {
    const previous = this.getWorkspaceSelection(binding)
    if (Object.entries(patch).every(([key, value]) => previous[key as keyof TeamWorkspaceSelection] === value)) return
    this.selections.set(JSON.stringify(binding), { ...previous, ...patch }); this.listeners.forEach(listener => listener())
  }
  state: TeamDashboardSurfaceState = { mode: 'docked', view: 'overview', targetSessionId: 'main-brain' }
  private readonly listeners = new Set<() => void>()
  readonly observeTab = vi.fn(() => () => {}); readonly toggle = vi.fn(); readonly showToolDetails = vi.fn(); readonly closeAndRestoreFocus = vi.fn(); readonly selectView = vi.fn()
  readonly openCaptainChat = vi.fn(async (): Promise<void> => { this.set({ mode: 'inactive', view: 'overview', targetSessionId: undefined }) })
  readonly openTeamCaptain = vi.fn((captainSessionId: string): void => { this.set({ mode: 'inactive', view: 'overview', targetSessionId: captainSessionId }) })
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'en-US' => 'en-US'
  set(state: TeamDashboardSurfaceState): void { this.state = state; this.listeners.forEach(listener => listener()) }
}

type RosterController = { getSnapshot(): TeamDashboardState; subscribe(listener: () => void): () => void; selectTeam?(id: string): void }
function LeftNavigation({ controller, coordinator }: { controller: RosterController; coordinator: FakeCoordinator }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const props = { t, wide: true, expandSidebar: vi.fn(), useTeam: <T,>(selector: (value: TeamDashboardState) => T) => selector(state),
    usePanelInfo: <T,>(selector: (value: { activePanelId: null }) => T) => selector({ activePanelId: null }),
    selectGroup: (id: string) => { controller.selectTeam?.(id) }, openMain: async () => {},
    openCaptain: () => coordinator.openCaptainChat(), openMember: async () => {},
  }
  return <TeamGroupNavigation {...props as ComponentProps<typeof TeamGroupNavigation>} />
}
async function renderRoster(controller: RosterController, coordinator: FakeCoordinator, sessionId = 'main-brain'): Promise<void> {
  await render(<><LeftNavigation controller={controller} coordinator={coordinator} /><TeamDashboardDetails {...({ controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId, t } as any)} /></>)
  await act(async () => { document.querySelector<HTMLButtonElement>(`[data-swarm-group="${controller.getSnapshot().data!.projection.binding.teamId}"]`)!.click() })
}

async function selectMembers(): Promise<void> { await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="members"]')!.click() }) }
async function render(node: ReactNode): Promise<void> { const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root); await act(async () => { root.render(node) }); await selectMembers() }
afterEach(async () => { while (mounted.length) await act(async () => { mounted.pop()?.unmount() }); document.body.replaceChildren(); vi.clearAllMocks() })

describe('roster/Captain interaction slice', () => {
  it('renders each real roster member avatar initial, name, profession and derived tone from the Host fixture', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)

    // Avatars are safe deterministic pixel SVGs seeded from the real member name, carrying the
    // honest not-generated state — never a fabricated profile asset.
    const haibaoAvatar = document.querySelector<SVGElement>('[data-swarm-member-name="海宝"] [data-swarm-pixel-avatar]')!
    expect(haibaoAvatar.getAttribute('data-avatar-state')).toBe('not_generated')
    expect(haibaoAvatar.getAttribute('aria-label')).toContain('海宝')
    const eclairAvatar = document.querySelector<SVGElement>('[data-swarm-member-name="e\u0301clair"] [data-swarm-pixel-avatar]')!
    expect(eclairAvatar.getAttribute('data-avatar-state')).toBe('not_generated')
    expect(eclairAvatar.getAttribute('aria-label')).toContain('e\u0301clair')

    // Name, authoritative role and derived tone come verbatim / strictly from the fixture row.
    const member = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="海宝"]')!
    expect(member.querySelector('[data-swarm-member-visible-name]')?.textContent).toBe('海宝')
    expect(member.getAttribute('data-swarm-member-role')).toBe('Read-only auditor')
    expect(member.getAttribute('data-swarm-member-lifecycle')).toBeNull()
    expect(member.getAttribute('data-swarm-identity-state')).toBe('not_generated')
    expect(member.getAttribute('data-swarm-tone')).toBe('standby')
    expect(activityOf('海宝')).toBe(t('tone.standby'))

    // Phase-aware tone: a provisioning member shows the pending marker, not an online claim.
    expect(toneOf('boot')).toBe('pending')
    expect(activityOf('boot')).toBe(t('tone.pending'))
  })

  it('maps each work-seat tone strictly from the derived real activity across all five honest groups', async () => {
    const coordinator = new FakeCoordinator()
    const t0 = 1_700_000_000_000
    const snapshot = SWARM_READ_RPC_FIXTURES_V1.values.snapshot
    const roster = [
      { name: 'worker', role: 'Implementation', phase: 'active', createdAt: t0 },
      { name: 'acceptor', role: 'QA', phase: 'active', createdAt: t0 + 1 },
      { name: 'idler', role: 'Reviewer', phase: 'active', createdAt: t0 + 2 },
      { name: 'broken', role: 'QA', phase: 'failed', createdAt: t0 + 3 },
      { name: 'left', role: 'Ops', phase: 'removed', createdAt: t0 + 4 },
    ]
    const projection = {
      ...snapshot,
      roster,
      tasks: [
        { id: 't1', revision: 1, subject: 'Ship roster slice', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId: 'a1', createdAt: t0, updatedAt: t0 },
        { id: 't2', revision: 1, subject: 'Accept roster QA', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'acceptor', currentAttemptId: 'a2', createdAt: t0, updatedAt: t0 },
      ],
      attempts: [
        { id: 'a1', taskId: 't1', generation: 1, phase: 'running', assignmentPhase: 'delivered', memberName: 'worker', createdAt: t0, updatedAt: t0 },
        { id: 'a2', taskId: 't2', generation: 1, phase: 'accepted', assignmentPhase: 'delivered', memberName: 'acceptor', createdAt: t0, updatedAt: t0 },
      ],
      totals: { ...snapshot.totals, roster: 5, tasks: 2, attempts: 2, pendingInteractions: 0 },
    }
    const ready = { open: true, phase: 'ready', targetSessionId: 'main-brain', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } } as TeamDashboardState
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)

    // executing: an in-flight running attempt.
    expect(toneOf('worker')).toBe('executing')
    expect(activityOf('worker')).toBe(t('tone.executing'))
    // standby: idle member — a terminal attempt alone never reads as running or pending.
    expect(toneOf('idler')).toBe('standby')
    expect(activityOf('idler')).toBe(t('tone.standby'))
    // The accepted attempt is neutral, but acceptor still owns an in_progress task → pending.
    expect(toneOf('acceptor')).toBe('pending')
    // failed: authoritative failed lifecycle.
    expect(toneOf('broken')).toBe('failed')
    expect(activityOf('broken')).toBe(t('tone.failed'))
    // offline: removed member.
    expect(toneOf('left')).toBe('offline')
    expect(activityOf('left')).toBe(t('tone.offline'))
    // name, authoritative role and right-side derived tone stay intact.
    const worker = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    expect(worker.querySelector('[data-swarm-member-visible-name]')?.textContent).toBe('worker')
    expect(worker.getAttribute('data-swarm-member-role')).toBe('Implementation')
    // The statistics line derives from the SAME tone source.
    const stats = document.querySelector<HTMLElement>('[data-swarm-desk-stats]')!.textContent ?? ''
    expect(stats).toContain(`1 ${t('tone.executing')}`)
    expect(stats).toContain(`1 ${t('tone.pending')}`)
    expect(stats).toContain(`1 ${t('tone.standby')}`)
    expect(stats).toContain(`1 ${t('tone.failed')}`)
    expect(stats).toContain(`1 ${t('tone.offline')}`)
  })

  it('marks the Captain as the sole non-member work seat, first and distinct from real members', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)

    const captain = document.querySelector<HTMLButtonElement>('[data-swarm-captain-desk]')!
    // The Captain desk is unambiguous: not a member row, same 56px work-seat shape, small 队长 badge.
    expect(captain.hasAttribute('data-swarm-member-name')).toBe(false)
    expect(captain.tagName).toBe('DIV')
    expect(captain.querySelector('button')).toBeNull()
    const captainAvatar = captain.querySelector<SVGElement>('[data-swarm-pixel-avatar]')!
    expect(captainAvatar).not.toBeNull()
    expect(captainAvatar.getAttribute('data-avatar-state')).toBe('generated')
    expect(captainAvatar.getAttribute('aria-label')).toContain('Fixture Captain')
    expect(captain.title).toBe(t('captainRole'))
    expect(captain.querySelector('[data-swarm-captain-visible-name]')?.textContent).toContain('Fixture Captain')
    expect(captain.textContent).toContain('Coordinator')
    expect(captain.querySelector('.swarm-team-workspace__captain-badge')?.textContent).toBe(t('captainRole'))
    // It leads the workroom before every real member.
    const firstMember = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="海宝"]')!
    expect(captain.compareDocumentPosition(firstMember) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('never impersonates an un-generated Captain identity with the technical Team name', async () => {
    const coordinator = new FakeCoordinator()
    const ungeneratedTeams = {
      schemaVersion: 1, binding: { rootSessionId: 'root' },
      teams: [{
        teamId: 'team-fixture', name: 'Fixture Team', phase: 'active', captainSessionId: 'session-fixture',
        avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
        identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
        goal: { state: 'not_generated', reason: 'goal_not_set' },
        endpoints: {
          members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-fixture' } },
          announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-fixture' } },
          diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-fixture' } },
        },
      }],
      observedAt: 1, complete: true,
    } as const
    const state = { ...readyWithRoster([...REAL_ROSTER]), data: { ...readyWithRoster([...REAL_ROSTER]).data!, teams: ungeneratedTeams as never } }
    const controller = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await renderRoster(controller, coordinator)
    const captain = document.querySelector<HTMLButtonElement>('[data-swarm-captain-desk]')!
    expect(captain.querySelector('[data-swarm-captain-visible-name]')?.textContent).toContain(t('profileIncomplete'))
    expect(captain.textContent).not.toContain('Fixture Team')
    expect(captain.textContent).not.toContain('Fixture Captain')
    // The right roster labels the role; the left navigation owns the Session action.
    expect(captain.querySelector('[data-swarm-captain-state]')?.getAttribute('data-swarm-captain-state')).toBe(t('captainRole'))
    // Missing identity does not establish the Captain's runtime state.
    expect(captain.getAttribute('data-swarm-tone')).toBeNull()
    const openCaptain = document.querySelector<HTMLButtonElement>('[data-swarm-group-captain]')!
    expect(openCaptain.disabled).toBe(false)
    await act(async () => { openCaptain.click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
  })

  it('routes a single left Captain click from the Main Brain to the bound Captain Session without leaving a second surface', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await renderRoster(controller, coordinator)

    const captain = document.querySelector<HTMLButtonElement>('[data-swarm-group-captain]')!
    await act(async () => { captain.click(); await Promise.resolve() })

    // A single click dispatches the Captain handoff exactly once (no double navigation).
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // On handoff the Team surface yields back to the official Chat: no replacement surface,
    // no modal/fullscreen second state, and only the single complementary occupant is ever present.
    expect(coordinator.getSnapshot().mode).toBe('inactive')
    expect(document.querySelector('[role="dialog"][data-swarm-detail-overlay]')).toBeNull()
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(0)
  })

  it('labels the Captain Session as current and never performs a redundant navigation from that same Session', async () => {
    const coordinator = new FakeCoordinator()
    const base = readyWithRoster([...REAL_ROSTER])
    const ready = { ...base, targetSessionId: base.data!.projection.binding.rootSessionId }
    coordinator.state = { ...coordinator.state, targetSessionId: ready.targetSessionId }
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await renderRoster(controller, coordinator, ready.targetSessionId)

    const captain = document.querySelector<HTMLButtonElement>('[data-swarm-group-captain]')!
    expect(captain.disabled).toBe(true)
    expect(captain.getAttribute('aria-current')).toBe('page')
    expect(captain.textContent).toContain(t('captainCurrentSession'))
    expect(captain.title).toBe(`Fixture Captain · ${t('captainCurrentSessionTitle')}`)
    await act(async () => { captain.click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).not.toHaveBeenCalled()
  })

  it('localizes Captain and member copy in en and zh while the theme stays on official alias tokens with no hardcoded color', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root)

    await act(async () => { root.render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />) })
    await selectMembers()
    expect(document.querySelector('[data-swarm-captain-desk] .swarm-team-workspace__captain-badge')?.textContent).toBe('Team Captain')
    // The backend-authored captain display name is locale-independent real data.
    expect(document.body.textContent).toContain('Fixture Captain')
    expect(document.body.textContent).toContain('Team Captain')

    await act(async () => { root.render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t: tZh } as any)} />) })
    expect(document.querySelector('[data-swarm-captain-desk] .swarm-team-workspace__captain-badge')?.textContent).toBe('团队队长')
    expect(document.body.textContent).toContain('Fixture Captain')
    expect(document.body.textContent).toContain('团队队长')
    expect(document.body.textContent).toContain('活跃')
    expect(document.body.textContent).toContain('待机')

    // Theme: the whole scoped shell stylesheet colors only through official alias tokens.
    const stylesheet = document.querySelector('style')?.textContent ?? ''
    expect(stylesheet).toContain('var(--dsw-alias-bg-layer-1)')
    expect(stylesheet).toContain('var(--dsw-alias-label-primary)')
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(stylesheet).not.toMatch(/rgb\(|rgba\(|hsl\(/)
  })

  it('introduces no second source of truth and renders no Canvas: one official Details occupant, coordinator owns no data', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)

    // The surface is a plain complementary occupant of the official Details column: no canvas, no second state.
    expect(document.querySelectorAll('canvas')).toHaveLength(0)
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"][data-swarm-detail-overlay]')).toBeNull()
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    // A complementary panel is the only occupant; no overlay layer duplicates it.
    expect(document.querySelectorAll('[data-swarm-team-panel]')).toHaveLength(1)

    // Surface coordination carries only {mode, view, targetSessionId} — never Team data.
    // The single source of truth stays the Host projection owned by the controller.
    expect(Object.keys(coordinator.getSnapshot()).toSorted()).toEqual(['mode', 'targetSessionId', 'view'])
    expect(Object.hasOwn(coordinator.getSnapshot(), 'data')).toBe(false)
    expect(Object.hasOwn(coordinator.getSnapshot(), 'projection')).toBe(false)
  })

  it('keeps every left Team entry visible and never displays the old roster under a pending Team selection', async () => {
    const coordinator = new FakeCoordinator()
    // A legal multi-team result: two independent dedicated Captains, each honest not-generated assets.
    const multiTeams = {
      schemaVersion: 1, binding: { rootSessionId: 'root' },
      teams: [
        {
          teamId: 'team-alpha', name: 'Alpha 舰队', phase: 'active', captainSessionId: 'captain-alpha',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          goal: { state: 'not_generated', reason: 'goal_not_set' },
          endpoints: {
            members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-alpha' } },
          },
        },
        {
          teamId: 'team-beta', name: 'Beta Team', phase: 'active', captainSessionId: 'captain-beta',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          goal: { state: 'not_generated', reason: 'goal_not_set' },
          endpoints: {
            members: { method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team-beta' } },
            announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'root', teamId: 'team-beta' } },
            diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'root', teamId: 'team-beta' } },
          },
        },
      ],
      observedAt: 1_700_000_000_200, complete: true,
    } as const
    const base = readyWithRoster([...REAL_ROSTER])
    let ready = { ...base, data: { ...base.data!, teams: multiTeams as never,
      projection: { ...base.data!.projection, binding: { ...base.data!.projection.binding, teamId: 'team-alpha' }, team: { ...base.data!.projection.team, id: 'team-alpha', name: 'Alpha 舰队' } },
    } } as TeamDashboardState
    const accepted = ready
    const listeners = new Set<() => void>()
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, refresh: vi.fn(), reconnect: vi.fn(),
      selectTeam: vi.fn((id: string) => { ready = id === 'team-alpha' ? accepted : { ...accepted, phase: 'reconnecting', pendingTeamId: id }; listeners.forEach(listener => listener()) }) }
    await renderRoster(controller, coordinator)
    controller.selectTeam.mockClear()

    expect(document.querySelector('[data-swarm-team-rail]')).toBeNull()
    expect([...document.querySelectorAll('[data-swarm-group]')].map(entry => entry.getAttribute('data-swarm-group'))).toEqual(['team-alpha', 'team-beta'])
    const navigation = document.querySelector('[data-swarm-group-navigation]')!
    const toggle = (id: string) => navigation.querySelector<HTMLButtonElement>(`[data-swarm-group="${id}"]`)!
    expect(toggle('team-alpha').textContent).toContain('Alpha 舰队')
    expect(toggle('team-alpha').getAttribute('aria-expanded')).toBe('true')

    // Selecting another Team switches the CURRENT sidebar through
    // controller.selectTeam exactly once — it never opens or jumps to a Captain Session.
    await act(async () => { toggle('team-beta').click() })
    expect(controller.selectTeam).toHaveBeenCalledTimes(1)
    expect(controller.selectTeam).toHaveBeenCalledWith('team-beta')
    expect(coordinator.openTeamCaptain).not.toHaveBeenCalled()
    expect(coordinator.openCaptainChat).not.toHaveBeenCalled()
    // No surface jump: the Team panel remains the single docked occupant; the Main Brain is never
    // replaced and no second fullscreen/second source of truth is ever introduced.
    expect(coordinator.getSnapshot().mode).toBe('docked')
    expect(coordinator.getSnapshot().targetSessionId).toBe('main-brain')
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.querySelector('[role="dialog"][data-swarm-detail-overlay]')).toBeNull()
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(1)
    expect(document.querySelector('[data-swarm-member-name]')).toBeNull()
    expect(document.querySelector('[data-swarm-group-member]')).toBeNull()
    expect(document.querySelector('[data-swarm-empty-shell] [role="status"]')).not.toBeNull()
    await act(async () => { ready = { ...ready, phase: 'stale', error: { code: 'FAILED_B', message: 'Team B unavailable' } }; listeners.forEach(listener => listener()) })
    expect(document.querySelector('[data-swarm-member-name]')).toBeNull()
    expect(document.querySelector('[data-swarm-group-member]')).toBeNull()
    expect(document.querySelector('[data-swarm-empty-shell]')?.textContent).toContain('Team B unavailable')
    // Returning to the still-visible previous card cancels the pending choice.
    await act(async () => { toggle('team-alpha').click() })
    expect(controller.selectTeam).toHaveBeenLastCalledWith('team-alpha')
    expect(toggle('team-beta').getAttribute('aria-expanded')).toBe('false')
    await selectMembers()
    expect(document.querySelector('[data-swarm-workroom] [data-swarm-member-name="海宝"]')).not.toBeNull()
  })
})
