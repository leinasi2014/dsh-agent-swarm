/** Actual Runtime + official ToolRuntime/storage; controlled Providers expose admission races. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import * as Swarm from '../src/index.js'
import type { ResolveWorkRequestInput } from '../src/domain/work-request.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'
import { restartTool as tool, RESTART_SIGNAL as signal } from './helpers/restart-real-composition.js'

const owned: Array<{ root: string; fibers: Fiber[] }> = []
afterEach(async () => {
  for (const { root, fibers } of owned.splice(0)) {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'work-admission-')), ctx = new Context(), fibers: Fiber[] = []
  owned.push({ root, fibers })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions.db') }))
  await mountStorageStackOn(ctx, join(root, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(Swarm, { reviewProvider: 'reviewer-agent' }))
  const unregister = ctx.agentSwarmPermission.registerReviewerAgentProvider({
    kind: 'reviewer-agent', name: 'admission-reviewer',
    review: async () => ({ kind: 'evidence', evidenceIds: ['admission-e1'], diagnostic: 'Controlled test Provider.', recommendation: 'accept' }),
  })
  const captain = await ctx.agentLoop.create(SessionId('admission-captain'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const team = await ctx.agentSwarm.create({ agent: captain, signal }, 'Admission', 'Provider admission boundary.')
  const scope = ctx.agentSwarm.scopeOf(captain), domain = ctx.agentSwarm.domain
  const propose = async (requestId: string) => await domain.submitWorkRequest(scope, team.id, { kind: 'local-operator' }, { requestId, description: 'Requested work.' })
  const snapshot = async () => (await domain.snapshot(scope, team.id, captain.id)).team
  const resolve = async (input: ResolveWorkRequestInput) => await ctx.agentSwarm.work.resolve({ agent: captain, signal }, input)
  return { ctx, captain, team, scope, domain, unregister, propose, snapshot, resolve }
}
function accept(workRequestId: string, command?: string): ResolveWorkRequestInput {
  return { workRequestId, expectedRequestRevision: 1, decision: { kind: 'accept', items: [{
    itemKey: 'first', subject: 'First task', description: 'Preserve the complete atomic decision.',
    ...(command === undefined ? {} : { verification: [{ command }] }),
  }] } }
}

it.each(['review-provider', 'routed-root'] as const)('rejects missing %s through the actual tool before creating any Task', async missing => {
  const f = await fixture(), proposal = await f.propose('missing')
  if (missing === 'review-provider') f.unregister()
  const result = await tool(f.ctx, f.captain, 'missing-admission', 'agent_swarm_resolve_work_request', {
    work_request_id: proposal.request.id, expected_request_revision: 1, decision: 'accept',
    items: [{ item_key: 'first', subject: 'First task', description: 'Must remain pending.',
      ...(missing === 'routed-root' ? { verification: [{ command: 'dsh-verification-root:absent/node -- node --version' }] } : {}),
    }],
  })
  expect(result.isError).toBe(true)
  expect(result.error).toMatchObject({ info: { code: missing === 'review-provider' ? 'TEAM_REVIEW_PROVIDER_MISSING' : 'TEAM_REVIEW_ROOT_PROVIDER_MISSING' } })
  const after = await f.snapshot()
  expect(after.tasks).toHaveLength(0)
  expect(after.nextTaskNumber).toBe(1)
  expect(after.workRequests?.requests[0]).toMatchObject({ revision: 1 })
  expect(after.workRequests?.requests[0]?.resolution).toBeUndefined()
  expect(after.workActivity?.entries.map(entry => entry.kind)).toEqual(['request-proposed'])
})

it('keeps rejection and accepted decision replay available after the reviewer is removed', async () => {
  const f = await fixture(), first = await f.propose('accepted'), second = await f.propose('rejected')
  const input = accept(first.request.id), committed = await f.resolve(input)
  f.unregister()
  const replay = await f.resolve(input)
  expect(replay).toMatchObject({ replayed: true, request: { resolution: committed.request.resolution } })
  const rejected = await f.resolve({ workRequestId: second.request.id, expectedRequestRevision: 1,
    decision: { kind: 'reject', publicReason: 'No additional work is needed.' } })
  expect(rejected.request.resolution?.kind).toBe('reject')
  expect((await f.snapshot()).tasks).toHaveLength(1)
  await expect(f.resolve({ ...input, decision: { kind: 'reject', publicReason: 'Different terminal decision.' } }))
    .rejects.toMatchObject({ code: 'TEAM_WORK_REQUEST_CONFLICT' })
})

it('recovers another caller’s committed mapping even when its asynchronous root check later fails', async () => {
  const f = await fixture(), proposal = await f.propose('compile-race')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), checking = new Promise<void>(resolve => { entered = resolve })
  const check = vi.fn(async () => { entered(); await gate; return { available: false, diagnostic: 'Capability disappeared while checking.' } })
  const unregister = f.ctx.agentSwarm.registerReviewRootProvider('held', { open: async () => { throw new Error('No execution root should open during admission') } },
    { provides: ['node'], checkAvailability: check })
  const input = accept(proposal.request.id, 'dsh-verification-root:held/node -- node --version')
  const pending = f.resolve(input)
  try {
    await checking
    const winner = await f.domain.resolveWorkRequest(f.scope, f.team.id, f.captain.id, input)
    f.unregister()
    release()
    expect(await pending).toMatchObject({ replayed: true, request: { resolution: winner.request.resolution } })
    expect(check).toHaveBeenCalledTimes(1)
    expect((await f.snapshot()).tasks).toHaveLength(1)
  } finally { release(); unregister(); await pending.catch(() => undefined) }
})

it('rechecks configured Providers after asynchronous verification and leaves the request pending', async () => {
  const f = await fixture(), proposal = await f.propose('late-removal')
  const unregister = f.ctx.agentSwarm.registerReviewRootProvider('withdraw', { open: async () => { throw new Error('Admission must not execute commands') } },
    { provides: ['node'], checkAvailability: async () => { f.unregister(); return { available: true } } })
  try {
    await expect(f.resolve(accept(proposal.request.id, 'dsh-verification-root:withdraw/node -- node --version')))
      .rejects.toMatchObject({ code: 'TEAM_REVIEW_PROVIDER_MISSING' })
    const after = await f.snapshot()
    expect(after.tasks).toHaveLength(0)
    expect(after.workRequests?.requests[0]?.resolution).toBeUndefined()
  } finally { unregister() }
})
