/**
 * Pure derivation of official job records from one authoritative Team
 * aggregate (M2-2, issue #76). The mapping table this module implements —
 * including the attempt-retry boundary and the projection's one-way
 * direction — is docs/development/2026-08-21-m2b-jobs-bridge-design.md §2.
 *
 * The derivation is a total function of the aggregate: running it on the
 * live event stream and on a post-crash re-seed produces byte-identical
 * records (startedAt/finishedAt/output come from durable aggregate fields,
 * never from wall-clock observation), which is what makes projection
 * rebuild after a crash a plain re-derivation.
 * @module dsh-agent-swarm/runtime/jobs/projection-derive
 */

import type { JobStatus } from '@deepseek-ai/dsh-jobs'
import type { AttemptId, TeamState, TeamTask } from '../../domain/types.js'

/**
 * The projection's producer kind. Extends the official merge-extensible
 * {@link JobKindMap} the same way the official test consumer does
 * (dsh-jobs-local `tests/jobs.spec.ts:12-16`); the registry treats the kind
 * as an opaque id namespace, so job ids read `team-task-N`.
 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'team-task': 'team-task'
  }
}

/** The registered job kind of every projected Team task. */
export const TEAM_TASK_JOB_KIND = 'team-task' as const

/** Kind-specific status-detail budget (diagnostics can be 8 KiB in the aggregate). */
const DETAIL_MAX_BYTES = 512

/** Terminal projection statuses (official `JobStatus` subset). */
const TERMINAL = new Set<JobStatus>(['completed', 'killed', 'failed'])

/** True for the three terminal official job statuses. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.has(status)
}

/** One derived job record — the desired projection of one Team task. */
export interface DerivedTeamJob {
  /** Authoritative task id (correlation back into the Team aggregate). */
  readonly taskId: string
  /** Model-facing label: the task subject (non-empty by domain validation). */
  readonly label: string
  readonly status: JobStatus
  /** Kind-specific correlation plus the settling attempt's diagnostic. */
  readonly detail: string
  /** Final output — only meaningful once `status === 'completed'`. */
  readonly output: string
  /** Epoch ms of the task's earliest attempt (deterministic across rebuilds). */
  readonly startedAt: number
  /** Epoch ms of the terminal task transition; absent while live. */
  readonly finishedAt?: number
}

/** Truncate a detail suffix to the kind-specific budget. */
function clipped(text: string): string {
  const suffix = text.length > DETAIL_MAX_BYTES ? `${text.slice(0, DETAIL_MAX_BYTES - 1)}…` : text
  return suffix
}

/** Project one task's lifecycle status onto the official job status vocabulary. */
function taskStatusToJobStatus(status: TeamTask['status']): JobStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'killed'
  // pending (post-reject requeue), in_progress, submitted, verifying: the
  // Team protocol's final word has not landed — execution is still live.
  return 'running'
}

/** Derive one task's job record, or undefined when the task never executed. */
function deriveTask(team: TeamState, task: TeamTask): DerivedTeamJob | undefined {
  const attempts = team.attempts.filter(attempt => attempt.taskId === task.id)
  // A task with no attempt was never claimed: pending board work is not
  // background execution and projects no job.
  if (attempts.length === 0) return undefined
  const status = taskStatusToJobStatus(task.status)
  const startedAt = Math.min(...attempts.map(attempt => attempt.createdAt))
  // The attempt the task points at while live; after cancellation the
  // execution fields are cleared, so fall back to the latest generation.
  const referenced = task.currentAttemptId !== undefined
    ? attempts.find(attempt => attempt.id === task.currentAttemptId)
    : undefined
  const settledAttempt = referenced ?? [...attempts].toSorted((left, right) => left.generation - right.generation).at(-1)
  const attemptRef: AttemptId | undefined = settledAttempt?.id
  const correlation = `task ${task.id}${attemptRef === undefined ? '' : ` (attempt ${attemptRef})`}`
  const diagnostic = isTerminalStatus(status) ? settledAttempt?.diagnostic : undefined
  return {
    taskId: task.id,
    label: task.subject,
    status,
    detail: diagnostic === undefined ? correlation : clipped(`${correlation}: ${diagnostic}`),
    output: task.status === 'completed' ? task.output ?? '' : '',
    startedAt,
    ...(status !== 'running' ? { finishedAt: task.updatedAt } : {}),
  }
}

/**
 * Derive the complete set of job records one Team projects: every task that
 * has at least one attempt (has entered execution), in task-array order
 * (creation order), regardless of the Team's active/archived phase.
 * @param team - one authoritative Team aggregate (post-commit snapshot).
 * @returns the desired records for the whole task board.
 */
export function deriveTeamJobs(team: TeamState): DerivedTeamJob[] {
  const derived: DerivedTeamJob[] = []
  for (const task of team.tasks) {
    const record = deriveTask(team, task)
    if (record !== undefined) derived.push(record)
  }
  return derived
}
