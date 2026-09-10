import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TeamMessageId } from '../src/domain/types.js'
import { DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { FaultableBackend, openFaultableStack } from './helpers/storage-stack.js'

it('commits an observed coordination under mailbox pressure and later emits its remaining result debt once', async () => {
  const backend = new FaultableBackend(), stack = await openFaultableStack(backend, () => 1_000)
  try {
    const scope = join(tmpdir(), 'goal-coordinate-capacity'), port = stack.port
    const team = await port.createTeam(scope, 'captain', 'Goals', 'Coordination under mailbox pressure')
    await port.provisionMember(scope, team.id, 'captain', { name: 'alice', role: 'worker', sessionId: 'alice', provider: 'spawn' })
    await port.settleMember(scope, team.id, 'alice', { active: true })
    await port.saveGoal(scope, team.id, { kind: 'local-operator' }, { requestId: 'start', expectedLifecycleRevision: 0,
      goal: { text: 'Deliver checked work', acceptanceCriteria: 'Review every result', constraints: '', mode: 'finite' }, start: true })
    const trigger = (await stack.store.read(scope, team.id))!.goalLifecycle!.currentTrigger!
    // This Domain-only test records the real mailbox delivery acknowledgement;
    // actual official Session claim/delivery is covered by the runtime suite.
    await port.acknowledgeMessage(scope, team.id, TeamMessageId(trigger.notificationMessageId))
    const task = await port.createTask(scope, team.id, 'captain', { subject: 'Superseded work', description: 'Produces real cancellation result debt' })
    await port.cancelTask(scope, team.id, 'captain', { requestId: 'cancel', taskId: task.id,
      expectedTaskRevision: task.revision, reason: 'Requirements changed' })
    for (let index = 0; index < DEFAULT_TEAM_LIMITS.maxPendingMessagesPerMember; index++) {
      await port.queueMessage(scope, team.id, 'alice', 'captain', `Pending work ${index}`, 'wakeup')
    }
    const before = (await stack.store.read(scope, team.id))!
    expect(before.goalLifecycle!.resultSequence).toBe(trigger.resultSequence + 1)
    expect(before.messages.filter(message => message.phase === 'queued')).toHaveLength(64)
    const input = { triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
      summary: 'The observed start trigger has been coordinated', taskIds: [], outcome: 'coordinated' as const }
    await expect(port.coordinateGoal(scope, team.id, 'captain', input)).resolves.toMatchObject({ replayed: false })
    const coordinated = (await stack.store.read(scope, team.id))!
    expect(coordinated.goalLifecycle).toMatchObject({ lastCoordination: input, resultSequence: 1, coordinatedResultSequence: 0 })
    expect(coordinated.goalLifecycle!.currentTrigger).toBeUndefined()
    expect(coordinated.messages).toEqual(before.messages)
    await expect(port.coordinateGoal(scope, team.id, 'captain', input)).resolves.toMatchObject({ replayed: true })
    expect(await stack.store.read(scope, team.id)).toEqual(coordinated)
    const pending = coordinated.messages.find(message => message.phase === 'queued')!
    await port.acknowledgeMessage(scope, team.id, pending.id)
    await port.reconcileGoal(scope, team.id)
    const emitted = (await stack.store.read(scope, team.id))!, successor = emitted.goalLifecycle!.currentTrigger!
    expect(successor).toMatchObject({ resultSequence: 1, reason: 'task-result' })
    expect(successor.id).not.toBe(trigger.id)
    expect(emitted.goalLifecycle!.lastCoordination).toEqual(coordinated.goalLifecycle!.lastCoordination)
    expect(emitted.messages.filter(message => message.id === successor.notificationMessageId)).toHaveLength(1)
    expect(emitted.messages.filter(message => message.phase === 'queued')).toHaveLength(64)
    await port.reconcileGoal(scope, team.id)
    expect(await stack.store.read(scope, team.id)).toEqual(emitted)
  } finally { await stack.close() }
})
