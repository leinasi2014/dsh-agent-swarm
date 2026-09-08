// @vitest-environment jsdom
import { t, tZh, ready, teamData, FakeCoordinator, controller, mounted, render, detailOverlay, pressEscape, tabButton } from './helpers/dashboard-ui.js'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { TeamDashboardAction } from '../src/client/TeamDashboardAction.js'
import { memberRosterInitial, shellCss } from '../src/client/TeamDashboardContent.js'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { en, zh } from '../src/client/team-dashboard-locales.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'

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

  it('renders the task dependency DAG in the Tasks tab', async () => {
    const snapshot = SWARM_READ_RPC_FIXTURES_V1.values.snapshot as Record<string, unknown>
    const baseArray = snapshot.tasks as unknown as Array<Record<string, unknown>>
    const base = baseArray[0] ?? { id: 't0', revision: 1, subject: 'x', status: 'pending', blockedBy: [], priority: 0, createdAt: 1, updatedAt: 1 }
    const tasks = [] as Array<Record<string, unknown>>
    for (const id of ['t1', 't2', 't3']) tasks.push({ ...base, id, subject: 'Task ' + id, status: 'pending', blockedBy: [] })
    tasks[1]!.blockedBy = ['t1']
    tasks[2]!.blockedBy = ['t2']
    const dagState: TeamDashboardState = {
      open: true, phase: 'ready', targetSessionId: 'main-brain',
      data: {
        capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never,
        projection: { ...snapshot, tasks } as never,
        teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never,
        captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never,
        captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never,
        captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never,
      },
    }
    const dagController = { getSnapshot: (): TeamDashboardState => dagState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: dagController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    await act(async () => { tabButton('tasks')!.click() })
    expect(document.querySelectorAll('[data-swarm-dag-node]')).toHaveLength(3)
    expect(document.querySelectorAll('[data-swarm-dag-edge]')).toHaveLength(2)
    expect(document.querySelector('[data-swarm-dag-node="t3"]')?.getAttribute('data-swarm-dag-tone')).toBe('open')
    const taskEntry = document.querySelector<HTMLButtonElement>('[data-swarm-dag-node="t3"]')!
    taskEntry.focus()
    await act(async () => { taskEntry.click() })
    expect(document.querySelector('[data-swarm-detail-view] [data-swarm-task-detail]')).not.toBeNull()
    await pressEscape()
    expect(document.activeElement).toBe(taskEntry)
  })

  it('renders the attention card from pending human interactions', async () => {
    const snapshot = SWARM_READ_RPC_FIXTURES_V1.values.snapshot as Record<string, unknown>
    const attentionState: TeamDashboardState = {
      open: true, phase: 'ready', targetSessionId: 'main-brain',
      data: {
        capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never,
        projection: { ...snapshot, pendingInteractions: [{ requestId: 'human-attn-1', intent: 'member-question', targetKind: 'member', targetRef: 'worker', status: 'pending', createdAt: 1, updatedAt: 1 }] } as never,
        teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never,
        captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never,
        captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never,
        captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never,
      },
    }
    const attentionController = { getSnapshot: (): TeamDashboardState => attentionState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: attentionController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    expect(document.querySelector('[data-swarm-attention]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-attention-row="human-attn-1"]')?.textContent).toContain('member-question')
  })

  it('renders the staged plan review card for a staged Team projection', async () => {
    const snapshot = SWARM_READ_RPC_FIXTURES_V1.values.snapshot as Record<string, unknown>
    const teams = SWARM_READ_RPC_FIXTURES_V1.values.teams as { teams: Array<Record<string, unknown>> }
    const stagedState: TeamDashboardState = {
      open: true, phase: 'ready', targetSessionId: 'main-brain',
      data: {
        capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never,
        projection: { ...snapshot, team: { ...(snapshot.team as Record<string, unknown>), phase: 'staged', plan: { members: 2, tasks: 3 } } } as never,
        teams: { ...teams, teams: teams.teams.map(row => ({ ...row, phase: 'staged', captainSessionId: '' })) } as never,
        captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never,
        captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never,
        captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never,
      },
    }
    const stagedController = { getSnapshot: (): TeamDashboardState => stagedState, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const coordinator = new FakeCoordinator()
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: stagedController, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
    expect(document.querySelector('[data-swarm-staged-plan-summary]')?.textContent).toContain('2 members')
    expect(document.querySelector('[data-swarm-staged-plan-summary]')?.textContent).toContain('3 tasks')
    expect(document.querySelector('[data-swarm-staged-plan-hint]')).not.toBeNull()
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
      await page.setContent(`<!doctype html><html><head><style>body{margin:0}.host{display:grid;grid-template-columns:minmax(0,1fr) 360px;height:800px}.details{min-width:0;overflow:hidden}${shellCss}</style></head><body>
        <div class="host"><main>Chat</main><aside class="details"><div data-swarm-team-dashboard data-swarm-team-panel><button data-swarm-member-name="worker" type="button" style="width:140px;height:32px">worker</button></div></aside></div>
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

    it.each([813, 995, 996, 1280] as const)('%spx: Team content remains inside the host Details column and its member button is clickable', async (width) => {
      await mountPanelAt(width)
      const g = await panelComputed()
      expect(g.position).toBe('static')
      expect(g.rect!.x).toBe(width - 360)
      expect(g.rect!.width).toBe(360)
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
    expect(document.body.textContent).toContain('Overview'); expect(document.body.textContent).toContain('Active')
    await act(async () => { root.render(<TeamDashboardDetails {...({ ...common, t: tZh } as any)} />) })
    expect(document.body.textContent).toContain('概览'); expect(document.body.textContent).toContain('活跃')
  })

  it('derives display-only initials from an NFC grapheme cluster without storing a profile', () => {
    expect(memberRosterInitial('e\u0301clair')).toBe('é')
    expect(memberRosterInitial('👩🏽‍💻 builder')).toBe('👩🏽‍💻')
  })

  it('opens member details inline in the fixed sidebar, returns with focus restore, and recovers from a removed member', async () => {
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
    // The detail replaces the browse view within the same sidebar.
    const overlay = detailOverlay()!
    expect(overlay.getAttribute('role')).toBe('region')
    expect(overlay.hasAttribute('aria-modal')).toBe(false)
    const headingId = overlay.getAttribute('aria-labelledby')!
    expect(headingId).not.toBe('')
    expect(document.getElementById(headingId)?.textContent).toBe('Member: worker')
    expect(document.activeElement?.textContent).toBe('Member: worker')
    // Missing read fields render the explicit unavailable marker, never fabricated values.
    expect(overlay.textContent).toContain('Not available yet')
    expect(overlay.textContent).toContain('No current task')
    const back = overlay.querySelector<HTMLButtonElement>('[data-swarm-detail-back]')!
    expect(back.getAttribute('aria-label')).toBe('Back')
    expect(back.textContent).toContain('←')
    expect(document.querySelector<HTMLElement>('[data-swarm-workbench-browse]')?.hidden).toBe(true)
    expect(shellCss).not.toContain('position:absolute; inset:0;')
    await act(async () => { back.click() })
    expect(detailOverlay()).toBeNull()
    expect(document.activeElement).toBe(memberTrigger)
    expect(coordinator.closeAndRestoreFocus).not.toHaveBeenCalled()
    await act(async () => { memberTrigger.click() })
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
    await act(async () => { detailOverlay()!.querySelector<HTMLButtonElement>('[data-swarm-detail-back]')!.click() })
    await Promise.resolve()
    expect(detailOverlay()).toBeNull()
    expect(document.activeElement).toBe(task)
  })

})
