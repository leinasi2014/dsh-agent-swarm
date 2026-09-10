/** Shared allowlisted summaries; adding detail fields here would widen snapshot. */
import type { TaskAttempt, TeamTask, TeamState } from '../domain/types.js'
import { isTaskReady } from '../domain/graph.js'
import { budgetExhaustion, outstandingReservationTokens, reservationAdmissible } from '../domain/team-domain-budget.js'
import type { SwarmHostReadProjectionV1, SwarmTaskRowV2, SwarmTaskReadinessV2 } from './host-read-types.js'

export function taskReadSummary(task: TeamTask, captainId: string, names: ReadonlyMap<string, string>): SwarmHostReadProjectionV1['tasks'][number] {
  return {
    id: task.id, revision: task.revision, subject: task.subject, status: task.status,
    blockedBy: [...task.blockedBy], priority: task.priority,
    ...nameField('ownerName', task.ownerSessionId, captainId, names),
    ...nameField('targetMemberName', task.targetMemberSessionId, captainId, names),
    ...(task.currentAttemptId === undefined ? {} : { currentAttemptId: task.currentAttemptId }),
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  }
}

export function taskReadSummaryV2(task: TeamTask, team: TeamState, captainId: string, names: ReadonlyMap<string, string>, now: number): SwarmTaskRowV2 {
  let readiness: SwarmTaskReadinessV2
  if (task.status !== 'pending' || task.ownerSessionId !== undefined) readiness = 'not-pending'
  else if (team.phase !== 'active') readiness = 'team-inactive'
  else if (team.goalLifecycle?.phase === 'paused') readiness = 'paused'
  else if (!isTaskReady(team.tasks, task)) readiness = 'blocked'
  else if (budgetExhaustion(team.budget, now) !== undefined
    || !reservationAdmissible(team.budget, outstandingReservationTokens(team.tasks), task.reservationTokens ?? 0)) readiness = 'budget-hold'
  else readiness = 'ready'
  return { ...taskReadSummary(task, captainId, names), assignmentMode: task.assignmentMode ?? 'automatic', readiness }
}

/** No identity or timestamp is inferred from current owner, status, or updatedAt. */
export function taskEventFacts(row: Pick<TeamTask, 'submittedAt' | 'submittedBySessionId' | 'reviewedAt' | 'reviewedBySessionId'>) {
  return {
    ...(row.submittedAt === undefined ? {} : { submittedAt: row.submittedAt }),
    ...(row.submittedBySessionId === undefined ? {} : { submittedBySessionId: row.submittedBySessionId }),
    ...(row.reviewedAt === undefined ? {} : { reviewedAt: row.reviewedAt }),
    ...(row.reviewedBySessionId === undefined ? {} : { reviewedBySessionId: row.reviewedBySessionId }),
  }
}

export function attemptReadSummary(attempt: TaskAttempt, captainId: string, names: ReadonlyMap<string, string>): SwarmHostReadProjectionV1['attempts'][number] {
  return {
    id: attempt.id, taskId: attempt.taskId, generation: attempt.generation,
    ...nameField('memberName', attempt.memberSessionId, captainId, names),
    phase: attempt.phase, assignmentPhase: attempt.assignmentPhase,
    createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
  }
}

function nameField<K extends 'ownerName' | 'targetMemberName' | 'memberName'>(key: K, id: string | undefined,
  captainId: string, names: ReadonlyMap<string, string>): Partial<Record<K, string>> {
  const name = id === undefined ? undefined : id === captainId ? 'captain' : names.get(id)
  return name === undefined ? {} : { [key]: name } as Record<K, string>
}
