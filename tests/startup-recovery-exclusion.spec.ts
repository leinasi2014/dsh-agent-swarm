/** Exact Team exclusions affect automatic startup recovery, not durable work. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { expect, it, vi } from 'vitest'
import { TeamId, type TeamState } from '../src/domain/types.js'
import { ManagedActivationRecovery } from '../src/runtime/managed-activation-recovery.js'
import { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { Recording } from './helpers/public-chat-real-composition.js'
import { GatedAdapter } from './helpers/gated-composition.js'
import {
  mountRestartComposition as mount, disposeRestartComposition as dispose,
  restartTool as tool, RESTART_SIGNAL as SIGNAL, type RestartMounted,
} from './helpers/restart-real-composition.js'

const ROUTE = { provider: 'exclusion-fixture', model: 'exclusion-model' }

async function seed(sandbox: string) {
  const first = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter([ROUTE.provider], new Recording()) })
  const teams: Array<{ rootId: SessionId; captainId: SessionId; teamId: TeamId; scope: string }> = []
  try {
    for (const name of ['excluded', 'other']) {
      const root = (await first.ctx.agents.create({ sessionId: SessionId(`startup-${name}-root`), agentOptions: ROUTE,
        meta: { cwd: join(sandbox, 'workspace') } })).agent
      root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare existing work.' }] }))
      await root.whenIdle()
      const created = await tool(first.ctx, root, `create-${name}`, 'agent_swarm_create_managed', { name, description: 'Keep the existing pending task.' })
      expect(created.isError, JSON.stringify(created)).toBe(false)
      const ids = created.value as { team_id: string; captain_session_id: string }
      const teamId = TeamId(ids.team_id), captainId = SessionId(ids.captain_session_id), scope = first.ctx.agentSwarm.scopeOf(root)
      await first.ctx.agentSwarm.domain.createTask(scope, teamId, captainId, { subject: 'Pending work', description: 'Resume only when intended.' })
      await first.ctx.agents.get(captainId)?.whenIdle()
      await root.whenIdle()
      teams.push({ rootId: root.id, captainId, teamId, scope })
    }
  } finally { await dispose(first) }
  return teams as [typeof teams[number], typeof teams[number]]
}

async function storedEvents(ctx: Context, id: SessionId) {
  return (await readPersistedSession(ctx.sessionPersistence, id, SIGNAL)).events
}

it('excludes one pending Team before all startup recovery side effects while another Team resumes, then restores recovery after clearing the setting', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-exclusion-'))
  let second: RestartMounted | undefined, third: RestartMounted | undefined
  const recoverApproved = vi.spyOn(AgentSwarmRuntime.prototype, 'recoverApprovedTeam')
  try {
    const [excluded, other] = await seed(sandbox)
    const recoverUsage = vi.spyOn(UsageAccountant.prototype, 'recoverTeamUsage')
    const resumed: string[] = [], prompted: string[] = [], sessionWrites: string[] = []
    let before!: TeamState, beforeRoot!: Awaited<ReturnType<typeof storedEvents>>, beforeCaptain!: Awaited<ReturnType<typeof storedEvents>>
    const adapter = new Recording()
    second = await mount(sandbox, 0, undefined, undefined, async ctx => {
      expect(ctx.agents.roots()).toEqual([])
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      beforeRoot = await storedEvents(ctx, excluded.rootId)
      beforeCaptain = await storedEvents(ctx, excluded.captainId)
      const resume = ctx.agents.resume.bind(ctx.agents)
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => { resumed.push(options.resumeSessionId); return await resume(options) })
      const host = ctx.subagents as unknown as HostPromptDeliverer, deliver = host[deliverSubagentPrompt].bind(host)
      vi.spyOn(host, deliverSubagentPrompt).mockImplementation(async (...args) => { prompted.push(args[1]); return await deliver(...args) })
      ctx.on('session/event', session => { sessionWrites.push(session.id) })
      // Observe the exact authoritative record after storage opens but before
      // any startup recovery. This is not a second Team state authority.
      const original = AgentSwarmRuntime.prototype.recoverDormantManagedTeams
      vi.spyOn(AgentSwarmRuntime.prototype, 'recoverDormantManagedTeams').mockImplementation(async function (this: AgentSwarmRuntime) {
        before = (await this.listTeamAggregates(excluded.scope)).find(team => team.id === excluded.teamId)!
        return await original.call(this)
      })
    }, { startupRecoveryExcludedTeamIds: [excluded.teamId] })
    await vi.waitFor(() => expect(adapter.requests.some(request => request.sessionId === other.captainId)).toBe(true))
    expect(before.tasks).toEqual([expect.objectContaining({ status: 'pending' })])
    expect(resumed).not.toContain(excluded.rootId)
    expect(resumed).not.toContain(excluded.captainId)
    expect(prompted).not.toContain(excluded.captainId)
    expect(sessionWrites).not.toContain(excluded.rootId)
    expect(sessionWrites).not.toContain(excluded.captainId)
    expect(recoverApproved.mock.calls.some(([, team]) => team.id === excluded.teamId)).toBe(false)
    expect(recoverUsage.mock.calls.some(([, team]) => team.id === excluded.teamId)).toBe(false)
    expect(recoverUsage.mock.calls.some(([, team]) => team.id === other.teamId)).toBe(true)
    expect((await second.ctx.agentSwarm.listTeamAggregates(excluded.scope)).find(team => team.id === excluded.teamId)).toEqual(before)
    expect(await storedEvents(second.ctx, excluded.rootId)).toEqual(beforeRoot)
    expect(await storedEvents(second.ctx, excluded.captainId)).toEqual(beforeCaptain)
    await dispose(second); second = undefined
    vi.restoreAllMocks()

    const restored = new Recording()
    third = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter([ROUTE.provider], restored) }, { startupRecoveryExcludedTeamIds: [] })
    await vi.waitFor(() => expect(restored.requests.some(request => request.sessionId === excluded.captainId)).toBe(true))
  } finally {
    vi.restoreAllMocks()
    if (second !== undefined) await dispose(second)
    if (third !== undefined) await dispose(third)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it('preserves default startup recovery when no exclusion list is configured', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-default-'))
  let restarted: RestartMounted | undefined
  try {
    const teams = await seed(sandbox), adapter = new Recording()
    restarted = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter([ROUTE.provider], adapter) })
    await vi.waitFor(() => {
      for (const team of teams) expect(adapter.requests.some(request => request.sessionId === team.captainId)).toBe(true)
    })
  } finally {
    if (restarted !== undefined) await dispose(restarted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it('holds approved-plan startup repair but allows the explicit manual recovery with the exclusion still configured', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-plan-exclusion-'))
  const rootId = SessionId('excluded-plan-root'), captainId = SessionId('excluded-plan-captain')
  let first: RestartMounted | undefined, second: RestartMounted | undefined
  const adapter = new GatedAdapter()
  try {
    first = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter([ROUTE.provider], new Recording()) })
    const root = (await first.ctx.agents.create({ sessionId: rootId, agentOptions: ROUTE, meta: { cwd: join(sandbox, 'workspace') } })).agent
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare an approved plan.' }] }))
    await root.whenIdle()
    const scope = first.ctx.agentSwarm.scopeOf(root), domain = first.ctx.agentSwarm.domain
    const staged = await domain.createStagedManaged(scope, `managed:${rootId}:detached:plan`, 'Approved plan', 'Keep the original plan.')
    const planned = await domain.setPlanDraft(scope, staged.id, staged.revision, {
      members: [{ name: 'worker', role: 'Finish the existing task.' }],
      tasks: [{ key: 'existing', subject: 'Existing work', description: 'Resume this plan.', targetMemberName: 'worker' }],
    })
    await domain.approveStagedPlan(scope, staged.id, planned.revision, captainId)
    // Compare restart against the committed record, including its storage timestamp.
    const before = (await first.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === staged.id)!
    await dispose(first); first = undefined
    second = await mount(sandbox, 0, undefined, undefined, async ctx => {
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      await ctx.agents.resume({ resumeSessionId: rootId, agentOptions: ROUTE })
    }, { startupRecoveryExcludedTeamIds: [staged.id] })
    expect(adapter.requests).toEqual([])
    expect(second.ctx.agents.get(captainId)).toBeUndefined()
    expect((await second.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === staged.id)).toEqual(before)

    const recovered = await second.ctx.agentSwarm.recoverApprovedTeam(scope, before)
    expect(recovered.members).toHaveLength(1)
    expect(recovered.tasks).toHaveLength(1)
    await vi.waitFor(() => expect(adapter.requests.some(request => request.sessionId === captainId)).toBe(true))
  } finally {
    adapter.open()
    if (first !== undefined) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it('skips an excluded Team before goal preparation or any debt-specific drain', async () => {
  const team = { id: TeamId('excluded-team'), phase: 'active', managedOrigin: 'managed:root:detached:test',
    tasks: [], messages: [], goalLifecycle: { phase: 'waiting' } } as unknown as TeamState
  const before = structuredClone(team), prepareGoal = vi.fn(async () => team), drainPublic = vi.fn(), drainWork = vi.fn(), drainGoal = vi.fn(), trackChild = vi.fn()
  const ctx = { sessionPersistence: { list: async () => [{ header: { id: 'root', cwd: process.cwd() } }] }, logger: { info: vi.fn() } } as unknown as Context
  const recovery = new ManagedActivationRecovery(ctx, {
    teams: async () => [team], trackChild, prepareGoal, drainPublic, drainWork, drainGoal,
    excludedTeamIds: new Set([team.id]),
  })
  await recovery.run()
  for (const callback of [prepareGoal, drainPublic, drainWork, drainGoal, trackChild]) expect(callback).not.toHaveBeenCalled()
  expect(team).toEqual(before)
  expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining(team.id))
})
