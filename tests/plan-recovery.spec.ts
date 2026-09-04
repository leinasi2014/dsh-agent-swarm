/**
 * P0-2 S4: crash-window recovery for an approved managed Team.
 *
 * The staged->active commit is durable before provisioning. If the process
 * dies (or Captain start fails) right after the commit, the declared Captain
 * and the planned members/tasks are missing. recoverApprovedTeam re-provisions
 * them on the existing Team; a second call is idempotent.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { mount, toolCall } from './helpers/gated-composition.js'

describe('approved Captain recovery (S4)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('re-provisions the declared Captain, planned members and tasks after a commit-without-provisioning crash', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-recovery-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    try {
      const mb = composition.ctx.agentLoop.create(SessionId(`plan-recovery-mb-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await toolCall(composition.ctx, mb, 'stage', 'agent_swarm_create_managed', { name: 'Recovery Team', description: 'Survive a crash.', stage: true })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const planned = await toolCall(composition.ctx, mb, 'plan', 'agent_swarm_set_plan', {
        team_id: teamId, expected_revision: 1,
        members: [{ name: 'worker', role: 'writer' }],
        tasks: [
          { key: 't1', subject: 'Implement', description: 'Write.', target_member_name: 'worker' },
          { key: 't2', subject: 'Review', description: 'Approve.', dependencies: ['t1'], target_member_name: 'worker' },
        ],
      })
      expect(planned.isError).toBe(false)

      // Simulate: durable active commit happened, provisioning never ran.
      const declaredCaptain = randomUUID()
      const scope = composition.ctx.agentSwarm.scopeOf(mb)
      const committed = await composition.ctx.agentSwarm.domain.approveStagedPlan(scope, TeamId(teamId), 2, declaredCaptain)
      expect(committed.phase).toBe('active')
      expect(committed.members).toEqual([])
      expect(composition.ctx.agents.get(SessionId(declaredCaptain))).toBeUndefined()

      let aggregate = (await composition.ctx.agentSwarm.listTeamAggregates(scope)).find(candidate => candidate.id === TeamId(teamId))!
      const recovered = await composition.ctx.agentSwarm.recoverApprovedTeam(scope, aggregate)
      expect(recovered.phase).toBe('active')
      expect(recovered.members).toHaveLength(1)
      expect(recovered.tasks).toHaveLength(2)
      expect(recovered.tasks.find(task => task.subject === 'Review')?.blockedBy).toHaveLength(1)
      expect(composition.ctx.agents.get(SessionId(declaredCaptain))).toBeDefined()

      // Idempotent second recovery: no duplicate members/tasks.
      aggregate = (await composition.ctx.agentSwarm.listTeamAggregates(scope)).find(candidate => candidate.id === TeamId(teamId))!
      const again = await composition.ctx.agentSwarm.recoverApprovedTeam(scope, aggregate)
      expect(again.members).toHaveLength(1)
      expect(again.tasks).toHaveLength(2)
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })
})
