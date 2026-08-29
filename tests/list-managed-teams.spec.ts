/**
 * Fault-first suite for the read-only `agent_swarm_list_managed_teams` tool
 * (issue: Main Brain must be able to enumerate its own managed Teams, which the
 * membership-bounded model read tools cannot — the Main Brain is outside every
 * Team). The tool reuses the existing managed-origin / Host-visibility /
 * TeamDomainPort seams and never builds a second authority or cross-process
 * union.
 *
 * The fail-closed property is the heart: a Team is listed iff the caller is
 * its Captain, a managed dedicated Captain child of the caller, or the
 * persisted parent of its Captain — otherwise it is DROPPED with no foreign
 * metadata leak, even inside the same workspace scope.
 *
 * The restart leg proves persistence: after a full service restart (fresh
 * runtime, empty in-memory ownedChildren) a resumed Main Brain still lists the
 * Team, because the root → Captain edge is rebuilt from the official persisted
 * Session headers (parentSession) at start.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mountNodeComposition,
  SIGNAL,
  type NodeComposition,
} from './helpers/node-composition.js'
import {
  disposeRestartComposition as dispose,
  mountRestartComposition as mount,
  restartTool as tool,
  type RestartMounted,
} from './helpers/restart-real-composition.js'

interface ManagedTeamRow {
  readonly team_id: string
  readonly name: string
  readonly phase: 'active' | 'archived'
  readonly captain_session_id: string
  readonly managed_origin?: string
  readonly display_name?: string
  readonly profession?: string
  readonly personality?: string
  readonly goal: { readonly state: 'generated'; readonly text: string } | { readonly state: 'not_generated'; readonly reason: 'goal_not_set' }
  readonly member_count: number
  readonly task_count: number
}

interface ListedManagedTeams {
  readonly teams: ManagedTeamRow[]
  readonly next_cursor?: number
}

async function listManaged(
  ctx: NodeComposition['ctx'],
  agent: Agent,
  callId: string,
  args: Record<string, unknown> = {},
) {
  return await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(callId),
    name: 'agent_swarm_list_managed_teams',
    arguments: args,
    agent,
  })
}

async function listedManaged(ctx: NodeComposition['ctx'], agent: Agent, callId: string, args: Record<string, unknown> = {}): Promise<ListedManagedTeams> {
  const result = await listManaged(ctx, agent, callId, args)
  if (result.isError) throw new Error(`list_managed_teams failed: ${JSON.stringify(result.error)}`)
  return result.value as unknown as ListedManagedTeams
}

describe('agent_swarm_list_managed_teams (read-only Main Brain enumeration)', () => {
  let sandbox: string | undefined
  let mounted: NodeComposition | undefined

  afterEach(async () => {
    mounted?.adapter.open()
    if (mounted !== undefined) {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
    if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
  })

  it('lists the Main Brain\'s own managed Team with identity, phase, goal, counts and navigation id', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-list-managed-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const ctx = mounted.ctx

    const created = await ctx.tools.execute({
      signal: SIGNAL, callId: CallId('managed-create'), name: 'agent_swarm_create_managed',
      arguments: { name: 'Managed Team', description: 'Public goal for the read.' },
      agent: mounted.lead,
    })
    expect(created.isError).toBe(false)
    const { team_id: teamId, captain_session_id: captainId } = created.value as { team_id: string; captain_session_id: string }

    // The bare read sees the honest `not_generated` goal before any are set.
    const fresh = await listedManaged(ctx, mounted.lead, 'list-fresh', {})
    expect(fresh.teams).toHaveLength(1)
    const freshRow = fresh.teams[0]!
    expect(freshRow.team_id).toBe(teamId)
    expect(freshRow.phase).toBe('active')
    expect(freshRow.captain_session_id).toBe(captainId)
    expect(freshRow.managed_origin).toMatch(/^managed:/u)
    expect(freshRow.display_name).toBeUndefined()
    expect(freshRow.goal).toEqual({ state: 'not_generated', reason: 'goal_not_set' })
    expect(freshRow.member_count).toBe(0)
    expect(freshRow.task_count).toBe(0)

    // The dedicated Captain (a live continuable child) authors the public goal
    // and identity profile; the read must then surface them from the aggregate.
    const captain = ctx.agents.get(SessionId(captainId))
    expect(captain).toBeDefined()
    const membership = await mounted.domain.requireMembership(mounted.scope, captainId)
    const revision = membership.team.revision
    const setGoal = await ctx.tools.execute({
      signal: SIGNAL, callId: CallId('set-goal'), name: 'agent_swarm_set_public_goal',
      arguments: { expected_revision: revision, text: 'Ship the minimal managed-Team list reader.' },
      agent: captain!,
    })
    expect(setGoal.isError).toBe(false)
    const setProfile = await ctx.tools.execute({
      signal: SIGNAL, callId: CallId('set-profile'), name: 'agent_swarm_set_captain_profile',
      arguments: { expected_revision: revision + 1, display_name: 'Lead Captain', profession: 'Team lead', personality: 'Precise.' },
      agent: captain!,
    })
    expect(setProfile.isError).toBe(false)

    const listed = await listedManaged(ctx, mounted.lead, 'list-enriched', {})
    expect(listed.next_cursor).toBeUndefined()
    expect(listed.teams).toHaveLength(1)
    const row = listed.teams[0]!
    expect(row.name).toBe('Managed Team')
    expect(row.captain_session_id).toBe(captainId)
    expect(row.display_name).toBe('Lead Captain')
    expect(row.profession).toBe('Team lead')
    expect(row.personality).toBe('Precise.')
    expect(row.goal).toEqual({ state: 'generated', text: 'Ship the minimal managed-Team list reader.' })
  })

  it('fails closed across principals in the same scope: each root sees only its own managed Team, unrelated roots see nothing', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-list-managed-xparam-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const ctx = mounted.ctx
    const sharedCwd = join(sandbox, 'workspace')

    // Root A creates a managed Team.
    const createdA = await ctx.tools.execute({
      signal: SIGNAL, callId: CallId('create-a'), name: 'agent_swarm_create_managed',
      arguments: { name: 'Team A', description: 'Root A only.' },
      agent: mounted.lead,
    })
    expect(createdA.isError).toBe(false)
    const captainA = (createdA.value as { captain_session_id: string }).captain_session_id

    // Root B is an independent top-level Main Brain in the SAME workspace scope.
    const rootB = ctx.agentLoop.create(
      SessionId(`root-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      { provider: 'mock', model: 'mock' },
      { cwd: sharedCwd },
    )
    const createdB = await ctx.tools.execute({
      signal: SIGNAL, callId: CallId('create-b'), name: 'agent_swarm_create_managed',
      arguments: { name: 'Team B', description: 'Root B only.' },
      agent: rootB,
    })
    expect(createdB.isError).toBe(false)
    const captainB = (createdB.value as { captain_session_id: string }).captain_session_id
    expect(captainB).not.toBe(captainA)

    // Each root enumerates exactly its own managed Team — never the other's.
    const listA = await listedManaged(ctx, mounted.lead, 'list-a', {})
    expect(listA.teams.map(row => row.captain_session_id)).toEqual([captainA])
    const listB = await listedManaged(ctx, rootB, 'list-b', {})
    expect(listB.teams.map(row => row.captain_session_id)).toEqual([captainB])

    // An unrelated top-level root in the same scope has no owned/managed Team
    // and must fail closed to an explicit empty list (no union, no fallback).
    const rootC = ctx.agentLoop.create(
      SessionId(`root-c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      { provider: 'mock', model: 'mock' },
      { cwd: sharedCwd },
    )
    expect((await listedManaged(ctx, rootC, 'list-c', {})).teams).toEqual([])
  })

  it('bounds the page window like the other read tools and validates input', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-list-managed-bounds-'))
    mounted = await mountNodeComposition(sandbox)
    const badCursor = await listManaged(mounted.ctx, mounted.lead, 'list-bad-cursor', { cursor: -1 })
    expect(badCursor).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
    const badLimit = await listManaged(mounted.ctx, mounted.lead, 'list-bad-limit', { limit: 0 })
    expect(badLimit).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
  })
})

/** Plain-stop mock so the dedicated Captain's initial turn settles cleanly (restart leg). */
class PlainStopAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Captain online.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Captain online.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
}

describe('agent_swarm_list_managed_teams survives a service restart', () => {
  const ROOT = SessionId('list-managed-restart-main')
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('a resumed Main Brain still lists its managed Team from the fresh runtime', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-list-managed-restart-'))
    roots.push(sandbox)
    let first: RestartMounted | undefined
    let second: RestartMounted | undefined
    try {
      first = await mount(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new PlainStopAdapter())
      const leadA = first.ctx.agentLoop.create(
        ROOT, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') },
      )
      const created = await tool(first.ctx, leadA, 'restart-create', 'agent_swarm_create_managed', {
        name: 'Restart-listed team', description: 'Must be listed again after restart.',
      })
      expect(created.isError).toBe(false)
      const captainId = (created.value as { captain_session_id: string }).captain_session_id
      expect(captainId).not.toBe(ROOT)

      // In-process: the Main Brain lists the created Team immediately.
      const before = await tool(first.ctx, leadA, 'restart-list-before', 'agent_swarm_list_managed_teams', {})
      expect(before.isError).toBe(false)
      const beforeTeams = (before.value as unknown as ListedManagedTeams).teams
      expect(beforeTeams.map(row => row.captain_session_id)).toEqual([captainId])

      // Full teardown: next process starts with an EMPTY ownedChildren.
      await dispose(first)
      first = undefined

      // Context B = "service restart" over the same durable SQLite + Storage roots.
      second = await mount(sandbox, 50)
      second.ctx.llm.registerAdapter(['mock'], new PlainStopAdapter())
      const resumed = await second.ctx.agents.resume({ resumeSessionId: ROOT })
      const leadB = resumed.agent
      expect(second.ctx.agents.get(ROOT)).toBe(leadB)

      // The fresh runtime rebuilt the root → Captain edge from persisted Session
      // headers (parentSession) + authoritative Team aggregate at start; the
      // resumed Main Brain must once again enumerate its managed Team read-only.
      const after = await tool(second.ctx, leadB, 'restart-list-after', 'agent_swarm_list_managed_teams', {})
      expect(after.isError).toBe(false)
      const afterTeams = (after.value as unknown as ListedManagedTeams).teams
      expect(afterTeams.map(row => row.captain_session_id)).toEqual([captainId])
      expect(afterTeams[0]!.phase).toBe('active')
    } finally {
      if (second !== undefined) await dispose(second).catch(() => undefined)
      if (first !== undefined) await dispose(first).catch(() => undefined)
    }
  })
})
