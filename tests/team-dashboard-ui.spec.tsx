// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { TeamDashboardAction } from '../src/client/TeamDashboardAction.js'
import { deriveMemberActivity, deriveMemberTone, memberRosterInitial, shellCss, TEAM_WORKSPACE_WIDE_MIN_WIDTH, teamWorkspaceLayoutForWidth } from '../src/client/TeamDashboardContent.js'
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
const ready: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'main-brain', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: SWARM_READ_RPC_FIXTURES_V1.values.snapshot as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } }
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
const detailOverlay = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-swarm-detail-overlay]')
const pressEscape = async (): Promise<void> => { await act(async () => { detailOverlay()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }); await Promise.resolve() }
const tabButton = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-swarm-view-tab="${id}"]`)!
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

  it('uses the unique public Details occupant: team rail, header title, goal/announcement cards, four tabs', async () => {
    const coordinator = new FakeCoordinator(); const common = { anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t }
    await render(<TeamDashboardDetails {...(common as any)} />)
    const panel = document.querySelector<HTMLElement>('[role="complementary"][data-swarm-team-panel]')!
    expect(panel.textContent).toContain('Fixture Team'); expect(panel.textContent).toContain('Active')
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.body.innerHTML).toContain('--dsw-alias-bg-layer-1')
    // Honest read surfaces: exactly one goal card and one announcement preview above the tabs.
    expect(document.querySelectorAll('[data-swarm-goal-card]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-swarm-announcement-preview]')).toHaveLength(1)
    // No removed surface types survive: no fixed footer actions, no Main-Brain/Captain tabs.
    expect(panel.querySelector('[data-swarm-team-workspace] .swarm-team-workspace__footer, [data-swarm-view-tab="roster"], [data-swarm-view-tab="captain"], [data-swarm-view-tab="board"]')).toBeNull()
    // A single Captain desk click routes to the official Captain Chat.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-captain-desk]')!.click(); await Promise.resolve() })
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
    // Missing authority keeps the same honest empty shell, but does not invent Team rows.
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
    const coordinator = new FakeCoordinator()
    const longRole = '开发 writer（仅负责本 P0）：修复 SWARM_UI_READ_FAILED。在受管 lane p0-swarm-ui-read-v2（pnpm isolation open，owner terra-p0）内实施：契约一致（role 上限有界提升并同步 CONTRACT_DIGEST）'.repeat(6)
    expect(longRole.length).toBeGreaterThan(256)
    const projection = { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot, roster: [{ name: 'worker', role: longRole, phase: 'active', createdAt: 1_700_000_000_000 }], totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 } }
    const readyState: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'root', data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const longRoleController = { getSnapshot: (): TeamDashboardState => readyState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: longRoleController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // The member desk's profession element keeps the full authoritative value in its title.
    const secondary = document.querySelector<HTMLElement>('[data-swarm-member-name] small.swarm-team-workspace__truncate[title]')!
    expect(secondary.getAttribute('title')).toBe(longRole)
    // The visible rendering is bounded by the shared truncation class so the desk does not grow unboundedly.
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

  it('opens the member detail as an in-sidebar overlay dialog, closes on Escape with focus restore, and recovers from a removed member', async () => {
    const coordinator = new FakeCoordinator()
    let projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1 }],
      tasks: [], attempts: [],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1, tasks: 0, attempts: 0 },
    }
    let dynamicState: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const dynamicController = {
      getSnapshot: (): TeamDashboardState => dynamicState,
      subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn(),
    }
    const common = { anchorRef: { current: null }, controller: dynamicController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root)
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    const memberTrigger = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    memberTrigger.focus()
    await act(async () => { memberTrigger.click() })
    // The detail is an overlay dialog inside the sidebar, not content stacked below the page.
    const overlay = detailOverlay()!
    expect(overlay.getAttribute('role')).toBe('dialog')
    expect(overlay.getAttribute('aria-modal')).toBe('true')
    const headingId = overlay.getAttribute('aria-labelledby')!
    expect(headingId).not.toBe('')
    expect(document.getElementById(headingId)?.textContent).toBe('Member: worker')
    expect(document.activeElement?.textContent).toBe('Member: worker')
    // Missing read fields render the explicit unavailable marker, never fabricated values.
    expect(overlay.textContent).toContain('Not available yet')
    expect(overlay.textContent).toContain('No current task')
    await pressEscape()
    expect(detailOverlay()).toBeNull()
    expect(document.activeElement).toBe(memberTrigger)
    // A member disappearing from the roster closes the overlay without leaving a dangling dialog.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!.click() })
    expect(detailOverlay()).not.toBeNull()
    projection = { ...projection, roster: [], totals: { ...projection.totals, roster: 0 } }
    dynamicState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    await act(async () => { root.render(<TeamDashboardDetails {...(common as any)} />) })
    expect(detailOverlay()).toBeNull()
    // The authority-driven auto-close still leaves usable focus behind (the selected tab).
    expect(document.activeElement).toBe(tabButton('workspace'))
    expect(document.body.textContent).not.toContain('worker is no longer in this Team')
  })

  it('renders member detail composition fields from the real captainMembers.composition.v1 row, fail-closed for non-available rows', async () => {
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [
        { name: 'worker', role: 'writer', phase: 'active', createdAt: 1 },
        { name: 'artist', role: 'artist', phase: 'active', createdAt: 2 },
      ],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 2 },
    }
    const state: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const compositionController = { getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: compositionController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    // Available row (fixture `worker`): every composition field renders its real value.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!.click() })
    const overlay = detailOverlay()!
    expect(overlay.querySelector<HTMLElement>('[data-swarm-detail-provider]')?.textContent).toBe('spawn')
    expect(overlay.querySelector<HTMLElement>('[data-swarm-detail-llm-provider]')?.textContent).toBe('mock')
    expect(overlay.querySelector<HTMLElement>('[data-swarm-detail-model]')?.textContent).toBe('worker-model')
    expect(overlay.querySelector<HTMLElement>('[data-swarm-detail-persona]')?.textContent).toBe('Yes')
    expect(overlay.querySelector<HTMLElement>('[data-swarm-detail-denied-tools]')?.textContent).toBe('agent_swarm_create_managed')
    // No fail-closed state/reason disclosure on an available row; no fabricated permissions/skills.
    expect(overlay.querySelector('[data-swarm-detail-composition-state]')).toBeNull()
    expect(overlay.querySelector('[data-swarm-detail-composition-reason]')).toBeNull()
    expect(overlay.querySelector<HTMLElement>('[data-swarm-detail-skills-value]')?.textContent).toBe('Not available yet')
    await pressEscape()
    // Fail-closed row (fixture `artist`, invalid descriptor): only state/reason + runtimeProvider.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="artist"]')!.click() })
    const closed = detailOverlay()!
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-provider]')?.textContent).toBe('spawn')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-composition-state]')?.textContent).toBe('invalid')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-composition-reason]')?.textContent).toBe('descriptor_invalid')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-model]')?.textContent).toBe('Not available yet')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-llm-provider]')?.textContent).toBe('Not available yet')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-preset]')?.textContent).toBe('Not available yet')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-persona]')?.textContent).toBe('Not available yet')
    expect(closed.querySelector<HTMLElement>('[data-swarm-detail-denied-tools]')?.textContent).toBe('Not available yet')
    await pressEscape()
    // A member missing from captainMembers keeps every honest unavailable marker.
    const noMemberProjection = { ...projection, roster: [projection.roster[0]!] }
    const missingState: TeamDashboardState = { ...ready, data: { ...teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, noMemberProjection), captainMembers: { schemaVersion: 1, binding: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers.binding, members: [], observedAt: 0 } as never } }
    const missingController = { getSnapshot: (): TeamDashboardState => missingState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    document.body.replaceChildren()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: missingController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!.click() })
    const missing = detailOverlay()!
    expect(missing.querySelector<HTMLElement>('[data-swarm-detail-provider]')?.textContent).toBe('Not available yet')
    expect(missing.querySelector<HTMLElement>('[data-swarm-detail-model]')?.textContent).toBe('Not available yet')
    expect(missing.querySelector<HTMLElement>('[data-swarm-detail-persona]')?.textContent).toBe('Not available yet')
    expect(missing.querySelector<HTMLElement>('[data-swarm-detail-denied-tools]')?.textContent).toBe('Not available yet')
  })

  it('localizes the new composition detail copy in both official locales', () => {
    for (const key of ['detail.field.llmProvider', 'detail.field.preset', 'detail.field.persona', 'detail.field.deniedTools', 'detail.field.none', 'detail.compositionState', 'detail.compositionReason'] as const) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })

  it('restores focus to task triggers and recovers from a removed task through the same overlay', async () => {
    const coordinator = new FakeCoordinator()
    const projection = {
      ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
      roster: [{ name: 'worker', role: 'Read-only verifier', phase: 'active', createdAt: 1 }],
      tasks: [{ id: 'task-1', revision: 1, subject: 'Check focus recovery', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId: 'attempt-1', createdAt: 1, updatedAt: 2 }],
      attempts: [{ id: 'attempt-1', taskId: 'task-1', generation: 1, memberName: 'worker', phase: 'running', assignmentPhase: 'delivered', createdAt: 1, updatedAt: 2 }],
      totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1, tasks: 1, attempts: 1 },
    }
    const dynamicState: TeamDashboardState = { ...ready, data: teamData(SWARM_READ_RPC_FIXTURES_V1.values.capabilities, projection) }
    const dynamicController = { getSnapshot: (): TeamDashboardState => dynamicState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: dynamicController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    await act(async () => { tabButton('tasks').click() })
    const task = document.querySelector<HTMLButtonElement>('[data-swarm-task-id="task-1"]')!
    task.focus()
    await act(async () => { task.click() })
    expect(document.activeElement?.textContent).toBe('Task: Check focus recovery')
    await act(async () => { [...detailOverlay()!.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Close Team workspace and return to Chat')!.click() })
    await Promise.resolve()
    expect(detailOverlay()).toBeNull()
    expect(document.activeElement).toBe(task)
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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: populated, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    const stylesheet = document.querySelector('style')?.textContent ?? ''
      // Exactly one team rail, one captain desk and two member desks with honest tones.
      expect(document.querySelectorAll('[data-swarm-team-panel] [data-swarm-team-rail]')).toHaveLength(1)
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
    const activePanel = (): string | null => document.querySelector<HTMLElement>('[role="tabpanel"]')?.getAttribute('data-swarm-panel') ?? null
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

  it('derives the team rail from the real teams[] enumeration and switches Teams in place via controller.selectTeam; never jumps to a Captain Session', async () => {
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
    // Teams deduplicate by teamId; the bound Team carries aria-current and never switches away.
    const dots = [...document.querySelectorAll<HTMLButtonElement>('[data-swarm-team-dot]')]
    expect(dots).toHaveLength(2)
    const bound = dots.find(dot => dot.getAttribute('data-swarm-team-dot') === 'team-alpha')!
    expect(bound.getAttribute('aria-current')).toBe('true')
    await act(async () => { bound.click() })
    expect(railController.selectTeam).not.toHaveBeenCalled()
    // Another Team's dot switches the CURRENT sidebar to that Team through controller.selectTeam
    // with its real id — it never opens or jumps to any Captain Session.
    const beta = dots.find(dot => dot.getAttribute('data-swarm-team-dot') === 'team-beta')!
    expect(beta.getAttribute('data-swarm-captain-session')).toBe('captain-beta')
    await act(async () => { beta.click() })
    expect(railController.selectTeam).toHaveBeenCalledTimes(1)
    expect(railController.selectTeam).toHaveBeenCalledWith('team-beta')
    expect(coordinator.openTeamCaptain).not.toHaveBeenCalled()
    expect(coordinator.openCaptainChat).not.toHaveBeenCalled()
    // The same Team panel stays mounted in the sidebar: no Captain Session handoff, no second surface.
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(1)
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.querySelector('[role="dialog"][data-swarm-detail-overlay]')).toBeNull()
    // After the switch the panel renders the SECOND Team's bound data: the moved selection, the
    // Beta Team title, and Beta's real public goal from the same read contract.
    expect(document.querySelector<HTMLElement>('[data-swarm-team-dot="team-beta"]')!.getAttribute('aria-current')).toBe('true')
    expect(document.querySelector<HTMLElement>('[data-swarm-team-dot="team-alpha"]')!.getAttribute('aria-current')).toBeNull()
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
    const signalOf = (id: string): string | null => document.querySelector<HTMLElement>(`[data-swarm-activity-attempt="${id}"] [data-swarm-signal]`)?.getAttribute('data-swarm-signal') ?? null
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
