// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { TeamDashboardAction } from '../src/client/TeamDashboardAction.js'
import { deriveMemberActivity, memberRosterInitial, shellCss, TEAM_WORKSPACE_WIDE_MIN_WIDTH, teamWorkspaceLayoutForWidth } from '../src/client/TeamDashboardContent.js'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
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
const ready: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'root', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: SWARM_READ_RPC_FIXTURES_V1.values.snapshot as never } }

class FakeCoordinator {
  state: TeamDashboardSurfaceState = { mode: 'docked', view: 'overview', targetSessionId: 'root' }
  private readonly listeners = new Set<() => void>()
  readonly toggle = vi.fn(); readonly showToolDetails = vi.fn(); readonly openCaptainChat = vi.fn(async () => {}); readonly closeAndRestoreFocus = vi.fn(); readonly selectView = vi.fn()
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
    expect(document.querySelectorAll('section')).toHaveLength(0)
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
    // No section content is fabricated from a missing projection — the surface fails closed rather than guessing.
    expect(document.querySelectorAll('section')).toHaveLength(0)
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
    const readyState: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'root', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
    const longRoleController = { getSnapshot: (): TeamDashboardState => readyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: longRoleController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    const secondary = document.querySelector<HTMLElement>('small.swarm-team-workspace__truncate[title]')!
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
    let dynamicState: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
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
    dynamicState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    expect(document.body.textContent).toContain('worker is no longer in this Team. Returning to members.')
    expect(document.activeElement).toBe(document.querySelector('.swarm-team-workspace__roster h3'))
    expect(document.querySelector('.swarm-team-workspace__roster')?.textContent).toMatchSnapshot()
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
    let dynamicState: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
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
    dynamicState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    expect(document.body.textContent).toContain('The selected task is no longer in this Team. Returning to tasks.')
    expect(document.activeElement).toBe(taskSummary)
    expect(taskSummary.textContent).toBe('Tasks')
  })

  it('keeps roster first at 359/360/520/719 and reserves three columns for the future 720px seam', async () => {
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
    const populatedState: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
    const populated = { getSnapshot: (): TeamDashboardState => populatedState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    try {
      await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: populated, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
      const workspace = document.querySelector<HTMLElement>('.swarm-team-workspace')!
      const body = document.querySelector<HTMLElement>('.swarm-team-workspace__body')!
      const stylesheet = document.querySelector('style')?.textContent ?? ''
      // A single vertical roster-first rail replaces the previous three-column grid.
      expect(document.querySelectorAll('[data-swarm-team-panel] [data-swarm-team-rail]')).toHaveLength(1)
      expect(document.querySelectorAll('[data-swarm-team-panel] .swarm-team-workspace__column')).toHaveLength(0)
      // Folded sections live inside the rail as default-closed details (tasks/overview+budget/capabilities/diagnostics).
      const folded = [...document.querySelectorAll('[data-swarm-team-panel] [data-swarm-team-rail] > details')]
      expect(folded).toHaveLength(4)
      expect(folded.every(detail => detail.open === false)).toBe(true)
      // Overview folds real Host budget metrics; capabilities fold real Host capabilities.
      expect(document.querySelector('[data-swarm-budget]')).not.toBeNull()
      expect(document.querySelector('[data-swarm-capabilities]')).not.toBeNull()
      expect(observers).toHaveLength(1)
      expect(workspace.dataset.swarmTeamLayout).toBe('compact')
      // This is a component contract, not a jsdom geometry claim. Browser-proof owns geometry acceptance.
      expect(body.className).toContain('swarm-team-workspace__body')
      expect(stylesheet).toContain('container-type:inline-size')
      expect(teamWorkspaceLayoutForWidth(359)).toBe('compact')
      await act(async () => { observers[0]?.emit(workspace, 359) })
      expect(workspace.dataset.swarmTeamLayout).toBe('compact')
      expect(teamWorkspaceLayoutForWidth(TEAM_WORKSPACE_WIDE_MIN_WIDTH)).toBe('wide')
      await act(async () => { observers[0]?.emit(workspace, 720) })
      expect(workspace.dataset.swarmTeamLayout).toBe('wide')
      // Team switcher names the real bound Team; switching to another Team is an explicit unavailable capability.
      const switcher = document.querySelector<HTMLElement>('[data-swarm-team-switcher]')!
      expect(switcher.textContent).toContain('Fixture Team')
      expect(switcher.textContent).toContain('team-fixture')
      const switchButton = document.querySelector<HTMLButtonElement>('[data-swarm-team-switch-unavailable]')!
      expect(switchButton.disabled).toBe(true)
      expect(switchButton.getAttribute('aria-disabled')).toBe('true')
      expect(switchButton.textContent).toContain('unavailable')
      // Main Brain / Dedicated Captain navigation over official child seams.
      expect(document.querySelector('[data-swarm-nav-main]')?.textContent).toContain('Main Brain')
      expect(document.querySelector('[data-swarm-nav-captain]')?.textContent).toContain('Dedicated Captain')
      await act(async () => { (document.querySelector<HTMLButtonElement>('[data-swarm-nav-main]')!).click() })
      expect(coordinator.closeAndRestoreFocus).toHaveBeenCalledTimes(1)
      // Roster-first: Captain hero precedes every real member.
      const captain = document.querySelector<HTMLButtonElement>('.swarm-team-workspace__roster > button')!
      const member = document.querySelector<HTMLButtonElement>('.swarm-team-workspace__rows button')!
      expect(captain.compareDocumentPosition(member) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(captain.querySelector('.swarm-team-workspace__avatar')?.textContent).toBe('C')
      expect(captain.textContent).toContain('Fixture Team Captain')
      expect(captain.querySelector('.swarm-team-workspace__captain-badge')?.textContent).toBe('Team Captain')
      expect(captain.textContent).not.toContain('session-fixture')
      expect(member.querySelector('[aria-hidden="true"]')?.textContent).toBe('w')
      expect(member.querySelector('[data-swarm-member-visible-lifecycle]')?.textContent).toBe('Lifecycle: Active')
      expect(member.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Running')
      expect(member.querySelector('[data-swarm-task-owner]')).toBeNull()
      // Goal and announcement entries are explicit unavailable cards (no phantom backend source).
      expect(document.querySelector('[data-swarm-goal-unavailable]')?.textContent).toContain('Public goal')
      expect(document.querySelector('[data-swarm-announcement-unavailable]')?.textContent).toContain('Announcements')
      // A single Captain-row click routes to the dedicated Captain Chat via the coordinator.
      await act(async () => { captain.click(); await Promise.resolve() })
      expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
      expect(document.querySelector('details')?.open).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver })
    }
  })

  it('keeps legal 64-character owner and target values bounded in Task rows while retaining their titles', async () => {
    const memberName = 'a'.repeat(64)
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      tasks: [{ id: 'task-long-name', revision: 1, subject: 'Task with long Host names', status: 'in_progress', blockedBy: [], priority: 1, ownerName: memberName, targetMemberName: memberName, createdAt: 1, updatedAt: 2 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, tasks: 1 },
    }
    const state: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } }
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
    const state: TeamDashboardState = { ...ready, data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection } }
    const historyController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: historyController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    expect(document.body.textContent).toContain('Recent attempt: Accepted')
    const member = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    expect(member.querySelector('[data-swarm-member-visible-lifecycle]')?.textContent).toBe('Lifecycle: Active')
    expect(member.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Recent attempt: Accepted')
    await act(async () => { member.click() })
    expect(document.body.textContent).toContain('LifecycleActive')
    expect(document.body.textContent).toContain('Recent attempt: Accepted')
    expect(document.body.textContent).not.toContain('Current task: task-history')
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
