// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TaskBoard } from '../src/components/TaskBoard.tsx'
import type { SwarmTaskView } from '../src/types.ts'
import { strings } from './fixtures.ts'

afterEach(cleanup)

const TASKS: ReadonlyArray<SwarmTaskView> = [
  { id: 't-1', title: 'wire contracts', status: 'in_progress', ownerId: 'm-lead', attempts: 1 },
  { id: 't-2', title: 'write docs', status: 'pending', attempts: 0, blockedBy: ['t-1', 't-9'] },
  { id: 't-3', title: 'land release', status: 'completed', ownerId: 'm-worker', attempts: 2 },
]

/** Status badge of the row holding the given title. */
function badgeOf(title: string): HTMLElement {
  const item = screen.getByText(title).closest<HTMLElement>('.swarm-task')
  if (item === null) throw new Error(`no task row holds ${title}`)
  const badge = item.querySelector<HTMLElement>('.swarm-task__status')
  if (badge === null) throw new Error(`no status badge on the row holding ${title}`)
  return badge
}

describe('TaskBoard', () => {
  it('renders one row per task with status badges, owners, and attempts', () => {
    render(<TaskBoard tasks={TASKS} strings={strings} />)
    const list = screen.getByLabelText('任务列表')
    expect(list.querySelectorAll('.swarm-task')).toHaveLength(3)
    expect(badgeOf('wire contracts').textContent).toBe('进行中')
    expect(badgeOf('write docs').textContent).toBe('待处理')
    expect(badgeOf('land release').textContent).toBe('已完成')
    // data-status drives the --swarm-state-* CSS selectors.
    expect(badgeOf('wire contracts').getAttribute('data-status')).toBe('in_progress')
    expect(badgeOf('land release').getAttribute('data-status')).toBe('completed')
    expect(screen.getByText('m-lead')).toBeDefined()
    expect(screen.getByText('m-worker')).toBeDefined()
    expect(screen.getByText('尝试 2 次')).toBeDefined()
  })

  it('folds blocked-by evidence to the first blocker plus a rest count', () => {
    const first = render(<TaskBoard tasks={TASKS} strings={strings} />)
    const blocked = screen.getByText(/阻塞于/).closest('.swarm-task__blocked')
    if (blocked === null) throw new Error('no blocked-by span')
    expect(blocked.textContent).toBe('阻塞于 t-1等 1 项')

    first.unmount()
    // A single-blocker task renders the id with no rest chip.
    render(<TaskBoard tasks={[{ id: 't-4', title: 'audit', status: 'ready', attempts: 1, blockedBy: ['t-1'] }]} strings={strings} />)
    expect(screen.queryByText(/等 \d+ 项/)).toBeNull()
    expect(screen.getByText(/阻塞于 t-1/)).toBeDefined()
    expect(badgeOf('audit').textContent).toBe('就绪')
  })

  it('marks unowned tasks, hides zero attempts, and omits blockers when there are none', () => {
    render(<TaskBoard tasks={[
      { id: 't-5', title: 'orphan', status: 'submitted', attempts: 0 },
    ]} strings={strings} />)
    expect(screen.getByText('未认领')).toBeDefined()
    expect(screen.queryByText(/尝试/)).toBeNull()
    expect(screen.queryByText(/阻塞于/)).toBeNull()
    expect(badgeOf('orphan').textContent).toBe('已提交')
  })

  it('shows the empty state instead of an empty list', () => {
    const { container } = render(<TaskBoard tasks={[]} strings={strings} />)
    expect(screen.getByText('暂无任务')).toBeDefined()
    // The labeled region stays (it explains the emptiness); the list is gone.
    expect(screen.getByLabelText('任务列表')).toBeDefined()
    expect(container.querySelector('.swarm-tasks__list')).toBeNull()
  })

  it('falls back to the raw host status word for an unknown status', () => {
    render(<TaskBoard tasks={[{ id: 't-6', title: 'escalated work', status: 'escalated', attempts: 1 }]} strings={strings} />)
    const badge = badgeOf('escalated work')
    expect(badge.textContent).toBe('escalated')
    expect(badge.getAttribute('data-status')).toBe('escalated')
  })

  it('makes rows selectable only when a handler is given and reports the task id', () => {
    const onSelectTask = vi.fn()
    const first = render(<TaskBoard tasks={TASKS} strings={strings} />)
    expect(first.container.querySelectorAll('button')).toHaveLength(0)
    first.unmount()

    const second = render(<TaskBoard tasks={TASKS} strings={strings} onSelectTask={onSelectTask} />)
    expect(second.container.querySelectorAll('button.swarm-task__select')).toHaveLength(3)
    fireEvent.click(second.getByRole('button', { name: '查看任务 write docs' }))
    expect(onSelectTask).toHaveBeenCalledWith('t-2')
    expect(within(second.getByLabelText('任务列表')).getAllByRole('button')).toHaveLength(3)
  })
})
