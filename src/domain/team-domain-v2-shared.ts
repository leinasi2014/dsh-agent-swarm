import { TeamDomainError } from './error.js'
import type { TaskAttemptV2, TeamStateV2 } from './team-state-v2.js'
import type { TeamTask } from './types.js'

/** Normalize one bounded required v2 text field. */
export function requireV2Text(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new TeamDomainError(`${label} is empty or too large`, 'TEAM_INPUT_INVALID')
  }
  return normalized
}

/** Replace one already-bound Attempt inside a v2 aggregate draft. */
export function replaceV2Attempt(team: TeamStateV2, attempt: TaskAttemptV2): void {
  const index = team.attempts.findIndex(candidate => candidate.id === attempt.id)
  if (index < 0) throw new TeamDomainError(`attempt "${attempt.id}" is stale`, 'TEAM_ATTEMPT_STALE')
  team.attempts[index] = attempt
}

/** Replace one already-bound task inside a v2 aggregate draft. */
export function replaceV2Task(team: TeamStateV2, task: TeamTask): void {
  const index = team.tasks.findIndex(candidate => candidate.id === task.id)
  if (index < 0) throw new TeamDomainError(`task "${task.id}" not found`, 'TEAM_TASK_NOT_FOUND')
  team.tasks[index] = task
}
