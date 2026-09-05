/**
 * Issue #184 — recruited identity and member-assigned Skills become an
 * executable contract:
 *  - add_member can declare a member Skill subset; it is validated against the
 *    immutable Team allow-list AND the current complete scoped catalog
 *    (model-invocable) BEFORE any roster mutation (zero-side-effect rejection);
 *  - the subset is persisted in the Team aggregate, reconstructed on restart,
 *    projected into the fenced member persona and further narrows the
 *    TeamSkillSurface for that member;
 *  - scheduling semantics stay explicit: specialist work must name
 *    target_member; omission means any eligible member is interchangeable.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { normalizeMemberAssignedSkills } from '../src/domain/identity-profile.js'
import { memberPersona } from '../src/runtime/prompts.js'
import { priorityReadyScheduler } from '../src/runtime/providers.js'
import { TaskId, type TeamState as DomainTeamState, type TeamTask } from '../src/domain/types.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal
const ALPHA = { name: 'alpha', description: 'Alpha.', content: 'ALPHA' }
const BETA = { name: 'beta', description: 'Beta.', content: 'BETA' }

class CapturingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Acknowledged.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Mounted {
  readonly ctx: Context
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: string
  readonly fibers: Fiber[]
}

async function mount(sandbox: string, allowedSkills: readonly string[] | undefined): Promise<Mounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(SkillRegistry))
  ctx.skills.register({ ...ALPHA, source: 'runtime' })
  ctx.skills.register({ ...BETA, source: 'runtime' })
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    ...(allowedSkills === undefined ? {} : { allowedSkills: [...allowedSkills] }),
  }))
  const adapter = new CapturingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId('skills-lead'), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
  const created = await ctx.tools.execute({
    signal: SIGNAL, callId: CallId('create-team'), name: 'agent_swarm_create',
    arguments: { name: 'Skills team', description: 'Prove assigned Skills.' }, agent: lead,
  })
  expect(created.isError).toBe(false)
  return { ctx, lead, teamId: (created.value as { team_id: string }).team_id, fibers }
}

async function addMember(mounted: Mounted, callId: string, args: Record<string, unknown>) {
  return await mounted.ctx.tools.execute({
    signal: SIGNAL, callId: CallId(callId), name: 'agent_swarm_add_member', arguments: args, agent: mounted.lead,
  })
}


describe('member assigned Skills contract (issue #184)', () => {
  it('persists the allowed subset, projects it into the fenced persona and keeps generic/target scheduling semantics', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skills-member-'))
    const mounted = await mount(sandbox, ['alpha', 'beta'])
    try {
      const start = vi.spyOn(mounted.ctx.subagents, 'startContinuable')
      const added = await addMember(mounted, 'add-front', { name: 'front', role: 'frontend', skills: ['alpha'] })
      if (added.isError) console.error('ADD_ERROR', JSON.stringify(added.error))
      expect(added.isError).toBe(false)
      const member = added.value as { session_id: string }
      const state = await mounted.ctx.agentSwarm.domain.snapshot(
        mounted.ctx.agentSwarm.scopeOf(mounted.lead), AgentSwarm.TeamId(mounted.teamId), mounted.lead.id,
      )
      const row = state.team.members.find(candidate => candidate.name === 'front')!
      expect(row.assignedSkills).toEqual(['alpha'])
      const persona = start.mock.calls.find(call => (call[0] as { childId?: string }).childId === member.session_id)?.[0].request.persona ?? ''
      expect(persona).toContain('Assigned Skills (data): alpha')
      // Guidance: the create-task surface states the target_member rule.
      expect(mounted.ctx.tools.get('agent_swarm_create_task')?.description).toContain('MUST name target_member')
      start.mockRestore()

      // Scheduler: a targeted task goes exactly to its member; a generic task
      // stays interchangeable among the remaining eligible members.
      const scheduler = priorityReadyScheduler()
      const team = {
        members: [
          { name: 'front', role: 'frontend', sessionId: 'm1', provider: 'spawn', phase: 'active', createdAt: 1, assignedSkills: ['alpha'] },
          { name: 'back', role: 'backend', sessionId: 'm2', provider: 'spawn', phase: 'active', createdAt: 2 },
        ],
        tasks: [],
        attempts: [],
      } as unknown as DomainTeamState
      const generic: TeamTask = { id: TaskId('g1'), revision: 1, subject: 's', description: 'd', acceptanceCriteria: [], status: 'pending' as const, blockedBy: [], writeScopes: [], priority: 0, createdAt: 1, updatedAt: 1 }
      const targeted = { ...generic, id: TaskId('t1'), targetMemberSessionId: 'm1' }
      const decisions = (await scheduler.select({ team, readyTasks: [targeted, generic], availableMembers: team.members })) as readonly { taskId: string; memberSessionId: string }[]
      expect(decisions).toContainEqual({ taskId: 't1', memberSessionId: 'm1' })
      const genericDecision = decisions.find(decision => decision.taskId === 'g1')
      expect(genericDecision).toBeDefined()
      expect(['m1', 'm2']).toContain(genericDecision!.memberSessionId)
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('rejects a Skill missing from the scoped catalog with zero roster side effects', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skills-missing-'))
    const mounted = await mount(sandbox, ['alpha', 'beta'])
    try {
      const drain = vi.spyOn(mounted.ctx.subagents, 'drainContinuableChildren')
      const rejected = await addMember(mounted, 'add-missing', { name: 'ghost', role: 'worker', skills: ['missing-skill'] })
      expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_MEMBER_SKILLS_INVALID' } } })
      expect(drain).not.toHaveBeenCalled()
      const state = await mounted.ctx.agentSwarm.domain.snapshot(
        mounted.ctx.agentSwarm.scopeOf(mounted.lead), AgentSwarm.TeamId(mounted.teamId), mounted.lead.id,
      )
      expect(state.team.members).toHaveLength(0)
      drain.mockRestore()
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('rejects a Skill outside the Team allow-list with zero roster side effects', { timeout: 30_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skills-outside-'))
    const mounted = await mount(sandbox, ['alpha'])
    try {
      const rejected = await addMember(mounted, 'add-outside', { name: 'outside', role: 'worker', skills: ['alpha', 'beta'] })
      expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_MEMBER_SKILLS_INVALID' } } })
      const state = await mounted.ctx.agentSwarm.domain.snapshot(
        mounted.ctx.agentSwarm.scopeOf(mounted.lead), AgentSwarm.TeamId(mounted.teamId), mounted.lead.id,
      )
      expect(state.team.members).toHaveLength(0)
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('normalizes the subset, keeps the aggregate valid, and embeds it as data in the persona', () => {
    expect(normalizeMemberAssignedSkills([' alpha ', 'alpha', 'beta', '', ' gamma '])).toEqual(['alpha', 'beta', 'gamma'])
    expect(() => normalizeMemberAssignedSkills(Array.from({ length: 33 }, (_, index) => `s${index}`)))
      .toThrowError(expect.objectContaining({ code: 'TEAM_MEMBER_IDENTITY_INVALID' }))
    const team = {
      name: 'T', id: 'team-1', description: 'g', members: [],
    } as unknown as DomainTeamState
    const persona = memberPersona(team, 'front', 'frontend', ['alpha', 'gamma'])
    expect(persona).toContain('Assigned Skills (data): alpha, gamma')
    expect(persona).not.toContain('beta')
    // A2: display name, profession, personality AND role all ride the fenced persona.
    const personaWithIdentity = memberPersona(team, 'front', 'frontend', ['alpha'], {
      displayName: 'Front', profession: 'UI', personality: 'careful',
    })
    expect(personaWithIdentity).toContain('Your role: frontend')
    expect(personaWithIdentity).toContain('Display name: Front')
    expect(personaWithIdentity).toContain('Profession: UI')
    expect(personaWithIdentity).toContain('Personality: careful')
    expect(personaWithIdentity).toContain('Assigned Skills (data): alpha')
    // Explicit empty subset narrows the member to NO Skill (fail-closed, not inheritance).
    const personaEmpty = memberPersona(team, 'front', 'frontend', [])
    expect(personaEmpty).not.toContain('Assigned Skills (data):')
    // Persistence + storage-schema round-trip is proven by the real-composition
    // test above (snapshot reads the Team aggregate through the zod store).
  })
})
