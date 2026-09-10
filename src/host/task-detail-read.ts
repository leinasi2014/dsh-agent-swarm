/** One task's public detail projected from the existing Team aggregate. */
import { TeamDomainError } from '../domain/error.js'
import type { TeamState } from '../domain/types.js'
import type { SwarmReadTaskDetailV1 } from '../rpc/read-rpc-contract.js'
import { assertSwarmReadRpcValue } from '../rpc/read-rpc-artifact.js'
import { deepFreezeJson } from './frozen-json.js'
import { attemptReadSummary, taskReadSummary } from './task-read-summary.js'

export function projectTaskDetail(team: TeamState, taskId: string, bindingRoot: string): SwarmReadTaskDetailV1 {
  const task = team.tasks.find(row => row.id === taskId)
  if (task === undefined) throw new TeamDomainError('Task is not present in the selected Team', 'TEAM_TASK_NOT_FOUND')
  const names = new Map(team.members.map(row => [row.sessionId, row.name]))
  const retained = team.attempts.filter(row => row.taskId === task.id)
    .toSorted((left, right) => right.generation - left.generation || left.id.localeCompare(right.id))
  const entries = retained.slice(0, 100).map(attempt => ({
    ...attemptReadSummary(attempt, bindingRoot, names),
    ...(attempt.output === undefined ? {} : { output: attempt.output }),
    evidence: [...attempt.evidence],
    ...(attempt.diagnostic === undefined ? {} : { diagnostic: attempt.diagnostic }),
    ...(attempt.assignmentDeliveredAt === undefined ? {} : { assignmentDeliveredAt: attempt.assignmentDeliveredAt }),
    ...(attempt.replacesAttemptId === undefined ? {} : { replacesAttemptId: attempt.replacesAttemptId }),
  }))
  const value: SwarmReadTaskDetailV1 = {
    schemaVersion: 1, binding: { rootSessionId: bindingRoot, teamId: team.id },
    state: 'available', taskId: task.id, teamRevision: team.revision,
    task: { ...taskReadSummary(task, bindingRoot, names), description: task.description,
      acceptanceCriteria: [...task.acceptanceCriteria], ...(task.output === undefined ? {} : { output: task.output }) },
    attempts: { scope: 'retained', entries, retainedCount: retained.length, returnedCount: entries.length,
      limit: 100, truncated: entries.length < retained.length },
    observedAt: Date.now(),
  }
  // Historical aggregates may exceed today's admission limits. Do not silently
  // shorten text or emit a success body that the strict consumer cannot read.
  try { assertSwarmReadRpcValue('taskDetail', value) } catch {
    throw new TeamDomainError('Task detail exceeds its public projection bounds', 'SWARM_RPC_PROJECTION_LIMIT')
  }
  return deepFreezeJson(value)
}
