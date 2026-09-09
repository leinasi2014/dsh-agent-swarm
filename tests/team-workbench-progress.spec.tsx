// @vitest-environment jsdom
import { useTabInfo } from './helpers/sidebar-tab.js'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { t, ready, teamData, FakeCoordinator, render, pressEscape } from './helpers/dashboard-ui.js'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

type Task = SwarmHostReadProjectionV1['tasks'][number]
const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, status, revision: 1, subject: `Subject ${id}`, blockedBy: [], priority: 1, createdAt: 1, updatedAt: 2, ...extra,
})
async function mount(extra: Partial<SwarmHostReadProjectionV1>) {
  const projection = { ...ready.data!.projection, ...extra }
  let state: TeamDashboardState = { ...ready, data: teamData(ready.data!.capabilities, projection) }
  let notify = () => {}
  const coordinator = new FakeCoordinator()
  const controller = { getSnapshot: () => state, subscribe: (listener: () => void) => { notify = listener; return () => {} }, refresh: vi.fn(), reconnect: vi.fn() }
  await render(<TeamDashboardDetails {...({ anchorRef: { current: null }, controller, coordinator, useTabInfo, localeTag: coordinator.localeTag, sessionId: 'main-brain', t } as any)} />)
  return { update: (patch: Partial<TeamDashboardState>) => { state = { ...state, ...patch }; notify() } }
}

describe('at-a-glance Team progress and execution hierarchy', () => {
  it('distinguishes completion, work, review, dependency waiting and failures without invented model progress', async () => {
    const tasks = [task('done', 'completed'), task('run', 'in_progress'), task('review', 'submitted'), task('verify', 'verifying'), task('blocked', 'pending', { blockedBy: ['run'] }), task('ready', 'pending', { blockedBy: ['done'] }), task('failed', 'failed'), task('cancelled', 'cancelled')]
    await mount({ tasks, totals: { ...ready.data!.projection.totals, tasks: 8 }, truncated: { ...ready.data!.projection.truncated, tasks: false } })
    for (const [state, count] of Object.entries({ completed: 1, running: 1, review: 2, blocked: 1, ready: 1, failed: 1, cancelled: 1 })) {
      expect(document.querySelector(`[data-swarm-progress-state="${state}"]`)?.getAttribute('data-count')).toBe(String(count))
    }
    const bar = document.querySelector('[role="progressbar"]')!
    expect(bar.closest('details:not([open])')).toBeNull()
    expect(bar.getAttribute('aria-valuenow')).toBe('1')
    expect(bar.getAttribute('aria-valuemax')).toBe('8')
    expect(document.querySelector('[data-swarm-review-attention]')?.textContent).toContain('2')
    expect(document.querySelector('[data-swarm-review-attention]')?.closest('details:not([open])')).toBeNull()
    expect(document.querySelector('[data-swarm-staged-plan]')).toBeNull()
  })

  it('labels partial task counts and never shows the visible subset as total completion', async () => {
    await mount({ tasks: [task('done', 'completed'), task('run', 'in_progress')], totals: { ...ready.data!.projection.totals, tasks: 19 }, truncated: { ...ready.data!.projection.truncated, tasks: true } })
    expect(document.querySelector('[data-swarm-progress-partial]')?.textContent).toContain('2 of 19')
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('keeps an omitted dependency unknown unless a visible dependency proves the task blocked', async () => {
    await mount({ tasks: [task('unknown', 'pending', { blockedBy: ['omitted'] }), task('busy', 'in_progress'), task('blocked', 'pending', { blockedBy: ['omitted', 'busy'] })], totals: { ...ready.data!.projection.totals, tasks: 200 }, truncated: { ...ready.data!.projection.truncated, tasks: true } })
    expect(document.querySelector('[data-swarm-progress-state="unknown"]')?.getAttribute('data-count')).toBe('1')
    expect(document.querySelector('[data-swarm-progress-state="blocked"]')?.getAttribute('data-count')).toBe('1')
    expect(document.querySelector('[data-swarm-progress-state="ready"]')).toBeNull()
  })

  it('keeps stale and reconnecting warnings visible when an open detail retains cached data', async () => {
    const mounted = await mount({ roster: [{ name: 'worker', role: 'Verifier', phase: 'active', createdAt: 1 }] })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-member-name="worker"]')!.click() })
    await act(async () => { mounted.update({ phase: 'stale', error: { code: 'SWARM_UI_READ_FAILED', message: 'connection lost' } }) })
    const warning = document.querySelector('[role="alert"]')!
    expect(warning.textContent).toContain('connection lost')
    expect(warning.closest('[hidden]')).toBeNull()
    expect(document.querySelector('[data-swarm-detail-view]')).not.toBeNull()
    await act(async () => { mounted.update({ phase: 'reconnecting' }) })
    const reconnecting = document.querySelector('[role="status"]')!
    expect(reconnecting.textContent).toContain('Reconnecting')
    expect(reconnecting.closest('[hidden]')).toBeNull()
  })

  it('connects the current member task to inline details and ignores a stale running attempt', async () => {
    await mount({
      roster: [{ name: 'worker', role: 'Verifier', phase: 'active', createdAt: 1 }],
      tasks: [task('current', 'in_progress', { ownerName: 'worker', currentAttemptId: 'new' }), task('old-task', 'completed', { ownerName: 'worker', currentAttemptId: 'accepted' })],
      attempts: [
        { id: 'new', taskId: 'current', memberName: 'worker', generation: 2, phase: 'running', assignmentPhase: 'delivered', createdAt: 2, updatedAt: 3 },
        { id: 'stale', taskId: 'current', memberName: 'worker', generation: 1, phase: 'running', assignmentPhase: 'delivered', createdAt: 1, updatedAt: 9 },
        { id: 'accepted', taskId: 'old-task', memberName: 'worker', generation: 1, phase: 'accepted', assignmentPhase: 'delivered', createdAt: 1, updatedAt: 2 },
      ],
    })
    const entry = document.querySelector<HTMLButtonElement>('[data-swarm-tree-task="current"]')!
    expect(entry).not.toBeNull()
    expect(entry.closest('[data-swarm-member-branch]')?.getAttribute('data-swarm-member-branch')).toBe('worker')
    expect(entry.getAttribute('data-swarm-current-attempt')).toBe('new')
    expect(document.querySelector('[data-swarm-tree-task="old-task"]')).toBeNull()
    entry.focus()
    await act(async () => { entry.click() })
    expect(document.querySelector('[data-swarm-detail-view]')?.getAttribute('role')).toBe('region')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector<HTMLElement>('[data-swarm-workbench-browse]')?.hidden).toBe(true)
    await pressEscape()
    expect(document.activeElement).toBe(entry)
  })
})
