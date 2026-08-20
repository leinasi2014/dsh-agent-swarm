import { TeamDomainError } from './error.js'
import type { TaskId, TeamTask } from './types.js'

/** Validate the complete active DAG after replacing or adding one task. */
export function assertTaskGraph(tasks: readonly TeamTask[]): void {
  const active = new Map<TaskId, TeamTask>()
  for (const task of tasks) {
    if (task.status !== 'cancelled') active.set(task.id, task)
  }

  for (const task of active.values()) {
    const seen = new Set<TaskId>()
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) {
        throw new TeamDomainError(`task "${task.id}" cannot depend on itself`, 'TEAM_TASK_DEPENDENCY_CYCLE')
      }
      if (seen.has(dependency)) {
        throw new TeamDomainError(
          `task "${task.id}" repeats dependency "${dependency}"`,
          'TEAM_TASK_DEPENDENCY_DUPLICATE',
        )
      }
      if (!active.has(dependency)) {
        throw new TeamDomainError(
          `task "${task.id}" depends on missing task "${dependency}"`,
          'TEAM_TASK_DEPENDENCY_MISSING',
        )
      }
      seen.add(dependency)
    }
  }

  const visiting = new Set<TaskId>()
  const visited = new Set<TaskId>()
  const visit = (id: TaskId): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      throw new TeamDomainError(`task dependency cycle includes "${id}"`, 'TEAM_TASK_DEPENDENCY_CYCLE')
    }
    visiting.add(id)
    for (const dependency of active.get(id)?.blockedBy ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of active.keys()) visit(id)
}

export function isTaskReady(tasks: readonly TeamTask[], task: TeamTask): boolean {
  if (task.status !== 'pending' || task.ownerSessionId !== undefined) return false
  const byId = new Map(tasks.map(candidate => [candidate.id, candidate]))
  return task.blockedBy.every(id => byId.get(id)?.status === 'completed')
}
