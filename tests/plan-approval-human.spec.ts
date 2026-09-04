/**
 * P0-2 S3: plan approval through the official ctx.userQuestions seam.
 *
 * approve_plan(ask_user=true) asks exactly one Approve & Run / Discard
 * question; the answer drives provisioning (approve) or archival (discard).
 * A missing userQuestions service fails closed (never auto-approve).
 * Member turns use the gated adapter so approval activation does not race a
 * fast immediate first turn.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mount, toolCall } from './helpers/gated-composition.js'

describe('plan approval through official userQuestions (S3)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })


  it('approve answer provisions the planned Team', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-human-approve-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    await composition.ctx.plugin(UserQuestionService)
    try {
      const mb = composition.ctx.agentLoop.create(SessionId(`plan-approve-mb-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await toolCall(composition.ctx, mb, 'stage', 'agent_swarm_create_managed', { name: 'Human Approval Team', description: 'Approve me.', stage: true })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const planned = await toolCall(composition.ctx, mb, 'plan', 'agent_swarm_set_plan', {
        team_id: teamId, expected_revision: 1,
        members: [{ name: 'worker', role: 'writer' }],
        tasks: [{ key: 't1', subject: 'Do', description: 'Work.', target_member_name: 'worker' }],
      })
      expect(planned.isError).toBe(false)
      composition.ctx.userQuestions.registerProvider({
        ask: async input => ({ answers: [{ id: input.questions[0]?.id ?? 'q', selected: ['Approve & Run'] }] }),
      })
      const approved = await toolCall(composition.ctx, mb, 'approve', 'agent_swarm_approve_plan', { team_id: teamId, expected_revision: 2, ask_user: true })
      expect(approved.isError).toBe(false)
      const aggregates = await composition.ctx.agentSwarm.listTeamAggregates(composition.ctx.agentSwarm.scopeOf(mb))
      const team = aggregates.find(candidate => candidate.id === AgentSwarm.TeamId(teamId))
      expect(team!.phase).toBe('active')
      expect(team!.members).toHaveLength(1)
      expect(team!.tasks).toHaveLength(1)
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('discard answer archives without starting work', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-human-discard-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    await composition.ctx.plugin(UserQuestionService)
    try {
      const mb = composition.ctx.agentLoop.create(SessionId(`plan-discard-mb-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await toolCall(composition.ctx, mb, 'stage', 'agent_swarm_create_managed', { name: 'Human Approval Team', description: 'Never start.', stage: true })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const planned = await toolCall(composition.ctx, mb, 'plan', 'agent_swarm_set_plan', {
        team_id: teamId, expected_revision: 1,
        members: [{ name: 'worker', role: 'writer' }],
        tasks: [{ key: 't1', subject: 'Never', description: 'Not executed.' }],
      })
      expect(planned.isError).toBe(false)
      composition.ctx.userQuestions.registerProvider({
        ask: async input => ({ answers: [{ id: input.questions[0]?.id ?? 'q', selected: ['Discard'] }] }),
      })
      const discarded = await toolCall(composition.ctx, mb, 'discard', 'agent_swarm_approve_plan', { team_id: teamId, expected_revision: 2, ask_user: true })
      expect(discarded.isError).toBe(false)
      const aggregates = await composition.ctx.agentSwarm.listTeamAggregates(composition.ctx.agentSwarm.scopeOf(mb))
      const team = aggregates.find(candidate => candidate.id === AgentSwarm.TeamId(teamId))
      expect(team!.phase).toBe('archived')
      expect(team!.captainSessionId).toBe('')
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('fails closed when the userQuestions service is absent', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-human-missing-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    try {
      const mb = composition.ctx.agentLoop.create(SessionId(`plan-missing-mb-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await toolCall(composition.ctx, mb, 'stage', 'agent_swarm_create_managed', { name: 'Human Approval Team', description: 'Never start.', stage: true })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const planned = await toolCall(composition.ctx, mb, 'plan', 'agent_swarm_set_plan', {
        team_id: teamId, expected_revision: 1,
        members: [{ name: 'worker', role: 'writer' }],
        tasks: [{ key: 't1', subject: 'Never', description: 'Not executed.' }],
      })
      expect(planned.isError).toBe(false)
      const approved = await toolCall(composition.ctx, mb, 'approve', 'agent_swarm_approve_plan', { team_id: teamId, expected_revision: 2, ask_user: true })
      expect(approved.isError).toBe(true)
      expect((approved.error as { info?: { code?: string } }).info?.code).toBe('TEAM_HUMAN_QUESTIONS_MISSING')
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })
})

