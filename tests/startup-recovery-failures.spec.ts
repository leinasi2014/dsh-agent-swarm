/** Actual cold composition distinguishes Team binding faults from shared IO failure. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MessageDelivery, type PublicDeliveryResult } from '../src/runtime/message-delivery.js'
import { ManagedActivationRecovery } from '../src/runtime/managed-activation-recovery.js'
import { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import * as frames from '../src/runtime/frame-visibility.js'
import { unitFilePath } from './helpers/storage-stack.js'
import { GatedAdapter } from './helpers/gated-composition.js'
import { ROUTE, seed, queueDebt } from './helpers/startup-recovery-fixture.js'
import { mountRestartComposition as mount, disposeRestartComposition as dispose, RESTART_SIGNAL as SIGNAL, type RestartMounted } from './helpers/restart-real-composition.js'

const deliveryMethod = { work: 'deliverWorkRequests', public: 'deliverPublicMessages', goal: 'deliverGoalNotices' } as const

it.each((['work', 'public', 'goal'] as const).flatMap(debt => (['frame-read', 'lineage-read', 'claim-flush'] as const)
  .flatMap(point => [true, false].map(startup => ({ debt, point, startup })))))('propagates $debt $point IO only at startup ($startup)', async ({ debt, point, startup }) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-read-failure-')), adapter = new GatedAdapter()
  const fault = new Error(`injected actual ${point} handle read failure`)
  let restarted: RestartMounted | undefined, armed = startup, failedReads = 0, checkingClaim = false
  try {
    const [bad, good] = await seed(sandbox, async (ctx, teams) => { await queueDebt(ctx, teams[0]!, debt) })
    let before: unknown
    const outcome = await mount(sandbox, 0, undefined, undefined, ctx => {
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      if (point === 'claim-flush') {
        const wait = frames.waitForFrameClaim
        vi.spyOn(frames, 'waitForFrameClaim').mockImplementation(async (...args) => {
          checkingClaim = true
          try { return await wait(...args) } finally { checkingClaim = false }
        })
        const flush = ctx.sessions.flush.bind(ctx.sessions)
        vi.spyOn(ctx.sessions, 'flush').mockImplementation(async session => {
          if (armed && checkingClaim && session.id === bad.captainId) { failedReads += 1; throw fault }
          return await flush(session)
        })
      }
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (point !== 'claim-flush' && args[0] === (point === 'frame-read' ? bad.captainId : bad.rootId) && args[1] === 'read') {
          const read = handle.read.bind(handle)
          vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
            if (armed) { failedReads += 1; throw fault }
            return await read(...readArgs)
          })
        }
        return handle
      })
      const run = ManagedActivationRecovery.prototype.run
      vi.spyOn(ManagedActivationRecovery.prototype, 'run').mockImplementation(async function (this: ManagedActivationRecovery) {
        before = (await ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)
        return await run.call(this)
      })
    }, { startupRecoveryExcludedTeamIds: startup ? [] : [bad.teamId] })
      .then(value => { restarted = value; return { mounted: true } }, error => ({ error }))
    if (startup) {
      expect(failedReads).toBeGreaterThan(0)
      expect(outcome).toEqual({ error: fault })
      vi.restoreAllMocks()
      const readback = await mount(sandbox, 0, undefined, undefined, ctx => { vi.spyOn(ctx.sessionPersistence, 'list').mockResolvedValue([]) })
      try { expect((await readback.ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)).toEqual(before) }
      finally { await dispose(readback) }
    } else {
      expect(outcome).toEqual({ mounted: true }); expect(failedReads).toBe(0)
      let deliver!: MessageDelivery['deliverWorkRequests'], captured!: Promise<PublicDeliveryResult>
      const original = MessageDelivery.prototype.deliverWorkRequests
      vi.spyOn(MessageDelivery.prototype, 'deliverWorkRequests').mockImplementation(function (this: MessageDelivery, ...args) {
        deliver = this[deliveryMethod[debt]].bind(this)
        const result = original.apply(this, args); captured = result
        return result
      })
      // Capture the already installed serialization owner via its public kick;
      // no work notice exists on the healthy Team, so this adds no admission.
      restarted!.ctx.agentSwarm.kickWorkRequests(good.scope, good.teamId)
      await captured
      armed = true
      // Ordinary public delivery reports its admission even if the later
      // flush is unknown; the durable aggregate still retains queued debt.
      expect(await deliver(bad.scope, bad.teamId, SIGNAL)).toMatchObject({
        deferred: !(debt === 'public' && point === 'claim-flush'), reconciled: 0 })
      expect(failedReads).toBeGreaterThan(0)
      expect((await restarted!.ctx.agentSwarm.listTeamAggregates(bad.scope)).find(team => team.id === bad.teamId)).toEqual(before)
      armed = false
      expect(await deliver(bad.scope, bad.teamId, SIGNAL)).toMatchObject(point === 'claim-flush'
        ? { admitted: false, deferred: false, reconciled: 1 } : { admitted: true, deferred: false })
      expect(adapter.requests.filter(request => request.sessionId === bad.captainId)).toHaveLength(1)
    }
  } finally {
    adapter.open(); vi.restoreAllMocks()
    if (restarted !== undefined) await dispose(restarted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it.each(['session-list', 'team-list', 'post-root-list', 'post-root-abort'] as const)('fails mounting and cleans owned roots on %s', async point => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-global-failure-')), adapter = new GatedAdapter()
  const fault = new Error(`injected ${point} failure`)
  let restarted: RestartMounted | undefined, rootPublished = false, ownedDisposals = 0, reads = 0
  let closeRecovery: (() => void) | undefined
  try {
    await seed(sandbox)
    const outcome = await mount(sandbox, 0, undefined, undefined, ctx => {
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
      const run = ManagedActivationRecovery.prototype.run
      vi.spyOn(ManagedActivationRecovery.prototype, 'run').mockImplementation(function (this: ManagedActivationRecovery) {
        closeRecovery = this.close.bind(this); return run.call(this)
      })
      if (point === 'session-list') vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async () => { reads += 1; throw fault })
      const list = AgentSwarmRuntime.prototype.listTeamAggregates
      vi.spyOn(AgentSwarmRuntime.prototype, 'listTeamAggregates').mockImplementation(async function (this: AgentSwarmRuntime, scope) {
        const rows = await list.call(this, scope)
        if (point === 'team-list' || (point === 'post-root-list' && rootPublished)) { reads += 1; throw fault }
        return rows
      })
      const resume = ctx.agents.resume.bind(ctx.agents)
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => {
        const handle = await resume(options), disposeRoot = handle.dispose.bind(handle)
        vi.spyOn(handle, 'dispose').mockImplementation(async () => { ownedDisposals += 1; await disposeRoot() })
        rootPublished = true
        if (point === 'post-root-abort') closeRecovery!()
        return handle
      })
    }).then(value => { restarted = value; return { mounted: true } }, error => ({ error }))
    if (point === 'post-root-abort') expect(outcome).toMatchObject({ error: expect.objectContaining({ message: 'managed activation recovery disposed' }) })
    else { expect(reads).toBeGreaterThan(0); expect(outcome).toEqual({ error: fault }) }
    expect(adapter.requests).toEqual([])
    expect(rootPublished).toBe(point.startsWith('post-root'))
    expect(ownedDisposals).toBe(point.startsWith('post-root') ? 1 : 0)
  } finally {
    adapter.open(); vi.restoreAllMocks()
    if (restarted !== undefined) await dispose(restarted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.each(['schema', 'aggregate'] as const)('fails mounting on actual persisted %s corruption', async kind => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-startup-corruption-'))
  let restarted: RestartMounted | undefined
  try {
    const [bad] = await seed(sandbox)
    const path = unitFilePath(join(sandbox, 'storage')), media = JSON.parse(await readFile(path, 'utf8'))
    const team = media.tables.teams[bad.teamId].team
    if (kind === 'schema') team.description = 42
    else team.tasks[0].currentAttemptId = 'attempt-missing'
    const bytes = JSON.stringify(media)
    await writeFile(path, bytes)
    const outcome = await mount(sandbox, 0).then(value => { restarted = value; return undefined }, error => error)
    expect(outcome).toBeInstanceOf(Error)
    if (kind === 'aggregate') expect(outcome).toMatchObject({ code: 'TEAM_STATE_CORRUPT' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
  } finally {
    vi.restoreAllMocks()
    if (restarted !== undefined) await dispose(restarted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
