import { TeamDomainError } from './error.js'
import type { TaskAttemptV2, TeamStateV2 } from './team-state-v2.js'

/** Replace one already-bound Attempt inside a v2 aggregate draft. */
export function replaceV2Attempt(team: TeamStateV2, attempt: TaskAttemptV2): void {
  const index = team.attempts.findIndex(candidate => candidate.id === attempt.id)
  if (index < 0) throw new TeamDomainError(`attempt "${attempt.id}" is stale`, 'TEAM_ATTEMPT_STALE')
  team.attempts[index] = attempt
}
