// @vitest-environment jsdom
import { act, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import type { SwarmReadCapabilitiesV1 } from '../src/rpc/read-rpc-contract.js'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'
import { TeamDashboardAction, type TeamDashboardActionProps } from '../src/client/TeamDashboardAction.js'
import { TeamDashboardOverlay, type TeamDashboardOverlayProps } from '../src/client/TeamDashboardOverlay.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { en } from '../src/client/team-dashboard-locales.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  const Icon = () => react.createElement('svg', { 'aria-hidden': 'true' })
  return {
    Button: ({ children, icon: _icon, variant: _variant, size: _size, ...props }: Record<string, unknown>) =>
      react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    Pill: ({ children }: { children?: ReactNode }) => react.createElement('span', {}, children),
    StateDot: () => react.createElement('span', { 'aria-hidden': 'true' }),
    IconUserOutline16: Icon,
    IconCloseOutline16: Icon,
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
    this.state = { open: true, phase: 'loading', targetSessionId: sessionId }
    for (const listener of this.listeners) listener()
  }
  close = (): void => {
    this.closeCalls()
    this.state = { open: false, phase: 'closed' }
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
  it('renders every real read family in a non-modal anchored Peek Card and hands off only through the injected verifier', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => {})
    await render(<TeamDashboardOverlay {...({ anchorRef: anchorRef(), controller, openCaptainChat: handoff, t } as unknown as TeamDashboardOverlayProps)} />)

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
    await render(<>
      <TeamDashboardAction {...({ anchorRef: anchor, controller, sessionId: 'missing', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardOverlay {...({ anchorRef: anchor, controller, openCaptainChat: vi.fn(), t } as unknown as TeamDashboardOverlayProps)} />
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
    await render(<TeamDashboardOverlay {...({ anchorRef: anchorRef(), controller, openCaptainChat: handoff, t } as unknown as TeamDashboardOverlayProps)} />)

    await act(async () => {
      button('Open Captain Chat').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(button('Open Captain Chat').disabled).toBe(false)
  })

  it('uses framework Session ids only as target hints and toggles the current target', async () => {
    const controller = new FakeController({ open: false, phase: 'closed' })
    await render(<>
      <TeamDashboardAction {...({ anchorRef: anchorRef(), controller, sessionId: 'root-from-framework', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardAction {...({ anchorRef: anchorRef(), controller, sessionId: 'other-root', t } as unknown as TeamDashboardActionProps)} />
    </>)
    const triggers = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Team"]')]
    await act(async () => { triggers[0]?.click() })
    expect(triggers[0]?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { triggers[0]?.click() })
    expect(controller.closeCalls).toHaveBeenCalledTimes(1)
    await act(async () => { triggers[1]?.click() })
    expect(controller.openCalls).toEqual(['root-from-framework', 'other-root'])
    expect(triggers[1]?.getAttribute('aria-controls')).toBe('swarm-team-peek-card')
  })

  it('dismisses on an outside pointer without stealing focus and ignores the card and trigger', async () => {
    const controller = new FakeController(readyState())
    const anchor = anchorRef()
    await render(<>
      <button type="button" data-chat-composer>Composer</button>
      <TeamDashboardAction {...({ anchorRef: anchor, controller, sessionId: 'session-fixture', t } as unknown as TeamDashboardActionProps)} />
      <TeamDashboardOverlay {...({ anchorRef: anchor, controller, openCaptainChat: vi.fn(), t } as unknown as TeamDashboardOverlayProps)} />
    </>)

    const card = document.querySelector<HTMLElement>('[data-swarm-team-card]')
    const trigger = labelledButton('Team')
    await act(async () => { card?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    await act(async () => { trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(controller.closeCalls).not.toHaveBeenCalled()

    const composer = document.querySelector<HTMLButtonElement>('[data-chat-composer]')
    composer?.focus()
    await act(async () => { composer?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(controller.closeCalls).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(composer)
  })

  it('marks a retained complete projection as stale instead of fresh', async () => {
    const state = { ...readyState(), phase: 'stale' as const, error: { code: 'SWARM_RPC_UNAVAILABLE', message: 'offline' } }
    const controller = new FakeController(state)
    await render(<TeamDashboardOverlay {...({ anchorRef: anchorRef(), controller, openCaptainChat: vi.fn(), t } as unknown as TeamDashboardOverlayProps)} />)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Showing the last complete projection')
    expect(document.querySelector('[data-swarm-team-card]')?.textContent).toContain('Fixture Team')
  })
})
