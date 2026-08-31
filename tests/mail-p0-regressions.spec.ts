/**
 * P0 regressions (memory-1) over the real Agent Teams composition.
 *
 * P0#1 — `add_member` must resolve the subagent provider before any
 * provisioning record is persisted: an unavailable provider is an explicit
 * `TEAM_MEMBER_PROVIDER_MISSING` error with NO member row committed (no
 * unusable member ever enters the roster).
 *
 * P0#2 — a member must not remain declared `active` after its initial turn
 * fails to reach a healthy terminal: a child whose initial turn ends in error
 * is durably demoted to `failed` (never left as an unusable active member).
 *
 * P0#3 — `llm_provider` / `model` must resolve before any provisioning record
 * is persisted: an unavailable LLM route is an explicit error with no member
 * row and no child Session.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

/** Healthy child: completes its initial turn with a stop finish. */
class HealthyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
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

/** Pathological child: its initial turn fails with an error (UNKNOWN_MODEL class). */
class FailingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    throw new Error('injected initial-turn failure (UNKNOWN_MODEL class)')
  }
}

interface CaptainStack {
  readonly ctx: Context
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: string
}

async function mountCaptain(sandbox: string, fibers: Fiber[], adapter: LlmAdapter, leadId: string): Promise<CaptainStack> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId(leadId), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
  const created = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('create'),
    name: 'agent_swarm_create',
    arguments: { name: 'P0 team', description: 'P0 regression team' },
    agent: lead,
  })
  expect(created.isError).toBe(false)
  return { ctx, lead, teamId: (created.value as { team_id: string }).team_id }
}

async function memberCount(stack: CaptainStack): Promise<number> {
  const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
    stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
  )
  return snapshot.team.members.length
}

describe('P0 add-member regressions over the real composition', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('P0#1: add_member resolves the provider before persist — missing provider errors with no member row', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-p0-provider-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const stack = await mountCaptain(sandbox, fibers, new HealthyAdapter(), 'p0-provider-lead')
      expect(await memberCount(stack)).toBe(0)
      await expect(stack.ctx.agentSwarm.addMember(
        { agent: stack.lead, signal: SIGNAL },
        { name: 'bad-provider-worker', role: 'worker', provider: 'missing-provider' },
      )).rejects.toMatchObject({ code: 'TEAM_MEMBER_PROVIDER_MISSING' })
      // No provisioning record persisted: the malformed call left no unusable member.
      expect(await memberCount(stack)).toBe(0)
      const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(snapshot.team.members).toEqual([])
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 30_000)

  it('P0#2: initial-turn failure demotes the member to failed — never left declared active', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-p0-initial-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const stack = await mountCaptain(sandbox, fibers, new FailingAdapter(), 'p0-initial-lead')
      // The child's initial turn fails (UNKNOWN_MODEL class). Whether addMember
      // rejects outright or resolves-then-demotes, the durable contract is the
      // same: the member must settle `failed`, never a lingering active row.
      await stack.ctx.agentSwarm.addMember(
        { agent: stack.lead, signal: SIGNAL },
        { name: 'doomed-worker', role: 'worker' },
      ).catch(() => undefined)
      await vi.waitFor(async () => {
        const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
          stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
        )
        const member = snapshot.team.members.find(candidate => candidate.name === 'doomed-worker')
        expect(member).toBeDefined()
        expect(member!.phase).toBe('failed')
      }, { timeout: 10_000, interval: 50 })
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 40_000)

  it('P0#3: add_member resolves the LLM route before persist — bad llm_provider errors with no member row', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-p0-llm-route-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []
    try {
      const stack = await mountCaptain(sandbox, fibers, new HealthyAdapter(), 'p0-llm-route-lead')
      expect(await memberCount(stack)).toBe(0)
      await expect(stack.ctx.agentSwarm.addMember(
        { agent: stack.lead, signal: SIGNAL },
        { name: 'bad-llm-worker', role: 'worker', llmProvider: 'missing-llm-provider', model: 'mock' },
      )).rejects.toMatchObject({ code: 'TEAM_LLM_ROUTE_INVALID' })
      expect(await memberCount(stack)).toBe(0)
      const headers = await stack.ctx.sessionPersistence.list()
      expect(headers.some(header => header.id !== String(stack.lead.id) && header.parentSession === String(stack.lead.id))).toBe(false)
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 30_000)
})
