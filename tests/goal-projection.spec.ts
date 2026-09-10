import { expect, it } from 'vitest'
import { FaultableBackend, openFaultableStack } from './helpers/storage-stack.js'
import { taskReadSummaryV2 } from '../src/host/task-read-summary.js'
import { projectTaskDetail } from '../src/host/task-detail-read.js'

it('shows a paused pending task as held and a cancelled task with its actual public conclusion', async () => {
  const f = await openFaultableStack(new FaultableBackend(), () => 10_000)
  try {
    const scope = 'goal-projection', team = await f.port.createTeam(scope, 'captain', 'Goal facts', 'Read actual control results')
    const task = await f.port.createTask(scope, team.id, 'captain', { subject: 'A pending task', description: 'Still on the board' })
    await f.port.saveGoal(scope, team.id, { kind: 'local-operator' }, { requestId: 'draft', expectedLifecycleRevision: 0, start: false,
      goal: { text: 'A finite goal', acceptanceCriteria: 'Checked', constraints: '', mode: 'finite' } })
    await f.port.controlGoal(scope, team.id, { kind: 'local-operator' }, { requestId: 'pause', expectedLifecycleRevision: 1, action: 'pause' })
    const paused = (await f.store.read(scope, team.id))!
    expect(taskReadSummaryV2(task, paused, 'captain', new Map(), 10_000)).toMatchObject({ readiness: 'paused' })
    await f.port.cancelTask(scope, team.id, 'captain', { requestId: 'cancel', taskId: task.id, expectedTaskRevision: task.revision, reason: 'The requirement was replaced' })
    const cancelled = (await f.store.read(scope, team.id))!
    const detail = projectTaskDetail(cancelled, task.id, 'captain', 2)
    expect(detail.task).toMatchObject({ status: 'cancelled', cancellation: { reason: 'The requirement was replaced', actorSessionId: 'captain', at: 10_000 } })
    expect(detail.task).not.toHaveProperty('cancellation.requestId')
    expect(detail.task).not.toHaveProperty('cancellation.expectedTaskRevision')
    expect(projectTaskDetail(cancelled, task.id, 'captain', 1).task).not.toHaveProperty('cancellation')
  } finally { await f.close() }
})
