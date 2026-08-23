// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
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
  return {
    Button: ({ children, icon: _icon, variant: _variant, size: _size, ...props }: Record<string, unknown>) =>
      react.createElement('button', { type: 'button', ...props }, children as ReactNode),
    Pill: ({ children }: { children?: ReactNode }) => react.createElement('span', {}, children),
    StateDot: () => react.createElement('span', { 'aria-hidden': 'true' }),
    Modal: ({ open, onClose, title, children, footer }: {
      open: boolean; onClose: () => void; title: string; children?: ReactNode; footer?: ReactNode
    }) => {
      react.useEffect(() => {
        if (!open) return
        const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', listener)
        return () => { document.removeEventListener('keydown', listener) }
      }, [open, onClose])
      return open ? react.createElement('div', { role: 'dialog', 'aria-label': title }, children, footer) : null
    },
  }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mounted: Root[] = []

class FakeController {
  readonly openCalls: string[] = []
  readonly refresh = vi.fn()
  readonly reconnect = vi.fn()
  private readonly listeners = new Set<() => void>()

  constructor(private state: TeamDashboardState) {}

  getSnapshot = (): TeamDashboardState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  open = (sessionId: string): void => { this.openCalls.push(sessionId) }
  close = (): void => {
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

afterEach(async () => {
  while (mounted.length > 0) {
    const root = mounted.pop()
    if (root !== undefined) await act(async () => { root.unmount() })
  }
  document.body.replaceChildren()
})

describe('R3 DSH-native Team UI', () => {
  it('renders every read family in an accessible official dialog and hands off only through the injected verifier', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => {})
    await render(<TeamDashboardOverlay {...({ controller, openCaptainChat: handoff, t } as unknown as TeamDashboardOverlayProps)} />)

    const dialog = document.querySelector('[role="dialog"][aria-label="Agent Team"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Fixture Team')
    for (const heading of ['Members', 'Tasks', 'Attempts', 'Budget', 'Pending interactions', 'Capabilities']) {
      expect(dialog?.textContent).toContain(heading)
    }
    const chat = button('Open Captain Chat')
    expect(chat.disabled).toBe(false)
    await act(async () => { chat.click() })
    expect(handoff).toHaveBeenCalledTimes(1)
  })

  it('exposes error/retry without rendering stale authority as fresh data and closes on Escape', async () => {
    const controller = new FakeController({
      open: true, phase: 'error', targetSessionId: 'missing',
      error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'not live' },
    })
    await render(<TeamDashboardOverlay {...({ controller, openCaptainChat: vi.fn(), t } as unknown as TeamDashboardOverlayProps)} />)

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('SWARM_RPC_TARGET_NOT_LIVE')
    expect(document.querySelectorAll('section')).toHaveLength(0)
    await act(async () => { button('Retry').click() })
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('handles a rejected Captain handoff without leaking an unhandled rejection or locking the action', async () => {
    const controller = new FakeController(readyState())
    const handoff = vi.fn(async () => { throw new Error('binding changed') })
    await render(<TeamDashboardOverlay {...({ controller, openCaptainChat: handoff, t } as unknown as TeamDashboardOverlayProps)} />)

    await act(async () => {
      button('Open Captain Chat').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(button('Open Captain Chat').disabled).toBe(false)
  })

  it('uses the framework Session id only as the header action target hint', async () => {
    const controller = new FakeController({ open: false, phase: 'closed' })
    await render(<TeamDashboardAction {...({ controller, sessionId: 'root-from-framework', t } as unknown as TeamDashboardActionProps)} />)
    await act(async () => { button('Team').click() })
    expect(controller.openCalls).toEqual(['root-from-framework'])
  })
})
