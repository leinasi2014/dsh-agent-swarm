/** Shared allowlisted summaries; adding detail fields here would widen snapshot. */
import type { TaskAttempt, TeamTask } from '../domain/types.js'
import type { SwarmHostReadProjectionV1 } from './host-read-types.js'

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
