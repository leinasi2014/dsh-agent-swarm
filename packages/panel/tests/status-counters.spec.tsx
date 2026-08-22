// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { StatusCounters } from '../src/components/StatusCounters.tsx'
import type { SwarmCounters } from '../src/types.ts'
import { strings } from './fixtures.ts'

afterEach(cleanup)

function cellValues(): string[] {
  const row = screen.getByLabelText('Team 计数')
  return [...row.querySelectorAll('.swarm-counter__value')].map(cell => cell.textContent ?? '')
}

describe('StatusCounters', () => {
  it('renders all five counters with labels and values in contract order', () => {
    const counters: SwarmCounters = { total: 12, completed: 7, ready: 2, queuedMessages: 3, memoryEntries: 41 }
    render(<StatusCounters counters={counters} strings={strings} />)
    const row = screen.getByLabelText('Team 计数')
    for (const label of ['任务总数', '已完成', '就绪', '排队消息', '记忆条目']) {
      expect(within(row).getByText(label)).toBeDefined()
    }
    expect(cellValues()).toEqual(['12', '7', '2', '3', '41'])
  })

  it('renders a zeroed team without hiding or restructuring cells', () => {
    render(<StatusCounters counters={{ total: 0, completed: 0, ready: 0, queuedMessages: 0, memoryEntries: 0 }} strings={strings} />)
    expect(cellValues()).toEqual(['0', '0', '0', '0', '0'])
  })

  it('renders plain digits with no locale grouping', () => {
    render(<StatusCounters counters={{ total: 1234567, completed: 1000, ready: 999, queuedMessages: 0, memoryEntries: 5 }} strings={strings} />)
    expect(cellValues()).toEqual(['1234567', '1000', '999', '0', '5'])
  })
})
