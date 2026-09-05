/** Exact grace decisions over the real domain, without a wall-clock race. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { mount, snapshotOf } from './helpers/gated-composition.js'

it('keeps phase, owner and creation time through fresh-idle grace, retries at its deadline, and leaves a cold owner untouched', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-grace-'))
  const composition = await mount(sandbox, 0)
  const { ctx, scope, lead } = composition
  const teamId = AgentSwarm.TeamId(composition.teamId)
  const domain = ctx.agentSwarm.domain
  let pass: SchedulingPass | undefined
  let restoreClock: (() => void) | undefined
  let restoreAgents: (() => void) | undefined
  let restoreFollowup: (() => void) | undefined
  try {
    const owner = 'grace-owner'
    await domain.provisionMember(scope, teamId, lead.id, { name: owner, role: 'Grace boundary', sessionId: owner, provider: 'spawn' })
    await domain.settleMember(scope, teamId, owner, { active: true })
    const task = await domain.createTask(scope, teamId, lead.id, { subject: 'Exact grace', description: 'Fresh idle edge wins over an old task clock.' })
    const claimed = await domain.claimTask(scope, teamId, lead.id, task.id, task.revision, owner)
    await domain.acknowledgeAssignment(scope, teamId, task.id, claimed.attempt.id)
    const before = await snapshotOf(composition)
    const idleAt = before.team.tasks[0]!.updatedAt + 1_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(idleAt + 199)
    restoreClock = () => clock.mockRestore()
    let live = true
    const getAgent = ctx.agents.get.bind(ctx.agents)
    const agents = vi.spyOn(ctx.agents, 'get').mockImplementation(id => String(id) === owner
      ? (live ? { status: 'idle' } as never : undefined)
      : getAgent(id))
    restoreAgents = () => agents.mockRestore()
    // Liveness and dispatch are controlled collaborators around the real
    // domain. The companion composition suite proves actual turn delivery.
    const followup = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async () => { live = false; return 'grace-followup' as never })
    restoreFollowup = () => followup.mockRestore()
    const retry = vi.spyOn(domain, 'retryAttempt')
    pass = new SchedulingPass(ctx, {
      domain: () => domain, delivery: () => ({}) as never, usage: () => ({}) as never,
      schedulerProvider: () => 'grace-observer', schedulerProviders: () => new Map([['grace-observer', { select: () => [] }]]),
      strandedAfterMs: 200, idleSince: () => idleAt, eventFaceActive: () => true,
      isClosing: () => false, trackTeamChildren: () => {}, requestSchedule: () => {},
      executionRoots: () => ({}) as never, executionRootsEnabled: () => false, sweepExecutionRoots: async () => {},
    })

    // The task is older than grace, but the CURRENT idle stretch is not.
    // Repeated completed passes and arbitrarily delayed readers cannot
    // advance this controlled decision clock past the threshold.
    for (let observation = 0; observation < 2; observation += 1) {
      await pass.run(scope, teamId, lead)
      const within = await snapshotOf(composition)
      expect(within.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: owner, createdAt: task.createdAt })
      expect(within.team.attempts).toEqual(before.team.attempts)
      expect(retry).not.toHaveBeenCalled()
      expect(followup).not.toHaveBeenCalled()
    }

    clock.mockReturnValue(idleAt + 200)
    await pass.run(scope, teamId, lead)
    const after = await snapshotOf(composition)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(after.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: owner, createdAt: task.createdAt })
    expect(after.team.tasks[0]?.currentAttemptId).not.toBe(claimed.attempt.id)
    expect(after.team.attempts.find(attempt => attempt.id === claimed.attempt.id)).toMatchObject({ phase: 'stale', diagnostic: expect.stringContaining('stranded') })
    const fresh = after.team.attempts.find(attempt => attempt.id === after.team.tasks[0]?.currentAttemptId)!
    expect(fresh).toMatchObject({ phase: 'running', memberSessionId: owner })

    // Settle the delivery checkpoint explicitly; cold-owner grace must not
    // be conflated with the separate reserved-assignment redelivery path.
    await domain.acknowledgeAssignment(scope, teamId, task.id, fresh.id)
    const cold = await snapshotOf(composition)
    clock.mockReturnValue(idleAt + 60_000)
    await pass.run(scope, teamId, lead)
    expect((await snapshotOf(composition)).team.tasks).toEqual(cold.team.tasks)
    expect((await snapshotOf(composition)).team.attempts).toEqual(cold.team.attempts)
    expect(retry).toHaveBeenCalledTimes(1)
  } finally {
    pass?.dispose()
    restoreClock?.()
    restoreAgents?.()
    restoreFollowup?.()
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
