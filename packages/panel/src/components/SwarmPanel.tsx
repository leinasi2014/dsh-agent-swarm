import type { SwarmPanelSnapshot } from '../types.ts'
import type { SwarmStrings } from '../strings.ts'
import { BudgetMeter } from './BudgetMeter.tsx'
import { TaskBoard } from './TaskBoard.tsx'
import { TeamSummaryCard } from './TeamSummaryCard.tsx'

/** Props for the top-level panel composition. */
export interface SwarmPanelProps {
  /** Absent before the first snapshot arrives (loading/empty/error states cover it). */
  readonly snapshot?: SwarmPanelSnapshot
  /** True while a (re)fetch is in flight; also exposed as aria-busy. */
  readonly loading?: boolean
  /** Error text for the latest fetch; a stale snapshot stays visible under a staleness banner. */
  readonly error?: string
  readonly strings: SwarmStrings
  readonly onRefresh?: () => void
}

/**
 * Top-level composition with built-in loading/error/empty states and the
 * degraded-snapshot form: when neither roster nor task rows are projected
 * (the Canvas MVP counters+budget shape), the panel shows the summary card
 * plus a degradation note instead of an empty task board.
 */
export function SwarmPanel({ snapshot, loading = false, error, strings, onRefresh }: SwarmPanelProps) {
  return (
    <section className="swarm-panel" aria-busy={loading} aria-label={strings['panel.title']}>
      <div className="swarm-panel__bar">
        <span className="swarm-panel__title">{strings['panel.title']}</span>
        {onRefresh === undefined
          ? null
          : <button type="button" className="swarm-panel__refresh" onClick={onRefresh}>{strings['panel.refresh']}</button>}
      </div>
      {snapshot === undefined
        ? (
          loading
            ? <div className="swarm-panel__state" role="status">{strings['panel.loading']}</div>
            : error !== undefined
              ? <div className="swarm-panel__state swarm-panel__state--error" role="alert">{strings['panel.error']}</div>
              : <div className="swarm-panel__state">{strings['panel.empty']}</div>
        )
        : (
          <>
            {error === undefined
              ? null
              : <div className="swarm-panel__stale" role="alert">{strings['panel.stale']}</div>}
            <TeamSummaryCard snapshot={snapshot} strings={strings} />
            {snapshot.budget === undefined
              ? null
              : <BudgetMeter budget={snapshot.budget} strings={strings} />}
            {(snapshot.members === undefined || snapshot.members.length === 0)
              && (snapshot.tasks === undefined || snapshot.tasks.length === 0)
              ? <div className="swarm-panel__degraded">{strings['panel.degraded']}</div>
              : <TaskBoard tasks={snapshot.tasks ?? []} strings={strings} />}
            {loading
              ? <div className="swarm-panel__state" role="status">{strings['panel.loading']}</div>
              : null}
          </>
        )}
    </section>
  )
}
