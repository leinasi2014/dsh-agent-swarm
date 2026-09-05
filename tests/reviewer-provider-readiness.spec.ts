import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import * as Swarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const owned: Array<{ ctx: Context; fibers: Fiber[]; root: string }> = []
const signal = new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(async () => {
  for (const stack of owned.splice(0)) {
    await stack.ctx.loader.root.stop()
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    await rm(stack.root, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function mount() {
  const root = await mkdtemp(join(tmpdir(), 'swarm-review-ready-'))
  const ctx = new Context()
  const fibers: Fiber[] = [await ctx.plugin(Loader)]
  owned.push({ ctx, fibers, root })
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.db') }))
  await mountStorageStackOn(ctx, join(root, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  const errors: unknown[] = []
  ctx.logger.exporter({ export: message => { if (message.type === 'error') errors.push(...message.args) } })
  const mounted = deferred()
  ctx.loader.builtins.swarm = {
    ...Swarm,
    async apply(context: Context, config: Swarm.Config) {
      await Swarm.apply(context, config)
      mounted.resolve()
    },
  }
  return { ctx, root, errors, mounted }
}

it('reports the missing actual reviewer at Loader settlement and admits no Team', async () => {
  const { ctx, root, errors } = await mount()
  await ctx.loader.root.update([{ id: 'swarm', name: 'cordis:swarm', config: { reviewProvider: 'reviewer-agent' } }])
  await ctx.loader.await()
  await expect.poll(() => errors.some(error => error instanceof Swarm.TeamDomainError
    && error.code === 'TEAM_INVALID_CONFIG'
    && error.message.includes('registerReviewerAgentProvider'))).toBe(true)
  const captain = ctx.agentLoop.create(SessionId('missing-reviewer'), { provider: 'mock', model: 'mock' }, { cwd: root })
  await expect(ctx.agentSwarm.create({ agent: captain, signal }, 'blocked', 'Must not admit without review')).rejects.toMatchObject({ code: 'TEAM_REVIEW_PROVIDER_MISSING' })
  expect(await ctx.agentSwarm.listTeamAggregates(root)).toEqual([])
})

it('accepts post-mount host registration before settlement and fences disposal/re-registration', async () => {
  const { ctx, root, errors, mounted } = await mount()
  const hostRelease = deferred()
  let unregister: (() => void) | undefined
  const provider = { kind: 'reviewer-agent' as const, name: 'host-reviewer', review: async () => ({ kind: 'evidence' as const, evidenceIds: ['e1'], diagnostic: 'reviewed', recommendation: 'accept' as const }) }
  ctx.loader.builtins.host = {
    inject: ['agentSwarmPermission'],
    async apply(context: Context) {
      await hostRelease.promise
      unregister = context.agentSwarmPermission.registerReviewerAgentProvider(provider)
      context.effect(() => () => unregister?.())
    },
  }
  const loading = ctx.loader.root.update([
    { id: 'swarm', name: 'cordis:swarm', config: { reviewProvider: 'reviewer-agent' } },
    { id: 'host', name: 'cordis:host' },
  ])
  await mounted.promise
  expect(errors).toEqual([])
  hostRelease.resolve()
  await loading
  await ctx.loader.await()
  const captain = ctx.agentLoop.create(SessionId('registered-reviewer'), { provider: 'mock', model: 'mock' }, { cwd: root })
  await expect(ctx.agentSwarm.create({ agent: captain, signal }, 'allowed', 'Registered review provider')).resolves.toMatchObject({ name: 'allowed' })
  const retired = unregister
  unregister?.()
  const other = ctx.agentLoop.create(SessionId('replacement-reviewer'), { provider: 'mock', model: 'mock' }, { cwd: root })
  await expect(ctx.agentSwarm.create({ agent: other, signal }, 'blocked', 'Must not admit without review')).rejects.toMatchObject({ code: 'TEAM_REVIEW_PROVIDER_MISSING' })
  unregister = ctx.agentSwarmPermission.registerReviewerAgentProvider(provider)
  retired?.()
  expect(ctx.agentSwarmPermission.reviewerAgent?.name).toBe('host-reviewer')
  await expect(ctx.agentSwarm.create({ agent: other, signal }, 'recovered', 'Replacement review provider')).resolves.toMatchObject({ name: 'recovered' })
  expect(errors).toEqual([])
})


