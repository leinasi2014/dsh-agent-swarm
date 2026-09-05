/**
 * Cross-subdomain transaction helpers of the Team protocol core.
 *
 * The subdomain modules (roster, task board, mailbox, budget, projection)
 * run every state transition inside one `TeamAggregateStore` transaction
 * over the same immutable dependency bundle (`TeamDomainDeps`). This
 * module owns the invariants several subdomains lean on: input validation,
 * caller authority resolution, aggregate lookups and the execution-reset
 * task shape. Nothing here appears on the public `TeamDomainPort` surface;
 * the member-name fold is additionally shared with the runtime's host-side
 * name resolution (interrupt targets), which must normalize identically.
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

/** Longest normalized member name admitted (official roster bound parity). */
const MAX_MEMBER_NAME_LENGTH = 64

/**
 * Fold one member name onto its canonical identity (issue #19, ref
 * `dsh-agent-teams` `sanitizeKey` template): NFC normalization keeps
 * canonically equivalent inputs one identity, `\p{L}\p{N}` keeps Unicode
 * letters and digits (CJK/Cyrillic/Greek names stay distinct and readable),
 * and every other run folds to `-` so spaces and punctuation are separators,
 * never identity. Pure: callers decide how an unusable fold fails.
 */
export function foldMemberName(value: string): string {
  return value.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Validate one member name for provisioning (issue #19): the fold must leave
 * 1..64 code points of letters/digits/separators — over-length and letter-less
 * names are rejected fail-loud rather than truncated with a digest suffix,
 * because a roster name is an identity (collisions already fail loud through
 * `TEAM_MEMBER_NAME_TAKEN`) and truncation would manufacture new ones — and
 * the `captain` pseudo-name stays reserved for the captain identity.
 */
export function normalizeMemberName(value: string): string {
  const normalized = foldMemberName(value)
  expectDomain(
    normalized !== '' && [...normalized].length <= MAX_MEMBER_NAME_LENGTH,
    `member name must fold to 1..${MAX_MEMBER_NAME_LENGTH} Unicode letters, digits or separators`,
    'TEAM_MEMBER_NAME_INVALID',
  )
  expectDomain(normalized !== 'captain', 'member name "captain" is reserved', 'TEAM_MEMBER_NAME_RESERVED')
  return normalized
}

export function nonEmpty(value: string, label: string, max = 512): string {
  const normalized = value.trim()
  expectDomain(normalized !== '', `${label} must not be empty`, 'TEAM_INPUT_INVALID')
  expectDomain(Buffer.byteLength(normalized, 'utf8') <= max, `${label} is too large`, 'TEAM_INPUT_LIMIT')
  return normalized
}

/** Admission only: historical aggregates remain readable at their old sizes. */
export function boundedBoardItems(values: readonly string[], label: string, maxBytes: number): string[] {
  expectDomain(values.length <= 64, `${label} exceeds 64 items`, 'TEAM_INPUT_LIMIT')
  return values.map(value => nonEmpty(value, label, maxBytes))
}

export function attemptOf(team: TeamState, id: AttemptId): TaskAttempt {
  const attempt = team.attempts.find(candidate => candidate.id === id)
  if (attempt === undefined) throw new TeamDomainError(`attempt "${id}" not found`, 'TEAM_ATTEMPT_NOT_FOUND')
  return attempt
}

export function replaceTask(team: TeamState, next: TeamTask): void {
  const index = team.tasks.findIndex(candidate => candidate.id === next.id)
  expectDomain(index >= 0, `task "${next.id}" not found`, 'TEAM_TASK_NOT_FOUND')
  team.tasks[index] = next
}

export function replaceAttempt(team: TeamState, next: TaskAttempt): void {
  const index = team.attempts.findIndex(candidate => candidate.id === next.id)
  expectDomain(index >= 0, `attempt "${next.id}" not found`, 'TEAM_ATTEMPT_NOT_FOUND')
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

/**
 * The read-side authority split (F14): mutations go through
 * {@link actorMembership}, which rejects an archived Team outright, while
 * reads (`snapshot`/`waitForChange`) resolve the archived captain so a
 * terminal aggregate stays inspectable. Members removed at archive are not
 * archived readers — their rows are terminal `removed` records.
 */
export function readerMembership(team: TeamState, sessionId: string): TeamMembership {
  if (team.captainSessionId === sessionId) return { team, role: 'captain', name: 'captain' }
  const member = team.members.find(candidate => candidate.sessionId === sessionId && candidate.phase === 'active')
  if (team.phase !== 'active') throw new TeamDomainError('Team is archived', 'TEAM_ARCHIVED')
  if (member === undefined) throw new TeamDomainError('caller is not an active Team participant', 'TEAM_UNAUTHORIZED')
  return { team, role: 'member', name: member.name }
}
