// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TeamSummaryCard } from '../src/components/TeamSummaryCard.tsx'
import { makeDegradedSnapshot, makeSnapshot, strings } from './fixtures.ts'

afterEach(cleanup)

describe('TeamSummaryCard', () => {
  it('shows the team name, revision chip, active-member count, and the counters strip', () => {
    render(<TeamSummaryCard snapshot={makeSnapshot()} strings={strings} />)
    expect(screen.getByText('demo-team')).toBeDefined()
    expect(screen.getByText('修订 3')).toBeDefined()
    // Only phase === 'active' counts: two active members, one idle.
    expect(screen.getByText('2 个活跃成员')).toBeDefined()
    const card = screen.getByRole('banner')
    for (const label of ['任务总数', '已完成', '就绪', '排队消息', '记忆条目']) {
      expect(within(card).getByText(label)).toBeDefined()
    }
  })

  it('reports an unknown member count for a degraded snapshot instead of a fake zero', () => {
    render(<TeamSummaryCard snapshot={makeDegradedSnapshot()} strings={strings} />)
    expect(screen.getByText('成员数未知')).toBeDefined()
    expect(screen.queryByText(/活跃成员/)).toBeNull()
    // The counters strip is still the visible summary body.
    expect(screen.getByText('任务总数')).toBeDefined()
  })

  it('renders the detail trigger only when a handler is given and forwards the click', () => {
    const onOpenDetail = vi.fn()
    const first = render(<TeamSummaryCard snapshot={makeSnapshot()} strings={strings} />)
    expect(first.queryByText('查看详情')).toBeNull()

    const second = render(<TeamSummaryCard snapshot={makeSnapshot()} strings={strings} onOpenDetail={onOpenDetail} />)
    fireEvent.click(second.getByText('查看详情'))
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('renders revision zero without dropping the chip', () => {
    const snapshot = { ...makeSnapshot(), team: { ...makeSnapshot().team, revision: 0 } }
    render(<TeamSummaryCard snapshot={snapshot} strings={strings} />)
    expect(screen.getByText('修订 0')).toBeDefined()
  })
})
