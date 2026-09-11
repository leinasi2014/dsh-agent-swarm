/** Approved-plan failures belong to the awaited startup pass. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { DedicatedCaptainProvisioner } from '../src/runtime/dedicated-captain-provisioning.js'
import { TEAM_DOMAIN_NAME } from '../src/storage/team-spec.js'
import { GatedAdapter } from './helpers/gated-composition.js'
import { Recording } from './helpers/public-chat-real-composition.js'
import { ROUTE } from './helpers/startup-recovery-fixture.js'
import { mountRestartComposition as mount, disposeRestartComposition as dispose, type RestartMounted } from './helpers/restart-real-composition.js'

it.each(['publish-failure', 'captain-retired'] as const)('awaits actual approved-plan recovery and classifies %s', async point => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-approved-')), adapter = new GatedAdapter()
  const rootId = SessionId('approved-recovery-root'), captainId = SessionId('approved-recovery-captain')
  const fault = new Error('injected actual approved-plan JSON publish failure')
  let first: RestartMounted | undefined, second: RestartMounted | undefined, armed = false
  let publishes = 0, attempts = 0, captainCreated = false, cleanupObserved = false, hostPreserved = false, retirementCuts = 0, finished = false
  try {
    first = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter([ROUTE.provider], new Recording()) })
    const root = (await first.ctx.agents.create({ sessionId: rootId, agentOptions: ROUTE, meta: { cwd: join(sandbox, 'workspace') } })).agent
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the approved plan.' }] }))
    await root.whenIdle()
    const scope = first.ctx.agentSwarm.scopeOf(root), domain = first.ctx.agentSwarm.domain
    const staged = await domain.createStagedManaged(scope, `managed:${rootId}:detached:plan`, 'Approved plan', 'Keep the original committed plan.')
    const planned = await domain.setPlanDraft(scope, staged.id, staged.revision, {
      members: [{ name: 'worker', role: 'Finish the existing task.' }],
      tasks: [{ key: 'existing', subject: 'Existing work', description: 'Resume this plan.', targetMemberName: 'worker' }],
    })
    // Compare durable against durable: the store stamps updatedAt again at commit
    // time, so the transaction's returned draft can trail the committed record by
    // one millisecond. Read the approved aggregate back before this Context closes.
    await domain.approveStagedPlan(scope, staged.id, planned.revision, captainId)
    const before = (await first.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === staged.id)
    expect(before).toBeDefined()
    await dispose(first); first = undefined
    const outcome = await mount(sandbox, 0, undefined, undefined, async ctx => {
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      const host = (await ctx.agents.resume({ resumeSessionId: rootId, agentOptions: ROUTE })).agent
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (...args) => {
        const opened = await open(...args)
        if (args[0].name === TEAM_DOMAIN_NAME) {
          const unit = (opened as unknown as { unit: { publish(): Promise<void> } }).unit, publish = unit.publish.bind(unit)
          vi.spyOn(unit, 'publish').mockImplementation(async () => {
            if (armed && point === 'publish-failure') { publishes += 1; throw fault }
            await publish()
          })
        }
        return opened
      })
      const provision = DedicatedCaptainProvisioner.prototype.provisionForTeam
      vi.spyOn(DedicatedCaptainProvisioner.prototype, 'provisionForTeam').mockImplementation(async function (this: DedicatedCaptainProvisioner, input) {
        const result = await provision.call(this, input)
        captainCreated = ctx.agents.get(captainId) !== undefined
        if (point === 'captain-retired') {
          await ctx.subagents.drainContinuableChildren(input.root, [captainId]); retirementCuts += 1
          expect(ctx.agents.get(captainId)).toBeUndefined()
        }
        return result
      })
      const recover = AgentSwarmRuntime.prototype.recoverApprovedTeam
      vi.spyOn(AgentSwarmRuntime.prototype, 'recoverApprovedTeam').mockImplementation(async function (this: AgentSwarmRuntime, ...args) {
        attempts += 1; armed = true
        try { return await recover.apply(this, args) } finally { armed = false; finished = true }
      })
      const disposeRuntime = AgentSwarmRuntime.prototype.dispose
      vi.spyOn(AgentSwarmRuntime.prototype, 'dispose').mockImplementation(async function (this: AgentSwarmRuntime) {
        await disposeRuntime.call(this)
        cleanupObserved = ctx.agents.get(captainId) === undefined && ctx.sessions.get(captainId) === undefined
        hostPreserved = ctx.agents.get(rootId) === host
      })
    }).then(value => { second = value; return { mounted: true } }, error => ({ error }))
    await vi.waitFor(() => expect(finished).toBe(true))
    expect(attempts).toBe(1); expect(captainCreated).toBe(true)
    if (point === 'publish-failure') {
      expect(publishes).toBeGreaterThan(0)
      expect(outcome).toEqual({ error: fault })
      expect(cleanupObserved).toBe(true); expect(hostPreserved).toBe(true)
    } else {
      expect(retirementCuts).toBe(1); expect(outcome).toEqual({ mounted: true })
      expect((await second!.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === staged.id)).toEqual(before)
    }
  } finally {
    adapter.open(); vi.restoreAllMocks()
    if (first !== undefined) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
