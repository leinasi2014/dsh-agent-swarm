import type { SwarmPanelSnapshot } from '../types.ts'
import { formatSwarmString, type SwarmStrings } from '../strings.ts'
import { StatusCounters } from './StatusCounters.tsx'

/** Props for the team summary card. */
export interface TeamSummaryCardProps {
  readonly snapshot: SwarmPanelSnapshot
  readonly strings: SwarmStrings
  readonly onOpenDetail?: () => void
}

/**
 * Card header: team name, revision chip, active-member chip, and the
 * counters strip (spec §5.3 "任务计数条"). In a degraded snapshot the roster
 * is absent, so the member chip reports "unknown" — an absent roster is a
 * projection boundary, not a zero-member Team.
 */
export function TeamSummaryCard({ snapshot, strings, onOpenDetail }: TeamSummaryCardProps) {
  const activeMembers = snapshot.members === undefined
    ? undefined
    : snapshot.members.filter(member => member.phase === 'active').length
  return (
    <header className="swarm-card">
      <div className="swarm-card__header">
        <span className="swarm-card__name">{snapshot.team.name}</span>
        <span className="swarm-card__chip">{formatSwarmString(strings['team.revision'], { revision: snapshot.team.revision })}</span>
        {activeMembers === undefined
          ? <span className="swarm-card__chip swarm-card__chip--muted">{strings['team.membersUnknown']}</span>
          : <span className="swarm-card__chip">{formatSwarmString(strings['team.activeMembers'], { count: activeMembers })}</span>}
        {onOpenDetail === undefined
          ? null
          : <button type="button" className="swarm-card__detail" onClick={onOpenDetail}>{strings['team.detail']}</button>}
      </div>
      <StatusCounters counters={snapshot.counters} strings={strings} />
    </header>
  )
}
