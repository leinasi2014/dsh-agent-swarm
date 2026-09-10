import type { TeamDomainDeps } from './team-domain-shared.js'
import { actorMembership, replaceTask } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import { TaskId, type TeamId } from './types.js'
import type { CancelTaskInput, CancelTaskGuards, CancelTaskResult, TaskCancellation } from './goal-lifecycle.js'
import { cancelTaskInputSchema } from './goal-validation.js'
import { expectDomain } from './error.js'
import { fenceAttemptStale, pruneRetainedAttempts } from './team-domain-board.js'
import { recordGoalTaskResult } from './goal-transitions.js'
import { appendWorkActivity } from './team-domain-work-activity.js'

/** Cancel the task, preserving result history. Runtime may synchronously stop only its captured old execution. */
export async function cancelTask(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, captain: string,
  raw: CancelTaskInput, guards?: CancelTaskGuards): Promise<CancelTaskResult> {
  const parsed = cancelTaskInputSchema.safeParse(raw)
  expectDomain(parsed.success, 'Invalid task cancellation', 'TEAM_INPUT_INVALID')
  const input = parsed.data
  let effect: (() => void) | undefined
  return await deps.store.transact(scope, teamId, team => {
    expectDomain(actorMembership(team, captain).role === 'captain', 'Only Captain cancels Team tasks', 'TEAM_CAPTAIN_REQUIRED')
    guards?.assertExecution?.()
    const task = team.tasks.find(item => item.id === input.taskId)
    expectDomain(task !== undefined, 'Task not found', 'TEAM_TASK_NOT_FOUND')
    if (task.cancellation !== undefined) {
      const original = task.cancellation
      expectDomain(original.requestId === input.requestId && original.expectedTaskRevision === input.expectedTaskRevision
        && original.reason === input.reason && original.actorSessionId === captain, 'This task has another cancellation', 'TEAM_TASK_CANCEL_CONFLICT')
      return { task: structuredClone(task), replayed: true }
    }
    expectDomain(task.revision === input.expectedTaskRevision, 'Task revision changed', 'TEAM_TASK_STALE_REVISION')
    expectDomain(!['completed', 'failed', 'cancelled'].includes(task.status), 'Only unfinished tasks can be cancelled', 'TEAM_TASK_NOT_CANCELLABLE')
    const attempt = task.currentAttemptId === undefined ? undefined : team.attempts.find(item => item.id === task.currentAttemptId)
    effect = guards?.captureInterruption?.(structuredClone(team), structuredClone(task), attempt === undefined ? undefined : structuredClone(attempt))
    const at = deps.now(), taskRevision = task.revision + 1
    const cancellation: TaskCancellation = { requestId: input.requestId, expectedTaskRevision: input.expectedTaskRevision,
      taskRevision, reason: input.reason, actorSessionId: captain, at, ...(attempt === undefined ? {} : { attemptId: attempt.id }) }
    if (attempt !== undefined) fenceAttemptStale(team, attempt.id, input.reason, at)
    const { ownerSessionId: _owner, currentAttemptId: _attempt, openClaimNotice: _notice, ...history } = task
    const cancelled = { ...history, revision: taskRevision, status: 'cancelled' as const, updatedAt: at, cancellation }
    replaceTask(team, cancelled)
    recordGoalTaskResult(team)
    appendWorkActivity(team, { kind: 'task-cancelled', actor: { kind: 'session', sessionId: captain },
      taskId: TaskId(input.taskId), ...(task.source === undefined ? {} : { workRequestId: task.source.workRequestId }),
      ...(attempt === undefined ? {} : { attemptId: attempt.id }), status: 'cancelled', occurredAt: at })
    pruneRetainedAttempts(team, deps.limits.maxRetainedAttempts)
    return { task: structuredClone(cancelled), replayed: false }
  }, { afterCommit: () => effect?.() })
}
