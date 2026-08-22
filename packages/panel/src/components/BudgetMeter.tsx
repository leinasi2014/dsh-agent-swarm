import type { SwarmBudgetUsage } from '../types.ts'
import { formatSwarmString, type SwarmStrings } from '../strings.ts'

/** Props for the budget usage meter. */
export interface BudgetMeterProps {
  /** Absent budget hides the whole meter (never a fake zero row). */
  readonly budget?: SwarmBudgetUsage
  readonly strings: SwarmStrings
}

/**
 * The three usage figures (tokens/requests/retries) plus the optional
 * observation timestamp. The contract carries used figures only — no caps —
 * so this renders plain usage values, not percentage bars. An absent budget
 * renders nothing at all.
 */
export function BudgetMeter({ budget, strings }: BudgetMeterProps) {
  if (budget === undefined) return null
  const rows: ReadonlyArray<{ key: string; label: string; value: number }> = [
    { key: 'tokens', label: strings['budget.tokens'], value: budget.usedTokens },
    { key: 'requests', label: strings['budget.requests'], value: budget.usedRequests },
    { key: 'retries', label: strings['budget.retries'], value: budget.usedRetries },
  ]
  return (
    <section className="swarm-budget" aria-label={strings['budget.title']}>
      <div className="swarm-budget__title">{strings['budget.title']}</div>
      <ul>
        {rows.map(row => (
          <li key={row.key} className="swarm-budget__row">
            <span className="swarm-budget__label">{row.label}</span>
            <span className="swarm-budget__value">{row.value}</span>
          </li>
        ))}
      </ul>
      {budget.observedAt === undefined
        ? null
        : <span className="swarm-budget__observed">{formatSwarmString(strings['budget.observedAt'], { time: budget.observedAt })}</span>}
    </section>
  )
}
