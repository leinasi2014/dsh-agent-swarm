// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BudgetMeter } from '../src/components/BudgetMeter.tsx'
import type { SwarmBudgetUsage } from '../src/types.ts'
import { strings } from './fixtures.ts'

afterEach(cleanup)

function rowValues(): string[] {
  const section = screen.getByLabelText('预算用量')
  return [...section.querySelectorAll('.swarm-budget__value')].map(cell => cell.textContent ?? '')
}

describe('BudgetMeter', () => {
  it('renders the three usage rows and the observation timestamp', () => {
    const budget: SwarmBudgetUsage = {
      usedTokens: 1234, usedRequests: 12, usedRetries: 1, observedAt: '2026-08-22T00:00:00.000Z',
    }
    render(<BudgetMeter budget={budget} strings={strings} />)
    for (const label of ['Token', '请求', '重试']) {
      expect(screen.getByText(label)).toBeDefined()
    }
    expect(rowValues()).toEqual(['1234', '12', '1'])
    expect(screen.getByText('观测于 2026-08-22T00:00:00.000Z')).toBeDefined()
  })

  it('renders nothing at all when the budget is absent', () => {
    const { container } = render(<BudgetMeter strings={strings} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders zeroed usage without an observation timestamp', () => {
    render(<BudgetMeter budget={{ usedTokens: 0, usedRequests: 0, usedRetries: 0 }} strings={strings} />)
    expect(rowValues()).toEqual(['0', '0', '0'])
    expect(screen.queryByText(/观测于/)).toBeNull()
  })
})
