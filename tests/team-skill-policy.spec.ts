/**
 * Issue #183 — Team skill allow-list enforcement (test implementer, strict TDD).
 *
 * The runtime surface under test (`TeamSkillSurface`) is meant to install a
 * same-name `skill` shadow only for Team sessions that carry a persisted
 * `allowedSkills` policy.  These regressions assert the CONTRACTED behavior of
 * that surface and the official skill faces it must govern:
 *
 *   1. A restricted member's `skill` shadow ALLOWS an allowed name and DENIES a
 *      name outside the allow-list; an unrestricted Team keeps the host default.
 *   2. A non-allowed `/name` user gesture injects no `skill-invocation`.
 *   3. The model `skill-catalog` shows ONLY the allowed names (+ descriptions),
 *      not the host catalog and not an empty list.
 *   4. The restricted result carries the canonical `resourceBase` and the
 *      shadow's output schema admits it (absent/malformed cases are handled).
 *   5. A freshly provisioned dedicated Captain AND a freshly added member are
 *      restricted from the very first turn.
 *   6. A cold-resumed member re-applies its allow-list and, when the policy
 *      cannot be resolved from the durable Team store, FAILS CLOSED rather than
 *      silently becoming unrestricted.
 *   7. Teardown prunes the transient policy entry for a released child.
 *
 * The harness mounts the REAL official services a deployment composes
 * (AgentLoop, in-process spawn continuable provider, sqlite persistence,
 * storage stack, skill registry, the official `dsh-tool-skill`) and drives the
 * actual continuable-child flow.  It asserts observable model-facing behavior:
 * the assembled LLM tool schemas, the durable `skill-catalog` source, the
 * injected `skill-invocation` messages, and the effective tool-result path.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamSkillSurface } from '../src/runtime/team-skill-surface.js'
import type { TeamState } from '../src/domain/types.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

const ALPHA = 'alpha'
const BETA = 'beta'
const USER_ONLY = 'user-only'
const ALPHA_DESCRIPTION = 'Alpha skill description.'
const ALPHA_BODY = 'ALPHA BODY'
const BETA_DESCRIPTION = 'Beta skill description.'
const BETA_BODY = 'BETA BODY'
const ALPHA_RESOURCE_BASE = { kind: 'directory' as const, path: 'C:/alpha' }

/** Captures every assembled LLM request, so the model-facing tools are observable. */
class CapturingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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
  readonly parent: ReturnType<Context['agentLoop']['create']>
  readonly surface: TeamSkillSurface
  readonly adapter: CapturingAdapter
  readonly sandbox: string
}

async function mountSurfaceStack(sandbox: string, fibers: Fiber[]): Promise<Mounted> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(SkillRegistry))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(ToolSkill))
  ctx.skills.register({
    name: ALPHA, description: ALPHA_DESCRIPTION, content: ALPHA_BODY, source: 'runtime', resourceBase: ALPHA_RESOURCE_BASE,
  })
  ctx.skills.register({ name: BETA, description: BETA_DESCRIPTION, content: BETA_BODY, source: 'runtime' })
  ctx.skills.register({
    name: USER_ONLY, description: 'User-only skill description.', content: 'USER BODY', source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true },
  })
  const adapter = new CapturingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const surface = new TeamSkillSurface(ctx)
  const parent = ctx.agentLoop.create(
    SessionId('mt-parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') })
  return { ctx, parent, surface, adapter, sandbox }
}

/** A minimal durable-shaped TeamState carrying the allow-list under test. */
function makeTeam(captainSessionId: string, memberSessionIds: string[] = [], allowedSkills?: readonly string[]): TeamState {
  return {
    captainSessionId,
    members: memberSessionIds.map(sessionId => ({ sessionId })),
    ...(allowedSkills === undefined ? {} : { allowedSkills }),
  } as unknown as TeamState
}

/** Materialize one continuable child bound to `team.allowedSkills` via rememberChild. */
async function spawnMember(mounted: Mounted, childId: SessionId, team: TeamState, assignedSkills?: readonly string[]): Promise<Agent> {
  mounted.surface.rememberChild(team, childId, assignedSkills)
  let member: Agent | undefined
  const stop = mounted.ctx.on('agent/created', ({ agent }) => {
    if (String(agent.id) === String(childId)) member = agent
  })
  await mounted.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'member',
    childId,
    request: { prompt: [{ type: 'text', text: 'Join.' }], parent: mounted.parent, persona: 'worker' } as never,
    signal: SIGNAL,
  })
  await vi.waitFor(() => expect(member).toBeDefined(), { timeout: 15_000 })
  stop()
  await member!.whenIdle()
  return member!
}

/** Materialize one child bound to a Team policy via rememberTeam (dedicated Captain). */
async function spawnCaptain(mounted: Mounted, childId: SessionId, team: TeamState): Promise<Agent> {
  mounted.surface.rememberTeam(team)
  let captain: Agent | undefined
  const stop = mounted.ctx.on('agent/created', ({ agent }) => {
    if (String(agent.id) === String(childId)) captain = agent
  })
  await mounted.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'Captain',
    childId,
    request: { prompt: [{ type: 'text', text: 'Start.' }], parent: mounted.parent, persona: 'captain' } as never,
    signal: SIGNAL,
  })
  await vi.waitFor(() => expect(captain).toBeDefined(), { timeout: 15_000 })
  stop()
  await captain!.whenIdle()
  return captain!
}

async function callSkill(mounted: Mounted, agent: Agent, callId: string, name: string) {
  return await mounted.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(callId),
    name: 'skill',
    arguments: { name },
    agent,
  })
}

/** The shadow schema as the model sees it in `request.tools`. */
function shadowSkillSchema() {
  return {
    name: 'skill',
    description: 'Load the full instructions for one Skill that this Team is allowed to use.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact allowed Skill name.' },
      },
      required: ['name'],
    },
  }
}

function skillCatalogOf(agent: Agent): { entries: Array<{ name: string; description: string }> } | undefined {
  const event = agent.session.events.find(
    candidate => candidate.type === 'user/message' && (candidate.data as { source?: { kind?: string } }).source?.kind === 'skill-catalog',
  )
  if (event === undefined) return undefined
  return (event.data as unknown as { source: { entries: Array<{ name: string; description: string }> } }).source
}

function skillInvocationsOf(agent: Agent): string[] {
  return agent.session.events
    .filter(event => event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'skill-invocation')
    .map(event => (event.data as unknown as { source: { name: string } }).source.name)
}

const roots: string[] = []
const fibers: Fiber[] = []

afterEach(async () => {
  for (const fiber of fibers.toReversed()) await fiber.dispose()
  fibers.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('Team skill allow-list surface (strict-TDD regressions)', () => {
  describe('restricted member tool surface', () => {
    it('allow-list admits only names it lists: the shadow ALLOWS an allowed skill and its result is loadable', { timeout: 30_000 }, async () => {
      const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-allow-'))
      roots.push(sandbox)
      const mounted = await mountSurfaceStack(sandbox, fibers)
      const childId = SessionId('allow-child')
      const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA]))

      // The model-facing tool is the allow-list shadow, not the host loader.
      const request = mounted.adapter.requests[0]!
      expect(request.sessionId).toBe(String(childId))
      const tools = request.tools?.filter(tool => (tool as { name: string }).name === 'skill')
      expect(tools).toEqual([shadowSkillSchema()])

      // The shadow must LOAD an allowed name (contracted: allowed => success).
      const allow = await callSkill(mounted, member, 'allow', ALPHA)
      expect(allow.isError).toBe(false)
      expect((allow.value as { name: string }).name).toBe(ALPHA)
    })

    it('further narrows a member to its assigned subset (issue #184): allowed subset loads, Team-allowed but unassigned is denied', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-assigned-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('assigned-child')
    const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA, BETA]), [BETA])

    const request = mounted.adapter.requests[0]!
    const tools = request.tools?.filter(tool => (tool as { name: string }).name === 'skill')
    expect(tools).toEqual([shadowSkillSchema()])

    // The assigned subset is loadable.
    const allow = await callSkill(mounted, member, 'assigned-beta', BETA)
    expect(allow.isError).toBe(false)
    expect((allow.value as { name: string }).name).toBe(BETA)
    // Team-allowed but NOT member-assigned stays denied.
    const denied = await callSkill(mounted, member, 'unassigned-alpha', ALPHA)
    expect(denied.isError).toBe(true)
    expect((denied.error as { message: string }).message).toContain('not allowed')
  })

  it('denies a name outside the allow-list and an unknown name', { timeout: 30_000 }, async () => {
      const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-deny-'))
      roots.push(sandbox)
      const mounted = await mountSurfaceStack(sandbox, fibers)
      const childId = SessionId('deny-child')
      const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA]))

      const denied = await callSkill(mounted, member, 'deny-beta', BETA)
      expect(denied.isError).toBe(true)
      expect((denied.error as { message: string }).message).toContain('not allowed')

      const deniedUnknown = await callSkill(mounted, member, 'deny-unknown', 'definitely-not-a-skill')
      expect(deniedUnknown.isError).toBe(true)
      expect((deniedUnknown.error as { message: string }).message).toContain('not allowed')
    })
  })

  it('does not inject a skill-invocation for a non-allowed /name gesture, but injects an allowed one', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-gesture-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('gesture-child')
    const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA]))

    member.followup(createUserMessage({
      content: [{ type: 'text', text: 'Please use /beta and then /alpha.' }],
      source: { kind: 'user' },
    }))
    await member.whenIdle()

    const invocations = skillInvocationsOf(member)
    // Non-allowed gesture must be suppressed; only the allowed one may inject.
    expect(invocations).not.toContain(BETA)
    expect(invocations).toContain(ALPHA)
  })

  it('projects a skill-catalog containing ONLY the allowed skills (name + description), not the host catalog', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-catalog-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('catalog-child')
    const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA]))

    const catalog = skillCatalogOf(member)
    expect(catalog).toBeDefined()
    // Only the allowed skill is advertised; the host beta is not leaked and the
    // user-only skill is excluded from the model catalog.
    expect(catalog?.entries).toEqual([{ name: ALPHA, description: ALPHA_DESCRIPTION }])
  })

  it('preserves the canonical resourceBase on the restricted result and admits it in the tool schema', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-resource-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('resource-child')
    const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA]))

    const allow = await callSkill(mounted, member, 'resource', ALPHA)
    expect(allow.isError).toBe(false)
    expect(allow.value).toEqual({
      name: ALPHA,
      provider: 'runtime',
      resourceBase: ALPHA_RESOURCE_BASE,
      content: ALPHA_BODY,
    })
    // The rendered model content reflects the resource base hint.
    const contentBlock = allow.content[0]
    expect((contentBlock as { text: string }).text).toContain(`Base directory for this skill: ${ALPHA_RESOURCE_BASE.path}`)
  })

  it('restricts a freshly provisioned dedicated Captain and a freshly added member from the very first turn', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-fresh-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const captainId = SessionId('fresh-captain')
    const memberId = SessionId('fresh-member')
    const team = makeTeam(String(captainId), [], [ALPHA])

    const captain = await spawnCaptain(mounted, captainId, team)
    const member = await spawnMember(mounted, memberId, makeTeam(String(captainId), [String(memberId)], [ALPHA]))

    // Both carry the allow-list shadow from their first request, not the host loader.
    const captainTools = mounted.adapter.requests.find(request => request.sessionId === String(captainId))!.tools?.filter(tool => (tool as { name: string }).name === 'skill')
    const memberTools = mounted.adapter.requests.find(request => request.sessionId === String(memberId))!.tools?.filter(tool => (tool as { name: string }).name === 'skill')
    expect(captainTools).toEqual([shadowSkillSchema()])
    expect(memberTools).toEqual([shadowSkillSchema()])

    // Neither leaks a non-allowed skill on the first turn.
    const captainDeny = await callSkill(mounted, captain, 'captain-deny', BETA)
    expect(captainDeny.isError).toBe(true)
    const memberDeny = await callSkill(mounted, member, 'member-deny', BETA)
    expect(memberDeny.isError).toBe(true)
  })

  it('fails closed on cold resume when the policy cannot be resolved from the durable store', { timeout: 40_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-cold-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('cold-child')

    // A restricted Team exists durably (allow-list ['alpha']) and this child is
    // one of its members ([makeTeam] above models that durable row), but the
    // freshly mounted surface has NOT yet resolved that policy — its in-memory
    // map is empty on a cold resume.  Fail-closed: the member must NOT silently
    // become unrestricted (host default) while the policy is unresolved.

    let member: Agent | undefined
    const stop = mounted.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.id) === String(childId)) member = agent
    })
    // Deliberately do NOT call `rememberChild`/`rememberTeam`: this is the cold
    // resume path on a mount that has not yet re-resolved the Team policy.
    await mounted.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'member',
      childId,
      request: { prompt: [{ type: 'text', text: 'Resume.' }], parent: mounted.parent, persona: 'worker' } as never,
      signal: SIGNAL,
    })
    await vi.waitFor(() => expect(member).toBeDefined(), { timeout: 15_000 })
    stop()
    await member!.whenIdle()

    // FAIL-CLOSED: the unresolved member must still be governed by the
    // allow-list (the shadow), not the unrestricted host loader.  The current
    // implementation fails open here, so these assertions are the red
    // regression for the fail-closed requirement.
    const tools = mounted.adapter.requests.find(request => request.sessionId === String(childId))!.tools?.filter(tool => (tool as { name: string }).name === 'skill')
    expect(tools).toEqual([shadowSkillSchema()])
    const denied = await callSkill(mounted, member!, 'resume-deny', BETA)
    expect(denied.isError).toBe(true)
    expect((denied.error as { message: string }).message).toContain('not allowed')
  })

  it('prunes the transient policy entry when a restricted child session is released', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-teardown-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('teardown-child')
    await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)], [ALPHA]))
    expect(mounted.surface.policyEntryCount()).toBe(1)
    expect(mounted.surface.hasPolicy(String(childId))).toBe(true)

    await mounted.ctx.subagents.drainContinuableChildren(mounted.parent, [childId])
    expect(mounted.surface.hasPolicy(String(childId))).toBe(false)
    expect(mounted.surface.policyEntryCount()).toBe(0)
  })
})

describe('unrestricted Team preserves host skill behavior', () => {
  it('an allow-list-free Team keeps the host skill loader and host catalog', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skill-host-'))
    roots.push(sandbox)
    const mounted = await mountSurfaceStack(sandbox, fibers)
    const childId = SessionId('host-child')
    // No allow-list: the surface must be invisible and the host default applies.
    const member = await spawnMember(mounted, childId, makeTeam('mt-parent', [String(childId)]))

    const hostRequest = mounted.adapter.requests[0]!
    const hostTool = hostRequest.tools?.find(tool => (tool as { name: string }).name === 'skill') as { description: string } | undefined
    expect(hostTool?.description).toContain('an available skill')

    // Host loader loads any model-invocable skill, carrying its resourceBase.
    const allow = await callSkill(mounted, member, 'host-load', ALPHA)
    expect(allow.isError).toBe(false)
    expect((allow.value as { resourceBase?: unknown }).resourceBase).toEqual(ALPHA_RESOURCE_BASE)
  })
})
