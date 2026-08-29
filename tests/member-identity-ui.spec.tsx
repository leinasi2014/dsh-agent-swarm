// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import { parseSafePixelSvg, pixelPattern } from '../src/client/SafePixelAvatar.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, TEAM_DASHBOARD_NS } from '../src/client/team-dashboard-locales.js'
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
const t: TranslateNS<typeof TEAM_DASHBOARD_NS> = ((key: keyof typeof en, params?: Record<string, unknown>): string => (en[key] as string).replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)) as TranslateNS<typeof TEAM_DASHBOARD_NS>

async function render(node: ReactNode): Promise<void> { const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root); await act(async () => { root.render(node) }) }
afterEach(async () => { while (mounted.length) await act(async () => { mounted.pop()?.unmount() }); document.body.replaceChildren(); vi.clearAllMocks() })
const overlay = (): HTMLElement => document.querySelector<HTMLElement>('[data-swarm-detail-overlay]')!
const tabButton = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-swarm-view-tab="${id}"]`)!

const safeSvg = '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3"/><rect x="2" y="2" width="4" height="4" fill="#fff" opacity="0.5"/></svg>'
const svg16 = '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="16" height="16" fill="#39f"/><rect x="4" y="4" width="8" height="8" fill="#ccc"/></svg>'
const unsafeSvgs = [
  '<svg viewBox="0 0 8 8"><script>alert(1)</script></svg>',
  '<svg viewBox="0 0 4 4"><rect x="0" y="0" width="4" height="4" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="url(#x)"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3" onclick="x()"/></svg>',
  '<svg viewBox="0 0 8 8"><foreignObject><rect x="0" y="0" width="8" height="8" fill="#2a3"/></foreignObject></svg>',
  '<svg viewBox="0 0 8 8"><g><rect x="0" y="0" width="8" height="8" fill="#2a3"/></g></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3" extra="1"/></svg>',
  '<svg viewBox="0 0 8 8"><text x="0" y="4">hi</text></svg>',
  // Strict numeric grammar: exponent, signs, whitespace and non-finite values are rejected.
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="1e1" height="8" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="-1" y="0" width="8" height="8" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x=" 0" y="0" width="8" height="8" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="Infinity" y="0" width="8" height="8" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3" opacity="+0.5"/></svg>',
  // Wrong element namespace falls back.
  '<svg viewBox="0 0 8 8" xmlns="http://www.w3.org/1999/xhtml"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>',
  // Rect outside / degenerate extent falls back.
  '<svg viewBox="0 0 8 8"><rect x="4" y="4" width="8" height="8" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="0" height="8" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="0" fill="#2a3"/></svg>',
  '<svg viewBox="0 0 8 8"><rect x="0" y="4" width="8" height="8" fill="#2a3"/></svg>',
]

describe('client-side safe pixel svg allowlist', () => {
  it('parses an allowlisted viewBox+rect svg into plain rect data', () => {
    const parsed = parseSafePixelSvg(safeSvg)
    expect(parsed).toBeDefined()
    expect(parsed!.size).toBe(8)
    expect(parsed!.rects).toHaveLength(2)
    expect(parsed!.rects[0]).toMatchObject({ x: 0, y: 0, width: 8, height: 8, fill: '#2a3' })
    expect(parsed!.rects[1]).toMatchObject({ opacity: 0.5 })
    const parsed16 = parseSafePixelSvg(svg16)
    expect(parsed16).toBeDefined()
    expect(parsed16!.size).toBe(16)
    expect(parsed16!.rects).toHaveLength(2)
  })
  it.each(unsafeSvgs)('rejects unsafe svg markup: %s', svg => {
    expect(parseSafePixelSvg(svg)).toBeUndefined()
  })
  it('rejects oversized, non-svg, and rectless input', () => {
    expect(parseSafePixelSvg('x'.repeat(20_000))).toBeUndefined()
    expect(parseSafePixelSvg('not svg')).toBeUndefined()
    expect(parseSafePixelSvg('<svg viewBox="0 0 8 8"></svg>')).toBeUndefined()
  })
})

function stateWithMemberAssets(memberRows: unknown): TeamDashboardState {
  const projection = {
    ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot,
    roster: [{ name: 'worker', role: 'implementation', phase: 'active', createdAt: 1 }],
    totals: { ...SWARM_READ_RPC_FIXTURES_V1.values.snapshot.totals, roster: 1 },
  }
  return {
    open: true, phase: 'ready', targetSessionId: 'root',
    data: {
      capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never,
      projection: projection as never,
      teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never,
      captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never,
      captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never,
      captainMembers: memberRows as never,
    },
  }
}
const controllerOf = (state: TeamDashboardState) => ({ getSnapshot: (): TeamDashboardState => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() })

async function renderDetails(state: TeamDashboardState): Promise<void> {
  const surfaceState = { mode: 'docked' as const, view: 'overview' as const, targetSessionId: 'root' }
  const coordinator = {
    state: surfaceState,
    getSnapshot: (): typeof surfaceState => surfaceState,
    subscribe: (_listener: () => void): (() => void) => () => {},
    localeTag: (): 'en-US' => 'en-US',
    openCaptainChat: vi.fn(async () => {}), closeAndRestoreFocus: vi.fn(), openTeamCaptain: vi.fn(), showToolDetails: vi.fn(), selectView: vi.fn(), toggle: vi.fn(),
  }
  await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller: controllerOf(state), coordinator, localeTag: coordinator.localeTag, sessionId: 'root', t } as any)} />)
}

describe('member rows consume real captainMembers identity data', () => {
  const generatedRow = {
    name: 'worker', role: 'Implementation', phase: 'active', createdAt: 1,
    displayName: 'Pixel Painter', profession: 'Avatar artist', personality: 'Careful, meticulous',
    avatar: { state: 'generated', svg: safeSvg },
    identityCard: { state: 'generated' },
  }

  it('renders the allowlisted svg rects and real display/profession on the desk; personality only in the overlay detail', async () => {
    await renderDetails(stateWithMemberAssets({ schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, members: [generatedRow], observedAt: 1 }))
    const row = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    expect(row).not.toBeNull()
    expect(row.getAttribute('data-swarm-identity-state')).toBe('generated')
    // Real identity values win on the narrow desk.
    expect(row.querySelector('[data-swarm-member-visible-name]')?.textContent).toBe('Pixel Painter')
    expect(row.querySelector('[data-swarm-member-visible-profession]')?.textContent).toBe('Avatar artist')
    // The avatar renders the parsed backend rects (converted to React elements, no raw markup).
    const avatar = row.querySelector<SVGSVGElement>('[data-swarm-pixel-avatar]')!
    expect(avatar.getAttribute('data-avatar-state')).toBe('generated')
    expect(avatar.getAttribute('data-avatar-fallback')).toBeNull()
    expect(avatar.querySelectorAll('rect')).toHaveLength(2)
    expect(avatar.innerHTML).not.toContain('<script')
    expect(avatar.getAttribute('viewBox')).toBe('0 0 8 8')
    // Personality never appears on the narrow desk.
    expect(row.textContent).not.toContain('Careful')
    // The overlay detail is the only surface for personality and separated role/profession facts.
    await act(async () => { row.click() })
    const detail = overlay()
    expect(detail.getAttribute('role')).toBe('dialog')
    expect(detail.textContent).toContain('Careful, meticulous')
    // Authoritative technical role (from the roster projection) and Captain-declared
    // profession are separate rows.
    expect(detail.querySelector('[data-swarm-detail-role]')?.textContent).toBe('implementation')
    expect(detail.querySelector('[data-swarm-detail-profession]')?.textContent).toBe('Avatar artist')
    expect(detail.textContent).toContain('Pixel Painter')
    // Growth section: honest folded values — private memory fact plus explicit unavailable markers.
    const growth = detail.querySelector('[data-swarm-detail-growth]')!
    expect(growth.textContent).toContain('Private to the member (never exposed here)')
    expect(growth.querySelectorAll('dd')).toHaveLength(4)
    expect(growth.textContent.match(/Not available yet/gu)!.length).toBe(3)
    // Ordinary members have no direct contact capability: disabled with an explanation.
    expect(detail.querySelector('[data-swarm-contact-disabled]')?.textContent).toContain('not available yet')
  })

  it('renders an authored 16x16 asset with its own viewBox, and falls back on unsafe/invalid input', async () => {
    const row16 = { ...generatedRow, avatar: { state: 'generated', svg: svg16 } }
    await renderDetails(stateWithMemberAssets({ schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, members: [row16], observedAt: 1 }))
    const row = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    const avatar = row.querySelector<SVGSVGElement>('[data-swarm-pixel-avatar]')!
    // Authored 16x16 grid is NOT clipped into the legacy 5x5 viewBox.
    expect(avatar.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(avatar.querySelectorAll('rect')).toHaveLength(2)
    expect(avatar.querySelector('rect[fill="#39f"]')).not.toBeNull()
    // Unsafe numeric/namespace input falls back to the deterministic grid with no script element.
    const unsafeRow = { ...generatedRow, avatar: { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="1e2" height="16" fill="#39f"/></svg>' } }
    document.body.replaceChildren()
    await renderDetails(stateWithMemberAssets({ schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, members: [unsafeRow], observedAt: 1 }))
    const fallback = document.querySelector<SVGSVGElement>('[data-swarm-member-name="worker"] [data-swarm-pixel-avatar]')!
    expect(fallback.getAttribute('data-avatar-fallback')).toBe('unsafe-svg')
    expect(document.querySelector('script')).toBeNull()
  })

  it('falls back honestly when the svg is unsafe: deterministic grid, fallback marker, no script element', async () => {
    const unsafe = { ...generatedRow, avatar: { state: 'generated', svg: unsafeSvgs[0] } }
    await renderDetails(stateWithMemberAssets({ schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, members: [unsafe], observedAt: 1 }))
    const row = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    const avatar = row.querySelector<SVGSVGElement>('[data-swarm-pixel-avatar]')!
    expect(avatar.getAttribute('data-avatar-state')).toBe('generated')
    expect(avatar.getAttribute('data-avatar-fallback')).toBe('unsafe-svg')
    // Fallback grid is the deterministic 5×5 pattern, never the raw markup.
    expect(avatar.querySelectorAll('rect').length).toBe(1 + pixelPattern('worker').flat().filter(Boolean).length)
    expect(document.querySelector('script')).toBeNull()
  })

  it('keeps technical name/role on the desk and explicit not-available profession/personality in the detail', async () => {
    await renderDetails(stateWithMemberAssets({ schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, members: [], observedAt: 1 }))
    const row = document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!
    expect(row.getAttribute('data-swarm-identity-state')).toBe('not_generated')
    expect(row.querySelector('[data-swarm-member-visible-name]')?.textContent).toBe('worker')
    expect(row.querySelector('[data-swarm-member-visible-profession]')?.textContent).toBe('implementation')
    const avatar = row.querySelector<SVGSVGElement>('[data-swarm-pixel-avatar]')!
    expect(avatar.getAttribute('data-avatar-state')).toBe('not_generated')
    await act(async () => { row.click() })
    const detail = overlay()
    expect(detail.querySelector('[data-swarm-detail-role]')?.textContent).toBe('implementation')
    expect(detail.querySelector('[data-swarm-detail-profession]')?.textContent).toBe('Not available yet')
    expect(detail.querySelector('[data-swarm-detail-personality]')?.textContent).toBe('Not available yet')
    expect(detail.querySelector('[data-swarm-detail-model]')?.textContent).toBe('Not available yet')
    expect(detail.querySelector('[data-swarm-detail-provider]')?.textContent).toBe('Not available yet')
  })

  it('renders real announcement entries and an honest empty state in both locales', async () => {
    const entries = [
      { id: 'ann-1', text: 'First notice', createdAt: 1_700_000_000_000 },
      { id: 'ann-2', text: 'Second notice', createdAt: 1_700_000_060_000 },
    ]
    const withAnnouncements = (rows: readonly unknown[]): TeamDashboardState => {
      const base = stateWithMemberAssets({ schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, members: [], observedAt: 1 })
      return { ...base, data: { ...base.data!, captainAnnouncements: { schemaVersion: 1, binding: { rootSessionId: 'root-1', teamId: 'team-1' }, state: 'available', entries: rows, observedAt: 1 } as never } }
    }
    // The full announcement history renders exactly once, inside the notices tab panel.
    await renderDetails(withAnnouncements(entries))
    await act(async () => { tabButton('notices').click() })
    const rendered = document.querySelectorAll('[data-swarm-announcement-entry]')
    expect(rendered).toHaveLength(2)
    expect(rendered[0]!.textContent).toContain('First notice')
    expect(rendered[1]!.textContent).toContain('Second notice')
    expect(document.querySelectorAll('[data-swarm-announcements-list]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('backend has not exposed')
    // Honest empty state, en copy present in the notices panel and the header preview.
    document.body.replaceChildren()
    await renderDetails(withAnnouncements([]))
    await act(async () => { tabButton('notices').click() })
    expect(document.querySelectorAll('[data-swarm-announcements-empty]').length).toBeGreaterThanOrEqual(1)
    expect(document.querySelector('[data-swarm-announcements-empty]')?.textContent).toBe('No announcements published yet.')
  })
})
