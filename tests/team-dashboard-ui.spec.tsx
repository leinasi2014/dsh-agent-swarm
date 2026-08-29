// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { TeamDashboardAction } from '../src/client/TeamDashboardAction.js'
import { deriveMemberActivity, memberRosterInitial, shellCss, TEAM_WORKSPACE_WIDE_MIN_WIDTH, teamWorkspaceLayoutForWidth } from '../src/client/TeamDashboardContent.js'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardData, TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { en, zh } from '../src/client/team-dashboard-locales.js'
import type { TeamDashboardSurfaceState } from '../src/client/team-dashboard-surface-coordinator.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    Button: ({ children, icon: _icon, ...props }: Record<string, unknown>) => react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    IconUserOutline16: () => react.createElement('svg', { 'data-icon': 'user' }), IconCodeOutline16: () => react.createElement('svg', { 'data-icon': 'code' }), IconCloseOutline16: () => react.createElement('svg', { 'data-icon': 'close' }), IconRefreshOutline16: () => react.createElement('svg', { 'data-icon': 'refresh' }),
    Pill: ({ children }: { children?: ReactNode }) => react.createElement('span', {}, children), StateDot: () => react.createElement('span', {}),
  }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: Root[] = []
const t = (key: keyof typeof en, params?: Record<string, unknown>): string => en[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
const tZh = (key: keyof typeof en, params?: Record<string, unknown>): string => zh[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
const ready: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'root', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: SWARM_READ_RPC_FIXTURES_V1.values.snapshot as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } }
const teamData = (capabilities: unknown, projection: unknown): TeamDashboardData => ({
  capabilities: capabilities as never,
  projection: projection as never,
  teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never,
  captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never,
  captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never,
  captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never,
})

class FakeCoordinator {
  state: TeamDashboardSurfaceState = { mode: 'docked', view: 'overview', targetSessionId: 'root' }
  private readonly listeners = new Set<() => void>()
  readonly toggle = vi.fn(); readonly showToolDetails = vi.fn(); readonly openCaptainChat = vi.fn(async () => {}); readonly closeAndRestoreFocus = vi.fn(); readonly selectView = vi.fn(); readonly openTeamCaptain = vi.fn()
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'en-US' => 'en-US'
  set(state: TeamDashboardSurfaceState): void { this.state = state; this.listeners.forEach(listener => listener()) }
}
const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
async function render(node: ReactNode): Promise<void> { const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root); await act(async () => { root.render(node) }) }
afterEach(async () => { while (mounted.length) await act(async () => { mounted.pop()?.unmount() }); document.body.replaceChildren(); vi.clearAllMocks() })

describe('R3 native Team Details surface', () => {
  it('places an icon Team toggle in the official Session utility contract with correct aria state', async () => {
    const coordinator = new FakeCoordinator(); const anchorRef = { current: null }
    await render(<TeamDashboardAction {...({ anchorRef, coordinator, sessionId: 'root', t } as any)} />)
    const team = document.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')!
    expect(team.getAttribute('aria-expanded')).toBe('true'); expect(team.querySelector('[data-icon="user"]')).not.toBeNull()
    await act(async () => { team.click() }); expect(coordinator.toggle).toHaveBeenCalledWith('root')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-tool-trigger]')?.click() }); expect(coordinator.showToolDetails).toHaveBeenCalledTimes(1)
    await act(async () => { coordinator.set({ mode: 'inactive', view: 'overview', targetSessionId: undefined }) })
    expect(team.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses the unique public Details occupant, not an overlay/modal/fullscreen fallback', async () => {
    const coordinator = new FakeCoordinator(); const common = { anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t }
    await render(<TeamDashboardDetails {...(common as any)} />)
    const panel = document.querySelector<HTMLElement>('[role="complementary"][data-swarm-team-panel]')!
    expect(panel.textContent).toContain('Fixture Team'); expect(panel.textContent).toContain('Active')
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.body.innerHTML).toContain('--dsw-alias-bg-layer-1')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Return to main Chat')?.click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
  })

  describe('real-browser media-query geometry (Playwright, actual exported shellCss)', () => {
    let browser: Browser
    let page: Page

    beforeAll(async () => {
      browser = await chromium.launch({ channel: 'msedge', headless: true })
      page = await browser.newPage()
    }, 120_000)

    afterAll(async () => {
      await page?.close()
      await browser?.close()
    })

    async function mountPanelAt(width: number): Promise<void> {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<!doctype html><html><head><style>${shellCss}</style></head><body>
        <div data-swarm-team-dashboard data-swarm-team-panel><button data-swarm-member-name="worker" type="button" style="width:140px;height:32px">worker</button></div>
      </body></html>`)
    }

    async function panelComputed(): Promise<{ position: string; top: string; right: string; bottom: string; left: string; rect: { x: number; y: number; width: number; height: number } | null; memberBox: { x: number; y: number; width: number; height: number } | null; innerWidth: number; innerHeight: number }> {
      return page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[data-swarm-team-panel]')
        const member = document.querySelector<HTMLElement>('[data-swarm-member-name="worker"]')
        const cs = panel === null ? null : getComputedStyle(panel)
        const rect = panel?.getBoundingClientRect() ?? null
        const memberBox = member?.getBoundingClientRect() ?? null
        return {
          position: cs?.position ?? 'missing',
          top: cs?.top ?? '', right: cs?.right ?? '', bottom: cs?.bottom ?? '', left: cs?.left ?? '',
          rect: rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          memberBox: memberBox === null ? null : { x: memberBox.x, y: memberBox.y, width: memberBox.width, height: memberBox.height },
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        }
      })
    }

    it.each([813, 995] as const)('%spx: Team panel computed position=fixed with all four insets 0, fully covering the viewport (overlay), member button in-viewport and clickable', async (width) => {
      await mountPanelAt(width)
      const g = await panelComputed()
      expect(g.position).toBe('fixed')
      expect(g.top).toBe('0px'); expect(g.right).toBe('0px'); expect(g.bottom).toBe('0px'); expect(g.left).toBe('0px')
      expect(g.rect).not.toBeNull()
      expect(g.rect!.x).toBeCloseTo(0, 5); expect(g.rect!.y).toBeCloseTo(0, 5)
      expect(g.rect!.width).toBeCloseTo(width, 5); expect(g.rect!.height).toBeCloseTo(800, 5)
      expect(g.memberBox).not.toBeNull()
      const mb = g.memberBox!
      expect(mb.x).toBeGreaterThanOrEqual(0); expect(mb.y).toBeGreaterThanOrEqual(0)
      expect(mb.x + mb.width).toBeLessThanOrEqual(g.innerWidth); expect(mb.y + mb.height).toBeLessThanOrEqual(g.innerHeight)
      await page.click('[data-swarm-member-name="worker"]')
    })

    it.each([996, 1280] as const)('%spx: Team panel stays computed position=static on the official dock/desktop-collapse path (media query not matched), member button in-viewport and clickable', async (width) => {
      await mountPanelAt(width)
      const g = await panelComputed()
      expect(g.position).toBe('static')
      expect(g.memberBox).not.toBeNull()
      const mb = g.memberBox!
      expect(mb.x).toBeGreaterThanOrEqual(0); expect(mb.y).toBeGreaterThanOrEqual(0)
      expect(mb.x + mb.width).toBeLessThanOrEqual(g.innerWidth); expect(mb.y + mb.height).toBeLessThanOrEqual(g.innerHeight)
      await page.click('[data-swarm-member-name="worker"]')
    })
  })

  it('renders real error/stale authority signals and retry without claiming a fresh projection', async () => {
    const coordinator = new FakeCoordinator()
    const errorState: TeamDashboardState = { open: true, phase: 'error', targetSessionId: 'missing', error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'not live' } }
    const errorController = { getSnapshot: (): TeamDashboardState => errorState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: errorController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('SWARM_RPC_TARGET_NOT_LIVE')
    // The real error message must be visible inline, not hidden only in a tooltip.
    expect(alert.textContent).toContain('not live')
    // The inline message is visually bounded by the scoped Team Workspace stylesheet.
    const messageSpan = alert.querySelector<HTMLElement>('span[title*="not live"]')!
    expect(messageSpan.className).toContain('swarm-team-workspace__error')
    expect(document.querySelector('style')?.textContent).toContain('text-overflow:ellipsis')
    expect(messageSpan.getAttribute('title')).toBe('SWARM_RPC_TARGET_NOT_LIVE: not live')
    // Missing authority keeps the same roster-first product shell, but does not invent Team rows.
    expect(document.querySelector('[data-swarm-empty-shell]')).not.toBeNull()
    expect(document.querySelectorAll('[data-swarm-member-name]')).toHaveLength(0)
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')?.click() })
    expect(errorController.reconnect).toHaveBeenCalledTimes(1)
  })

  it('surfaces SWARM_UI_READ_FAILED from a failed Host projection as an explicit, diagnosable error state, never a silent panel', async () => {
    const coordinator = new FakeCoordinator()
    const readFailedState: TeamDashboardState = { open: true, phase: 'error', targetSessionId: 'root', error: { code: 'SWARM_UI_READ_FAILED', message: 'read-plus: fetch failed' } }
    const failedController = { getSnapshot: (): TeamDashboardState => readFailedState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: failedController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // The panel is present and tagged with the failing phase, so the error is observable in the DOM.
    const panel = document.querySelector<HTMLElement>('[data-swarm-team-panel][data-phase="error"]')!
    expect(panel).not.toBeNull()
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('SWARM_UI_READ_FAILED')
    expect(alert.textContent).toContain('read-plus: fetch failed')
    // The shared empty shell is visible, while no member or task projection is fabricated.
    expect(document.querySelector('[data-swarm-empty-shell]')).not.toBeNull()
    expect(document.querySelectorAll('[data-swarm-member-name], [data-swarm-task-rows]')).toHaveLength(0)
    // Exactly one honest error state card: no duplicated placeholder roster/goal cards.
    const emptyStates = document.querySelectorAll('[data-swarm-empty-shell] [data-swarm-empty-state]')
    expect(emptyStates).toHaveLength(1)
    expect(emptyStates[0]!.textContent).toContain('Team status is unavailable.')
    expect(document.querySelectorAll('[data-swarm-empty-shell] [data-swarm-empty-person], [data-swarm-empty-shell] [data-swarm-goal-unavailable]')).toHaveLength(0)
    // The full code+message is preserved in the boundary-specifying title for copy/debug.
    const messageSpan = alert.querySelector<HTMLElement>('span[title*="read-plus"]')!
    expect(messageSpan.getAttribute('title')).toBe('SWARM_UI_READ_FAILED: read-plus: fetch failed')
    // Retry explicitly reconnects instead of pretending a fresh projection is ready.
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')?.click() })
    expect(failedController.reconnect).toHaveBeenCalledTimes(1)
  })

  it('presents a long member role visually bounded while preserving its full authoritative value', async () => {
    const coordinator = new FakeCoordinator(); coordinator.state = { mode: 'docked', view: 'members', targetSessionId: 'root' }
    const longRole = '开发 writer（仅负责本 P0）：修复 SWARM_UI_READ_FAILED。在受管 lane p0-swarm-ui-read-v2（pnpm isolation open，owner terra-p0）内实施：契约一致（role 上限有界提升并同步 CONTRACT_DIGEST）'.repeat(6)
    expect(longRole.length).toBeGreaterThan(256)
    const projection = { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot, roster: [{ name: 'worker', role: longRole, phase: 'active', createdAt: 1_700_000_000_000 }], totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 } }
    const readyState: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'root', data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const longRoleController = { getSnapshot: (): TeamDashboardState => readyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: longRoleController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // The member row's role element (scoped: the identity card above the roster also truncates a title'd role).
    const secondary = document.querySelector<HTMLElement>('[data-swarm-member-name] small.swarm-team-workspace__truncate[title]')!
    // The full authoritative role is preserved for inspection, never truncated/cut.
    expect(secondary.getAttribute('title')).toBe(longRole)
    // The visible rendering is bounded by the shared truncation class so the panel does not grow unboundedly.
    expect(secondary.className).toContain('swarm-team-workspace__truncate')
    expect(document.querySelector('style')?.textContent).toContain('white-space:nowrap')
  })

  it('rerenders the mounted Details body with official locale copy and mapped enums', async () => {
    const coordinator = new FakeCoordinator(); const common = { anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root' }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root)
    await act(async () => { root.render(<TeamDashboardDetails {...({ ...common, t } as any)} />) })
    expect(document.body.textContent).toContain('Read-only Team workspace for this main Chat.')
    await act(async () => { root.render(<TeamDashboardDetails {...({ ...common, t: tZh } as any)} />) })
    expect(document.body.textContent).toContain('当前主聊天的只读团队工作区。'); expect(document.body.textContent).toContain('活跃')
  })

  it('derives display-only initials from an NFC grapheme cluster without storing a profile', () => {
    expect(memberRosterInitial('e\u0301clair')).toBe('é')
    expect(memberRosterInitial('👩🏽‍💻 builder')).toBe('👩🏽‍💻')
  })

  it('keeps the active roster authoritative, labels no current task, and returns from a removed selected member', async () => {
    const coordinator = new FakeCoordinator()
    let projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1 }],
      tasks: [], attempts: [],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 101, tasks: 0, attempts: 0 },
      truncated: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.truncated, roster: true },
    }
    let dynamicState: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const dynamicController = {
      getSnapshot: (): TeamDashboardState => dynamicState,
      subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn(),
    }
    const common = { anchorRef: { current: null }, controller: dynamicController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root)
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    expect(document.body.textContent).toContain('No current task')
    expect(document.body.textContent).toContain('Host roster is truncated (up to the first 100): showing 1 of 101 members.')
    const memberTrigger = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    memberTrigger.focus()
    await act(async () => { memberTrigger.click() })
    expect(document.body.textContent).toContain('Back to members')
    const memberHeading = document.querySelector<HTMLHeadingElement>('h4[tabindex="-1"]')!
    expect(document.activeElement).toBe(memberHeading)
    projection = { ...projection, roster: [], totals: { ...projection.totals, roster: 0 } }
    dynamicState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    expect(document.body.textContent).toContain('worker is no longer in this Team. Returning to members.')
    expect(document.activeElement).toBe(document.querySelector('.swarm-team-workspace__roster h3'))
    expect(document.querySelector('[data-swarm-roster-members-label]')?.textContent).toContain('Members · 0')
  })

  it('moves keyboard focus into member/task detail, restores its logical trigger, and recovers from a removed task', async () => {
    const coordinator = new FakeCoordinator()
    let projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1 }],
      tasks: [{ id: 'task-1', revision: 1, subject: 'Check focus recovery', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId: 'attempt-1', createdAt: 1, updatedAt: 2 }],
      attempts: [{ id: 'attempt-1', taskId: 'task-1', generation: 1, memberName: 'worker', phase: 'running', assignmentPhase: 'delivered', createdAt: 1, updatedAt: 2 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1, tasks: 1, attempts: 1 },
    }
    let dynamicState: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const dynamicController = { getSnapshot: (): TeamDashboardState => dynamicState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const common = { anchorRef: { current: null }, controller: dynamicController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root)
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })

    const member = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    member.focus()
    await act(async () => { member.click() })
    expect(document.activeElement?.textContent).toBe('Member: worker')
    const backToMembers = [...document.querySelectorAll('button')].find(button => button.textContent === 'Back to members')!
    backToMembers.focus()
    await act(async () => { backToMembers.click() })
    expect(document.activeElement).toBe(document.querySelector('[data-swarm-member-name="worker"]'))

    const taskSummary = document.querySelector<HTMLElement>('details.swarm-team-workspace__collapsible summary')!
    await act(async () => { taskSummary.click() })
    const task = [...document.querySelectorAll<HTMLButtonElement>('.swarm-team-workspace__rows button')].find(button => button.dataset.swarmMemberName === undefined && button.textContent?.includes('Check focus recovery'))!
    task.focus()
    await act(async () => { task.click() })
    expect(document.activeElement?.textContent).toBe('Task: Check focus recovery')
    const backToTasks = [...document.querySelectorAll('button')].find(button => button.textContent === 'Back to tasks')!
    backToTasks.focus()
    await act(async () => { backToTasks.click() })
    expect(document.activeElement).toBe([...document.querySelectorAll<HTMLButtonElement>('.swarm-team-workspace__rows button')].find(button => button.dataset.swarmMemberName === undefined && button.textContent?.includes('Check focus recovery')))

    const selectedTask = [...document.querySelectorAll<HTMLButtonElement>('.swarm-team-workspace__rows button')].find(button => button.dataset.swarmMemberName === undefined && button.textContent?.includes('Check focus recovery'))!
    await act(async () => { selectedTask.click() })
    projection = { ...projection, tasks: [], attempts: [], totals: { ...projection.totals, tasks: 0, attempts: 0 } }
    dynamicState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    expect(document.body.textContent).toContain('The selected task is no longer in this Team. Returning to tasks.')
    expect(document.activeElement).toBe(taskSummary)
    expect(taskSummary.textContent).toBe('Tasks')
  })

  it('keeps the compact roster-first rail at 359 and really switches to the wide three-region structure at 720', async () => {
    const observers: TestResizeObserver[] = []
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
      disconnect = vi.fn()
      observe = vi.fn()
      emit(target: Element, width: number): void {
        this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver })
    const coordinator = new FakeCoordinator(); coordinator.state = { mode: 'docked', view: 'members', targetSessionId: 'root' }
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1_700_000_000_000 }],
      tasks: [{ id: 'task-1', revision: 1, subject: 'Check the panel', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId: 'attempt-1', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100 }],
      attempts: [{ id: 'attempt-1', taskId: 'task-1', generation: 1, memberName: 'worker', phase: 'running', assignmentPhase: 'delivered', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1, tasks: 1, attempts: 1 },
    }
    const populatedState: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const populated = { getSnapshot: (): TeamDashboardState => populatedState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    try {
      await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: populated, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
      const workspace = document.querySelector<HTMLElement>('.swarm-team-workspace')!
      const rail = document.querySelector<HTMLElement>('[data-swarm-team-rail]')!
      const stylesheet = document.querySelector('style')?.textContent ?? ''
      // One rail with the wireframe's three real internal regions: team/members · tasks/announcements · details/diagnostics.
      expect(document.querySelectorAll('[data-swarm-team-panel] [data-swarm-team-rail]')).toHaveLength(1)
      const regions = [...document.querySelectorAll<HTMLElement>('[data-swarm-team-rail] [data-swarm-rail-region]')]
      expect(regions.map(region => region.getAttribute('data-swarm-rail-region'))).toEqual(['team', 'work', 'detail'])
      // No duplicate Captain/Team identity blocks on the Main Brain first screen: exactly one pinned
      // Captain row, no switcher, no browser nav, no identity card, no enumerated Team list.
      expect(document.querySelectorAll('[data-swarm-captain-row]')).toHaveLength(1)
      expect(document.querySelector('[data-swarm-team-switcher]')).toBeNull()
      expect(document.querySelector('[data-swarm-browser-nav]')).toBeNull()
      expect(document.querySelector('[data-swarm-team-rail] [data-swarm-identity-card]')).toBeNull()
      expect(document.querySelector('[data-swarm-captain-list]')).toBeNull()
      // Exactly one compact Team overview carrying the durable public goal; no board goal card here.
      expect(document.querySelectorAll('[data-swarm-team-overview]')).toHaveLength(1)
      const overview = document.querySelector<HTMLElement>('[data-swarm-team-overview]')!
      expect(overview.getAttribute('data-swarm-goal-state')).toBe('generated')
      expect(overview.querySelector('[data-swarm-overview-goal-text]')?.textContent).toBe('Deliver the Team UI.')
      expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(0)
      // All six foldables (tasks/announcements/overview/budget/capabilities/diagnostics) are default-closed in compact.
      const folded = [...document.querySelectorAll<HTMLDetailsElement>('[data-swarm-team-panel] [data-swarm-team-rail] details')]
      expect(folded).toHaveLength(6)
      expect(folded.every(detail => detail.open === false)).toBe(true)
      expect(document.querySelector('[data-swarm-budget]')).not.toBeNull()
      expect(document.querySelector('[data-swarm-capabilities]')).not.toBeNull()
      // Diagnostics is a flat default-closed details (parent not DETAILS), never nested.
      const diagnostics = document.querySelector('[data-swarm-team-rail] details.swarm-team-workspace__diagnostics')!
      expect(diagnostics.hasAttribute('data-swarm-diagnostics-fold')).toBe(true)
      expect((diagnostics as HTMLDetailsElement).open).toBe(false)
      expect(diagnostics.parentElement?.tagName).not.toBe('DETAILS')
      expect(document.querySelectorAll('details details.swarm-team-workspace__diagnostics')).toHaveLength(0)
      expect(observers).toHaveLength(1)
      expect(workspace.dataset.swarmTeamLayout).toBe('compact')
      // This is a component contract, not a jsdom geometry claim. Browser-proof owns geometry acceptance.
      expect(stylesheet).toContain('container-type:inline-size')
      // The rail is a compact centered single column; the wide branch really switches to the 3-region grid.
      expect(stylesheet).toContain('.swarm-team-workspace__rail { width:100%; max-width:380px; margin-inline:auto')
      expect(stylesheet).toMatch(/__regions \{ display:flex; flex-direction:column/u)
      expect(stylesheet).toContain('[data-swarm-rail-layout="wide"] .swarm-team-workspace__regions { display:grid; grid-template-columns:repeat(3,minmax(0,1fr))')
      // Compact QQ/WeChat-group metrics: 28px member avatar, 48px member rows, 52px pinned Captain row, 12px rail body.
      expect(stylesheet).toMatch(/__avatar \{[^}]*inline-size:28px/u)
      expect(stylesheet).toContain('grid-template-columns:28px minmax(0,1fr) auto')
      expect(stylesheet).toContain('min-block-size:48px')
      expect(stylesheet).toContain('grid-template-columns:32px minmax(0,1fr) auto')
      expect(stylesheet).toMatch(/__captain-hero \{[^}]*min-block-size:52px/u)
      expect(stylesheet).toMatch(/__rail \{[^}]*font-size:12px/u)
      expect(stylesheet).toMatch(/@media \(max-width: 430px\).*white-space:nowrap/mu)
      expect(teamWorkspaceLayoutForWidth(359)).toBe('compact')
      await act(async () => { observers[0]?.emit(workspace, 359) })
      expect(rail.getAttribute('data-swarm-rail-layout')).toBe('compact')
      expect(teamWorkspaceLayoutForWidth(TEAM_WORKSPACE_WIDE_MIN_WIDTH)).toBe('wide')
      await act(async () => { observers[0]?.emit(workspace, 720) })
      expect(rail.getAttribute('data-swarm-rail-layout')).toBe('wide')
      // Wide mode really opens the work region (tasks + announcements) while diagnostics stay folded.
      expect(document.querySelector<HTMLDetailsElement>('[data-swarm-tasks-fold]')!.open).toBe(true)
      const announcementsFold = document.querySelector<HTMLDetailsElement>('[data-swarm-announcements-fold]')!
      expect(announcementsFold.open).toBe(true)
      expect(announcementsFold.querySelectorAll('[data-swarm-announcement-entry]')).toHaveLength(1)
      expect((document.querySelector('[data-swarm-diagnostics-fold]') as HTMLDetailsElement).open).toBe(false)
      // Roster-first: the single pinned Captain hero precedes every real member.
      const captain = document.querySelector<HTMLButtonElement>('[data-swarm-captain-row]')!
      const member = document.querySelector<HTMLButtonElement>('.swarm-team-workspace__rows button')!
      expect(captain.compareDocumentPosition(member) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(captain.querySelector('[data-swarm-pixel-avatar]')?.getAttribute('data-avatar-state')).toBe('generated')
      expect(captain.textContent).toContain('Fixture Captain')
      expect(captain.textContent).toContain('Coordinator')
      expect(captain.querySelector('.swarm-team-workspace__captain-badge')?.textContent).toBe('Team Captain')
      expect(captain.textContent).not.toContain('session-fixture')
      const memberAvatar = member.querySelector('[data-swarm-pixel-avatar]')
      expect(memberAvatar?.getAttribute('data-avatar-state')).toBe('not_generated')
      expect(memberAvatar?.getAttribute('aria-label')).toContain('worker')
      expect(member.querySelector('[data-swarm-member-visible-lifecycle]')).toBeNull()
      expect(member.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Running')
      expect(member.querySelector('[data-swarm-task-owner]')).toBeNull()
      // A single Captain-row click routes to the dedicated Captain Chat via the coordinator.
      await act(async () => { captain.click(); await Promise.resolve() })
      expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver })
    }
  })

  it('opens the Dedicated Captain page from its tab, keeps Captain identity details there, and returns to the roster', async () => {
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1_700_000_000_000 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 },
    }
    const state: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const mgmtController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: mgmtController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // The Main Brain rail shows no Captain identity card and no enumerated Team list.
    expect(document.querySelector('[data-swarm-identity-card]')).toBeNull()
    expect(document.querySelector('[data-swarm-captain-page]')).toBeNull()
    expect(document.querySelector('[data-swarm-management-entry]')).toBeNull()
    // Opening the Dedicated Captain page swaps the rail content (not stacked on the roster).
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    const page = document.querySelector<HTMLElement>('[data-swarm-captain-page]')!
    expect(page).not.toBeNull()
    expect(page.textContent).toContain('Dedicated Captain')
    // Captain identity detail lives HERE: real generated values, personality included, and no
    // unconditional "onboarding incomplete" banner next to an already generated profile.
    expect(page.querySelector('[data-swarm-identity-card]')?.textContent).toContain('Fixture Captain')
    expect(page.querySelector('[data-swarm-identity-profession]')?.textContent).toContain('Coordinator')
    expect(page.querySelector('[data-swarm-identity-personality]')?.textContent).toContain('Steady')
    expect(page.querySelector('[data-swarm-identity-incomplete]')).toBeNull()
    // The generated identity badge reads "Generated", not the not-generated marker.
    expect(page.querySelector('[data-swarm-identity-badge]')?.textContent).toBe('Generated')
    expect(page.querySelector('[data-swarm-identity-badge]')?.getAttribute('data-swarm-identity-badge-state')).toBe('generated')
    // The compact management entry lives HERE (never on the Main Brain first screen) and opens the
    // independent management surface; its back returns to the roster.
    const entry = page.querySelector<HTMLButtonElement>('[data-swarm-management-entry]')!
    expect(entry).not.toBeNull()
    await act(async () => { entry.click() })
    expect(document.querySelector('[data-swarm-management-view]')!.textContent).toContain('Team management')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Back to Team roster')!.click() })
    expect(document.querySelector('[data-swarm-management-view]')).toBeNull()
    expect(document.querySelector('.swarm-team-workspace__roster')).not.toBeNull()
    // The explicit chat handoff stays on the page.
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-captain-page-open]')!).click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // zh locale carries the honest generated badge copy.
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: mgmtController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t: tZh } as any)} />)
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    expect(document.querySelector('[data-swarm-captain-page] [data-swarm-identity-badge]')?.textContent).toBe('已生成')
    // Back returns to the roster-first rail; the captain page is removed.
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '返回成员列表')!.click() })
    expect(document.querySelector('[data-swarm-captain-page]')).toBeNull()
    expect(document.querySelector('.swarm-team-workspace__roster')).not.toBeNull()
  })

  it('lists deduplicated Teams and the real bound members in the management view with Captain-only actions', async () => {
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
      ],
      observedAt: 5, complete: true,
    }
    const generatedMembers = {
      schemaVersion: 1, binding: { rootSessionId: 'root', teamId: 'team-alpha' },
      members: [{ name: 'worker', role: 'Implementation', phase: 'active', createdAt: 1,
        displayName: 'Pixel Painter', profession: 'Avatar artist', personality: 'Careful',
        avatar: { state: 'generated', svg: '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
        identityCard: { state: 'generated' } }],
      observedAt: 5,
    }
    const state: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, SWARM_READ_RPC_FIXTURES_V1.values.snapshot), teams: multiTeams as never, captainMembers: generatedMembers as never, projection: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot, binding: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.binding, teamId: 'team-alpha' } } as never } }
    const mgmtController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: mgmtController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // The management entry lives on the Dedicated Captain page; the Main Brain rail has none.
    expect(document.querySelector('[data-swarm-management-entry]')).toBeNull()
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-management-entry]')!.click() })
    // Teams: deduplicated by teamId (duplicate enumeration row collapsed), bound Team highlighted.
    const teamRows = [...document.querySelectorAll<HTMLButtonElement>('[data-swarm-management-team]')]
    expect(teamRows).toHaveLength(1)
    expect(teamRows[0]!.getAttribute('aria-current')).toBe('true')
    expect(teamRows[0]!.getAttribute('data-swarm-captain-session')).toBe('captain-alpha')
    expect(teamRows[0]!.textContent).toContain('Manage via Captain')
    // Team row click = the official Captain Session handoff, nothing else.
    await act(async () => { teamRows[0]!.click() })
    expect(coordinator.openTeamCaptain).toHaveBeenCalledWith('captain-alpha')
    // Bound members: real generated identity values win; the safe svg renders as React rects.
    const memberRow = document.querySelector<HTMLButtonElement>('[data-swarm-management-member="worker"]')!
    expect(memberRow.getAttribute('data-swarm-identity-state')).toBe('generated')
    expect(memberRow.querySelector('[data-swarm-member-visible-name]')?.textContent).toBe('Pixel Painter')
    expect(memberRow.querySelector('[data-swarm-member-visible-profession]')?.textContent).toBe('Avatar artist')
    expect(memberRow.querySelector('[data-swarm-pixel-avatar]')?.getAttribute('data-avatar-state')).toBe('generated')
    // The member "manage" action is the Captain handoff, not a fabricated direct write.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-manage-members-via-captain]')!.click() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // Empty members read renders an explicit empty state, not a fabricated row.
    const emptyMembers = { ...generatedMembers, members: [] }
    const emptyState: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, SWARM_READ_RPC_FIXTURES_V1.values.snapshot), teams: multiTeams as never, captainMembers: emptyMembers as never } }
    const emptyController = { getSnapshot: (): TeamDashboardState => emptyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: emptyController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-management-entry]')!.click() })
    expect(document.querySelector('[data-swarm-management-members-empty]')?.textContent).toContain('None')
  })

  it('renders the enumerated Team/Captain list with un-generated identity and opens the official Captain Session', async () => {
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1_700_000_000_000 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 },
    }
    const multiTeams = {
      schemaVersion: 1,
      binding: { rootSessionId: 'root' },
      teams: [
        { teamId: 'team-alpha', name: 'Alpha Team', phase: 'active', captainSessionId: 'captain-alpha',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' as const },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' as const },
          endpoints: {
            members: { method: 'captainMembers' as const, target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            announcements: { method: 'captainAnnouncements' as const, target: { rootSessionId: 'root', teamId: 'team-alpha' } },
            diagnostics: { method: 'captainDiagnostics' as const, target: { rootSessionId: 'root', teamId: 'team-alpha' } },
          },
        },
        { teamId: 'team-beta', name: 'Beta Team', phase: 'active', captainSessionId: 'captain-beta',
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' as const },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' as const },
          endpoints: {
            members: { method: 'captainMembers' as const, target: { rootSessionId: 'root', teamId: 'team-beta' } },
            announcements: { method: 'captainAnnouncements' as const, target: { rootSessionId: 'root', teamId: 'team-beta' } },
            diagnostics: { method: 'captainDiagnostics' as const, target: { rootSessionId: 'root', teamId: 'team-beta' } },
          },
        },
      ],
      observedAt: 3,
      complete: true,
    }
    const state: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection), teams: multiTeams as never } }
    const listController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: listController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // The enumeration lives on the Dedicated Captain page; the Main Brain rail keeps one pinned row.
    expect(document.querySelectorAll('[data-swarm-captain-row]')).toHaveLength(1)
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    // First-level right-rail lists every enumerated Team (real authorities, not a copied aggregate).
    const list = document.querySelector<HTMLElement>('[data-swarm-captain-list]')!
    expect(list).not.toBeNull()
    const rows = [...document.querySelectorAll('[data-swarm-captain-team]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Alpha Team')
    expect(rows[1]!.textContent).toContain('Beta Team')
    // Identity stays honest: un-generated captains keep the technical name + explicit placeholder.
    expect(list.querySelectorAll('[data-swarm-captain-profession]').length).toBe(2)
    expect(list.textContent).toContain('Profile not generated yet')
    expect(list.textContent).toContain('Alpha Team')
    expect(list.textContent).toContain('Beta Team')
    // Clicking a Captain opens that Team's official Session through the coordinator seam.
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-captain-team="team-alpha"]')!).click() })
    expect(coordinator.openTeamCaptain).toHaveBeenCalledWith('captain-alpha')
    // Zero Teams is an explicit empty state.
    const emptyState: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection), teams: { ...multiTeams, teams: [] } as never } }
    const emptyController = { getSnapshot: (): TeamDashboardState => emptyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: emptyController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="captain"]')!).click() })
    expect(document.querySelector('[data-swarm-captain-list] [data-swarm-captains-empty]')?.textContent).toContain('No Teams yet.')
  })

  it('keeps legal 64-character owner and target values bounded in Task rows while retaining their titles', async () => {
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
    await act(async () => { document.querySelector<HTMLElement>('details.swarm-team-workspace__collapsible summary')?.click() })
    const assignees = [...document.querySelectorAll<HTMLElement>('.swarm-team-workspace__task-assignee')]
    expect(assignees).toHaveLength(2)
    expect(assignees.map(element => element.getAttribute('title'))).toEqual([`Owner: ${memberName}`, `Target member: ${memberName}`])
    expect(document.querySelector('[data-swarm-task-owner]')?.getAttribute('data-swarm-task-owner')).toBe(`Owner: ${memberName}`)
    expect(document.querySelector('[data-swarm-task-target]')?.getAttribute('data-swarm-task-target')).toBe(`Target member: ${memberName}`)
    expect(assignees.every(element => element.className.includes('swarm-team-workspace__task-assignee'))).toBe(true)
    const stylesheet = document.querySelector('style')?.textContent ?? ''
    expect(stylesheet).toContain('.swarm-team-workspace__rows, [data-swarm-team-dashboard] .swarm-team-workspace__rows > li { min-width:0; max-width:100%; }')
    expect(stylesheet).toContain('.swarm-team-workspace__task-assignee { display:block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }')
    await act(async () => { document.querySelector<HTMLButtonElement>('.swarm-team-workspace__rows button')?.click() })
    expect(document.body.textContent).toContain('Back to tasks')
    expect(document.querySelector('[data-swarm-task-detail]')).not.toBeNull()
    expect(document.body.textContent).toContain('Task diagnostics')
    expect(document.body.textContent).toContain('Current attempt ID')
  })

  it.each([
    ['submitted', 'submitted'], ['verifying', 'verifying'], ['stale', 'stale'],
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
  })

  it('keeps a terminal currentAttemptId as recent history rather than current member work', async () => {
    const coordinator = new FakeCoordinator()
    const projection = projectionForActivity({
      tasks: [activityTask('task-history', 'attempt-history', 'failed')],
      attempts: [activityAttempt('attempt-history', 'accepted', 'worker', 2)],
    })
    const state: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } }
    const historyController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: historyController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    expect(document.body.textContent).toContain('Recent attempt: Accepted')
    const member = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    expect(member.querySelector('[data-swarm-member-visible-lifecycle]')).toBeNull()
    expect(member.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Recent attempt: Accepted')
    await act(async () => { member.click() })
    expect(document.body.textContent).toContain('LifecycleActive')
    expect(document.body.textContent).toContain('Recent attempt: Accepted')
    expect(document.body.textContent).not.toContain('Current task: task-history')
  })

  it('renders the view-tabs navigation strip with roster labels and switches to the board view', async () => {
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // Wireframe view-tabs: Main Brain / Dedicated Captain / Public goal, role=tablist.
    const tablist = document.querySelector<HTMLElement>('[data-swarm-view-tabs]')!
    expect(tablist.getAttribute('role')).toBe('tablist')
    const tabs = [...document.querySelectorAll('[data-swarm-view-tab]')]
    expect(tabs.map(tab => tab.getAttribute('data-swarm-view-tab'))).toEqual(['roster', 'captain', 'board'])
    // Roster labels group the Captain and members (captain · 1 / members · N).
    expect(document.querySelector('[data-swarm-roster-captain-label]')?.textContent).toContain('Team Captain')
    expect(document.querySelector('[data-swarm-roster-members-label]')?.textContent).toContain('Members')
    // Selecting the Board tab switches to the in-slot board view with the real durable goal card.
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="board"]')!).click() })
    expect(document.querySelector('[data-swarm-board-view]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-goal-card]')).not.toBeNull()
    // Selecting Main Brain routes back to the owner conversation (closeAndRestoreFocus + The FakeCoordinator).
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="roster"]')!).click() })
    expect(coordinator.closeAndRestoreFocus).toHaveBeenCalled()
  })

  it('keeps the roster free of duplicated goal cards, renders announcements once in the work region, and the real goal on the board', async () => {
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // Roster-first screen: exactly one compact Team overview carries the goal; no board goal card.
    expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-swarm-team-overview]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-swarm-announcement-unavailable]')).toHaveLength(0)
    // The work region holds the single real announcements read with the authored entry.
    const announcementsFold = document.querySelector<HTMLDetailsElement>('[data-swarm-announcements-fold]')!
    expect(announcementsFold.querySelectorAll('[data-swarm-announcements-state="available"]')).toHaveLength(1)
    const entries = announcementsFold.querySelectorAll('[data-swarm-announcement-entry]')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.textContent).toContain('Welcome to the Fixture Team.')
    // Board view: the durable public goal renders its real text; the update action reuses the official handoff.
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="board"]')!).click() })
    const board = document.querySelector<HTMLElement>('[data-swarm-board-view]')!
    const goalCard = board.querySelector<HTMLElement>('[data-swarm-goal-card]')!
    expect(goalCard.getAttribute('data-swarm-goal-state')).toBe('generated')
    expect(goalCard.querySelector('[data-swarm-goal-text]')?.textContent).toBe('Deliver the Team UI.')
    await act(async () => { goalCard.querySelector<HTMLButtonElement>('[data-swarm-goal-update]')!.click(); await Promise.resolve() })
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // No duplicated announcement section on the board; no fabricated extra rows.
    expect(board.querySelectorAll('[data-swarm-announcement-entry]')).toHaveLength(0)
    expect(board.querySelectorAll('h3')).toHaveLength(0)
  })

  it('renders the honest empty goal state for a Team that has not set one', async () => {
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
    await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-view-tab="board"]')!).click() })
    const goalCard = document.querySelector<HTMLElement>('[data-swarm-goal-card]')!
    expect(goalCard.getAttribute('data-swarm-goal-state')).toBe('not_generated')
    expect(goalCard.querySelector('[data-swarm-goal-not-set]')?.textContent).toBe('No public goal has been set yet.')
    expect(goalCard.querySelector('[data-swarm-goal-text]')).toBeNull()
  })
})

function activityTask(id: string, currentAttemptId: string, status: 'in_progress' | 'failed' = 'in_progress') {
  return { id, revision: 1, subject: id, status, blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId, createdAt: 1, updatedAt: 1 }
}
function activityAttempt(id: string, phase: 'running' | 'submitted' | 'verifying' | 'accepted' | 'rejected' | 'cancelled' | 'stale', memberName: string, updatedAt: number) {
  return { id, taskId: id.replace('attempt', 'task'), generation: 1, memberName, phase, assignmentPhase: 'delivered' as const, createdAt: 1, updatedAt }
}
function projectionForActivity({ tasks, attempts, memberPhase = 'active' }: { tasks: ReturnType<typeof activityTask>[]; attempts: ReturnType<typeof activityAttempt>[]; memberPhase?: 'provisioning' | 'active' | 'failed' | 'removed' }) {
  return { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot, roster: [{ name: 'worker', role: 'Verifier', phase: memberPhase, createdAt: 1 }], tasks, attempts, totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1, tasks: tasks.length, attempts: attempts.length } } as never
}
