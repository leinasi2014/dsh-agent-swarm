/** Maintenance retry uses original notices and rechecks authority after awaited recovery. */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Recording, setup, captureRestartSnapshot } from './helpers/public-chat-real-composition.js'
import { MaintenanceLoop, maintenanceCheckpoint, maintenanceTimers } from './helpers/maintenance-recovery.js'
import { ManagedActivationRecovery } from '../src/runtime/managed-activation-recovery.js'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamMessage } from '../src/domain/types.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import * as frames from '../src/runtime/frame-visibility.js'
import * as notices from '../src/runtime/work-request-delivery.js'

class HeldGoal extends Recording {
  release!: () => void
  private readonly gate = new Promise<void>(resolve => { this.release = resolve })
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('automatically repairs an already claimed goal notice after failed flush without another model input or reminder', async () => {
  const cut = await maintenanceCheckpoint(), { scope, teamId, captainId, firstDue } = cut
  const timers = maintenanceTimers(firstDue - 50_000), adapter = new HeldGoal()
  let resumed: Awaited<ReturnType<typeof setup>> | undefined, armed = true, checkingClaim = false, faults = 0, deferred = 0, reconciled = 0
  try {
    resumed = await setup(cut.checkpoint, adapter)
    const wait = frames.waitForFrameClaim, flush = resumed.ctx.sessions.flush.bind(resumed.ctx.sessions)
    vi.spyOn(frames, 'waitForFrameClaim').mockImplementation(async (...args) => {
      checkingClaim = true
      try { return await wait(...args) } finally { checkingClaim = false }
    })
    vi.spyOn(resumed.ctx.sessions, 'flush').mockImplementation(async session => {
      if (armed && checkingClaim && session.id === captainId) { faults++; throw new Error('temporary claimed goal input flush failure') }
      return await flush(session)
    })
    const deliver = notices.deliverWorkRequestNotice
    vi.spyOn(notices, 'deliverWorkRequestNotice').mockImplementation(async (...args) => {
      const result = await deliver(...args)
      if (args[6] === 'goal-coordination-notice') {
        if (result.result.deferred) deferred++
        reconciled += result.result.reconciled
      }
      return result
    })
    timers.pending[0]!.fire()
    await vi.waitFor(() => expect(deferred).toBeGreaterThan(0), { timeout: 15_000 })
    expect(faults).toBeGreaterThan(0)
    const interrupted = (await resumed.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    const trigger = interrupted.goalLifecycle!.currentTrigger!, noticeId = trigger.notificationMessageId
    expect(interrupted.goalLifecycle?.phase).toBe('running')
    expect(interrupted.messages.find(message => message.id === noticeId)?.phase).toBe('queued')
    expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(1)
    const matchingInputs = async () => (await readPersistedSession(resumed!.ctx.sessionPersistence, captainId)).events
      .filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text'
        && block.text.includes(`Goal coordination notice "${noticeId}":`)))
    expect(resumed.ctx.agents.get(captainId)!.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.includes(`Goal coordination notice "${noticeId}":`)))).toHaveLength(1)
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1))
    expect(timers.pending[0]!.delay).toBeGreaterThanOrEqual(1000)
    armed = false; timers.pending[0]!.fire()
    await vi.waitFor(() => expect(reconciled).toBe(1), { timeout: 15_000 })
    const after = (await resumed.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    expect(after.goalLifecycle?.phase).toBe('running')
    expect(after.goalLifecycle?.currentTrigger).toEqual(trigger)
    expect(after.messages.find(message => message.id === noticeId)?.phase).toBe('delivered')
    expect(after.messages.filter(message => message.kind === 'goal-coordination-notice' && message.triggerId === trigger.id)).toHaveLength(1)
    expect(await matchingInputs()).toHaveLength(1)
    expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(1)
    await vi.waitFor(() => expect(timers.pending).toHaveLength(0))
    adapter.release(); await resumed.ctx.agents.get(captainId)?.whenIdle()
    expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(1)
    expect(timers.pending).toHaveLength(0)
  } finally {
    adapter.release(); vi.restoreAllMocks(); timers.restore(); await resumed?.close()
    await rm(cut.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)

it.each(['pause', 'budget', 'owner', 'archive', 'dispose'] as const)('revokes maintenance retry after %s during awaited root recovery', async change => {
  const cut = await maintenanceCheckpoint(), { scope, teamId, captainId, firstDue } = cut
  const timers = maintenanceTimers(firstDue - 50_000), adapter = new Recording()
  let resumed: Awaited<ReturnType<typeof setup>> | undefined, release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    resumed = await setup(cut.checkpoint, adapter)
    const ensure = ManagedActivationRecovery.prototype.ensurePublicRoot
    const recovery = vi.spyOn(ManagedActivationRecovery.prototype, 'ensurePublicRoot')
      .mockRejectedValueOnce(new Error('first maintenance root attachment failure'))
    timers.pending[0]!.fire()
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1))
    const before = (await resumed.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    expect(before.goalLifecycle?.phase).toBe('running')
    expect(adapter.requests).toHaveLength(0)
    recovery.mockImplementationOnce(async function (this: ManagedActivationRecovery, ...args) {
      const root = await ensure.apply(this, args)
      entered = true; await gate
      return root
    })
    const wake = vi.spyOn(resumed.ctx.agentSwarm.goals, 'wake')
    timers.pending[0]!.fire()
    await vi.waitFor(() => expect(entered).toBe(true))
    if (change === 'pause') await resumed.ctx.agentSwarm.goals.controlOperator(scope, teamId,
      { requestId: 'pause-during-maintenance-retry', expectedLifecycleRevision: before.goalLifecycle!.revision, action: 'pause' })
    else if (change === 'budget') await resumed.ctx.agentSwarm.domain.consumeTokens(scope, teamId, 1000 - before.budget.usedTokens)
    else if (change === 'owner') resumed.ctx.agentSwarm.orchestration.acquire(scope, teamId, 'maintenance-test-owner')
    else if (change === 'archive') await resumed.ctx.agentSwarm.domain.archiveTeam(scope, teamId, captainId, 'Archive during awaited maintenance retry')
    else await resumed.ctx.agentSwarm.dispose()
    release()
    await Promise.allSettled(wake.mock.results.map(result => result.value))
    expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(0)
    await vi.waitFor(() => expect(timers.pending).toHaveLength(0))
    if (change !== 'dispose') {
      const after = (await resumed.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
      expect(after.messages.find(message => message.id === before.goalLifecycle!.currentTrigger!.notificationMessageId)?.phase).not.toBe('delivered')
    }
  } finally {
    release(); vi.restoreAllMocks(); timers.restore(); await resumed?.close()
    await rm(cut.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)

it('cold recovery continues the original queued maintenance trigger after the timer root attempt failed', async () => {
  const cut = await maintenanceCheckpoint(), { scope, teamId, captainId, firstDue } = cut
  const timers = maintenanceTimers(firstDue - 50_000), saved = join(cut.directory, 'interrupted'), adapter = new MaintenanceLoop()
  let second: Awaited<ReturnType<typeof setup>> | undefined, third: Awaited<ReturnType<typeof setup>> | undefined
  let settledDuringClaim: TeamMessage | undefined
  try {
    second = await setup(cut.checkpoint, new Recording())
    const recovery = vi.spyOn(ManagedActivationRecovery.prototype, 'ensurePublicRoot')
      .mockRejectedValueOnce(new Error('root admission failed before cold cut'))
    timers.pending[0]!.fire()
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1))
    const interrupted = (await second.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    const trigger = interrupted.goalLifecycle!.currentTrigger!
    expect(interrupted.messages.find(message => message.id === trigger.notificationMessageId)?.phase).toBe('queued')
    clearTimeout(timers.pending[0]!.timer)
    await captureRestartSnapshot(second, cut.checkpoint, saved)
    await second.close(); second = undefined; recovery.mockRestore()
    const acknowledge = TeamDomain.prototype.acknowledgeMessage
    vi.spyOn(TeamDomain.prototype, 'acknowledgeMessage').mockImplementation(async function (this: TeamDomain, ...args) {
      // Fix the observed legal ordering using the real Captain transaction,
      // then let the actual acknowledgement reject its now-obsolete notice.
      if (args[2] === trigger.notificationMessageId) await vi.waitFor(async () => {
        expect((await this.snapshot(scope, teamId, captainId)).team.goalLifecycle?.lastCoordination?.triggerId).toBe(trigger.id)
      }, { timeout: 15_000 })
      try { return await acknowledge.apply(this, args) }
      catch (error) {
        settledDuringClaim = (await this.snapshot(scope, teamId, captainId)).team.messages.find(message => message.id === trigger.notificationMessageId)
        throw error
      }
    })
    third = await setup(saved, adapter)
    await vi.waitFor(async () => {
      expect(adapter.rounds).toBe(1)
      expect((await third!.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle?.phase).toBe('waiting')
    }, { timeout: 15_000 })
    const after = (await third.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    expect(after).toMatchObject({ id: interrupted.id, captainSessionId: interrupted.captainSessionId, managedOrigin: interrupted.managedOrigin })
    expect(after.goalLifecycle?.lastCoordination?.triggerId).toBe(trigger.id)
    expect(after.messages.filter(message => message.kind === 'goal-coordination-notice' && message.triggerId === trigger.id)).toHaveLength(1)
    expect(settledDuringClaim).toMatchObject({ id: trigger.notificationMessageId, phase: 'obsolete', obsoletedAt: expect.any(Number), obsoletedReason: expect.any(String) })
    expect(after.messages.find(message => message.id === trigger.notificationMessageId)).toEqual(settledDuringClaim)
    const events = (await readPersistedSession(third.ctx.sessionPersistence, captainId)).events
    expect(events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text'
      && block.text.includes(`Goal coordination notice "${trigger.notificationMessageId}":`)))).toHaveLength(1)
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1))
    expect(timers.pending[0]!.at).toBe(after.goalLifecycle!.nextDueAt)
  } finally {
    vi.restoreAllMocks(); timers.restore(); await second?.close(); await third?.close()
    await rm(cut.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)
