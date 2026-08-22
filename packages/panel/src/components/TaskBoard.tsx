import type { SwarmTaskView } from '../types.ts'
import { formatSwarmString, type StringsKey, type SwarmStrings } from '../strings.ts'

/** Props for the task board. */
export interface TaskBoardProps {
  readonly tasks: ReadonlyArray<SwarmTaskView>
  readonly strings: SwarmStrings
  readonly onSelectTask?: (taskId: string) => void
}

/** Dictionary label for a status, falling back to the raw host status word. */
function statusLabel(status: string, strings: SwarmStrings): string {
  return strings[`task.status.${status}` as StringsKey] ?? status
}

/**
 * Task rows with a status badge (colored via the `[data-status]` selectors in
 * panel.css over the --swarm-state-* variables), the owner, an attempts count
 * (hidden while a task has never been attempted), and collapsed blocked-by
 * evidence: the first blocker id plus a "+N more" chip. An empty board shows
 * its empty state instead of an empty list.
 */
export function TaskBoard({ tasks, strings, onSelectTask }: TaskBoardProps) {
  return (
    <section className="swarm-tasks" aria-label={strings['tasks.aria']}>
      <div className="swarm-tasks__title">{strings['tasks.title']}</div>
      {tasks.length === 0
        ? <p className="swarm-tasks__empty">{strings['tasks.empty']}</p>
        : (
          <ul className="swarm-tasks__list">
            {tasks.map(task => {
              const blockers = task.blockedBy ?? []
              const [firstBlocker] = blockers
              const restBlockers = Math.max(0, blockers.length - 1)
              const row = (
                <>
                  <span className="swarm-task__status" data-status={task.status}>{statusLabel(task.status, strings)}</span>
                  <span className="swarm-task__title">{task.title}</span>
                  <span className="swarm-task__meta">
                    <span className="swarm-task__owner">{task.ownerId ?? strings['task.unowned']}</span>
                    {task.attempts > 0
                      ? <span className="swarm-task__attempts">{formatSwarmString(strings['task.attempts'], { count: task.attempts })}</span>
                      : null}
                    {firstBlocker === undefined
                      ? null
                      : (
                        <span className="swarm-task__blocked">
                          {strings['task.blockedBy']} {firstBlocker}
                          {restBlockers > 0
                            ? <span className="swarm-task__blocked-rest">{formatSwarmString(strings['task.blockedByMore'], { count: restBlockers })}</span>
                            : null}
                        </span>
                      )}
                  </span>
                </>
              )
              return (
                <li key={task.id} className="swarm-task">
                  {onSelectTask === undefined
                    ? <div className="swarm-task__body">{row}</div>
                    : (
                      <button
                        type="button"
                        className="swarm-task__select"
                        aria-label={formatSwarmString(strings['task.select'], { title: task.title })}
                        onClick={() => { onSelectTask(task.id) }}
                      >
                        {row}
                      </button>
                    )}
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}
