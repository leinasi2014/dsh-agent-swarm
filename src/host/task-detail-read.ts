/** One task's public detail projected from the existing Team aggregate. */
import { TeamDomainError } from '../domain/error.js'
import type { TeamState } from '../domain/types.js'
import type { SwarmReadTaskDetailV1, SwarmReadTaskDetailV2 } from '../rpc/read-rpc-contract.js'
import { assertSwarmReadRpcValue } from '../rpc/read-rpc-artifact.js'
import { deepFreezeJson } from './frozen-json.js'
import { attemptReadSummary, taskReadSummary, taskReadSummaryV2, taskEventFacts } from './task-read-summary.js'

export function projectTaskDetail(team: TeamState, taskId: string, bindingRoot: string, version: 1 | 2 = 1): SwarmReadTaskDetailV1 | SwarmReadTaskDetailV2 {
  const task = team.tasks.find(row => row.id === taskId)
  if (task === undefined) throw new TeamDomainError('Task is not present in the selected Team', 'TEAM_TASK_NOT_FOUND')
  const names = new Map(team.members.map(row => [row.sessionId, row.name]))
  const observedAt = Date.now()
  const retained = team.attempts.filter(row => row.taskId === task.id)
    .toSorted((left, right) => right.generation - left.generation || left.id.localeCompare(right.id))
  const entries = retained.slice(0, 100).map(attempt => ({
    ...attemptReadSummary(attempt, bindingRoot, names),
    ...(version === 2 ? taskEventFacts(attempt) : {}),
    ...(version === 2 && attempt.reviewProvider !== undefined ? { reviewProvider: attempt.reviewProvider } : {}),
    ...(attempt.output === undefined ? {} : { output: attempt.output }),
    evidence: [...attempt.evidence],
    ...(attempt.diagnostic === undefined ? {} : { diagnostic: attempt.diagnostic }),
    ...(attempt.assignmentDeliveredAt === undefined ? {} : { assignmentDeliveredAt: attempt.assignmentDeliveredAt }),
    ...(attempt.replacesAttemptId === undefined ? {} : { replacesAttemptId: attempt.replacesAttemptId }),
  }))
  const value = {
    schemaVersion: version, binding: { rootSessionId: bindingRoot, teamId: team.id },
    state: 'available', taskId: task.id, teamRevision: team.revision,
    task: { ...(version === 2 ? taskReadSummaryV2(task, team, bindingRoot, names, observedAt) : taskReadSummary(task, bindingRoot, names)),
      ...(version === 2 ? { ...taskEventFacts(task),
        ...(task.ownerSessionId === undefined ? {} : { ownerSessionId: task.ownerSessionId }),
        ...(task.createdBySessionId === undefined ? {} : { createdBySessionId: task.createdBySessionId }),
        ...(task.source === undefined ? {} : { source: { workRequestId: task.source.workRequestId, itemKey: task.source.itemKey,
          origin: task.source.origin.kind === 'main' ? { kind: 'main', sessionId: task.source.origin.sessionId } : { kind: 'local-operator' } } }),
      } : {}), description: task.description,
      acceptanceCriteria: [...task.acceptanceCriteria], ...(task.output === undefined ? {} : { output: task.output }) },
    attempts: { scope: 'retained', entries, retainedCount: retained.length, returnedCount: entries.length,
      limit: 100, truncated: entries.length < retained.length },
    observedAt,
  } as SwarmReadTaskDetailV1 | SwarmReadTaskDetailV2
  // Historical aggregates may exceed today's admission limits. Do not silently
  // shorten text or emit a success body that the strict consumer cannot read.
  try { assertSwarmReadRpcValue('taskDetail', value) } catch {
    throw new TeamDomainError('Task detail exceeds its public projection bounds', 'SWARM_RPC_PROJECTION_LIMIT')
  }
  return deepFreezeJson(value)
}
