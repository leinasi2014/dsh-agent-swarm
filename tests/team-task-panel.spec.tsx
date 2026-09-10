// @vitest-environment jsdom
import { FakeCoordinator, ready, render, t, tZh } from './helpers/dashboard-ui.js'
import { useTabInfo } from './helpers/sidebar-tab.js'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { SwarmReadTaskDetailV1 } from '../src/rpc/read-rpc-contract.js'

const start = 1_700_000_000_000
function fixture(): TeamDashboardState {
  const data = ready.data!, source = data.projection
  const tasks = [
    { id: 'task-a', revision: 3, subject: 'Repair the narrow layout', status: 'in_progress' as const, ownerName: 'worker', currentAttemptId: 'attempt-2', blockedBy: [], priority: 1, createdAt: start, updatedAt: start + 5000 },
    { id: 'task-b', revision: 1, subject: 'Review the profile', status: 'submitted' as const, ownerName: 'reviewer', blockedBy: [], priority: 1, createdAt: start, updatedAt: start + 3000 },
    { id: 'task-c', revision: 1, subject: 'Wait for omitted dependency', status: 'pending' as const, blockedBy: ['outside-page'], priority: 0, createdAt: start, updatedAt: start },
    { id: 'task-d', revision: 1, subject: 'Approved structure', status: 'completed' as const, blockedBy: [], priority: 0, createdAt: start, updatedAt: start + 1000 },
  ]
  const attempts = [
    { id: 'attempt-1', taskId: 'task-a', generation: 1, memberName: 'worker', phase: 'rejected' as const, assignmentPhase: 'delivered' as const, createdAt: start + 100, updatedAt: start + 2000 },
    { id: 'attempt-2', taskId: 'task-a', generation: 2, memberName: 'worker', phase: 'running' as const, assignmentPhase: 'reserved' as const, createdAt: start + 3000, updatedAt: start + 5000 },
  ]
  return { ...ready, data: { ...data, projection: { ...source, tasks, attempts, totals: { ...source.totals, tasks: 4, attempts: 2 }, truncated: { ...source.truncated, tasks: false, attempts: false } } } }
}
async function click(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector)
  expect(element, selector).not.toBeNull()
  await act(async () => { element!.click() })
}
async function mount(state = fixture(), translate = t) {
  const coordinator = new FakeCoordinator()
  const listeners = new Set<() => void>()
  const controller = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    readTaskDetail: async ({ taskId }: { taskId: string }): Promise<SwarmReadTaskDetailV1> => {
      const projection = state.data!.projection
      if (projection.truncated.attempts) throw new Error('Task detail unavailable in this fixture')
      const task = projection.tasks.find(row => row.id === taskId)
      if (task === undefined) throw new Error('Task detail unavailable in this fixture')
      const entries = projection.attempts.filter(row => row.taskId === taskId).map(row => ({ ...row, evidence: [] }))
      return { schemaVersion: 1, state: 'available', binding: projection.binding, taskId, teamRevision: projection.team.revision,
        task: { ...task, description: '', acceptanceCriteria: [] }, attempts: { scope: 'retained', entries, retainedCount: entries.length, returnedCount: entries.length, limit: 100, truncated: false }, observedAt: projection.observedAt }
    } }
  await render(<TeamDashboardDetails {...({ controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'main-brain', useTabInfo, t: translate } as any)} />)
  return { coordinator, setState: async (next: TeamDashboardState) => { await act(async () => { state = next; listeners.forEach(listener => listener()) }) } }
}

describe('V7 real task sidebar', () => {
  it.each([
    { language: 'English', translate: t, accepted: 'Accepted', assignment: 'Assignment record', reserved: 'Reserved', unsupported: 'not yet delivered' },
    { language: 'Chinese', translate: tZh, accepted: '已接受', assignment: '分派记录', reserved: '已预留', unsupported: '尚未送达' },
  ])('keeps an accepted attempt with a reserved assignment record factual in $language', async ({ translate, accepted, assignment, reserved, unsupported }) => {
    const state = fixture(), data = state.data!
    const tasks = data.projection.tasks.map(task => task.id === 'task-a' ? { ...task, status: 'completed' as const } : task)
    const attempts = data.projection.attempts.map(attempt => attempt.id === 'attempt-2' ? { ...attempt, phase: 'accepted' as const } : attempt)
    await mount({ ...state, data: { ...data, projection: { ...data.projection, tasks, attempts } } }, translate)
    const completed = document.querySelector<HTMLDetailsElement>('[data-swarm-task-group="completed"]')!
    await act(async () => { completed.open = true; completed.dispatchEvent(new Event('toggle', { bubbles: true })) })
    await click('[data-swarm-task-id="task-a"]')
    await click('[data-swarm-task-view="trace"]')
    const current = document.querySelector('[data-swarm-task-attempt="attempt-2"]')!
    expect(current.getAttribute('data-swarm-current-attempt')).toBe('true')
    expect(current.querySelector('summary')?.textContent).toContain(accepted)
    expect(current.textContent).not.toContain(unsupported)
    const assignmentLabel = [...current.querySelectorAll('dt')].find(label => label.textContent === assignment)
    expect(assignmentLabel?.nextElementSibling?.textContent).toBe(reserved)
  })

  it('defaults to one Tasks/Members/Team info tab strip and groups real task states', async () => {
    await mount()
    expect([...document.querySelectorAll('[data-swarm-view-tab]')].map(el => el.getAttribute('data-swarm-view-tab'))).toEqual(['tasks', 'members', 'info'])
    expect(document.querySelector('[data-swarm-view-tab="tasks"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-swarm-task-id="task-b"]')?.closest('[data-swarm-task-group]')?.getAttribute('data-swarm-task-group')).toBe('attention')
    expect(document.querySelector('[data-swarm-task-id="task-a"]')?.textContent).toContain('worker')
    expect(document.querySelector('[data-swarm-task-id="task-c"]')?.getAttribute('data-swarm-task-progress')).toBe('unknown')
    expect(document.querySelector('[data-swarm-task-id="task-d"]')?.closest('details')?.open).toBe(false)
  })

  it('shows both real generations, preserves selected trace and expanded rounds through close/reopen, and returns focus', async () => {
    const { coordinator } = await mount()
    await click('[data-swarm-view-tab="tasks"]')
    await click('[data-swarm-task-id="task-a"]')
    await click('[data-swarm-task-view="trace"]')
    expect(document.querySelectorAll('[data-swarm-task-attempt]')).toHaveLength(2)
    expect(document.querySelector('[data-swarm-task-attempt="attempt-1"]')?.textContent).toContain('Rejected')
    expect(document.querySelector('[data-swarm-task-attempt="attempt-2"]')?.getAttribute('data-swarm-current-attempt')).toBe('true')
    const oldRound = document.querySelector<HTMLDetailsElement>('[data-swarm-task-attempt="attempt-1"]')!
    await act(async () => { oldRound.open = true; oldRound.dispatchEvent(new Event('toggle', { bubbles: true })) })
    await act(async () => { coordinator.set({ mode: 'inactive', view: 'overview', targetSessionId: undefined }) })
    await act(async () => { coordinator.set({ mode: 'docked', view: 'overview', targetSessionId: 'main-brain' }) })
    expect(document.querySelector('[data-swarm-task-view="trace"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector<HTMLDetailsElement>('[data-swarm-task-attempt="attempt-1"]')?.open).toBe(true)
    await click('[data-swarm-detail-back]')
    expect(document.activeElement?.getAttribute('data-swarm-task-id')).toBe('task-a')
  })

  it('does not call a wrong-task attempt current or manufacture missing history and product fields', async () => {
    const state = fixture(), data = state.data!
    const attempts = data.projection.attempts.map(a => a.id === 'attempt-2' ? { ...a, taskId: 'another-task' } : a)
    await mount({ ...state, data: { ...data, projection: { ...data.projection, attempts, truncated: { ...data.projection.truncated, attempts: true } } } })
    await click('[data-swarm-view-tab="tasks"]')
    await click('[data-swarm-task-id="task-a"]')
    expect(document.querySelector('[data-swarm-task-detail-state]')?.textContent).toContain('could not be read')
    await click('[data-swarm-task-view="trace"]')
    expect(document.querySelector('[data-swarm-task-attempt="attempt-2"]')).toBeNull()
    expect(document.querySelector('[data-swarm-current-attempt="true"]')).toBeNull()
    expect(document.querySelector('[data-swarm-task-detail-state]')?.textContent).toContain('could not be read')
    expect(document.querySelector('[data-swarm-task-detail]')?.textContent).not.toContain('Review passed at')
  })

  it('isolates selected task and subview by root plus Team, including reused task IDs', async () => {
    const state = fixture(), { setState } = await mount(state)
    await click('[data-swarm-view-tab="tasks"]')
    await click('[data-swarm-task-id="task-a"]')
    await click('[data-swarm-task-view="trace"]')
    const other = { ...state, data: { ...state.data!, projection: { ...state.data!.projection, binding: { ...state.data!.projection.binding, rootSessionId: 'other-root' } } } }
    await setState(other)
    expect(document.querySelector('[data-swarm-task-view="trace"]')).toBeNull()
    expect(document.querySelector('[data-swarm-task-rows]')).not.toBeNull()
    await setState(state)
    expect(document.querySelector('[data-swarm-task-view="trace"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps the task subview while switching top tabs, and distinguishes a partial disappearance from authoritative removal', async () => {
    const state = fixture(), { setState } = await mount(state)
    await click('[data-swarm-task-id="task-a"]')
    await click('[data-swarm-task-view="trace"]')
    await click('[data-swarm-view-tab="members"]')
    await click('[data-swarm-view-tab="tasks"]')
    expect(document.querySelector('[data-swarm-task-view="trace"]')?.getAttribute('aria-selected')).toBe('true')
    const data = state.data!, tasks = data.projection.tasks.filter(task => task.id !== 'task-a')
    const partial = { ...state, data: { ...data, projection: { ...data.projection, cursor: `r1:${'e'.repeat(64)}`, tasks, truncated: { ...data.projection.truncated, tasks: true } } } }
    await setState(partial)
    expect(document.querySelector('[data-swarm-detail-view]')?.textContent).toContain('outside the available read')
    await setState(state)
    expect(document.querySelector('[data-swarm-task-view="trace"]')?.getAttribute('aria-selected')).toBe('true')
    await setState({ ...partial, data: { ...partial.data, projection: { ...partial.data.projection, totals: { ...data.projection.totals, tasks: tasks.length }, truncated: { ...data.projection.truncated, tasks: false } } } })
    expect(document.querySelector('[data-swarm-detail-view]')).toBeNull()
    expect(document.activeElement?.getAttribute('data-swarm-view-tab')).toBe('tasks')
  })

  it('distinguishes confirmed empty attempts from unavailable history and keeps target members separate from owners', async () => {
    const state = fixture(), data = state.data!
    const tasks = [{ ...data.projection.tasks[2]!, targetMemberName: 'worker' }]
    const complete = { ...state, data: { ...data, projection: { ...data.projection, tasks, attempts: [], totals: { ...data.projection.totals, tasks: 1, attempts: 0 } } } }
    const { setState } = await mount(complete)
    expect(document.querySelector('[data-swarm-task-owner]')?.getAttribute('data-swarm-task-owner')).toBe('Owner: Unassigned')
    expect(document.querySelector('[data-swarm-task-owner]')?.textContent).toContain('Target member: worker')
    await click('[data-swarm-task-id="task-c"]')
    await click('[data-swarm-task-view="trace"]')
    expect(document.querySelector('[data-swarm-task-trace]')?.textContent).toContain('No currently retained attempts')
    await setState({ ...complete, data: { ...complete.data, projection: { ...complete.data.projection, cursor: `r1:${'d'.repeat(64)}`, totals: { ...complete.data.projection.totals, attempts: 8 }, truncated: { ...complete.data.projection.truncated, attempts: true } } } })
    expect(document.querySelector('[data-swarm-task-detail-state]')?.textContent).toContain('could not be read')
    expect(document.querySelector('[data-swarm-task-detail]')?.textContent).not.toContain('No currently retained attempts')
  })

  it('opens only an active member Chat from the exact current Team binding', async () => {
    const state = fixture(), data = state.data!
    const member = { ...data.captainMembers.members[0]!, name: 'worker', phase: 'active' as const, sessionId: 'worker-session' }
    const bound = { ...state, data: { ...data, captainMembers: { ...data.captainMembers, binding: data.projection.binding, members: [member] }, projection: { ...data.projection, roster: [{ name: 'worker', role: 'Builder', phase: 'active' as const, createdAt: start }] } } }
    const { coordinator, setState } = await mount(bound)
    await click('[data-swarm-task-id="task-a"]')
    await click('[data-swarm-task-view="trace"]')
    await click('[data-swarm-task-attempt="attempt-2"] button')
    expect(coordinator.openMemberChat).toHaveBeenCalledExactlyOnceWith('worker', 'worker-session')
    await setState({ ...bound, data: { ...bound.data, captainMembers: { ...bound.data.captainMembers, binding: { ...data.projection.binding, rootSessionId: 'wrong-root' } } } })
    expect(document.querySelector('[data-swarm-task-attempt="attempt-2"] button')).toBeNull()
    await setState({ ...bound, data: { ...bound.data, projection: { ...bound.data.projection, roster: [{ ...bound.data.projection.roster[0]!, phase: 'removed' }] } } })
    expect(document.querySelector('[data-swarm-task-attempt="attempt-2"] button')).toBeNull()
  })
})
