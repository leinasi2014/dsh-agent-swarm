/**
 * M5-2 / F17 (issue #136): member tool-permission policy surface.
 *
 * Every composition test mounts the real official services a deployment
 * composes (AgentLoop + in-process spawn provider, sqlite session
 * persistence, real storage stack) exactly like `member-provisioning.spec.ts`,
 * so the deny-only `deny_tools` declaration is proven against the official
 * creation-window `tools.restrict()` semantics:
 *
 * 1. effective path — the declared narrowing lands in the DURABLE child
 *    descriptor (the single authoritative record of the applied filter,
 *    reconstructable from the Session log), composed as a monotone union with
 *    the mandatory captain-only baseline and with no allow surface;
 * 2. M1A zero regression — without a declaration the composed deny is exactly
 *    the M1A static baseline;
 * 3. fail-loud — an unknown tool name is rejected by the OFFICIAL seam's
 *    loud unknown-name validation inside the child creation window, the
 *    provisioning record settles failed, and no member is activated;
 * 4. structural validation — plugin-side rejects are `TEAM_TOOL_POLICY_INVALID`.
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
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { MEMBER_HIDDEN_TOOLS } from '../src/runtime/prompts.js'
import { MAX_DENY_TOOLS, memberToolDeny } from '../src/runtime/tool-policy.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

class ImmediateAdapter extends LlmAdapter {
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

/** The durable composition under test: one captain lead over real services. */
interface CaptainStack {
  readonly ctx: Context
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: string
}

async function mountCaptain(
  sandbox: string,
  fibers: Fiber[],
  leadId: string,
  teamName: string,
): Promise<CaptainStack> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  const lead = ctx.agentLoop.create(
    SessionId(leadId),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('create'),
    name: 'agent_swarm_create',
    arguments: { name: teamName, description: `Prove the member tool-permission surface for ${leadId}.` },
    agent: lead,
  })
  expect(created.isError).toBe(false)
  return { ctx, lead, teamId: (created.value as { team_id: string }).team_id }
}

/** The durable toolFilter applied to one provisioned member's child Session. */
async function durableToolFilter(stack: CaptainStack, memberSessionId: string): Promise<{ deny?: readonly string[]; allow?: readonly string[] } | undefined> {
  const stored = await stack.ctx.sessionPersistence.inspect(SessionId(memberSessionId))
  const suffix = stored.events.slice(stored.meta.seedLength ?? 0)
  const descriptor = foldSubagentDescriptor(suffix)
  expect(descriptor?.mode).toBe('continuable')
  if (descriptor?.mode !== 'continuable') return undefined
  return descriptor.toolFilter
}

async function addMember(stack: CaptainStack, callId: string, args: Record<string, unknown>) {
  return await stack.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(callId),
    name: 'agent_swarm_add_member',
    arguments: args,
    agent: stack.lead,
  })
}

const roots: string[] = []
const fibers: Fiber[] = []

afterEach(async () => {
  for (const fiber of fibers.toReversed()) await fiber.dispose()
  fibers.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('member tool-policy composition (unit)', () => {
  it('without a declaration returns exactly the M1A static baseline in stable order', () => {
    expect(memberToolDeny()).toEqual([...MEMBER_HIDDEN_TOOLS])
    expect(memberToolDeny(undefined)).toEqual([...MEMBER_HIDDEN_TOOLS])
  })

  it('composes a monotone deny-only union: declared names append after the baseline, no allow surface', () => {
    const deny = memberToolDeny(['agent_swarm_send_message', 'bash'])
    expect(deny.slice(0, MEMBER_HIDDEN_TOOLS.length)).toEqual([...MEMBER_HIDDEN_TOOLS])
    expect(deny.slice(MEMBER_HIDDEN_TOOLS.length)).toEqual(['agent_swarm_send_message', 'bash'])
  })

  it('declaring a captain-only name is an idempotent no-op the union absorbs (no widening path)', () => {
    const deny = memberToolDeny(['agent_swarm_archive'])
    expect(deny).toEqual([...MEMBER_HIDDEN_TOOLS])
    expect(new Set(deny).size).toBe(deny.length)
  })

  it.each([
    ['empty name', ['']],
    ['whitespace name', ['   ']],
    ['path-shaped name', ['../etc/passwd']],
    ['fenced name', ['not`a`tool']],
    ['spaced name', ['agent swarm']],
  ])('rejects a structurally invalid declaration (%s) with TEAM_TOOL_POLICY_INVALID', (_label, declared) => {
    expect(() => memberToolDeny(declared as string[])).toThrowError(expect.objectContaining({ code: 'TEAM_TOOL_POLICY_INVALID' }))
  })

  it('rejects a repeated declaration and an over-limit declaration', () => {
    expect(() => memberToolDeny(['bash', 'bash'])).toThrowError(expect.objectContaining({ code: 'TEAM_TOOL_POLICY_INVALID' }))
    expect(() => memberToolDeny(Array.from({ length: MAX_DENY_TOOLS + 1 }, (_, index) => `tool_${index}`)))
      .toThrowError(expect.objectContaining({ code: 'TEAM_TOOL_POLICY_INVALID' }))
    // The bound itself is admissible (no declared name collides with the baseline).
    expect(memberToolDeny(Array.from({ length: MAX_DENY_TOOLS }, (_, index) => `tool_${index}`))).toHaveLength(MEMBER_HIDDEN_TOOLS.length + MAX_DENY_TOOLS)
  })
})

describe('member tool-policy surface (real composition)', () => {
  it('lands the declared narrowing in the durable child descriptor as a monotone union with the captain-only baseline', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-tool-policy-effective-'))
    roots.push(sandbox)
    const stack = await mountCaptain(sandbox, fibers, 'tool-policy-lead', 'Tool policy team')

    const added = await addMember(stack, 'add-narrowed', {
      name: 'reviewer-worker',
      role: 'Review evidence without messaging tools.',
      deny_tools: ['agent_swarm_send_message'],
    })
    expect(added.isError).toBe(false)
    const member = added.value as { session_id: string; phase: string }
    expect(member.phase).toBe('active')

    const filter = await durableToolFilter(stack, member.session_id)
    // The applied filter is the durable authority: baseline plus the declared
    // narrowing, deduped, and structurally deny-only (no allow key exists).
    expect(filter).toEqual({ deny: [...MEMBER_HIDDEN_TOOLS, 'agent_swarm_send_message'] })
    expect('allow' in (filter ?? {})).toBe(false)
  }, 20_000)

  it('keeps the M1A static semantics byte-identical without a declaration (F15 preflight untouched)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-tool-policy-baseline-'))
    roots.push(sandbox)
    const stack = await mountCaptain(sandbox, fibers, 'tool-policy-baseline-lead', 'Baseline team')

    const added = await addMember(stack, 'add-baseline', {
      name: 'baseline-worker',
      role: 'Provision under the static M1A filter.',
    })
    expect(added.isError).toBe(false)
    const member = added.value as { session_id: string }

    const filter = await durableToolFilter(stack, member.session_id)
    expect(filter).toEqual({ deny: [...MEMBER_HIDDEN_TOOLS] })
  }, 20_000)

  it('fails loud on an unknown tool name: the official creation-window validation rejects, the record settles failed, no member activates', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-tool-policy-fail-'))
    roots.push(sandbox)
    const stack = await mountCaptain(sandbox, fibers, 'tool-policy-fail-lead', 'Fail-loud team')
    const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')

    const rejected = await addMember(stack, 'add-unknown', {
      name: 'typo-worker',
      role: 'Declares a tool name that does not exist.',
      deny_tools: ['definitely_not_a_real_tool_m5b'],
    })
    expect(rejected.isError).toBe(true)
    // The official restrict() diagnostic is the existence authority and must
    // surface verbatim through the provisioning failure path.
    expect((rejected.error as { message: string }).message).toContain('unknown global tool')
    expect((rejected.error as { message: string }).message).toContain('definitely_not_a_real_tool_m5b')

    // Fail-loud settlement: the interrupted provision is a visible failed
    // roster row (name occupied per F12), never a silently unfiltered member.
    const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
      stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
    )
    expect(snapshot.team.members).toHaveLength(1)
    expect(snapshot.team.members[0]).toMatchObject({ name: 'typo-worker', phase: 'failed' })
    expect(snapshot.team.members[0]!.error).toContain('unknown global tool')
    // A retry under the same name stays rejected (lifetime occupation), and
    // the failed declaration is reconstructable from the captain's own tool
    // call arguments plus this settlement — no silent state remains.
    const retry = await addMember(stack, 'add-unknown-retry', {
      name: 'typo-worker',
      role: 'Must be rejected.',
      deny_tools: ['definitely_not_a_real_tool_m5b'],
    })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'TEAM_MEMBER_NAME_TAKEN' } } })
    expect(drain).not.toHaveBeenCalled()
    drain.mockRestore()
  }, 20_000)

  it('rejects a structurally invalid declaration before any provisioning record commits', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-tool-policy-invalid-'))
    roots.push(sandbox)
    const stack = await mountCaptain(sandbox, fibers, 'tool-policy-invalid-lead', 'Invalid declaration team')

    const rejected = await addMember(stack, 'add-invalid', {
      name: 'invalid-worker',
      role: 'Declares a structurally invalid tool name.',
      deny_tools: ['not a tool name'],
    })
    expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_TOOL_POLICY_INVALID' } } })

    const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
      stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
    )
    expect(snapshot.team.members).toHaveLength(0)
  }, 20_000)
})
