import type { SwarmCounters } from '../types.ts'
import type { SwarmStrings } from '../strings.ts'

/** Props for the fixed-size counters row. */
export interface StatusCountersProps {
  readonly counters: SwarmCounters
  readonly strings: SwarmStrings
}

/**
 * The five fixed-size Team counters (total/completed/ready/queuedMessages/
 * memoryEntries), one cell each. Values render as plain digits — no locale
 * grouping, so every host shows byte-identical numbers.
 */
export function StatusCounters({ counters, strings }: StatusCountersProps) {
  const cells: ReadonlyArray<{ key: string; label: string; value: number }> = [
    { key: 'total', label: strings['counters.total'], value: counters.total },
    { key: 'completed', label: strings['counters.completed'], value: counters.completed },
    { key: 'ready', label: strings['counters.ready'], value: counters.ready },
    { key: 'queuedMessages', label: strings['counters.queuedMessages'], value: counters.queuedMessages },
    { key: 'memoryEntries', label: strings['counters.memoryEntries'], value: counters.memoryEntries },
  ]
  return (
    <dl className="swarm-counters" aria-label={strings['counters.aria']}>
      {cells.map(cell => (
        <div key={cell.key} className="swarm-counter">
          <dt className="swarm-counter__label">{cell.label}</dt>
          <dd className="swarm-counter__value">{cell.value}</dd>
        </div>
      ))}
    </dl>
  )
}
