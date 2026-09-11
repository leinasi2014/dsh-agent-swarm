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
import { MessageDelivery, type PublicDeliveryResult } from '../src/runtime/message-delivery.js'
import { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { TEAM_DOMAIN_NAME } from '../src/storage/team-spec.js'
import { Recording } from './helpers/public-chat-real-composition.js'
import { GatedAdapter } from './helpers/gated-composition.js'
import {
  mountRestartComposition as mount, disposeRestartComposition as dispose,
  restartTool as tool, type RestartMounted,
} from './helpers/restart-real-composition.js'

import { ROUTE, seed, storedEvents, queueDebt } from './helpers/startup-recovery-fixture.js'

it.each((['root', 'captain'] as const).flatMap(target => (['task', 'work', 'public', 'goal'] as const).map(debt => ({ target, debt }))))('isolates bad $target workspace with real queued $debt debt before a healthy Team', async ({ target, debt }) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-isolation-'))
  let restarted: RestartMounted | undefined
  const adapter = new GatedAdapter(), resumed: string[] = [], prompted: string[] = []
  let failures: unknown, beforeBad!: TeamState, beforeRoot!: Awaited<ReturnType<typeof storedEvents>>, beforeCaptain!: Awaited<ReturnType<typeof storedEvents>>
  const recoverApproved = vi.spyOn(AgentSwarmRuntime.prototype, 'recoverApprovedTeam')
  try {
    const [bad, good] = await seed(sandbox, async (ctx, teams) => {
      if (debt !== 'task') await queueDebt(ctx, teams[0]!, debt)
    })
    const orderedTeams = AgentSwarmRuntime.prototype.listTeamAggregates
    vi.spyOn(AgentSwarmRuntime.prototype, 'listTeamAggregates').mockImplementation(async function (this: AgentSwarmRuntime, scope) {
      const teams = (await orderedTeams.call(this, scope)).toSorted((a, b) => Number(b.id === bad.teamId) - Number(a.id === bad.teamId))
      if (scope === bad.scope && beforeBad === undefined) { expect(teams[0]?.id).toBe(bad.teamId); beforeBad = structuredClone(teams[0]!) }
      return teams
    })
    const recover = ManagedActivationRecovery.prototype.run
    vi.spyOn(ManagedActivationRecovery.prototype, 'run').mockImplementation(async function (this: ManagedActivationRecovery) {
      const result = await recover.call(this); failures = result; return result
    })
    restarted = await mount(sandbox, 0, undefined, undefined, async ctx => {
      expect(ctx.agents.roots()).toEqual([])
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      beforeRoot = await storedEvents(ctx, bad.rootId); beforeCaptain = await storedEvents(ctx, bad.captainId)
      const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async options => (await list(options)).map(snapshot =>
        snapshot.header.id === (target === 'root' ? bad.rootId : bad.captainId)
          ? { ...snapshot, header: { ...snapshot.header, cwd: join(sandbox, 'other-workspace') } } : snapshot))
      const resume = ctx.agents.resume.bind(ctx.agents)
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => { resumed.push(options.resumeSessionId); return await resume(options) })
      const host = ctx.subagents as unknown as HostPromptDeliverer, deliver = host[deliverSubagentPrompt].bind(host)
      vi.spyOn(host, deliverSubagentPrompt).mockImplementation(async (...args) => { prompted.push(args[1]); return await deliver(...args) })
    })
    await adapter.waitForRequests(1)
    expect(adapter.requests.some(request => request.sessionId === good.captainId)).toBe(true)
    expect(adapter.requests.some(request => request.sessionId === bad.captainId)).toBe(false)
    expect(resumed).not.toContain(bad.rootId); expect(resumed).not.toContain(bad.captainId)
    expect(prompted).not.toContain(bad.captainId)
    expect(recoverApproved.mock.calls.some(([, team]) => team.id === bad.teamId)).toBe(false)
    expect(failures).toEqual([expect.objectContaining({ scope: bad.scope, teamId: bad.teamId, captainSessionId: bad.captainId,
      parentSessionId: bad.rootId, stage: 'binding', code: 'TEAM_PARENT_REATTACH_FAILED', cause: expect.any(Error) })])
    expect((await restarted.ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)).toEqual(beforeBad)
    expect(await storedEvents(restarted.ctx, bad.rootId)).toEqual(beforeRoot)
    expect(await storedEvents(restarted.ctx, bad.captainId)).toEqual(beforeCaptain)
    const captain = restarted.ctx.agents.get(good.captainId)!
    expect(captain).toBeDefined()
    const pending = (await restarted.ctx.agentSwarm.listTeamAggregates(good.scope)).find(team => team.id === good.teamId)!.tasks[0]!
    const claim = await tool(restarted.ctx, captain, 'isolated-claim', 'agent_swarm_claim_task', { task_id: pending.id, expected_revision: pending.revision })
    expect(claim.isError, JSON.stringify(claim.error)).toBe(false)
    const claimed = claim.value as { revision: number; attempt_id: string }
    const submit = await tool(restarted.ctx, captain, 'isolated-submit', 'agent_swarm_submit_task', {
      task_id: pending.id, expected_revision: claimed.revision, attempt_id: claimed.attempt_id, output: 'Healthy recovered Captain completed its original task.' })
    expect(submit.isError, JSON.stringify(submit.error)).toBe(false)
    const review = await tool(restarted.ctx, captain, 'isolated-review', 'agent_swarm_review_task', {
      task_id: pending.id, expected_revision: (submit.value as { revision: number }).revision, attempt_id: claimed.attempt_id, decision: 'accept' })
    expect(review.isError, JSON.stringify(review.error)).toBe(false)
    expect((await restarted.ctx.agentSwarm.listTeamAggregates(good.scope)).find(team => team.id === good.teamId)!.tasks[0]).toMatchObject({ status: 'completed', currentAttemptId: claimed.attempt_id })
    await restarted.ctx.agentSwarm.recoverDormantManagedTeams()
    expect(prompted.filter(id => id === good.captainId)).toHaveLength(1)
    expect(prompted).not.toContain(bad.captainId)
  } finally {
    adapter.open(); vi.restoreAllMocks()
    if (restarted !== undefined) await dispose(restarted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it.each([true, false])('propagates startup publish failure while ordinary work delivery stays deferred and retryable (startup=%s)', async startup => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-publish-failure-'))
  let restarted: RestartMounted | undefined
  const fault = new Error('injected agent_swarm JSON publish failure'), adapter = new GatedAdapter()
  let failedPublishes = 0, obsoleteCommits = 0, armed = startup, before!: TeamState
  try {
    const [bad] = await seed(sandbox, async (ctx, teams) => {
      const team = teams[0]!, domain = ctx.agentSwarm.domain
      const proposed = await domain.submitWorkRequest(team.scope, team.teamId, { kind: 'local-operator' },
        { requestId: 'obsolete-before-restart', description: 'Already resolved request with an undelivered notice.' })
      await domain.resolveWorkRequest(team.scope, team.teamId, team.captainId, { workRequestId: proposed.request.id,
        expectedRequestRevision: proposed.request.revision, decision: { kind: 'reject', publicReason: 'This request is no longer needed.' } })
      before = (await domain.snapshot(team.scope, team.teamId, team.captainId)).team
      expect(before.messages.find(message => message.id === proposed.notificationMessageId)?.phase).toBe('queued')
    })
    const listTeams = AgentSwarmRuntime.prototype.listTeamAggregates
    vi.spyOn(AgentSwarmRuntime.prototype, 'listTeamAggregates').mockImplementation(async function (this: AgentSwarmRuntime, scope) {
      return (await listTeams.call(this, scope)).toSorted((a, b) => Number(b.id === bad.teamId) - Number(a.id === bad.teamId))
    })
    const outcome = await mount(sandbox, 0, undefined, undefined, ctx => {
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (...args) => {
        const domain = await open(...args)
        if (args[0].name === TEAM_DOMAIN_NAME) {
          // The existing #193 real JSON publish seam: downstream of Domain
          // enqueue and draft staging, before backend durability/publication.
          const unit = (domain as unknown as { unit: { publish(): Promise<void> } }).unit, publish = unit.publish.bind(unit)
          vi.spyOn(unit, 'publish').mockImplementation(async () => {
            if (armed && failedPublishes === 0) { failedPublishes += 1; throw fault }
            await publish()
          })
        }
        return domain
      })
      const run = ManagedActivationRecovery.prototype.run
      vi.spyOn(ManagedActivationRecovery.prototype, 'run').mockImplementation(async function (this: ManagedActivationRecovery) {
        const domain = ctx.agentSwarm.domain, obsolete = domain.markMessageObsolete.bind(domain)
        vi.spyOn(domain, 'markMessageObsolete').mockImplementation(async (...args) => {
          if (args[1] === bad.teamId) obsoleteCommits += 1
          return await obsolete(...args)
        })
        return await run.call(this)
      })
    }, { startupRecoveryExcludedTeamIds: startup ? [] : [bad.teamId] })
      .then(value => { restarted = value; return { mounted: true } }, error => ({ error }))
    if (startup) {
      expect(obsoleteCommits).toBeGreaterThan(0); expect(failedPublishes).toBe(1)
      expect(outcome).toEqual({ error: fault })
      vi.restoreAllMocks()
      const readback = await mount(sandbox, 0, undefined, undefined, ctx => { vi.spyOn(ctx.sessionPersistence, 'list').mockResolvedValue([]) })
      try { expect((await readback.ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)).toEqual(before) }
      finally { await dispose(readback) }
    } else {
      expect(outcome).toEqual({ mounted: true }); expect(failedPublishes).toBe(0)
      let delivery!: Promise<PublicDeliveryResult>
      const drain = MessageDelivery.prototype.deliverWorkRequests
      vi.spyOn(MessageDelivery.prototype, 'deliverWorkRequests').mockImplementation(function (this: MessageDelivery, ...args) {
        const result = drain.apply(this, args)
        if (args[1] === bad.teamId) delivery = result
        return result
      })
      armed = true
      restarted!.ctx.agentSwarm.kickWorkRequests(bad.scope, bad.teamId)
      expect(await delivery).toMatchObject({ deferred: true, reconciled: 0 })
      expect(failedPublishes).toBe(1)
      expect((await restarted!.ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)).toEqual(before)
      restarted!.ctx.agentSwarm.kickWorkRequests(bad.scope, bad.teamId)
      expect(await delivery).toMatchObject({ deferred: false, reconciled: 0 })
      expect((await restarted!.ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)!.messages[0]).toMatchObject({ phase: 'obsolete' })
    }
  } finally {
    adapter.open(); vi.restoreAllMocks()
    if (restarted !== undefined) await dispose(restarted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

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
