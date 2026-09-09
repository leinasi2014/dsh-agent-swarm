import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { teamDomainSpec } from '../src/storage/team-spec.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { assertSwarmReadRpcValue } from '../src/rpc/read-rpc-artifact.js'
import { mountNodeComposition, setUpTeam } from './helpers/node-composition.js'

const signal = new AbortController().signal
class RecruitAdapter extends LlmAdapter {
  readonly resolved: string[] = []
  override async resolveModel(provider: string, model: string) {
    this.resolved.push(`${provider}/${model}`)
    if (model === 'invalid') throw new Error('exact model rejected by adapter')
    return { provider, id: model, name: model }
  }
  override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.model === 'startup-fail') throw new Error('real initial generation failed')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    if (options.model === 'billed') yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mount(config: { memberLlmProvider?: string; memberModel?: string; maxMembers?: number } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recruit-176-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 1, ...config }))
  const adapter = new RecruitAdapter()
  ctx.llm.registerAdapter(['valid'], adapter)
  const lead = await ctx.agentLoop.create(SessionId(`recruit-${Math.random().toString(36).slice(2)}`), { provider: 'valid', model: 'dynamic-unlisted' }, { cwd: join(sandbox, 'workspace') })
  const call = (args: Record<string, unknown>, name = 'agent_swarm_add_member') => ctx.tools.execute({ signal, callId: ToolCallId(`recruit-${Math.random()}`), name, arguments: args, agent: lead })
  const created = await call({ name: 'Recovery', description: 'One employee, fenced provisioning attempts.' }, 'agent_swarm_create')
  expect(created.isError).toBe(false)
  const teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
  const scope = ctx.agentSwarm.scopeOf(lead)
  const snapshot = () => ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
  return { ctx, adapter, lead, teamId, scope, call, snapshot, async dispose() {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } }
}
type Stack = Awaited<ReturnType<typeof mount>>
const stacks: Stack[] = []
async function setup(config = {}) { const stack = await mount(config); stacks.push(stack); return stack }
afterEach(async () => { for (const stack of stacks.splice(0)) await stack.dispose() })

async function failFirst(stack: Stack) {
  const result = await stack.call({ name: 'worker', role: 'Implement', model: 'startup-fail' })
  expect(result.isError, JSON.stringify(result.error)).toBe(false)
  const sessionId = (result.value as { session_id: string }).session_id
  await vi.waitFor(async () => expect((await stack.snapshot()).team.members[0]?.phase).toBe('failed'))
  // Imported legacy identity must survive retry, although new recruitment cannot author it.
  const storage = stack.ctx.storageDomain.get('agent_swarm')! as unknown as Domain<typeof teamDomainSpec>
  await storage.table('teams').update(stack.teamId, record => ({ ...record, team: { ...record.team, members: record.team.members.map(member => ({ ...member, displayName: 'Lin' })) } }))
  const stored = await readPersistedSession(stack.ctx.sessionPersistence, SessionId(sessionId), signal)
  expect(stored.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(true)
  return sessionId
}

function gate() {
  let open!: () => void
  const waiting = new Promise<void>(resolve => { open = resolve })
  return { waiting, open }
}

describe('member recruitment route and same-identity recovery', () => {
  it('discloses the failed employee retry fence only to the authenticated Captain tool caller', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recruit-private-fence-'))
    const composition = await mountNodeComposition(sandbox, { maxMembers: 2 })
    try {
      await setUpTeam(composition, ['observer'])
      const { ctx, lead } = composition
      const execute = (agent: typeof lead, name: string, args: Record<string, unknown>) =>
        ctx.tools.execute({ signal, callId: ToolCallId(`fence-${Math.random()}`), name, arguments: args, agent })
      expect((await execute(lead, 'agent_swarm_add_member', {
        name: 'failed-worker', role: 'Implement', deny_tools: ['missing-official-tool'],
      })).isError).toBe(true)
      // The real official registry supplies a live authenticated member; no
      // private Team lookup or injected caller-id string establishes authority.
      const observer = ctx.agents.list().find(agent => agent.session.header.parentSession === lead.id)!
      expect(observer).toBeDefined()
      const peer = await execute(observer, 'agent_swarm_list_members', { phase: 'failed' })
      expect(peer.isError, JSON.stringify(peer.error)).toBe(false)
      const peerMembers = (peer.value as { members: Record<string, unknown>[] }).members
      expect(peerMembers).toHaveLength(1)
      expect(peerMembers[0]).not.toHaveProperty('retry_of')
      const captain = await execute(lead, 'agent_swarm_list_members', { phase: 'failed' })
      expect(captain.isError).toBe(false)
      expect((captain.value as { members: unknown[] }).members).toEqual([
        expect.objectContaining({ name: 'failed-worker', retry_of: expect.any(String) }),
      ])
    } finally {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('recovers a startup failure using only the public list_members fence, without a private Session lookup', async () => {
    const stack = await setup()
    const failed = await stack.call({ name: 'worker', role: 'Implement', deny_tools: ['missing-official-tool'] })
    expect(failed.isError).toBe(true)
    const listed = await stack.call({ phase: 'failed' }, 'agent_swarm_list_members')
    expect(listed.isError).toBe(false)
    const members = (listed.value as { members: Array<{ name: string; role: string; phase: string; retry_of?: string }> }).members
    expect(members).toHaveLength(1)
    const member = members[0]!
    expect(member).toMatchObject({ name: 'worker', phase: 'failed', retry_of: expect.any(String) })
    expect(member.retry_of).not.toBe('')
    const retried = await stack.call({ name: member.name, role: member.role, retry_of: member.retry_of })
    expect(retried.isError, JSON.stringify(retried.error)).toBe(false)
    const after = await stack.call({}, 'agent_swarm_list_members')
    expect(after.isError).toBe(false)
    expect((after.value as { members: unknown[] }).members).toEqual([
      expect.objectContaining({ name: member.name, phase: 'active' }),
    ])
    expect((after.value as { members: Record<string, unknown>[] }).members[0]).not.toHaveProperty('retry_of')
    expect((await stack.call({ name: member.name, role: member.role, retry_of: member.retry_of })).isError).toBe(true)
  })

  it.each([
    [{}, { llm_provider: 'missing' }],
    [{}, { model: 'invalid' }],
    [{ memberLlmProvider: 'missing' }, { model: 'dynamic-unlisted' }],
    [{ memberModel: 'invalid' }, { llm_provider: 'valid' }],
  ])('rejects the final exact route before any row or official child creation (%j, %j)', async (config, route) => {
    const stack = await setup(config)
    const before = await stack.snapshot()
    const start = vi.spyOn(stack.ctx.subagents, 'startContinuable')
    const result = await stack.call({ name: 'worker', role: 'Implement', ...route })
    expect(result.isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(await stack.snapshot()).toEqual(before)
  })

  it('accepts an adapter-resolved dynamic model without a catalog entry', async () => {
    const stack = await setup()
    expect(await stack.ctx.llm.listModels('valid')).toEqual([])
    expect((await stack.call({ name: 'worker', role: 'Implement' })).isError).toBe(false)
    expect(stack.adapter.resolved).toContain('valid/dynamic-unlisted')
  })

  it('recovers a full roster slot once, retaining identity, old billing and the exact Session fence', async () => {
    const stack = await setup()
    const terminals = new Map<string, { session: Session; event: SessionEvent }>()
    const detach = stack.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') terminals.set(session.id, { session, event })
    })
    const oldId = await failFirst(stack)
    const args = { name: 'worker', role: 'Implement', retry_of: oldId }
    const results = await Promise.all([stack.call(args), stack.call(args)])
    expect(results.filter(result => !result.isError)).toHaveLength(1)
    const team = (await stack.snapshot()).team
    expect(team.members).toHaveLength(1)
    expect(team.members[0]).toMatchObject({ name: 'worker', displayName: 'Lin', phase: 'active', previousSessionIds: [oldId] })
    expect(stack.ctx.agentSwarmHostRead.projectAuthorizedTeam(team, stack.scope).roster).toEqual([
      expect.objectContaining({ name: 'worker', provisioningAttempt: 2 }),
    ])
    assertSwarmReadRpcValue('snapshot', stack.ctx.agentSwarmHostRead.projectAuthorizedTeam(team, stack.scope))
    const newId = team.members[0]!.sessionId
    expect(newId).not.toBe(oldId)
    const domain = stack.ctx.agentSwarm.domain
    const oldTerminal = terminals.get(oldId)!
    expect(oldTerminal).toBeDefined()
    stack.ctx.agentSwarm.observeSessionEvent(oldTerminal.session, oldTerminal.event)
    detach()
    await expect(domain.settleMember(stack.scope, stack.teamId, oldId, { active: false, error: 'late failure' })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    expect(await domain.findMembership(stack.scope, oldId)).toBeUndefined()
    expect((await domain.findAccountingMembership(stack.scope, oldId))?.team.id).toBe(stack.teamId)
    const used = (await stack.snapshot()).team.budget.usedTokens
    await domain.recordSessionUsageBatch(stack.scope, stack.teamId, oldId, [{ eventSeq: 999, tokens: 7 }])
    await domain.recordSessionUsageBatch(stack.scope, stack.teamId, oldId, [{ eventSeq: 999, tokens: 7 }])
    expect((await stack.snapshot()).team.budget.usedTokens).toBe(used + 7)
    expect((await stack.call(args)).isError).toBe(true)
    expect((await stack.snapshot()).team.members[0]?.sessionId).toBe(newId)
  })

  it.each(['provision commit', 'child start'] as const)('does not recover an owned retry paused at %s', async seam => {
    const stack = await setup()
    const oldId = await failFirst(stack)
    const domain = stack.ctx.agentSwarm.domain
    const entered = gate()
    const release = gate()
    const pause = async () => { entered.open(); await release.waiting }
    if (seam === 'provision commit') {
      const provision = domain.provisionMember.bind(domain)
      vi.spyOn(domain, 'provisionMember').mockImplementation(async (...args) => {
        const member = await provision(...args)
        await pause()
        return member
      })
    } else {
      const start = stack.ctx.subagents.startContinuable.bind(stack.ctx.subagents)
      vi.spyOn(stack.ctx.subagents, 'startContinuable').mockImplementation(async (...args) => { await pause(); return start(...args) })
    }
    const retry = stack.call({ name: 'worker', role: 'Implement', retry_of: oldId })
    try {
      await entered.waiting
      const childId = (await stack.snapshot()).team.members[0]!.sessionId
      expect(stack.ctx.agents.get(SessionId(childId))).toBeUndefined()
      await stack.ctx.agentSwarm.recoverAgent(stack.lead)
      expect((await stack.snapshot()).team.members[0]).toMatchObject({ sessionId: childId, phase: 'provisioning' })
    } finally {
      release.open()
      await retry
    }
    expect((await retry).isError).toBe(false)
    expect((await stack.snapshot()).team.members[0]).toMatchObject({ phase: 'active', previousSessionIds: [oldId] })
  })

  it.each([
    ['child evidence', 'activation'], ['settlement', 'activation'],
    ['child evidence', 'replacement'], ['settlement', 'replacement'],
  ] as const)('fences stale recovery across %s after concurrent %s', async (seam, transition) => {
    const stack = await setup()
    const domain = stack.ctx.agentSwarm.domain
    await domain.provisionMember(stack.scope, stack.teamId, stack.lead.id, {
      name: 'worker', role: 'Implement', sessionId: 'interrupted-child', provider: 'spawn',
    })
    const entered = gate()
    const release = gate()
    const settle = domain.settleMember.bind(domain)
    const pause = async () => { entered.open(); await release.waiting }
    if (seam === 'child evidence') {
      const list = stack.ctx.subagents.listChildren.bind(stack.ctx.subagents)
      vi.spyOn(stack.ctx.subagents, 'listChildren').mockImplementationOnce(async (...args) => {
        const children = await list(...args)
        await pause()
        return children
      })
    } else {
      // Hold the write after evidence collection and runtime checks; only the
      // transaction's exact Session/phase fence can reject this stale verdict.
      vi.spyOn(domain, 'settleMember').mockImplementationOnce(async (...args) => { await pause(); return settle(...args) })
    }
    const recovery = stack.ctx.agentSwarm.recoverAgent(stack.lead)
    try {
      await entered.waiting
      if (transition === 'activation') {
        await settle(stack.scope, stack.teamId, 'interrupted-child', { active: true })
      } else {
        await settle(stack.scope, stack.teamId, 'interrupted-child', { active: false, error: 'real startup failure' })
        await domain.provisionMember(stack.scope, stack.teamId, stack.lead.id, {
          name: 'worker', role: 'Implement', sessionId: 'replacement-child', provider: 'spawn', retryOf: 'interrupted-child',
        })
        await settle(stack.scope, stack.teamId, 'replacement-child', { active: true })
      }
    } finally {
      release.open()
      await recovery
    }
    expect((await stack.snapshot()).team.members[0]).toMatchObject({
      sessionId: transition === 'activation' ? 'interrupted-child' : 'replacement-child', phase: 'active',
    })
  })

  it('keeps reconciliation fallback away from a concurrently owned provisioning row', async () => {
    const stack = await setup({ maxMembers: 2 })
    const domain = stack.ctx.agentSwarm.domain
    await domain.provisionMember(stack.scope, stack.teamId, stack.lead.id, {
      name: 'interrupted', role: 'Implement', sessionId: 'interrupted-child', provider: 'spawn',
    })
    const entered = gate()
    const release = gate()
    const start = stack.ctx.subagents.startContinuable.bind(stack.ctx.subagents)
    vi.spyOn(stack.ctx.subagents, 'startContinuable').mockImplementation(async (...args) => {
      entered.open()
      await release.waiting
      return start(...args)
    })
    const added = stack.call({ name: 'live-worker', role: 'Implement' })
    try {
      await entered.waiting
      vi.spyOn(domain, 'settleMember').mockRejectedValueOnce(new Error('transient recovery commit failure'))
      await stack.ctx.agentSwarm.recoverAgent(stack.lead)
      expect((await stack.snapshot()).team.members.find(member => member.name === 'interrupted')?.phase).toBe('failed')
      expect((await stack.snapshot()).team.members.find(member => member.name === 'live-worker')?.phase).toBe('provisioning')
    } finally {
      release.open()
      await added
    }
    expect((await added).isError).toBe(false)
    expect((await stack.snapshot()).team.members.find(member => member.name === 'live-worker')?.phase).toBe('active')
  })

  it('rejects suffixed replacement of a failed display identity and invalid/stale recovery atomically', async () => {
    const stack = await setup({ maxMembers: 2 })
    const oldId = await failFirst(stack)
    const before = await stack.snapshot()
    const start = vi.spyOn(stack.ctx.subagents, 'startContinuable')
    for (const args of [
      { name: 'worker-2', display_name: 'Lin' },
      { name: 'worker', retry_of: 'stale-session' },
      { name: 'worker', retry_of: oldId, llm_provider: 'missing' },
    ]) expect((await stack.call({ role: 'Implement', ...args })).isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(await stack.snapshot()).toEqual(before)
  })

  it('refolds a failed predecessor official Session after retry when its live billing write was lost', async () => {
    const stack = await setup()
    const domain = stack.ctx.agentSwarm.domain
    const billing = vi.spyOn(domain, 'recordSessionUsageBatch').mockRejectedValue(new Error('lost live billing write'))
    const added = await stack.call({ name: 'worker', role: 'Implement', model: 'billed' })
    expect(added.isError).toBe(false)
    const oldId = (added.value as { session_id: string }).session_id
    await vi.waitFor(async () => {
      const persisted = await readPersistedSession(stack.ctx.sessionPersistence, SessionId(oldId), signal)
      expect(persisted.events.some(event => event.type === 'turn/end')).toBe(true)
    })
    // Inject the failure at the real aggregate settlement seam after a billed
    // child exists, as an activation failure or imported failed row can do.
    await domain.settleMember(stack.scope, stack.teamId, oldId, { active: false, error: 'activation failed after billed work' })
    expect((await stack.call({ name: 'worker', role: 'Implement', retry_of: oldId })).isError).toBe(false)
    billing.mockRestore()
    const stored = await readPersistedSession(stack.ctx.sessionPersistence, SessionId(oldId), signal)
    expect(stored.events.filter(event => event.type === 'assistant/message').map(event => event.data.usage))
      .toContainEqual({ inputTokens: 5, outputTokens: 2 })
    expect((await stack.snapshot()).team.budget.usedTokens).toBe(0)
    const accountant = new UsageAccountant(stack.ctx, { domain: () => domain, isClosing: () => false })
    await accountant.recoverTeamUsage(stack.scope, (await stack.snapshot()).team)
    await accountant.recoverTeamUsage(stack.scope, (await stack.snapshot()).team)
    expect((await stack.snapshot()).team.budget.usedTokens).toBe(7)
    expect(await domain.findMembership(stack.scope, oldId)).toBeUndefined()
  })
})
