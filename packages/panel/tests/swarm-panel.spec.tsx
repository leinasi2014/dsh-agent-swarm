// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SwarmPanel } from '../src/components/SwarmPanel.tsx'
import { makeDegradedSnapshot, makeSnapshot, strings } from './fixtures.ts'

afterEach(cleanup)

describe('SwarmPanel composition', () => {
  it('composes card, budget meter, and task board for a full snapshot', () => {
    const onRefresh = vi.fn()
    const { container } = render(<SwarmPanel snapshot={makeSnapshot()} strings={strings} onRefresh={onRefresh} />)
    expect(screen.getByText('demo-team')).toBeDefined()
    expect(screen.getByText('修订 3')).toBeDefined()
    expect(screen.getByText('2 个活跃成员')).toBeDefined()
    expect(screen.getByLabelText('预算用量')).toBeDefined()
    expect(screen.getByLabelText('任务列表')).toBeDefined()
    expect(screen.getByText('wire contracts')).toBeDefined()
    expect(screen.queryByText(/降级快照/)).toBeNull()
    expect(container.querySelector('.swarm-panel')?.getAttribute('aria-busy')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('renders the summary card with a degradation note for a counters+budget snapshot', () => {
    render(<SwarmPanel snapshot={makeDegradedSnapshot()} strings={strings} />)
    // Summary card is the body, not a blank panel.
    expect(screen.getByText('demo-team')).toBeDefined()
    expect(screen.getByText('任务总数')).toBeDefined()
    expect(screen.getByText('成员数未知')).toBeDefined()
    expect(screen.getByLabelText('预算用量')).toBeDefined()
    expect(screen.getByText('降级快照：仅计数与预算可用')).toBeDefined()
    // No task board is fabricated for absent rows.
    expect(screen.queryByLabelText('任务列表')).toBeNull()
    // No refresh trigger is fabricated either.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the loading state while the first snapshot is pending', () => {
    render(<SwarmPanel loading strings={strings} />)
    expect(screen.getByRole('status').textContent).toBe('正在加载 Team 状态…')
    expect(screen.queryByText('暂无 Team 状态')).toBeNull()
  })

  it('shows the error state without a snapshot and a staleness banner over a stale one', () => {
    const failed = render(<SwarmPanel error="rpc bridge down" strings={strings} />)
    expect(failed.getByRole('alert').textContent).toBe('Team 状态加载失败')

    cleanup()
    const stale = render(<SwarmPanel snapshot={makeSnapshot()} error="rpc bridge down" strings={strings} />)
    // The stale snapshot stays visible under the banner instead of being blanked.
    expect(stale.getByRole('alert').textContent).toBe('数据可能已过期')
    expect(stale.getByText('demo-team')).toBeDefined()
    expect(stale.getByLabelText('任务列表')).toBeDefined()
  })

  it('shows the empty state when nothing is loading, failing, or projected', () => {
    render(<SwarmPanel strings={strings} />)
    expect(screen.getByText('暂无 Team 状态')).toBeDefined()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a refreshable snapshot readable while a refetch is in flight', () => {
    render(<SwarmPanel snapshot={makeSnapshot()} loading strings={strings} />)
    const panel = screen.getByLabelText('Agent Swarm')
    expect(panel.getAttribute('aria-busy')).toBe('true')
    // Both the live snapshot and the inline loading marker are visible.
    expect(screen.getByText('demo-team')).toBeDefined()
    expect(screen.getByRole('status').textContent).toBe('正在加载 Team 状态…')
  })
})
