// @vitest-environment jsdom
//
// Roster/Captain interaction slice — minimal failing tests (task-2 design).
//
// This focused spec pins the exact observable contract of the roster/Captain
// surface against the REAL backend read fixture (SWARM_READ_RPC_FIXTURES_V1)
// and the authoritative roster domain fields ({ name, role, phase, createdAt }),
// without touching any source. It asserts:
//   1. real member avatar initial / name / role / status from the Host fixture,
//   2. an unambiguous Captain marker distinct from member rows,
//   3. a single click of the Captain row routes to the bound main Chat and
//      never replaces the main brain nor leaves a second surface,
//   4. theme (official alias tokens, no hardcoded color) + en/zh copy,
//   5. no second source of truth and no Canvas (single official Details occupant).
//
// Deliberately additive: coverage that already exists in team-dashboard-ui.spec.tsx
// (error states, focus recovery, truncation, layout geometry, activity derivation)
// is NOT duplicated here.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { TeamDashboardSurfaceState } from '../src/client/team-dashboard-surface-coordinator.js'
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
  return { open: true, phase: 'ready', targetSessionId: 'root', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } } as TeamDashboardState
}

class FakeCoordinator {
  state: TeamDashboardSurfaceState = { mode: 'docked', view: 'overview', targetSessionId: 'root' }
  private readonly listeners = new Set<() => void>()
  readonly toggle = vi.fn(); readonly showToolDetails = vi.fn(); readonly closeAndRestoreFocus = vi.fn(); readonly selectView = vi.fn()
  readonly openCaptainChat = vi.fn(async (): Promise<void> => { this.set({ mode: 'inactive', view: 'overview', targetSessionId: undefined }) })
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'en-US' => 'en-US'
  set(state: TeamDashboardSurfaceState): void { this.state = state; this.listeners.forEach(listener => listener()) }
}

async function render(node: ReactNode): Promise<void> { const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root); await act(async () => { root.render(node) }) }
afterEach(async () => { while (mounted.length) await act(async () => { mounted.pop()?.unmount() }); document.body.replaceChildren(); vi.clearAllMocks() })

describe('roster/Captain interaction slice', () => {
  it('renders each real roster member avatar initial, name, role and authoritative life-cycle status from the Host fixture', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)

    // Avatar initials are derived from the real member name (NFC grapheme), not from a profile.
    expect(document.querySelector('[data-swarm-member-name="海宝"] .swarm-team-workspace__avatar')?.textContent).toBe('海')
    expect(document.querySelector('[data-swarm-member-name="e\u0301clair"] .swarm-team-workspace__avatar')?.textContent).toBe('é')

    // Name, role and life-cycle come verbatim from the fixture row.
    const member = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="海宝"]')!
    expect(member.querySelector('strong')?.textContent).toBe('海宝')
    expect(member.getAttribute('data-swarm-member-role')).toBe('Read-only auditor')
    expect(member.getAttribute('data-swarm-member-lifecycle')).toBe('active')
    expect(member.querySelector('[data-swarm-member-visible-lifecycle]')?.textContent).toBe('Lifecycle: Active')

    // Phase-aware status: provisioning member shows the provisioning marker, not an idle/online claim.
    const boot = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="boot"]')!
    expect(boot.getAttribute('data-swarm-member-lifecycle')).toBe('provisioning')
    expect(boot.getAttribute('data-swarm-member-activity')).toBe('provisioning')
  })

  it('maps each member StateDot only from the derived real activity and keeps name, role and current task', async () => {
    const coordinator = new FakeCoordinator()
    const t0 = 1_700_000_000_000
    const snapshot = SWARM_READ_RPC_FIXTURES_V1.values.snapshot
    const roster = [
      { name: 'worker', role: 'Implementation', phase: 'active', createdAt: t0 },
      { name: 'broken', role: 'QA', phase: 'failed', createdAt: t0 + 1 },
    ]
    const projection = {
      ...snapshot,
      roster,
      tasks: [{ id: 't1', revision: 1, subject: 'Ship roster slice', status: 'in_progress', blockedBy: [], priority: 1, ownerName: 'worker', currentAttemptId: 'a1', createdAt: t0, updatedAt: t0 }],
      attempts: [{ id: 'a1', taskId: 't1', generation: 1, phase: 'running', assignmentPhase: 'delivered', memberName: 'worker', createdAt: t0, updatedAt: t0 }],
      totals: { ...snapshot.totals, roster: 2, tasks: 1, attempts: 1, pendingInteractions: 0 },
    }
    const ready = { open: true, phase: 'ready', targetSessionId: 'root', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: projection as never } } as TeamDashboardState
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)

    const worker = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    const broken = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="broken"]')!
    // running real activity derives `running` -> official StateDot ongoing (blue), paired with the Running label.
    expect(worker.querySelector('[data-swarm-dot]')?.getAttribute('data-swarm-dot')).toBe('ongoing')
    expect(worker.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Running')
    // failed phase derives `error` -> official StateDot warning (amber), never a fabricated error dot.
    expect(broken.querySelector('[data-swarm-dot]')?.getAttribute('data-swarm-dot')).toBe('warning')
    expect(broken.querySelector('[data-swarm-member-visible-activity]')?.textContent).toBe('Error')
    // name, role and current task stay intact alongside the dot.
    expect(worker.querySelector('strong')?.textContent).toBe('worker')
    expect(worker.getAttribute('data-swarm-member-role')).toBe('Implementation')
    expect(worker.textContent).toContain('Ship roster slice')
  })

  it('marks the Captain as the sole non-member roster row, first and distinct from real members', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)

    const captain = document.querySelector<HTMLButtonElement>('.swarm-team-workspace__roster > button')!
    // The Captain row is unambiguous: it is not a real member row and never claims a member identity.
    expect(captain.hasAttribute('data-swarm-member-name')).toBe(false)
    expect(captain.type).toBe('button')
    // It carries the stable circular Captain avatar (no fabricated identity) and the two-level marker.
    expect(captain.querySelector('.swarm-team-workspace__avatar')?.textContent).toBe('C')
    expect(captain.title).toBe(t('captainMainChatTitle'))
    expect(captain.textContent).toContain(t('captainCurrent'))
    expect(captain.querySelector('.swarm-team-workspace__captain-badge')?.textContent).toBe(t('captainRole'))
    // It leads the roster before every real member.
    const firstMember = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="海宝"]')!
    expect(captain.compareDocumentPosition(firstMember) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('routes a single Captain-row click to the bound main Chat without replacing the main brain or leaving a second surface', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)

    const captain = document.querySelector<HTMLButtonElement>('.swarm-team-workspace__roster > button')!
    await act(async () => { captain.click(); await Promise.resolve() })

    // A single click dispatches the Captain handoff exactly once (no double navigation).
    expect(coordinator.openCaptainChat).toHaveBeenCalledTimes(1)
    // On handoff the Team surface yields back to the official Chat: no replacement surface,
    // no modal/fullscreen second state, and only the single complementary occupant is ever present.
    expect(coordinator.getSnapshot().mode).toBe('inactive')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('[data-swarm-member-name')
  })

  it('localizes Captain and member copy in en and zh while the theme stays on official alias tokens with no hardcoded color', async () => {
    const coordinator = new FakeCoordinator()
    const ready = readyWithRoster([...REAL_ROSTER])
    const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root)

    await act(async () => { root.render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />) })
    expect(document.querySelector('.swarm-team-workspace__roster > button .swarm-team-workspace__captain-badge')?.textContent).toBe('Team Captain')
    expect(document.body.textContent).toContain('Current main Chat')
    expect(document.body.textContent).toContain('Team Captain')

    await act(async () => { root.render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t: tZh } as any)} />) })
    expect(document.querySelector('.swarm-team-workspace__roster > button .swarm-team-workspace__captain-badge')?.textContent).toBe('团队队长')
    expect(document.body.textContent).toContain('当前主 Chat')
    expect(document.body.textContent).toContain('团队队长')
    expect(document.body.textContent).toContain('活跃')

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
    await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)

    // The surface is a plain complementary occupant of the official Details column: no canvas, no second state.
    expect(document.querySelectorAll('canvas')).toHaveLength(0)
    expect(document.querySelectorAll('[role="complementary"][data-swarm-team-panel]')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[data-swarm-team-fullscreen]')).toBeNull()
    // A complementary panel is the only occupant; no overlay layer duplicates it.
    expect(document.querySelectorAll('[data-swarm-team-panel]')).toHaveLength(1)

    // Surface coordination carries only {mode, view, targetSessionId} — never Team data.
    // The single source of truth stays the Host projection owned by the controller.
    expect(Object.keys(coordinator.getSnapshot()).toSorted()).toEqual(['mode', 'targetSessionId', 'view'])
    expect(Object.hasOwn(coordinator.getSnapshot(), 'data')).toBe(false)
    expect(Object.hasOwn(coordinator.getSnapshot(), 'projection')).toBe(false)
  })
})
