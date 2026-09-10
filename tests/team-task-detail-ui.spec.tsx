// @vitest-environment jsdom
import { FakeCoordinator, ready, render, t, tZh } from './helpers/dashboard-ui.js'
import { useTabInfo } from './helpers/sidebar-tab.js'
import { act } from 'react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import type { SwarmReadTaskDetailV1 } from '../src/rpc/read-rpc-contract.js'

const stamp = 1_700_000_000_000
function fixture(): TeamDashboardState {
  const data = ready.data!, projection = data.projection
  const tasks = ['task-a', 'task-b'].map(id => ({ id, revision: 2, subject: id, status: 'in_progress' as const, ownerName: 'worker', currentAttemptId: `${id}-attempt`, blockedBy: [], priority: 0, createdAt: stamp, updatedAt: stamp + 100 }))
  return { ...ready, targetSessionId: 'main-brain', data: { ...data, projection: { ...projection, tasks, attempts: [], totals: { ...projection.totals, tasks: 2, attempts: 0 }, truncated: { ...projection.truncated, tasks: false, attempts: false } } } }
}
function detail(state = fixture(), taskId = 'task-a'): SwarmReadTaskDetailV1 {
  const projection = state.data!.projection, task = projection.tasks.find(row => row.id === taskId)!
  return { schemaVersion: 1, state: 'available', binding: projection.binding, taskId, teamRevision: projection.team.revision,
    task: { ...task, description: `Description ${taskId}\n<img src=x onerror=alert(1)>`, acceptanceCriteria: ['Criterion one', 'Criterion two'], output: 'Recorded task output' },
    attempts: { scope: 'retained', retainedCount: 1, returnedCount: 1, limit: 100, truncated: false,
      entries: [{ id: task.currentAttemptId!, taskId, generation: 2, memberName: 'worker', phase: 'accepted', assignmentPhase: 'reserved', createdAt: stamp, updatedAt: stamp + 100,
        output: 'Recorded attempt output', evidence: ['file:///unverified.txt', '<script>bad()</script>'], diagnostic: 'Recorded diagnostic', assignmentDeliveredAt: stamp + 20, replacesAttemptId: 'prior-attempt' }] }, observedAt: stamp }
}
async function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector)
  expect(element, selector).not.toBeNull()
  await act(async () => { element!.click() })
}
type DetailReader = (target: { taskId: string }, signal: AbortSignal) => Promise<SwarmReadTaskDetailV1>
async function mount(read: Mock<DetailReader> = vi.fn(async target => detail(fixture(), target.taskId)), translate = t) {
  let state = fixture()
  const coordinator = new FakeCoordinator(), listeners = new Set<() => void>()
  const controller = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, readTaskDetail: read }
  await render(<TeamDashboardDetails {...({ controller, coordinator, localeTag: coordinator.localeTag, sessionId: 'main-brain', useTabInfo, t: translate } as any)} />)
  return { read, coordinator, setState: async (next: TeamDashboardState) => { await act(async () => { state = next; listeners.forEach(listener => listener()) }) } }
}

describe('real task detail UI', () => {
  it.each([{ language: 'English', translate: t, description: 'Description', diagnostic: 'Diagnostic record', scope: 'currently retained', missing: 'not provided by this read interface' },
    { language: 'Chinese', translate: tZh, description: '任务正文', diagnostic: '诊断记录', scope: '当前保留', missing: '当前接口未提供来源、审核者和阶段事件' }])('shows actual fields and opaque evidence as safe text in $language', async ({ translate, description, diagnostic, scope, missing }) => {
    await mount(undefined, translate)
    await click('[data-swarm-task-id="task-a"]')
    expect(document.querySelector('[data-swarm-task-description]')?.textContent).toContain('Description task-a\n<img src=x onerror=alert(1)>')
    expect(document.querySelector('[data-swarm-task-detail]')?.textContent).toContain(description)
    expect(document.querySelector('[data-swarm-task-criteria]')?.textContent).toContain('Criterion two')
    expect(document.querySelector('[data-swarm-task-output]')?.textContent).toBe('Recorded task output')
    expect(document.querySelector('[data-swarm-task-detail] img')).toBeNull()
    await click('[data-swarm-task-view="trace"]')
    const trace = document.querySelector('[data-swarm-task-trace]')!
    expect(trace.textContent).toContain('Recorded attempt output')
    expect(trace.textContent).toContain('Recorded diagnostic')
    expect(trace.textContent).toContain(diagnostic)
    expect(trace.textContent).toContain(scope)
    expect(trace.textContent).toContain('prior-attempt')
    expect(trace.textContent).toContain('file:///unverified.txt')
    expect(trace.textContent).toContain('<script>bad()</script>')
    expect(trace.textContent).toContain(missing)
    expect(trace.querySelector('a,script,img')).toBeNull()
    expect(trace.querySelector('[data-swarm-delivery-checkpoint] time')?.getAttribute('datetime')).toBe(new Date(stamp + 20).toISOString())
    expect(trace.textContent).not.toMatch(/Review passed at|审核通过时间|审核原因/u)
  })

  it('reads once on open, ignores unchanged successful polls and subviews, and refreshes on a changed stable cursor', async () => {
    const { read, setState } = await mount(), state = fixture()
    expect(read).not.toHaveBeenCalled()
    await click('[data-swarm-task-id="task-a"]')
    expect(read).toHaveBeenCalledTimes(1)
    await click('[data-swarm-task-view="trace"]'); await click('[data-swarm-task-view="overview"]')
    await setState({ ...state, data: { ...state.data!, projection: { ...state.data!.projection, observedAt: stamp + 5000 } } })
    expect(read).toHaveBeenCalledTimes(1)
    await setState({ ...state, data: { ...state.data!, projection: { ...state.data!.projection, cursor: `r1:${'b'.repeat(64)}`, team: { ...state.data!.projection.team, revision: state.data!.projection.team.revision + 1 } } } })
    expect(read).toHaveBeenCalledTimes(2)
    await click('[data-swarm-detail-back]')
    await setState(state)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer detail header and body on the same revision instead of mixing the old snapshot owner and status', async () => {
    const value = detail(), updated = stamp + 50_000
    await mount(vi.fn(async () => ({ ...value, teamRevision: value.teamRevision + 1,
      task: { ...value.task, revision: value.task.revision + 1, status: 'completed' as const, ownerName: 'new-owner', updatedAt: updated, output: '' } })))
    await click('[data-swarm-task-id="task-a"]')
    const panel = document.querySelector('[data-swarm-detail-view]')!
    expect(panel.textContent).toContain('Owner: new-owner')
    expect(panel.textContent).toContain('Completed')
    expect(panel.textContent).not.toContain('Owner: worker')
    expect([...panel.querySelectorAll('time')].some(time => time.getAttribute('datetime') === new Date(updated).toISOString())).toBe(true)
    expect(document.querySelector('[data-swarm-task-output]')?.textContent).toBe('Recorded empty text')
  })

  it('ends the visible detail lease on a Session switch and re-reads when its Session becomes visible again', async () => {
    const pending: { signal: AbortSignal; resolve: (value: SwarmReadTaskDetailV1) => void }[] = []
    const read = vi.fn<DetailReader>((_target, signal) => new Promise(resolve => { pending.push({ signal, resolve }) }))
    const { setState } = await mount(read), state = fixture()
    await click('[data-swarm-task-id="task-a"]')
    await setState({ ...state, targetSessionId: 'different-session' })
    expect(pending[0]!.signal.aborted).toBe(true)
    expect(document.querySelector('[data-swarm-task-panel]')).toBeNull()
    await setState(state)
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { pending[0]!.resolve(detail()) })
    expect(document.querySelector('[data-swarm-task-description]')).toBeNull()
    await act(async () => { pending[1]!.resolve(detail()) })
    expect(document.querySelector('[data-swarm-task-description]')).not.toBeNull()
  })

  it('cancels A on B selection and never publishes late A, even when cancellation is ignored', async () => {
    const pending: { target: { taskId: string }; signal: AbortSignal; resolve: (value: SwarmReadTaskDetailV1) => void }[] = []
    const read = vi.fn((target: { taskId: string }, signal: AbortSignal) => new Promise<SwarmReadTaskDetailV1>(resolve => { pending.push({ target, signal, resolve }) }))
    const { coordinator } = await mount(read)
    await click('[data-swarm-task-id="task-a"]')
    expect(document.querySelector('[data-swarm-task-detail-state]')?.textContent).toContain('Loading')
    await act(async () => { coordinator.updateWorkspaceSelection(fixture().data!.projection.binding, { detail: { kind: 'task', id: 'task-b' } }) })
    expect(pending[0]!.signal.aborted).toBe(true)
    await act(async () => { pending[1]!.resolve(detail(fixture(), 'task-b')) })
    expect(document.querySelector('[data-swarm-task-description]')?.textContent).toContain('Description task-b')
    await act(async () => { pending[0]!.resolve(detail()) })
    expect(document.querySelector('[data-swarm-task-detail]')?.textContent).not.toContain('Description task-a')
  })

  it.each(['root', 'team'] as const)('isolates reused task IDs across %s changes', async field => {
    const pending: { signal: AbortSignal; resolve: (value: SwarmReadTaskDetailV1) => void }[] = []
    const read = vi.fn((_target: { taskId: string }, signal: AbortSignal) => new Promise<SwarmReadTaskDetailV1>(resolve => { pending.push({ signal, resolve }) }))
    const { coordinator, setState } = await mount(read), state = fixture(), projection = state.data!.projection
    await click('[data-swarm-task-id="task-a"]')
    const changedBinding = { ...projection.binding, ...(field === 'root' ? { rootSessionId: 'other-root' } : { teamId: 'other-team' }) }
    const changed = { ...state, data: { ...state.data!, teams: { ...state.data!.teams, teams: state.data!.teams.teams.map(team => ({ ...team, teamId: changedBinding.teamId })) }, projection: { ...projection, binding: changedBinding } } }
    coordinator.updateWorkspaceSelection(changed.data.projection.binding, { view: 'tasks', detail: { kind: 'task', id: 'task-a' } })
    await setState(changed)
    expect(pending[0]!.signal.aborted).toBe(true)
    await act(async () => { pending[0]!.resolve(detail()) })
    expect(document.querySelector('[data-swarm-task-detail]')?.textContent).not.toContain('Description task-a')
    await act(async () => { pending[1]!.resolve({ ...detail(changed), task: { ...detail(changed).task, description: 'New binding description' } }) })
    expect(document.querySelector('[data-swarm-task-description]')?.textContent).toBe('New binding description')
  })

  it('cancels on top-tab hide and official close, then requests afresh on reopen without accepting an old response', async () => {
    const pending: { signal: AbortSignal; resolve: (value: SwarmReadTaskDetailV1) => void }[] = []
    const read = vi.fn((_target: { taskId: string }, signal: AbortSignal) => new Promise<SwarmReadTaskDetailV1>(resolve => { pending.push({ signal, resolve }) }))
    const { coordinator } = await mount(read)
    await click('[data-swarm-task-id="task-a"]'); await click('[data-swarm-view-tab="members"]')
    expect(pending[0]!.signal.aborted).toBe(true)
    await click('[data-swarm-view-tab="tasks"]')
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { coordinator.set({ mode: 'inactive', view: 'overview', targetSessionId: undefined }) })
    expect(pending[1]!.signal.aborted).toBe(true)
    await act(async () => { coordinator.set({ mode: 'docked', view: 'overview', targetSessionId: 'main-brain' }) })
    expect(read).toHaveBeenCalledTimes(3)
    await act(async () => { pending[1]!.resolve(detail()) })
    expect(document.querySelector('[data-swarm-task-description]')).toBeNull()
    await act(async () => { pending[2]!.resolve(detail()) })
    expect(document.querySelector('[data-swarm-task-description]')).not.toBeNull()
  })

  it.each([
    { code: 'TEAM_TASK_NOT_FOUND', expected: 'not found' },
    { code: 'SWARM_RPC_PROJECTION_LIMIT', expected: 'read limit' },
    { code: 'SWARM_UI_READ_FAILED', expected: 'could not be read' },
  ])('keeps $code distinct from missing recorded values', async ({ code, expected }) => {
    await mount(vi.fn(async () => { throw Object.assign(new Error('failure'), { code }) }))
    await click('[data-swarm-task-id="task-a"]')
    expect(document.querySelector('[data-swarm-task-detail-state]')?.textContent).toContain(expected)
    expect(document.querySelector('[data-swarm-task-output]')).toBeNull()
    expect(document.querySelector('[data-swarm-task-detail-state]')?.textContent).not.toContain('Not recorded')
  })

  it('distinguishes empty retained records and unrecorded fields from a truncated retained read', async () => {
    const value = detail(), { output: _output, ...task } = value.task
    const read = vi.fn<DetailReader>(async () => ({ ...value, task, attempts: { ...value.attempts, entries: [], retainedCount: 0, returnedCount: 0 } }))
    const { setState } = await mount(read)
    await click('[data-swarm-task-id="task-a"]')
    expect(document.querySelector('[data-swarm-task-output]')?.textContent).toBe('Not recorded')
    await click('[data-swarm-task-view="trace"]')
    expect(document.querySelector('[data-swarm-task-trace]')?.textContent).toContain('No currently retained attempts')
    read.mockImplementation(async () => ({ ...value, task, attempts: { ...value.attempts, entries: Array.from({ length: 100 }, (_, index) => ({ ...value.attempts.entries[0]!, id: `attempt-${index}`, generation: index + 1 })), retainedCount: 103, returnedCount: 100, truncated: true } }))
    const state = fixture()
    await setState({ ...state, data: { ...state.data!, projection: { ...state.data!.projection, cursor: `r1:${'c'.repeat(64)}` } } })
    expect(document.querySelector('[data-swarm-task-trace]')?.textContent).toContain('100 / 103')
    expect(document.querySelector('[data-swarm-attempts-partial]')).not.toBeNull()
    expect(document.querySelector('[data-swarm-task-trace]')?.textContent).not.toContain('No currently retained attempts')
  })
})
