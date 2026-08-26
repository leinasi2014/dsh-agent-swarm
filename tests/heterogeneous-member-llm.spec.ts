/**
 * Heterogeneous member LLM provider (branch codex/heterogeneous-member-llm).
 *
 * `agent_swarm_add_member` distinguishes two namespaces without confusing them:
 * - the continuable runtime `provider` (e.g. `spawn`) that hosts the child,
 *   recorded in the durable subagent descriptor as `provider` and used as the
 *   Team recovery fence (`runtime_provider` on the read surface);
 * - the member's LLM provider `llm_provider`, passed as the child agent's
 *   `agentOptions.provider`, recorded in the durable descriptor as
 *   `agentProvider` and surfaced as `llm_provider` on the read surface.
 *
 * Every test composes the real official services (AgentLoop + in-process spawn
 * continuable children, SQLite Session persistence, Storage Domain aggregate), so a
 * member provisioned with a distinct `llm_provider` really resolves and runs
 * against that distinct host LLM adapter — the same delta a GLM-5.3 captain
 * plus a `dsv4-f` member would exercise.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
const CAPTAIN = SessionId('hetero-real-captain')

/** Captures which provider/model the LLM runtime resolved to. */
class TrackedAdapter extends LlmAdapter {
  readonly resolved: Array<{ provider: string; model: string }> = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolved.push({ provider, model })
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
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
}

async function mount(sandbox: string): Promise<Mounted> {
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
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  const glm = new TrackedAdapter()
  const dsv4 = new TrackedAdapter()
  ctx.llm.registerAdapter(['glm'], glm)
  ctx.llm.registerAdapter(['dsv4-f'], dsv4)
  return { ctx, fibers, glm, dsv4 }
}

async function dispose(mounted: Mounted): Promise<void> {
  for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
}

async function tool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

async function addMember(
  ctx: Context, lead: Agent, teamId: string, name: string,
  args: { llm_provider?: string; model?: string } = {},
): Promise<string> {
  const res = await tool(ctx, lead, `hetero-add-${name}`, 'agent_swarm_add_member', {
    name, role: 'Prove the heterogeneous LLM surface.', ...args,
  })
  expect(res.isError).toBe(false)
  const sessionId = (res.value as { session_id: string }).session_id
  await vi.waitFor(async () => {
    const snap = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
    expect(snap.team.members.find(candidate => candidate.sessionId === sessionId)?.phase).toBe('active')
  }, { timeout: 15_000 })
  return sessionId
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

  it('provisions a GLM captain plus a distinct dsv4-f member, reads both back, and inherits the captain LLM when llm_provider is omitted', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-hetero-'))
    roots.push(sandbox)
    const wired = await mount(sandbox)
    try {
      const lead = wired.ctx.agentLoop.create(CAPTAIN, { provider: 'glm', model: 'glm-prod' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(wired.ctx, lead, 'hetero-create', 'agent_swarm_create', {
        name: 'Heterogeneous team', description: 'Prove a member on a distinct LLM provider.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id

      const heteroId = await addMember(wired.ctx, lead, teamId, 'hetero-worker', { llm_provider: 'dsv4-f', model: 'dsv4-f-prod' })
      const inheritId = await addMember(wired.ctx, lead, teamId, 'inherit-worker')

      // The distinct member really resolved and ran against the dsv4-f adapter.
      expect(wired.dsv4.resolved.some(entry => entry.provider === 'dsv4-f' && entry.model === 'dsv4-f-prod')).toBe(true)

      const heteroDescriptor = await descriptorOf(wired.ctx, heteroId)
      expect(heteroDescriptor?.mode).toBe('continuable')
      expect(heteroDescriptor?.provider).toBe('spawn')
      expect(heteroDescriptor?.agentProvider).toBe('dsv4-f')
      expect(heteroDescriptor?.agentModel).toBe('dsv4-f-prod')

      const inheritDescriptor = await descriptorOf(wired.ctx, inheritId)
      expect(inheritDescriptor?.agentProvider).toBe('glm')
      expect(inheritDescriptor?.agentModel).toBe('glm-prod')

      const members = await listMembers(wired.ctx, lead)
      expect(members.find(candidate => candidate.name === 'hetero-worker')).toMatchObject({
        profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'dsv4-f', model: 'dsv4-f-prod',
      })
      expect(members.find(candidate => candidate.name === 'inherit-worker')).toMatchObject({
        profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'glm', model: 'glm-prod',
      })
    } finally {
      await dispose(wired)
    }
  }, 30_000)

  it('returns the same heterogeneous provider/model from the durable descriptor after a full cold restart, without resuming any child', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-hetero-restart-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      first = await mount(sandbox)
      const leadA = first.ctx.agentLoop.create(CAPTAIN, { provider: 'glm', model: 'glm-prod' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'hetero-create', 'agent_swarm_create', {
        name: 'Heterogeneous team', description: 'Prove heterogeneous provider across a cold restart.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const heteroId = await addMember(first.ctx, leadA, teamId, 'hetero-worker', { llm_provider: 'dsv4-f', model: 'dsv4-f-prod' })
      const inheritId = await addMember(first.ctx, leadA, teamId, 'inherit-worker')

      await dispose(first)
      first = undefined

      second = await mount(sandbox)
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      try {
        const leadB = resumedCaptain.agent
        expect(second.ctx.agents.get(SessionId(heteroId))).toBeUndefined()
        expect(second.ctx.agents.get(SessionId(inheritId))).toBeUndefined()
        // Read-back after reopen is a durable, row-local projection — no child
        // is resumed and no LLM request is made by listing.
        const members = await listMembers(second.ctx, leadB)
        expect(members.find(candidate => candidate.name === 'hetero-worker')).toMatchObject({
          profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'dsv4-f', model: 'dsv4-f-prod',
        })
        expect(members.find(candidate => candidate.name === 'inherit-worker')).toMatchObject({
          profile_state: 'available', runtime_provider: 'spawn', llm_provider: 'glm', model: 'glm-prod',
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
