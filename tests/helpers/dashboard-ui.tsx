/** Shared DOM fixture; each suite still drives the real dashboard components. */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, vi } from 'vitest'
import type { TeamDashboardData, TeamDashboardState } from '../../src/client/team-dashboard-controller.js'
import type { TeamDashboardSurfaceState } from '../../src/client/team-dashboard-surface-coordinator.js'
import { EMPTY_TEAM_SELECTION, type TeamWorkspaceSelection } from '../../src/client/team-dashboard-surface-coordinator.js'
import type { SwarmHostReadProjectionV1 } from '../../src/host/host-read-types.js'
import { en, zh } from '../../src/client/team-dashboard-locales.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../../src/rpc/read-rpc-artifact.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  const { profilePrimitives } = await import('./profile-primitives.js')
  return {
    ...profilePrimitives(),
    Button: ({ children, icon: _icon, ...props }: Record<string, unknown>) => react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    IconUserOutline16: () => react.createElement('svg', { 'data-icon': 'user', width: 16, height: 16 }), IconCodeOutline16: () => react.createElement('svg', { 'data-icon': 'code', width: 16, height: 16 }), IconCloseOutline16: () => react.createElement('svg', { 'data-icon': 'close', width: 16, height: 16 }), IconRefreshOutline16: () => react.createElement('svg', { 'data-icon': 'refresh', width: 16, height: 16 }),
    Pill: ({ children }: { children?: ReactNode }) => react.createElement('span', {}, children), StateDot: () => react.createElement('span', {}),
  }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
export const mounted: Root[] = []
export const t = (key: keyof typeof en, params?: Record<string, unknown>): string => en[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
export const tZh = (key: keyof typeof en, params?: Record<string, unknown>): string => zh[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
export const ready: TeamDashboardState = { open: true, phase: 'ready', targetSessionId: 'main-brain', data: { capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as never, projection: SWARM_READ_RPC_FIXTURES_V1.values.snapshot as never, teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never, captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never, captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never, captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never } }
export const teamData = (capabilities: unknown, projection: unknown): TeamDashboardData => ({
  capabilities: capabilities as never,
  projection: projection as never,
  teams: SWARM_READ_RPC_FIXTURES_V1.values.teams as never,
  captainAnnouncements: SWARM_READ_RPC_FIXTURES_V1.values.captainAnnouncements as never,
  captainDiagnostics: SWARM_READ_RPC_FIXTURES_V1.values.captainDiagnostics as never,
  captainMembers: SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never,
})

export class FakeCoordinator {
  private readonly selections = new Map<string, TeamWorkspaceSelection>()
  getWorkspaceSelection(binding: SwarmHostReadProjectionV1['binding']): TeamWorkspaceSelection { return this.selections.get(JSON.stringify(binding)) ?? EMPTY_TEAM_SELECTION }
  updateWorkspaceSelection(binding: SwarmHostReadProjectionV1['binding'], patch: Partial<TeamWorkspaceSelection>): void {
    const previous = this.getWorkspaceSelection(binding)
    if (Object.entries(patch).every(([key, value]) => previous[key as keyof TeamWorkspaceSelection] === value)) return
    this.selections.set(JSON.stringify(binding), { ...previous, ...patch }); this.listeners.forEach(listener => listener())
  }
  readonly openMainChat = vi.fn(async () => {})
  readonly observeTab = vi.fn(() => () => {})
  readonly openMemberChat = vi.fn(async (_name: string, _sessionId: string) => {})
  state: TeamDashboardSurfaceState = { mode: 'docked', view: 'overview', targetSessionId: 'main-brain' }
  private readonly listeners = new Set<() => void>()
  readonly toggle = vi.fn(); readonly showToolDetails = vi.fn(); readonly openCaptainChat = vi.fn(async () => {}); readonly closeAndRestoreFocus = vi.fn(); readonly selectView = vi.fn(); readonly openTeamCaptain = vi.fn()
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  localeTag = (): 'en-US' => 'en-US'
  set(state: TeamDashboardSurfaceState): void { this.state = state; this.listeners.forEach(listener => listener()) }
}
export const controller = { getSnapshot: (): TeamDashboardState => ready, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
export async function render(node: ReactNode): Promise<void> { const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root); await act(async () => { root.render(node) }) }
export const detailOverlay = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-swarm-detail-view]')
export const pressEscape = async (): Promise<void> => { await act(async () => { detailOverlay()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }); await Promise.resolve() }
export const tabButton = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-swarm-view-tab="${id}"]`)!
afterEach(async () => { while (mounted.length) await act(async () => { mounted.pop()?.unmount() }); document.body.replaceChildren(); vi.clearAllMocks() })
