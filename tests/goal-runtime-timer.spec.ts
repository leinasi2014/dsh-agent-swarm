/** Real Domain transitions plus the one SchedulingPass timer, with a controlled clock. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { priorityReadyScheduler } from '../src/runtime/providers.js'
import { mount } from './helpers/gated-composition.js'

it('replaces an obsolete stranded timer with the maintenance deadline before the Captain becomes cold', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-timer-')), f = await mount(sandbox, 0)
  const domain = f.ctx.agentSwarm.domain, teamId = TeamId(f.teamId), scope = f.scope, lead = f.lead
  let pass: SchedulingPass | undefined, restore = () => {}
  try {
    const worker = await f.ctx.agentLoop.create(SessionId('goal-timer-worker'), { provider: 'mock', model: 'mock' }, { cwd: scope })
    await domain.provisionMember(scope, teamId, lead.id, { name: 'timer-worker', role: 'work', sessionId: worker.id, provider: 'spawn' })
    await domain.settleMember(scope, teamId, worker.id, { active: true })
    const task = await domain.createTask(scope, teamId, lead.id, { subject: 'Finish before next round', description: 'The old timer becomes obsolete.' })
    const claim = await domain.claimTask(scope, teamId, lead.id, task.id, task.revision, worker.id)
    await domain.acknowledgeAssignment(scope, teamId, task.id, claim.attempt.id)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const wake = vi.fn(async () => {}), request = vi.fn(), anchor = Date.now()
    pass = new SchedulingPass(f.ctx, { domain: () => domain, delivery: () => ({}) as never, usage: () => ({}) as never,
      schedulerProvider: () => 'priority-ready', schedulerProviders: () => new Map([['priority-ready', priorityReadyScheduler()]]),
      duringProvider: async (_scope, _team, op) => await op(), strandedAfterMs: 1000, idleSince: () => anchor,
      eventFaceActive: () => true, isClosing: () => false, trackTeamChildren: () => {}, requestSchedule: request,
      executionRoots: () => ({}) as never, executionRootsEnabled: () => false, sweepExecutionRoots: async () => {}, wakeGoal: wake })
    await pass.run(scope, teamId, lead)
    expect(vi.getTimerCount()).toBe(1)
    const submitted = await domain.submitTask(scope, teamId, worker.id, task.id, claim.task.revision, claim.attempt.id, 'Checked old result')
    await domain.reviewTask(scope, teamId, lead.id, task.id, submitted.revision, claim.attempt.id, 'accept')
    const saved = await domain.saveGoal(scope, teamId, { kind: 'captain', sessionId: lead.id }, { requestId: 'maintenance', expectedLifecycleRevision: 0, start: true,
      tokenBudget: { expectedTokenLimit: null, tokenLimit: 100 }, goal: { text: 'Maintain', acceptanceCriteria: 'Review each round.', constraints: '', mode: 'maintenance', intervalMs: 60_000 } })
    const trigger = saved.team.goalLifecycle!.currentTrigger!
    const ended = await domain.coordinateGoal(scope, teamId, lead.id, { triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
      summary: 'This round is complete.', taskIds: [task.id], outcome: 'round-finished' })
    pass.trackGoalDeadline(scope, ended.team)
    expect(vi.getTimerCount()).toBe(1)
    const get = f.ctx.agents.get.bind(f.ctx.agents)
    const spy = vi.spyOn(f.ctx.agents, 'get').mockImplementation(id => id === lead.id ? undefined : get(id))
    restore = () => spy.mockRestore()
    await vi.advanceTimersByTimeAsync(1500)
    expect(wake).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wake).toHaveBeenCalledExactlyOnceWith(scope, teamId)
    expect(request).not.toHaveBeenCalled()
  } finally {
    restore(); pass?.dispose(); vi.useRealTimers(); f.adapter.open()
    for (const fiber of f.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
