/** Shared DOM fixture; each suite still drives the real dashboard components. */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, vi } from 'vitest'
import type { TeamDashboardData, TeamDashboardState } from '../../src/client/team-dashboard-controller.js'
import type { TeamDashboardSurfaceState } from '../../src/client/team-dashboard-surface-coordinator.js'
import { en, zh } from '../../src/client/team-dashboard-locales.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../../src/rpc/read-rpc-artifact.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    Button: ({ children, icon: _icon, ...props }: Record<string, unknown>) => react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    IconUserOutline16: () => react.createElement('svg', { 'data-icon': 'user' }), IconCodeOutline16: () => react.createElement('svg', { 'data-icon': 'code' }), IconCloseOutline16: () => react.createElement('svg', { 'data-icon': 'close' }), IconRefreshOutline16: () => react.createElement('svg', { 'data-icon': 'refresh' }),
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
  readonly makeRoomForDetails = vi.fn(); readonly restoreDockedDetails = vi.fn()
  readonly openMemberChat = vi.fn(async (_name: string, _sessionId: string) => {})
  state: TeamDashboardSurfaceState = { mode: 'docked', view: 'overview', targetSessionId: 'root' }
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
