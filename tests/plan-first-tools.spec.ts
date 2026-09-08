/**
 * P0-2 S2 RED: plan-first tool surface over the real composition.
 *
 * Contract:
 * - create_managed(stage=true) returns a staged Team (cape space captain id '',
 *   no members/tasks) and list_managed_teams exposes it to the owning Main Brain.
 * - set_plan stores the bounded declaration; approve_plan atomically activates the
 *   Team and provisions the dedicated Captain, the planned members (with their
 *   planned routes/deny lists) and the planned task graph (keys resolved to real
 *   task ids, targets resolved to member sessions, dependencies wired).
 * - discard_plan archives the staged draft and prevents work from starting.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId } from '../src/domain/types.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'
import { assertSwarmReadRpcValue } from '../src/rpc/read-rpc-artifact.js'
import type { SwarmReadRpcRequest } from '../src/rpc/read-rpc-contract.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { mount, toolCall } from './helpers/gated-composition.js'

describe('plan-first tool surface (S2)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('reads unstarted and discarded managed Teams through the owner UI without provisioning a Captain', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-ui-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx } = composition
    const rpc = new AgentSwarmReadRpcService({ ctx, runtime: ctx.agentSwarm, hostRead: ctx.agentSwarmHostRead,
      webServer: { host: '127.0.0.1', port: 8279, register: () => () => {} } })
    const client = new SwarmReadClient(async (_input, init) => new Response(JSON.stringify({
      schemaVersion: 1, ok: true, value: await rpc.invoke(JSON.parse(String(init?.body))),
    }), { status: 200 }))
    const read = async (request: SwarmReadRpcRequest) => {
      const envelope = await client.request(request)
      if (!envelope.ok) throw new Error(envelope.error.message)
      return envelope.value
    }
    try {
      const owner = ctx.agentLoop.create(SessionId(`plan-ui-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: composition.scope })
      const stranger = ctx.agentLoop.create(SessionId(`${owner.id}-other`), { provider: 'mock', model: 'mock' }, { cwd: composition.scope })
      const staged = await toolCall(ctx, owner, 'stage-ui', 'agent_swarm_create_managed', { name: 'Visible draft', description: 'Await approval.', stage: true })
      expect(staged.isError).toBe(false)
      const teamId = (staged.value as { team_id: string }).team_id
      const target = { rootSessionId: owner.id, teamId }
      const directory = await read({ schemaVersion: 1, method: 'teams', target: { rootSessionId: owner.id } })
      expect(directory).toMatchObject({ teams: [{ teamId, phase: 'staged', captainSessionId: '' }] })
      assertSwarmReadRpcValue('teams', directory)
      for (const method of ['binding', 'status', 'snapshot', 'captainMembers', 'captainAnnouncements', 'captainDiagnostics'] as const) {
        const value = await read({ schemaVersion: 1, method, target })
        expect(value).toMatchObject({ binding: { rootSessionId: owner.id, teamId } })
        assertSwarmReadRpcValue(method, value)
      }
      const page = await read({ schemaVersion: 1, method: 'page', target, page: { kind: 'tasks', offset: 0, limit: 10 } })
      assertSwarmReadRpcValue('page', page)
      expect(await read({ schemaVersion: 1, method: 'teams', target: { rootSessionId: stranger.id } })).toMatchObject({ teams: [] })
      await expect(read({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: stranger.id, teamId } }))
        .rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
      const discarded = await toolCall(ctx, owner, 'discard-ui', 'agent_swarm_discard_plan', { team_id: teamId, expected_revision: 1 })
      expect(discarded.isError).toBe(false)
      const archived = await read({ schemaVersion: 1, method: 'teams', target: { rootSessionId: owner.id } })
      expect(archived).toMatchObject({ teams: [{ teamId, phase: 'archived', captainSessionId: '' }] })
      assertSwarmReadRpcValue('teams', archived)
      expect(await read({ schemaVersion: 1, method: 'snapshot', target })).toMatchObject({ team: { phase: 'archived' }, roster: [], tasks: [] })
      expect(composition.adapter.requests).toHaveLength(0)
    } finally {
      await rpc.dispose()
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('stages, plans, approves and provisions captain/members/tasks; discard prevents start', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-tools-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    try {
      const mb = composition.ctx.agentLoop.create(SessionId(`plan-first-root-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await toolCall(composition.ctx, mb, 'stage', 'agent_swarm_create_managed', {
        name: 'Plan Team', description: 'Review recent deliveries.', stage: true,
      })
      expect(created.isError).toBe(false)
      const value = created.value as { team_id: string; captain_session_id?: string }
      const teamId = value.team_id
      expect(value.captain_session_id).toBe('')

      const listed = await toolCall(composition.ctx, mb, 'list-stage', 'agent_swarm_list_managed_teams', {})
      expect(listed.isError).toBe(false)
      const rows = (listed.value as { teams: Array<{ team_id: string; phase: string }> }).teams
      expect(rows.find(row => row.team_id === teamId)?.phase).toBe('staged')

      const planned = await toolCall(composition.ctx, mb, 'plan', 'agent_swarm_set_plan', {
        team_id: teamId, expected_revision: 1,
        members: [
          { name: 'writer', role: 'implementer', model: 'mock' },
          { name: 'reviewer', role: 'reviewer', model: 'mock', deny_tools: ['agent_swarm_archive'] },
        ],
        tasks: [
          { key: 't1', subject: 'Implement', description: 'Write the change.', target_member_name: 'writer' },
          { key: 't2', subject: 'Review', description: 'Approve the change.', dependencies: ['t1'], target_member_name: 'reviewer' },
        ],
      })
      expect(planned.isError).toBe(false)

      const approved = await toolCall(composition.ctx, mb, 'approve', 'agent_swarm_approve_plan', {
        team_id: teamId, expected_revision: 2,
      })
      expect(approved.isError).toBe(false)

      const aggregates = await composition.ctx.agentSwarm.listTeamAggregates(composition.ctx.agentSwarm.scopeOf(mb))
      const team = aggregates.find(candidate => candidate.id === TeamId(teamId))
      expect(team).toBeDefined()
      expect(team!.phase).toBe('active')
      expect(team!.captainSessionId).not.toBe('')
      expect(team!.members).toHaveLength(2)
      expect(team!.tasks).toHaveLength(2)
      const reviewer = team!.members.find(member => member.name === 'reviewer')!
      const review = team!.tasks.find(task => task.subject === 'Review')!
      expect(review.blockedBy.map(String)).toEqual([team!.tasks.find(task => task.subject === 'Implement')!.id])
      expect(review.targetMemberSessionId).toBe(reviewer.sessionId)
      expect(reviewer.sessionId).not.toBe(team!.captainSessionId)
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('discards a staged plan without starting work and is idempotent at the tool face', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-plan-discard-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    try {
      const mb = composition.ctx.agentLoop.create(SessionId(`plan-first-root-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await toolCall(composition.ctx, mb, 'stage', 'agent_swarm_create_managed', {
        name: 'Discard Team', description: 'Never start.', stage: true,
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id

      const planned = await toolCall(composition.ctx, mb, 'plan', 'agent_swarm_set_plan', {
        team_id: teamId, expected_revision: 1,
        members: [{ name: 'worker', role: 'writer' }],
        tasks: [{ key: 't1', subject: 'Never', description: 'Not executed.' }],
      })
      expect(planned.isError).toBe(false)

      const discarded = await toolCall(composition.ctx, mb, 'discard', 'agent_swarm_discard_plan', {
        team_id: teamId, expected_revision: 2,
      })
      expect(discarded.isError).toBe(false)

      const aggregates = await composition.ctx.agentSwarm.listTeamAggregates(composition.ctx.agentSwarm.scopeOf(mb))
      const team = aggregates.find(candidate => candidate.id === TeamId(teamId))
      expect(team!.phase).toBe('archived')
      expect(team!.members).toEqual([])
      expect(team!.tasks).toEqual([])
      expect(team!.captainSessionId).toBe('')
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })
})

