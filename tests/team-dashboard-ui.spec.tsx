// @vitest-environment jsdom
import { act, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import type { SwarmReadCapabilitiesV1 } from '../src/rpc/read-rpc-contract.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'
import { TeamDashboardAction, type TeamDashboardActionProps } from '../src/client/TeamDashboardAction.js'
import { TeamDashboardOverlay, type TeamDashboardOverlayProps } from '../src/client/TeamDashboardOverlay.js'
import { TeamDashboardDetails, type TeamDashboardDetailsProps } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { en } from '../src/client/team-dashboard-locales.js'
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
    useAnchoredPosition: () => ({ left: 16, top: 48 }),
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
    this.state = { open: true, phase: 'loading', presentation: 'expanded', targetSessionId: sessionId }
    for (const listener of this.listeners) listener()
  }
  cycle = (sessionId: string): void => {
    if (!this.state.open || this.state.targetSessionId !== sessionId) {
      this.open(sessionId)
    } else if (this.state.presentation !== 'compact') {
      this.state = { ...this.state, presentation: 'compact' }
      for (const listener of this.listeners) listener()
    } else {
      this.close()
    }
  }
  close = (): void => {
    this.closeCalls()
    this.state = { open: false, phase: 'closed' }
    for (const listener of this.listeners) listener()
  }
}

class FakeCoordinator {
  readonly closeAndRestoreFocus = vi.fn(() => { this.close() })
  readonly dismiss = vi.fn(() => { this.close() })
  readonly showToolDetails = vi.fn()
  private readonly listeners = new Set<() => void>()
  private state: TeamDashboardSurfaceState

  constructor(
    private readonly controller: FakeController,
    private readonly handoff: () => Promise<void> = async () => {},
    safeWidth = false,
  ) {
    const controllerState = controller.getSnapshot()
    this.state = {
      mode: controllerState.open ? (controllerState.presentation === 'compact' ? 'compact' : 'peek') : 'inactive',
      view: 'overview',
      safeWidth,
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
  commitDocked = (targetSessionId: string): void => {
    this.publish({ mode: 'docked', safeWidth: true, targetSessionId })
  }
  cycle = (sessionId: string): void => {
    this.controller.cycle(sessionId)
    const controller = this.controller.getSnapshot()
    this.publish({
      mode: controller.open ? (controller.presentation === 'compact' ? 'compact' : 'peek') : 'inactive',
      targetSessionId: controller.targetSessionId,
    })
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
    presentation: 'expanded',
    targetSessionId: 'session-fixture',
    data: {
      capabilities: SWARM_READ_RPC_FIXTURES_V1.values.capabilities as SwarmReadCapabilitiesV1,
      projection: SWARM_READ_RPC_FIXTURES_V1.values.snapshot as SwarmHostReadProjectionV1,
    },
  }
}

function anchorRef(): RefObject<HTMLSpanElement> {
  return { current: null }
}

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
  it('commits one real complementary surface in the official Details seat without adding a main landmark', async () => {
    const controller = new FakeController(readyState())
    const coordinator = new FakeCoordinator(controller, async () => {}, true)
    coordinator.commitDocked('session-fixture')
    await render(<TeamDashboardDetails {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag,
      sessionId: 'session-fixture', t,
    } as unknown as TeamDashboardDetailsProps)} />)
    expect(document.querySelectorAll('[data-swarm-team-dashboard]')).toHaveLength(1)
    expect(document.querySelector('[data-swarm-team-dashboard]')?.getAttribute('role')).toBe('complementary')
    expect(document.querySelector('[data-swarm-team-dashboard] main')).toBeNull()
    expect(document.querySelector('[role="tablist"]')).toBeNull()
  })

  it('renders every real read family in a non-modal anchored Peek Card and hands off only through the injected verifier', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => {})
    const coordinator = new FakeCoordinator(controller, handoff)
    await render(<TeamDashboardOverlay {...({ anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag, t } as unknown as TeamDashboardOverlayProps)} />)

    const card = document.querySelector('[data-swarm-team-card]')
    expect(card?.getAttribute('role')).toBe('complementary')
    expect(card?.getAttribute('aria-modal')).not.toBe('true')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(card?.textContent).toContain('Fixture Team')
    expect(card?.textContent).toContain('Budget')
    expect(card?.textContent).toContain('Pending interactions')
    await act(async () => { button('Members').click() })
    expect(card?.textContent).toContain('Members (0)')
    await act(async () => { button('Work').click() })
    expect(card?.textContent).toContain('Attempts')
    await act(async () => { button('Details').click() })
    expect(card?.textContent).toContain('Capabilities')
    const chat = button('Open Captain Chat')
    expect(chat.disabled).toBe(false)
    await act(async () => { chat.click() })
    expect(handoff).toHaveBeenCalledTimes(1)
  })

  it('exposes error/retry without rendering authority and closes on Escape with trigger focus restored', async () => {
    const controller = new FakeController({
      open: true, phase: 'error', targetSessionId: 'missing',
      error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'not live' },
    })
    const anchor = anchorRef()
    const coordinator = new FakeCoordinator(controller)
    await render(<>
      <TeamDashboardAction {...({ anchorRef: anchor, coordinator, sessionId: 'missing', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardOverlay {...({ anchorRef: anchor, controller, coordinator, localeTag: coordinator.localeTag, t } as unknown as TeamDashboardOverlayProps)} />
    </>)

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('SWARM_RPC_TARGET_NOT_LIVE')
    expect(document.querySelectorAll('section')).toHaveLength(0)
    await act(async () => { button('Retry').click() })
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    const trigger = labelledButton('Team')
    trigger.focus()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[data-swarm-team-card]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('handles a rejected Captain handoff without leaking an unhandled rejection or locking the action', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => { throw new Error('binding changed') })
    const coordinator = new FakeCoordinator(controller, handoff)
    await render(<TeamDashboardOverlay {...({ anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag, t } as unknown as TeamDashboardOverlayProps)} />)

    await act(async () => {
      button('Open Captain Chat').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(button('Open Captain Chat').disabled).toBe(false)
  })

  it('uses framework Session ids only as target hints and cycles expanded, compact, then closed', async () => {
    const controller = new FakeController({ open: false, phase: 'closed' })
    const coordinator = new FakeCoordinator(controller)
    await render(<>
      <TeamDashboardAction {...({ anchorRef: anchorRef(), coordinator, sessionId: 'root-from-framework', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardAction {...({ anchorRef: anchorRef(), coordinator, sessionId: 'other-root', t } as unknown as TeamDashboardActionProps)} />
    </>)
    const triggers = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Team"]')]
    await act(async () => { triggers[0]?.click() })
    expect(triggers[0]?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { triggers[0]?.click() })
    expect(controller.getSnapshot().presentation).toBe('compact')
    expect(triggers[0]?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { triggers[0]?.click() })
    expect(controller.closeCalls).toHaveBeenCalledTimes(1)
    await act(async () => { triggers[1]?.click() })
    expect(controller.openCalls).toEqual(['root-from-framework', 'other-root'])
    expect(triggers[1]?.getAttribute('aria-controls')).toBe('swarm-team-surface')
  })

  it('renders compact mode as a real-data summary without the full controls', async () => {
    const controller = new FakeController({ ...readyState(), presentation: 'compact' })
    const coordinator = new FakeCoordinator(controller)
    await render(<TeamDashboardOverlay {...({
      anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag, t,
    } as unknown as TeamDashboardOverlayProps)} />)

    const card = document.querySelector('[data-swarm-team-card]')
    expect(card?.getAttribute('data-presentation')).toBe('compact')
    expect(card?.textContent).toContain('Fixture Team')
    expect(card?.textContent).toContain('Members')
    expect(card?.textContent).toContain('Tasks')
    expect(card?.textContent).toContain('Pending interactions')
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some(item => item.textContent?.includes('Open Captain Chat'))).toBe(false)
  })

  it('dismisses on an outside pointer without stealing focus and ignores the card and trigger', async () => {
    const controller = new FakeController(readyState())
    const anchor = anchorRef()
    const coordinator = new FakeCoordinator(controller)
    await render(<>
      <button type="button" data-chat-composer>Composer</button>
      <TeamDashboardAction {...({ anchorRef: anchor, coordinator, sessionId: 'session-fixture', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardOverlay {...({ anchorRef: anchor, controller, coordinator, localeTag: coordinator.localeTag, t } as unknown as TeamDashboardOverlayProps)} />
    </>)

    const card = document.querySelector<HTMLElement>('[data-swarm-team-card]')
    const trigger = labelledButton('Team')
    await act(async () => { card?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    await act(async () => { trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(coordinator.dismiss).not.toHaveBeenCalled()

    const composer = document.querySelector<HTMLButtonElement>('[data-chat-composer]')
    composer?.focus()
    await act(async () => { composer?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(coordinator.dismiss).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(composer)
  })

  it('marks a retained complete projection as stale instead of fresh', async () => {
    const state = { ...readyState(), phase: 'stale' as const, error: { code: 'SWARM_RPC_UNAVAILABLE', message: 'offline' } }
    const controller = new FakeController(state)
    const coordinator = new FakeCoordinator(controller)
    await render(<TeamDashboardOverlay {...({ anchorRef: anchorRef(), controller, coordinator, localeTag: coordinator.localeTag, t } as unknown as TeamDashboardOverlayProps)} />)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Showing the last complete projection')
    expect(document.querySelector('[data-swarm-team-card]')?.textContent).toContain('Fixture Team')
  })
})
