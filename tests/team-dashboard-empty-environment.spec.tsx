// @vitest-environment jsdom
import type React from 'react'
import { useTabInfo } from './helpers/sidebar-tab.js'
import { FakeCoordinator } from './helpers/dashboard-ui.js'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient, type SwarmFetch } from '../src/client/read-client.js'
import { zh } from '../src/client/team-dashboard-locales.js'
import { publicChatStatusKey } from '../src/client/team-dashboard-view-helpers.js'
import { goodFetch, teams, success, requestOf, ManualSchedule } from './helpers/dashboard-controller.js'

const tZh = (key: keyof typeof zh): string => zh[key]

/** Evidence spec: the deterministic controller phase when the server has no Team at all. */
describe('empty Team environment', () => {
  it('fails closed to the error phase with SWARM_UI_NO_VISIBLE_TEAM and keeps retrying', async () => {
    const attempts: string[] = []
    const validCapabilities = goodFetch([])
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      attempts.push(request.method)
      if (request.method === 'capabilities') return await validCapabilities(input, init)
      if (request.method === 'teams') return success({ ...teams, teams: [] })
      throw new Error(`unexpected method ${request.method}`)
    }
    const schedule = new ManualSchedule()
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), schedule)
    controller.open('root-1')
    // The capabilities + teams enumeration resolves; resolveTeamId then fails closed.
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('error'))
    const first = controller.getSnapshot()
    expect(first).toMatchObject({ open: true, phase: 'error', targetSessionId: 'root-1' })
    expect(first.data).toBeUndefined()
    expect(first.error).toMatchObject({ code: 'SWARM_UI_NO_VISIBLE_TEAM', message: 'No visible Team to bind the Team dashboard' })
    // The failure schedules a retry; the retried load first publishes the transient
    // 'reconnecting' phase (:305-306) and then settles back on the same error terminal.
    schedule.fire()
    await vi.waitFor(() => expect(attempts.filter(method => method === 'teams').length).toBeGreaterThanOrEqual(2))
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('error'))
    expect(controller.getSnapshot().error).toMatchObject({ code: 'SWARM_UI_NO_VISIBLE_TEAM' })
    controller.dispose()
  })

  it('distinguishes a transient read error from the no-Team fail-closed error', async () => {
    const fetcher: SwarmFetch = async (_input, init) => {
      const request = requestOf(init)
      if (request.method === 'capabilities') return success({ trust: { listener: 'loopback', principalBound: false, mode: 'local-single-user-target-bound' } })
      return new Response(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'SWARM_UI_READ_FAILED', message: 'network down' } }), { status: 500 })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('error'))
    expect(controller.getSnapshot().error).toMatchObject({ code: 'SWARM_UI_READ_FAILED' })
    controller.dispose()
  })

  // Current-behavior pin: a read that never settles keeps the dashboard in the
  // initial loading phase forever, and <Empty> renders the loading locale —
  // the exact symptom observed in the real no-Team environment.
  it('stays in the loading phase and renders the loading copy while a read never settles', async () => {
    const fetcher: SwarmFetch = () => new Promise<Response>(() => {})
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    const state = controller.getSnapshot()
    expect(state).toMatchObject({ open: true, phase: 'loading', targetSessionId: 'root-1' })
    expect(state.data).toBeUndefined()
    await Promise.resolve()
    await act(async () => {})
    expect(controller.getSnapshot().phase).toBe('loading')
    const stubController = { getSnapshot: () => state, subscribe: (): (() => void) => () => {}, refresh: vi.fn(), reconnect: vi.fn() }
    const coordinator = new FakeCoordinator()
    coordinator.set({ mode: 'docked', view: 'overview', targetSessionId: 'root-1' })
    const container = document.body.appendChild(document.createElement('div'))
    const root: Root = createRoot(container)
    await act(async () => {
      const detailsProps = { anchorRef: { current: null }, controller: stubController, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'root-1', t: tZh } as never as React.ComponentProps<typeof TeamDashboardDetails>
      root.render(<TeamDashboardDetails {...detailsProps} />)
    })
    expect(container.querySelector('[data-swarm-empty-shell]')).not.toBeNull()
    expect(container.querySelector('[data-swarm-empty-state]')).not.toBeNull()
    expect(container.textContent).toContain('正在读取权威团队投影…')
    expect(container.textContent).not.toContain('团队状态暂不可用')
    await act(async () => { root.unmount() })
    container.remove()
    controller.dispose()
  })

  // Regression for the observed real-environment symptom: the public-chat face must not
  // borrow the loading copy for a closed panel or a verified empty-Team directory.
  it('maps the public-chat status copy deterministically for empty environments', () => {
    expect(publicChatStatusKey({ phase: 'closed' })).toBe('public.needSession')
    expect(publicChatStatusKey({ phase: 'loading' })).toBe('loading')
    expect(publicChatStatusKey({ phase: 'reconnecting' })).toBe('loading')
    expect(publicChatStatusKey({ phase: 'error', error: { code: 'SWARM_UI_NO_VISIBLE_TEAM' } })).toBe('public.noTeamYet')
    expect(publicChatStatusKey({ phase: 'error', error: { code: 'SWARM_UI_READ_FAILED' } })).toBe('error')
    expect(publicChatStatusKey({ phase: 'ready', data: { teams: { complete: true, teams: [] } } })).toBe('public.noTeamYet')
    expect(publicChatStatusKey({ phase: 'ready', data: { teams: { complete: true, teams: [{ phase: 'archived' }] } } })).toBe('public.noTeamYet')
    expect(publicChatStatusKey({ phase: 'ready', data: { teams: { complete: true, teams: [{ phase: 'active' }] } } })).toBe('loading')
    expect(publicChatStatusKey({ phase: 'ready', data: { teams: { complete: false, teams: [] } } })).toBe('loading')
    expect(zh['public.noTeamYet']).toContain('尚无团队')
    expect(zh['public.needSession']).toContain('请先打开一个会话')
  })
})
