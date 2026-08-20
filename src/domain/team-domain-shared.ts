/**
 * Cross-subdomain transaction helpers of the Team protocol core.
 *
 * The subdomain modules (roster, task board, mailbox, budget, projection)
 * run every state transition inside one `TeamAggregateStore` transaction
 * over the same immutable dependency bundle (`TeamDomainDeps`). This
 * module owns the invariants several subdomains lean on: input validation,
 * caller authority resolution, aggregate lookups and the execution-reset
 * task shape. Everything here is private to the domain implementation and
 * never appears on the public `TeamDomainPort` surface.
 */
import { Buffer } from 'node:buffer'
import { expectDomain, TeamDomainError } from './error.js'
import type { TeamAggregateStore } from './team-domain-port.js'
import type { AttemptId, TaskAttempt, TeamLimits, TeamMembership, TeamState, TeamTask } from './types.js'

/** Immutable collaborators shared by every subdomain transition. */
export interface TeamDomainDeps {
  readonly store: TeamAggregateStore
  readonly limits: TeamLimits
  readonly now: () => number
}

export function nonEmpty(value: string, label: string, max = 512): string {
  const normalized = value.trim()
  expectDomain(normalized !== '', `${label} must not be empty`, 'TEAM_INPUT_INVALID')
  expectDomain(Buffer.byteLength(normalized, 'utf8') <= max, `${label} is too large`, 'TEAM_INPUT_LIMIT')
  return normalized
}

export function attemptOf(team: TeamState, id: AttemptId): TaskAttempt {
  const attempt = team.attempts.find(candidate => candidate.id === id)
  if (attempt === undefined) throw new TeamDomainError(`attempt "${id}" not found`, 'TEAM_ATTEMPT_NOT_FOUND')
  return attempt
}

export function replaceTask(team: TeamState, next: TeamTask): void {
  const index = team.tasks.findIndex(candidate => candidate.id === next.id)
  team.tasks[index] = next
}

export function replaceAttempt(team: TeamState, next: TaskAttempt): void {
  const index = team.attempts.findIndex(candidate => candidate.id === next.id)
  team.attempts[index] = next
}

export function clearTaskExecution(task: TeamTask, next: Pick<TeamTask, 'revision' | 'status' | 'updatedAt'>): TeamTask {
  const { ownerSessionId: _owner, currentAttemptId: _attempt, output: _output, ...stable } = task
  return { ...stable, ...next }
}

export function actorMembership(team: TeamState, sessionId: string): TeamMembership {
  if (team.phase !== 'active') throw new TeamDomainError('Team is archived', 'TEAM_ARCHIVED')
  if (team.captainSessionId === sessionId) return { team, role: 'captain', name: 'captain' }
  const member = team.members.find(candidate => candidate.sessionId === sessionId && candidate.phase === 'active')
  if (member === undefined) throw new TeamDomainError('caller is not an active Team participant', 'TEAM_UNAUTHORIZED')
  return { team, role: 'member', name: member.name }
}
