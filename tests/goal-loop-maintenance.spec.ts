/** Actual persisted maintenance rounds; only due clock callbacks and one IO failure are controlled. */
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { setup } from './helpers/public-chat-real-composition.js'
import { MaintenanceLoop, maintenanceCheckpoint, maintenanceTimers } from './helpers/maintenance-recovery.js'
import { ManagedActivationRecovery } from '../src/runtime/managed-activation-recovery.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import * as notices from '../src/runtime/work-request-delivery.js'

it.each(['none', 'root', 'delivery'] as const)('continues the same persisted maintenance round after %s failure and stops at token exhaustion', async failure => {
  const cut = await maintenanceCheckpoint(), { scope, teamId, captainId, rootId, before, firstDue } = cut
  const timers = maintenanceTimers(firstDue - 50_000), adapter = new MaintenanceLoop()
  let second: Awaited<ReturnType<typeof setup>> | undefined, inNotice = false, readFaults = 0, deferred = 0, armed = failure === 'delivery'
  try {
    second = await setup(cut.checkpoint, adapter)
    expect(adapter.requests).toHaveLength(0)
    expect(timers.pending).toHaveLength(1); expect(timers.pending[0]!.at).toBe(firstDue)
    expect((await second.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle?.nextDueAt).toBe(firstDue)
    const rootRecovery = vi.spyOn(ManagedActivationRecovery.prototype, 'ensurePublicRoot')
    if (failure === 'root') rootRecovery.mockRejectedValueOnce(new Error('one transient root restoration failure'))
    if (failure === 'delivery') {
      const deliver = notices.deliverWorkRequestNotice, open = second.ctx.sessionPersistence.open.bind(second.ctx.sessionPersistence)
      vi.spyOn(notices, 'deliverWorkRequestNotice').mockImplementation(async (...args) => {
        inNotice = args[6] === 'goal-coordination-notice'
        try {
          const result = await deliver(...args)
          if (inNotice && result.result.deferred) deferred++
          return result
        } finally { inNotice = false }
      })
      vi.spyOn(second.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (inNotice && armed && args[0] === rootId && args[1] === 'read') {
          vi.spyOn(handle, 'read').mockImplementationOnce(async () => { readFaults++; throw new Error('temporary goal notice lineage read failure') })
        }
        return handle
      })
    }
    const firstTimer = timers.pending[0]!
    vi.setSystemTime(firstDue + 5); firstTimer.fire()
    let failedTriggerId: string | undefined
    if (failure !== 'none') {
      if (failure === 'root') await vi.waitFor(() => expect(rootRecovery).toHaveBeenCalledOnce())
      else await vi.waitFor(() => expect(deferred).toBeGreaterThan(0))
      const interrupted = (await second.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle!
      expect(interrupted.phase).toBe('running'); failedTriggerId = interrupted.currentTrigger!.id
      expect(adapter.rounds).toBe(0)
      await vi.waitFor(() => expect(timers.pending.some(timer => timer.delay < 30_000)).toBe(true))
      const retry = timers.pending.find(timer => timer.delay < 30_000)!
      expect(retry.delay).toBeGreaterThanOrEqual(1000)
      if (failure === 'delivery') expect(readFaults).toBeGreaterThan(0)
      armed = false; retry.fire()
    }
    await vi.waitFor(async () => {
      expect(adapter.rounds).toBe(1)
      expect((await second!.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle?.phase).toBe('waiting')
    }, { timeout: 15_000 })
    await second.ctx.agents.get(captainId)?.whenIdle()
    const after = (await second.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    expect(after).toMatchObject({ id: before.id, captainSessionId: before.captainSessionId, managedOrigin: before.managedOrigin, phase: 'active' })
    expect(after.goalLifecycle!.lastCoordination!.at).toBeGreaterThanOrEqual(firstDue + 5)
    expect(after.goalLifecycle?.nextDueAt).toBe(after.goalLifecycle!.lastCoordination!.at + 60_000)
    const completedTrigger = after.goalLifecycle!.lastCoordination!.triggerId
    expect(completedTrigger).not.toBe(before.goalLifecycle?.lastCoordination?.triggerId)
    if (failure !== 'none') expect(completedTrigger).toBe(failedTriggerId)
    const messages = after.messages.filter(message => message.kind === 'goal-coordination-notice' && message.triggerId === completedTrigger)
    expect(messages).toHaveLength(1)
    const events = (await readPersistedSession(second.ctx.sessionPersistence, captainId)).events
    expect(events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text'
      && block.text.includes(`Goal coordination notice "${messages[0]!.id}":`)))).toHaveLength(1)
    expect(after.tasks).toHaveLength(0)
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1))
    expect(timers.pending[0]!.at).toBe(after.goalLifecycle!.nextDueAt)
    await second.ctx.agentSwarm.domain.consumeTokens(scope, teamId, Math.max(0, 1000 - after.budget.usedTokens))
    const due = timers.pending[0]!, wake = vi.spyOn(second.ctx.agentSwarm.goals, 'wake')
    due.fire()
    expect(wake).toHaveBeenCalledOnce(); await wake.mock.results[0]!.value
    expect(adapter.rounds).toBe(1)
    expect(await second.ctx.agentSwarm.goals.snapshot(scope, teamId)).toMatchObject({ waitingReason: 'budget', lifecycle: { phase: 'waiting', nextDueAt: due.at } })
    expect(timers.pending).toHaveLength(0)
  } finally {
    vi.restoreAllMocks(); timers.restore(); await second?.close()
    await rm(cut.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)
