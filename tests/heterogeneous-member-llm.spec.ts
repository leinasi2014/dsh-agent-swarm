/**
 * Heterogeneous member LLM provider (branch codex/heterogeneous-member-llm-glm).
 *
 * `agent_swarm_add_member` distinguishes two namespaces without confusing them:
 * - the continuable runtime `provider` (e.g. `spawn`) that hosts the child,
 *   recorded in the durable subagent descriptor as `provider` and used as the
 *   Team recovery fence (`runtime_provider` on the read surface);
 * - the member's LLM provider `llm_provider`, passed as the child agent's
 *   `agentOptions.provider`, recorded in the durable descriptor as
 *   `agentProvider` and surfaced as `llm_provider` on the read surface.
 *
 * Provider and model have INDEPENDENT precedence at provisioning: the LLM
 * provider is the member's `llm_provider`, else the captain's LLM provider;
 * the model is `model` ?? `memberModel` config ?? the captain's model. An
 * omitted `llm_provider` therefore only decides provider inheritance and never
 * changes the model precedence.
 *
 * Every test composes the real official services (AgentLoop + in-process spawn
 * continuable children, SQLite Session persistence, Storage Domain aggregate) and
 * records, per exact Session, which host LLM adapter actually served each turn (the
 * `official-preset-skill-continuation.spec.ts` requestsBySession pattern). The
 * Captain is driven through one real AgentLoop turn with
 * `lead.followup(createUserMessage(...))` + `lead.whenIdle()`, and each
 * member's real child turn is awaited on its exact Agent, so a GLM captain and a
 * `dsv4-f` member are proven to hit distinct adapters — not merely distinct
 * descriptor strings.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService, { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const SIGNAL = new AbortController().signal

/** Buckets requests by exact Session (official-preset-skill flux pattern). */
class TrackedAdapter extends LlmAdapter {
  private readonly requestsBySession = new Map<string, GenerateOptions[]>()
  readonly resolved: Array<{ provider: string; model: string }> = []

  requestsFor(sessionId: string): readonly GenerateOptions[] {
    return this.requestsBySession.get(sessionId) ?? []
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolved.push({ provider, model })
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new Error('proof adapter requires every observed request to carry its SessionId')
    const id = String(sessionId)
    const requests = this.requestsBySession.get(id) ?? []
    requests.push(options)
    this.requestsBySession.set(id, requests)
    const text = 'Acknowledged.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Mounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly glm: TrackedAdapter
  readonly dsv4: TrackedAdapter
  /**
   * This Context's exact Captain Session id. Every test uses its own unique id
   * so one test's live/retired captain Session can never leak liveness into
   * another test's resume (cross-test pollution), and exact-Session adapter
   * buckets stay disjoint per test.
   */
  readonly captainId: string
  /**
   * The Context's GLM captain. Assigned per Context: a fresh
   * `agentLoop.create` in a first-life Context, the cold-resumed agent of the
   * official `agents.resume` handle in a reopened one. Mounting must never
   * create it eagerly — a mounted live Session makes the later
   * `agents.resume` prepare fail with `while it is live` (the captain
   * reuse/live conflict).
   */
  lead: Agent
}

async function mount(captainId: string, sandbox: string, config: { memberModel?: string } = {}): Promise<Mounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    ...(config.memberModel === undefined ? {} : { memberModel: config.memberModel }),
  }))
  const glm = new TrackedAdapter()
  const dsv4 = new TrackedAdapter()
  ctx.llm.registerAdapter(['glm'], glm)
  ctx.llm.registerAdapter(['dsv4-f'], dsv4)
  return { ctx, fibers, glm, dsv4, captainId, lead: undefined as unknown as Agent }
}

/** Create the fresh GLM captain for a first-life Context (see `Mounted.lead`). */
function createLead(wired: Mounted, sandbox: string): Agent {
  wired.lead = wired.ctx.agentLoop.create(SessionId(wired.captainId), { provider: 'glm', model: 'cap-model' }, { cwd: join(sandbox, 'workspace') })
  return wired.lead
}

async function dispose(mounted: Mounted): Promise<void> {
  for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
}

async function tool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

async function addMember(
  wired: Mounted, teamId: string, name: string,
  args: { llm_provider?: string; model?: string } = {},
): Promise<string> {
  const res = await tool(wired.ctx, wired.lead, `hetero-add-${name}`, 'agent_swarm_add_member', {
    name, role: 'Prove the heterogeneous LLM surface.', ...args,
  })
  expect(res.isError).toBe(false)
  const sessionId = (res.value as { session_id: string }).session_id
  await vi.waitFor(async () => {
    const snap = await wired.ctx.agentSwarm.domain.snapshot(wired.ctx.agentSwarm.scopeOf(wired.lead), AgentSwarm.TeamId(teamId), wired.lead.id)
    expect(snap.team.members.find(candidate => candidate.sessionId === sessionId)?.phase).toBe('active')
  }, { timeout: 15_000 })
  return sessionId
}

/**
 * Await one member's real child turn to complete. The durable continuable child
 * quiesces and retires to cold promptly after its initial join turn settles, so
 * completion is proven deterministically by its persisted `turn/end` (the official
 * completion event) — strictly stronger than a transient live-handle idle and than the
 * roster `active` settlement. The exact-turn adapter routing is asserted at the call
 * site over `requestsFor`.
 */
async function awaitMemberTurn(wired: Mounted, memberSessionId: string): Promise<void> {
  await vi.waitFor(async () => {
    const stored = await wired.ctx.sessionPersistence.inspect(SessionId(memberSessionId), SIGNAL)
    expect(stored.events.some(event => event.type === 'turn/end')).toBe(true)
  }, { timeout: 20_000 })
}

/**
 * Drive the Captain through one real AgentLoop turn on its own Session via the
 * official followup seam (official-preset-skill flux, exact session proof), then
 * await idle.
 */
async function driveCaptainTurn(wired: Mounted): Promise<void> {
  wired.lead.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Captain routing probe.' }],
  }))
  await vi.waitFor(() => {
    expect(wired.glm.requestsFor(wired.captainId)).not.toHaveLength(0)
  }, { timeout: 15_000 })
  await wired.lead.whenIdle()
}

async function descriptorOf(ctx: Context, sessionId: string): Promise<
  Extract<NonNullable<ReturnType<typeof foldSubagentDescriptor>>, { mode: 'continuable' }> | undefined
> {
  const stored = await ctx.sessionPersistence.inspect(SessionId(sessionId), SIGNAL)
  const suffix = stored.events.slice(stored.meta.seedLength ?? 0)
  const descriptor = foldSubagentDescriptor(suffix)
  return descriptor !== undefined && descriptor.mode === 'continuable' ? descriptor : undefined
}

async function listMembers(ctx: Context, lead: Agent): Promise<Array<Record<string, unknown>>> {
  const res = await tool(ctx, lead, 'hetero-list', 'agent_swarm_list_members', {})
  expect(res.isError).toBe(false)
  return (res.value as { members: Array<Record<string, unknown>> }).members
}

describe('heterogeneous member LLM provider', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('routes the GLM captain and members to distinct host adapters by exact Session, with independent provider/model precedence', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-hetero-'))
    roots.push(sandbox)
    // `memberModel` config sits between an explicit `model` and the captain's
    // model in the precedence ladder: this mount locks the top two layers
    // (explicit beats config; config beats the captain's own `cap-model`),
    // while the restart test below pins the captain-fallback layer itself.
    const wired = await mount('hetero-routing-captain', sandbox, { memberModel: 'cfg-model' })
    createLead(wired, sandbox)
    try {
      const created = await tool(wired.ctx, wired.lead, 'hetero-create', 'agent_swarm_create', {
        name: 'Heterogeneous team', description: 'Prove distinct-LLM routing and precedence.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id

      // explicit model beats the memberModel config and rides a distinct provider.
      const explicitId = await addMember(wired, teamId, 'explicit-worker', { llm_provider: 'dsv4-f', model: 'explicit-model' })
      // omitted llm_provider/models: provider inherits captain, model falls to config.
      const cfgId = await addMember(wired, teamId, 'cfg-worker')
      // llm_provider without a model: the config model still wins (independent ladder).
      const providerOnlyId = await addMember(wired, teamId, 'provider-worker', { llm_provider: 'dsv4-f' })

      // Each member's real child turn is awaited on its exact Agent and persisted.
      await awaitMemberTurn(wired, explicitId)
      await awaitMemberTurn(wired, cfgId)
      await awaitMemberTurn(wired, providerOnlyId)
      await driveCaptainTurn(wired)

      // Exact-Session routing: the GLM captain and the provider-inheriting member
      // really hit glm; the two dsv4-f members hit dsv4-f — disjoint.
      expect(wired.glm.requestsFor(wired.captainId).length).toBeGreaterThan(0)
      expect(wired.glm.requestsFor(explicitId)).toHaveLength(0)
      expect(wired.glm.requestsFor(providerOnlyId)).toHaveLength(0)
      expect(wired.glm.requestsFor(cfgId).length).toBeGreaterThan(0)
      expect(wired.dsv4.requestsFor(wired.captainId)).toHaveLength(0)
      expect(wired.dsv4.requestsFor(cfgId)).toHaveLength(0)
      expect(wired.dsv4.requestsFor(explicitId).length).toBeGreaterThan(0)
      expect(wired.dsv4.requestsFor(providerOnlyId).length).toBeGreaterThan(0)

      const explicitDescriptor = await descriptorOf(wired.ctx, explicitId)
      expect(explicitDescriptor?.provider).toBe('spawn')
      expect(explicitDescriptor?.agentProvider).toBe('dsv4-f')
      expect(explicitDescriptor?.agentModel).toBe('explicit-model')
      const cfgDescriptor = await descriptorOf(wired.ctx, cfgId)
      expect(cfgDescriptor?.agentProvider).toBe('glm')
      expect(cfgDescriptor?.agentModel).toBe('cfg-model')
      const providerOnlyDescriptor = await descriptorOf(wired.ctx, providerOnlyId)
      expect(providerOnlyDescriptor?.agentProvider).toBe('dsv4-f')
      // llm_provider only re-routes the provider; the model ladder is untouched.
      expect(providerOnlyDescriptor?.agentModel).toBe('cfg-model')

      const members = await listMembers(wired.ctx, wired.lead)
      expect(members.find(candidate => candidate.name === 'explicit-worker')).toMatchObject({
        profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'dsv4-f', model: 'explicit-model',
      })
      expect(members.find(candidate => candidate.name === 'cfg-worker')).toMatchObject({
        profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'glm', model: 'cfg-model',
      })
      expect(members.find(candidate => candidate.name === 'provider-worker')).toMatchObject({
        profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'dsv4-f', model: 'cfg-model',
      })
    } finally {
      await dispose(wired)
    }
  }, 40_000)

  it('returns the same heterogeneous provider/model from the durable descriptor after a full cold restart, without resuming any child', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-hetero-restart-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      // No memberModel config: an omitted model falls back to the captain model.
      first = await mount('hetero-restart-captain', sandbox)
      createLead(first, sandbox)
      const created = await tool(first.ctx, first.lead, 'hetero-create', 'agent_swarm_create', {
        name: 'Heterogeneous team', description: 'Prove heterogeneous provider across a cold restart.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const heteroId = await addMember(first, teamId, 'hetero-worker', { llm_provider: 'dsv4-f', model: 'dsv4-f-prod' })
      const inheritId = await addMember(first, teamId, 'inherit-worker')
      await awaitMemberTurn(first, heteroId)
      await awaitMemberTurn(first, inheritId)
      // Member routing by exact Session (Captain GLM routing is proven in the
      // first test): the dsv4-f member hit dsv4-f, the inheriting member glm.
      // The Captain is deliberately NOT turned in Context A so the live session
      // cleanly retires on dispose and Context B can reopen it cold.
      expect(first.glm.requestsFor(inheritId).length).toBeGreaterThan(0)
      expect(first.dsv4.requestsFor(heteroId).length).toBeGreaterThan(0)
      expect(first.dsv4.requestsFor(inheritId)).toHaveLength(0)
      // No memberModel config → inherit member falls back to the captain model.
      const inheritDescriptor = await descriptorOf(first.ctx, inheritId)
      expect(inheritDescriptor?.agentProvider).toBe('glm')
      expect(inheritDescriptor?.agentModel).toBe('cap-model')

      // Retire Context A through the official seams (the accepted
      // restart-continuation pattern): drain the continuable children so their
      // descriptors go cold while their persisted Sessions stay intact, then
      // reverse-dispose every Context fiber. `agentLoop.create` returns the
      // bare Agent (no consumer AgentHandle), and a consumer AgentHandle
      // `dispose()` would REMOVE the persisted Session from the store — never
      // the wanted retirement here.
      for (const id of [heteroId, inheritId]) {
        const resident = first.ctx.agents.get(SessionId(id))
        if (resident !== undefined) first.ctx.subagents.interrupt(SessionId(id), { kind: 'ancestor', agent: first.lead })
        await first.ctx.subagents.drainContinuableChildren(first.lead, [SessionId(id)])
      }
      await vi.waitFor(() => {
        expect(first!.ctx.agents.get(SessionId(heteroId))).toBeUndefined()
        expect(first!.ctx.agents.get(SessionId(inheritId))).toBeUndefined()
      }, { timeout: 15_000 })
      await dispose(first)
      first = undefined

      second = await mount('hetero-restart-captain', sandbox)
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: SessionId(second.captainId) })
      try {
        const leadB = resumedCaptain.agent
        second.lead = leadB
        const hetero = await descriptorOf(second.ctx, heteroId)
        const inherit = await descriptorOf(second.ctx, inheritId)
        expect(hetero?.agentProvider).toBe('dsv4-f')
        expect(hetero?.agentModel).toBe('dsv4-f-prod')
        expect(inherit?.agentProvider).toBe('glm')
        expect(inherit?.agentModel).toBe('cap-model')
        // Read-back after reopen is a durable, row-local projection — no child
        // is resumed and no LLM request is made by listing.
        expect(second.ctx.agents.get(SessionId(heteroId))).toBeUndefined()
        expect(second.ctx.agents.get(SessionId(inheritId))).toBeUndefined()
        const members = await listMembers(second.ctx, leadB)
        expect(members.find(candidate => candidate.name === 'hetero-worker')).toMatchObject({
          profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'dsv4-f', model: 'dsv4-f-prod',
        })
        expect(members.find(candidate => candidate.name === 'inherit-worker')).toMatchObject({
          profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'glm', model: 'cap-model',
        })
        expect(second.ctx.agents.get(SessionId(heteroId))).toBeUndefined()
        expect(second.dsv4.resolved.length).toBe(0)
        expect(second.glm.resolved.length).toBe(0)
      } finally {
        await resumedCaptain.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  }, 40_000)
})
