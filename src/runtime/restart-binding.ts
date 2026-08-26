/**
 * Restart-safe, authority-derived identity of one task's current execution.
 *
 * This is deliberately a projection, not another durable record. Consumers
 * must derive it again from the persisted Team aggregate whenever they resume.
 */
import { TeamDomainError } from '../domain/error.js'
import type { AttemptId, TaskAttempt, TeamId, TeamState, TeamTask, TaskId } from '../domain/types.js'

/** The only attempt phase that a headless worker may resume as execution. */
type RestartBindingPhase = 'running'

export interface RestartSafeAttemptBinding {
  readonly teamId: TeamId
  readonly taskId: TaskId
  readonly taskRevision: number
  readonly attemptId: AttemptId
  readonly attemptGeneration: number
  readonly memberSessionId: string
}

const BINDING_KEYS = new Set([
  'teamId',
  'taskId',
  'taskRevision',
  'attemptId',
  'attemptGeneration',
  'memberSessionId',
])

function bindingError(message: string, code: string): never {
  throw new TeamDomainError(message, code)
}

function currentAttempt(team: TeamState, taskId: TaskId, allowedPhase: RestartBindingPhase): { task: TeamTask; attempt: TaskAttempt } {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) bindingError(`task "${taskId}" does not exist in Team "${team.id}"`, 'TEAM_RESTART_BINDING_TASK_MISSING')
  if (task.currentAttemptId === undefined) bindingError(`task "${taskId}" has no current attempt`, 'TEAM_RESTART_BINDING_CURRENT_ATTEMPT_MISSING')
  const attempt = team.attempts.find(candidate => candidate.id === task.currentAttemptId)
  if (attempt === undefined) bindingError(`task "${taskId}" references a missing current attempt`, 'TEAM_RESTART_BINDING_ATTEMPT_MISSING')
  if (attempt.taskId !== task.id) bindingError(`current attempt "${attempt.id}" belongs to another task`, 'TEAM_RESTART_BINDING_TASK_ATTEMPT_MISMATCH')
  if (task.ownerSessionId !== attempt.memberSessionId) bindingError(`task "${taskId}" owner does not match its current attempt`, 'TEAM_RESTART_BINDING_OWNER_MISMATCH')
  if (attempt.phase !== allowedPhase) bindingError(`current attempt "${attempt.id}" is not ${allowedPhase}`, 'TEAM_RESTART_BINDING_PHASE_INVALID')
  return { task, attempt }
}

function freezeBinding(team: TeamState, task: TeamTask, attempt: TaskAttempt): RestartSafeAttemptBinding {
  return Object.freeze({
    teamId: team.id,
    taskId: task.id,
    taskRevision: task.revision,
    attemptId: attempt.id,
    attemptGeneration: attempt.generation,
    memberSessionId: attempt.memberSessionId,
  })
}

/** Derive the active execution identity from the one persisted Team authority. */
export function deriveRestartSafeAttemptBinding(team: TeamState, taskId: TaskId): RestartSafeAttemptBinding {
  const { task, attempt } = currentAttempt(team, taskId, 'running')
  return freezeBinding(team, task, attempt)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') bindingError(`restart binding ${field} must be a non-empty string`, 'TEAM_RESTART_BINDING_INVALID')
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) bindingError(`restart binding ${field} must be a positive safe integer`, 'TEAM_RESTART_BINDING_INVALID')
  return value as number
}

/**
 * Revalidate a JSON-restored binding against the present aggregate. The JSON
 * object supplies no authority: every field must equal the freshly derived
 * current attempt, so a superseded binding cannot be resumed.
 */
export function parseRestartSafeAttemptBinding(team: TeamState, value: unknown): RestartSafeAttemptBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bindingError('restart binding must be an object', 'TEAM_RESTART_BINDING_INVALID')
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some(key => !BINDING_KEYS.has(key)) || Object.keys(candidate).length !== BINDING_KEYS.size) {
    bindingError('restart binding has an unexpected shape', 'TEAM_RESTART_BINDING_INVALID')
  }
  const taskId = text(candidate.taskId, 'taskId') as TaskId
  const derived = deriveRestartSafeAttemptBinding(team, taskId)
  const parsed = {
    teamId: text(candidate.teamId, 'teamId') as TeamId,
    taskId,
    taskRevision: positiveInteger(candidate.taskRevision, 'taskRevision'),
    attemptId: text(candidate.attemptId, 'attemptId') as AttemptId,
    attemptGeneration: positiveInteger(candidate.attemptGeneration, 'attemptGeneration'),
    memberSessionId: text(candidate.memberSessionId, 'memberSessionId'),
  }
  if (parsed.teamId !== derived.teamId
    || parsed.taskId !== derived.taskId
    || parsed.taskRevision !== derived.taskRevision
    || parsed.attemptId !== derived.attemptId
    || parsed.attemptGeneration !== derived.attemptGeneration
    || parsed.memberSessionId !== derived.memberSessionId) {
    bindingError('restart binding no longer matches the current Team execution', 'TEAM_RESTART_BINDING_STALE')
  }
  return derived
}
