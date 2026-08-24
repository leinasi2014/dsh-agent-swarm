// @vitest-environment jsdom
import { act, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import type { SwarmReadCapabilitiesV1 } from '../src/rpc/read-rpc-contract.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'
import { TeamDashboardAction, type TeamDashboardActionProps } from '../src/client/TeamDashboardAction.js'
import { TeamDashboardDetails, type TeamDashboardDetailsProps } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { en } from '../src/client/team-dashboard-locales.js'
import TEAM_DASHBOARD_STYLES from '../src/client/team-dashboard-styles.js'
import type { TeamDashboardSurfaceState } from '../src/client/team-dashboard-surface-coordinator.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  const Icon = () => react.createElement('svg', { 'aria-hidden': 'true' })
  return {
    Button: ({ children, icon: _icon, variant: _variant, size: _size, ...props }: Record<string, unknown>) =>
      react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    Pill: ({ children }: { children?: ReactNode }) => react.createElement('span', {}, children),
    StateDot: () => react.createElement('span', { 'aria-hidden': 'true' }),
    IconCodeOutline16: Icon,
    IconUserOutline16: Icon,
    IconRefreshOutline16: Icon,
  }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: Root[] = []

class FakeController {
  readonly openCalls: string[] = []
  readonly closeCalls = vi.fn()
  readonly refresh = vi.fn()
  readonly reconnect = vi.fn()
  private readonly listeners = new Set<() => void>()

  constructor(private state: TeamDashboardState) {}
  getSnapshot = (): TeamDashboardState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  open = (sessionId: string): void => {
    this.openCalls.push(sessionId)
    this.state = { open: true, phase: 'loading', targetSessionId: sessionId }
    this.emit()
  }
  close = (): void => {
    this.closeCalls()
    this.state = { open: false, phase: 'closed' }
    this.emit()
  }
  private emit(): void { for (const listener of this.listeners) listener() }
}

class FakeCoordinator {
  readonly showToolDetails = vi.fn()
  private readonly listeners = new Set<() => void>()
  private state: TeamDashboardSurfaceState

  constructor(
    private readonly controller: FakeController,
    private readonly handoff: () => Promise<void> = async () => {},
  ) {
    const controllerState = controller.getSnapshot()
    this.state = {
      mode: controllerState.open ? 'docked' : 'inactive',
      view: 'overview',
      targetSessionId: controllerState.targetSessionId,
      announcement: undefined,
      announcementRevision: 0,
    }
  }
  getSnapshot = (): TeamDashboardSurfaceState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  localeTag = (): 'en-US' => 'en-US'
  openCaptainChat = async (): Promise<void> => { await this.handoff() }
  selectView = (view: TeamDashboardSurfaceState['view']): void => { this.publish({ view }) }
  closeAndRestoreFocus = (): void => { this.close() }
  toggle = (sessionId: string): void => {
    if (this.state.mode === 'docked' && this.state.targetSessionId === sessionId) {
      this.close()
      return
    }
    this.controller.open(sessionId)
    this.publish({ mode: 'docked', targetSessionId: sessionId })
  }
  private close(): void {
    this.controller.close()
    this.publish({ mode: 'inactive', targetSessionId: undefined })
  }
  private publish(change: Partial<TeamDashboardSurfaceState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
}

function t(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
}

function readyState(): TeamDashboardState {
  return {
    open: true,
    phase: 'ready',
    targetSessionId: 'session-fixture',
    data: {
      capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as SwarmReadCapabilitiesV1,
      projection: SWARM_READ_RPC_FIXTURES_V1.values.snapshot as SwarmHostReadProjectionV1,
    },
  }
}

function anchorRef(): RefObject<HTMLSpanElement> { return { current: null } }

async function render(node: ReactNode): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push(root)
  await act(async () => { root.render(node) })
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label)
  if (match === undefined) throw new Error(`button not found: ${label}`)
  return match
}

function labelledButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (match === null) throw new Error(`labelled button not found: ${label}`)
  return match
}

afterEach(async () => {
  while (mounted.length > 0) {
    const root = mounted.pop()
    if (root !== undefined) await act(async () => { root.unmount() })
  }
  document.body.replaceChildren()
})

describe('R3 DSH-native Team UI', () => {
  it('renders exactly one non-modal panel in the official Details seat and no floating card', async () => {
    const controller = new FakeController(readyState())
    const coordinator = new FakeCoordinator(controller)
    await render(<TeamDashboardDetails {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag,
      sessionId: 'session-fixture', t,
    } as unknown as TeamDashboardDetailsProps)} />)
    const panel = document.querySelector('[data-swarm-team-panel]')
    expect(panel?.getAttribute('role')).toBe('complementary')
    expect(document.querySelectorAll('[data-swarm-team-dashboard]')).toHaveLength(1)
    expect(document.querySelector('[data-swarm-team-card]')).toBeNull()
    expect(document.querySelector('[data-swarm-team-layer]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes from the official-style header action through the coordinator', async () => {
    const controller = new FakeController(readyState())
    const coordinator = new FakeCoordinator(controller)
    await render(<TeamDashboardDetails {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag,
      sessionId: 'session-fixture', t,
    } as unknown as TeamDashboardDetailsProps)} />)
    await act(async () => { labelledButton('Close Team details').click() })
    expect(controller.closeCalls).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-swarm-team-panel]')).toBeNull()
  })

  it('renders every read family and hands off only through the injected verifier', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => {})
    const coordinator = new FakeCoordinator(controller, handoff)
    await render(<TeamDashboardDetails {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag,
      sessionId: 'session-fixture', t,
    } as unknown as TeamDashboardDetailsProps)} />)
    const panel = document.querySelector('[data-swarm-team-panel]')
    expect(panel?.textContent).toContain('Fixture Team')
    expect(panel?.textContent).toContain('Budget')
    expect(panel?.textContent).toContain('Pending interactions')
    await act(async () => { button('Members').click() })
    expect(panel?.textContent).toContain('Members (0)')
    await act(async () => { button('Work').click() })
    expect(panel?.textContent).toContain('Attempts')
    await act(async () => { button('Details').click() })
    expect(panel?.textContent).toContain('Capabilities')
    await act(async () => { button('Open Captain Chat').click() })
    expect(handoff).toHaveBeenCalledTimes(1)
  })

  it('shows error/retry and closes from Escape only while focus is inside Team', async () => {
    const controller = new FakeController({
      open: true, phase: 'error', targetSessionId: 'missing',
      error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'not live' },
    })
    const anchor = anchorRef()
    const coordinator = new FakeCoordinator(controller)
    await render(<>
      <TeamDashboardAction {...({ anchorRef: anchor, coordinator, sessionId: 'missing', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardDetails {...({
        anchorRef: anchor, controller, coordinator, localeTag: coordinator.localeTag,
        sessionId: 'missing', t,
      } as unknown as TeamDashboardDetailsProps)} />
    </>)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('SWARM_RPC_TARGET_NOT_LIVE')
    await act(async () => { button('Retry').click() })
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    const retry = button('Retry')
    retry.focus()
    await act(async () => { retry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(controller.closeCalls).toHaveBeenCalledTimes(1)
  })

  it('keeps a rejected Captain handoff actionable', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => { throw new Error('binding changed') })
    const coordinator = new FakeCoordinator(controller, handoff)
    await render(<TeamDashboardDetails {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag,
      sessionId: 'session-fixture', t,
    } as unknown as TeamDashboardDetailsProps)} />)
    await act(async () => {
      button('Open Captain Chat').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(button('Open Captain Chat').disabled).toBe(false)
  })

  it('uses a two-state Team toggle and keeps the adjacent Tool action available', async () => {
    const controller = new FakeController({ open: false, phase: 'closed' })
    const coordinator = new FakeCoordinator(controller)
    await render(<TeamDashboardAction {...({
      anchorRef: anchorRef(), coordinator, sessionId: 'root-from-framework', t,
    } as unknown as TeamDashboardActionProps)} />)
    const team = labelledButton('Team')
    await act(async () => { team.click() })
    expect(team.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { team.click() })
    expect(team.getAttribute('aria-expanded')).toBe('false')
    expect(controller.closeCalls).toHaveBeenCalledTimes(1)
    await act(async () => { labelledButton('Tool details').click() })
    expect(coordinator.showToolDetails).toHaveBeenCalledTimes(1)
    expect(team.getAttribute('aria-controls')).toBe('swarm-team-surface')
  })

  it('marks a retained complete projection as stale instead of fresh', async () => {
    const controller = new FakeController({
      ...readyState(), phase: 'stale', error: { code: 'SWARM_RPC_UNAVAILABLE', message: 'offline' },
    })
    const coordinator = new FakeCoordinator(controller)
    await render(<TeamDashboardDetails {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag,
      sessionId: 'session-fixture', t,
    } as unknown as TeamDashboardDetailsProps)} />)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Showing the last complete projection')
    expect(document.querySelector('[data-swarm-team-panel]')?.textContent).toContain('Fixture Team')
  })

  it('uses official Details chrome without floating, compact, shadow, or Peek rules', () => {
    expect(TEAM_DASHBOARD_STYLES).not.toMatch(/position:\s*fixed|box-shadow|swarm-team-peek|presentation='compact'|swarm-team-layer/u)
    expect(TEAM_DASHBOARD_STYLES).toContain('[data-swarm-team-panel]')
    expect(TEAM_DASHBOARD_STYLES).toContain('background: var(--dsw-alias-bg-base)')
    expect(TEAM_DASHBOARD_STYLES).toContain('padding: 14px 12px 12px')
    expect(TEAM_DASHBOARD_STYLES).toContain('border-bottom: 1px solid var(--dsw-alias-border-l2)')
  })
})
