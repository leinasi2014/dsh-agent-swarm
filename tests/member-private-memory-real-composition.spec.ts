/**
 * Real dual-context member-private-memory integration (2026-08-26): two fully
 * separate Cordis Contexts over ONE real SQLite Session store and ONE real
 * Storage Domain root, with the member resumed only through the official
 * persistence recovery seam (`ctx.agents.resume`) — no direct SQLite reads and
 * no LLM. Proves:
 *
 *  1. A member's private memory survives a full dispose + cold reopen exactly.
 *  2. Writing private memory never changes the authoritative Team aggregate
 *     (snapshot, revision, roster, budget, shared memory) in A or B.
 *  3. Private content never leaks onto the Team/Host/RPC read surface
 *     (`agent_swarm_status`, shared `agent_swarm_list_memory`,
 *     `agent_swarm_list_members`).
 *  4. Authority is strictly the owning active member: captain, peers, external
 *     sessions, removed members, and archived members are all rejected.
 *  5. Cross-member and pagination correctness in both contexts.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const SIGNAL = new AbortController().signal
const CAPTAIN = SessionId('private-memory-real-captain')

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class PassiveAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of textResponse('Passive.')) yield chunk
  }
}

interface Mounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
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
  return { ctx, fibers }
}

async function dispose(mounted: Mounted): Promise<void> {
  for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
}

async function tool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

async function snapshot(ctx: Context, lead: Agent, teamId: string) {
  return await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
}

/** Resolve a member Agent by durable Session id: live if resident, else official explicit resume. */
async function memberAgent(ctx: Context, memberId: string): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const resident = ctx.agents.get(SessionId(memberId))
  if (resident !== undefined) return { agent: resident, dispose: async () => {} }
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(memberId) })
  return { agent: resumed.agent, dispose: async () => { await resumed.dispose() } }
}

/** Poll an async predicate until it holds (bounded, default 15s). */
async function pollUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('pollUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Wait until the Team revision is stable across a quiet window, then return. */
async function quiesceRevision(ctx: Context, lead: Agent, teamId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = -1
  for (;;) {
    const current = (await snapshot(ctx, lead, teamId)).team.revision
    if (current === last) {
      await new Promise(resolve => setTimeout(resolve, 120))
      const recheck = (await snapshot(ctx, lead, teamId)).team.revision
      if (recheck === current) return
      last = recheck
    } else {
      last = current
    }
    if (Date.now() > deadline) throw new Error('Team revision did not quiesce')
  }
}

describe('member private memory real composition', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('cold-restores exactly after a full reopen and isolates authority to the owning member', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-private-memory-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    let memberAId = ''
    let memberBId = ''
    let teamId = ''
    const aPrivate = ['alpha private note', 'beta private note', 'gamma private note']
    try {
      // ---- Context A: establish durable private memory ----
      first = await mount(sandbox)
      first.ctx.llm.registerAdapter(['mock'], new PassiveAdapter())
      const leadA = first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'pm-create', 'agent_swarm_create', {
        name: 'Private memory', description: 'Prove cold restore and owning-member authority.',
      })
      expect(created.isError).toBe(false)
      teamId = (created.value as { team_id: string }).team_id

      const addedA = await tool(first.ctx, leadA, 'pm-add-a', 'agent_swarm_add_member', { name: 'alpha', role: 'Owns private memory.' })
      const addedB = await tool(first.ctx, leadA, 'pm-add-b', 'agent_swarm_add_member', { name: 'beta', role: 'Owns a distinct private memory.' })
      expect(addedA.isError).toBe(false)
      expect(addedB.isError).toBe(false)
      memberAId = (addedA.value as { session_id: string }).session_id
      memberBId = (addedB.value as { session_id: string }).session_id

      const memberAResolved = await memberAgent(first.ctx, memberAId)
      const memberBResolved = await memberAgent(first.ctx, memberBId)
      const memberA = memberAResolved.agent
      const memberB = memberBResolved.agent

      // Capture the baseline AFTER the roster settles into active (member
      // activation settlement can itself bump the Team revision) so the private-
      // memory writes are the only operation between the two snapshots.
      await pollUntil(async () => {
        const current = await snapshot(first!.ctx, leadA, teamId)
        return current.team.members.filter(member => member.sessionId === memberAId || member.sessionId === memberBId).every(member => member.phase === 'active')
      })
      const beforeWrites = await snapshot(first.ctx, leadA, teamId)
      const beforeMemoryLength = beforeWrites.team.memory.length

      try {
        for (const content of aPrivate) {
          const added = await tool(first.ctx, memberA, `pm-add-${content}`, 'agent_swarm_add_private_memory', {
            content,
            evidence_refs: content === aPrivate[0] ? ['ref-1', 'ref-2'] : [],
          })
          expect(added).toMatchObject({ isError: false })
        }
        await tool(first.ctx, memberB, 'pm-add-b1', 'agent_swarm_add_private_memory', { content: 'beta-only note', evidence_refs: [] })

        // Team aggregate is untouched by private-memory writes: private content
        // never enters the aggregate's memory ledger or any other field (member
        // usage accounting legitimately bumps the Team revision, so the invariant is
        // content absence, not a frozen revision).
        const afterWrites = await snapshot(first.ctx, leadA, teamId)
        expect(afterWrites.team.memory).toHaveLength(beforeMemoryLength)
        expect(JSON.stringify(afterWrites.team)).not.toContain('alpha private note')
        expect(JSON.stringify(afterWrites.team)).not.toContain('beta-only note')

        // Peer isolation in A: beta cannot see alpha's private memory, and vice versa.
        const alphaList = await tool(first.ctx, memberA, 'pm-list-a', 'agent_swarm_list_private_memory', {})
        expect(alphaList).toMatchObject({ isError: false })
        expect((alphaList.value as { memories: Array<{ memory_id: string; content: string }> }).memories.map(row => row.content))
          .toEqual(aPrivate)
        const betaList = await tool(first.ctx, memberB, 'pm-list-b', 'agent_swarm_list_private_memory', {})
        expect((betaList.value as { memories: Array<{ content: string }> }).memories.map(row => row.content)).toEqual(['beta-only note'])

        // Non-leakage on the Team/Host read surfaces in A.
        const statusA = await tool(first.ctx, leadA, 'pm-status', 'agent_swarm_status', {})
        expect(statusA).toMatchObject({ isError: false })
        expect((statusA.value as { memory_entries: number }).memory_entries).toBe(beforeMemoryLength)
        const listed = await tool(first.ctx, leadA, 'pm-shared-list', 'agent_swarm_list_memory', {})
        expect(listed).toMatchObject({ isError: false, value: { memories: [] } })
        const membersA = await tool(first.ctx, leadA, 'pm-members', 'agent_swarm_list_members', {})
        const rows = (membersA.value as { members: Array<Record<string, unknown>> }).members
        for (const content of aPrivate) {
          expect(JSON.stringify(rows)).not.toContain(content)
        }
        expect(rows.every(row => !('private_memory' in row) && !('private_memories' in row) && !('private_memory_ids' in row))).toBe(true)

        // Captain + outsider rejected in A.
        expect(await tool(first.ctx, leadA, 'pm-captain-add', 'agent_swarm_add_private_memory', { content: 'captain forbidden' }))
          .toMatchObject({ isError: true, error: { info: { code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' } } })
        const outsiderA = first.ctx.agentLoop.create(SessionId('pm-outsider-a'), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
        expect(await tool(first.ctx, outsiderA, 'pm-outsider-add', 'agent_swarm_add_private_memory', { content: 'nope' }))
          .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
        expect(await tool(first.ctx, outsiderA, 'pm-outsider-list', 'agent_swarm_list_private_memory', {}))
          .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
      } finally {
        await memberAResolved.dispose()
        await memberBResolved.dispose()
      }

      // ---- every Context A fiber is gone before B opens the same durable roots ----
      await dispose(first)
      first = undefined

      // ---- Context B: cold reopen + official recovery only ----
      second = await mount(sandbox)
      second.ctx.llm.registerAdapter(['mock'], new PassiveAdapter())
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      const leadB = resumedCaptain.agent
      try {
        const resumedA = await second.ctx.agents.resume({ resumeSessionId: SessionId(memberAId) })
        const resumedB = await second.ctx.agents.resume({ resumeSessionId: SessionId(memberBId) })
        const memberBLoaded = resumedB.agent
        try {
          const restored = await tool(second.ctx, resumedA.agent, 'pm-restore', 'agent_swarm_list_private_memory', {})
          expect(restored).toMatchObject({ isError: false })
          expect((restored.value as { memories: Array<{ memory_id: string; content: string; seq: number; evidence_refs: string[]; evidence_refs_truncated: boolean }> }).memories.map(row => row.content))
            .toEqual(aPrivate)
          expect((restored.value as { memories: Array<{ evidence_refs: string[]; evidence_refs_truncated: boolean }> }).memories[0])
            .toMatchObject({ evidence_refs: ['ref-1', 'ref-2'], evidence_refs_truncated: false })

          // Member A can still append in B and reads back in stable order.
          await tool(second.ctx, resumedA.agent, 'pm-b-app', 'agent_swarm_add_private_memory', { content: 'delta after restart', evidence_refs: [] })
          const fuller = await tool(second.ctx, resumedA.agent, 'pm-b-list', 'agent_swarm_list_private_memory', {})
          expect((fuller.value as { memories: Array<{ content: string; seq: number }> }).memories.map(row => `${row.seq}:${row.content}`))
            .toEqual(['1:alpha private note', '2:beta private note', '3:gamma private note', '4:delta after restart'])

          // Pagination in B.
          const page = await tool(second.ctx, resumedA.agent, 'pm-b-page', 'agent_swarm_list_private_memory', { cursor: 1, limit: 2 })
          expect(page).toMatchObject({ isError: false, value: { next_cursor: 3 } })
          expect((page.value as { memories: Array<{ content: string }> }).memories.map(row => row.content)).toEqual(['beta private note', 'gamma private note'])

          // Peer isolation persists in B: beta sees only its own.
          const betaRestored = await tool(second.ctx, memberBLoaded, 'pm-b-beta', 'agent_swarm_list_private_memory', {})
          expect((betaRestored.value as { memories: Array<{ content: string }> }).memories.map(row => row.content)).toEqual(['beta-only note'])

          // Captain still rejected in B. Team aggregate still unchanged.
          expect(await tool(second.ctx, leadB, 'pm-b-captain', 'agent_swarm_add_private_memory', { content: 'captain still forbidden' }))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' } } })
          const stillSnap = await snapshot(second.ctx, leadB, teamId)
          expect(stillSnap.team.memory).toHaveLength(0)
          expect(JSON.stringify(stillSnap.team)).not.toContain('alpha private note')
          const membersB = await tool(second.ctx, leadB, 'pm-b-members', 'agent_swarm_list_members', {})
          expect(JSON.stringify((membersB.value as { members: Array<Record<string, unknown>> }).members)).not.toContain('alpha private note')

          // Invalid list input.
          expect(await tool(second.ctx, resumedA.agent, 'pm-b-invalid', 'agent_swarm_list_private_memory', { cursor: -1 }))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
          expect(await tool(second.ctx, resumedA.agent, 'pm-b-invalid2', 'agent_swarm_list_private_memory', { limit: 0 }))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
        } finally {
          await resumedA.dispose()
          await resumedB.dispose()
        }

        // Removed member loses access (Team authority, not stale private state).
        const removed = await tool(second.ctx, leadB, 'pm-b-remove', 'agent_swarm_remove_member', { name: 'beta', reason: 'Close membership proof.' })
        expect(removed.isError).toBe(false)
        const resumedRemoved = await second.ctx.agents.resume({ resumeSessionId: SessionId(memberBId) })
        try {
          expect(await tool(second.ctx, resumedRemoved.agent, 'pm-b-removed-list', 'agent_swarm_list_private_memory', {}))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
          expect(await tool(second.ctx, resumedRemoved.agent, 'pm-b-removed-add', 'agent_swarm_add_private_memory', { content: 'x' }))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
        } finally {
          await resumedRemoved.dispose()
        }

        // Archived team: the member loses access entirely (unlike shared-memory reads).
        expect(await tool(second.ctx, leadB, 'pm-b-archive', 'agent_swarm_archive', { reason: 'Close the read-authority proof.' })).toMatchObject({ isError: false })
        const resumedA2 = await second.ctx.agents.resume({ resumeSessionId: SessionId(memberAId) })
        try {
          expect(await tool(second.ctx, resumedA2.agent, 'pm-b-archived-a', 'agent_swarm_list_private_memory', {}))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
          expect(await tool(second.ctx, resumedA2.agent, 'pm-b-archived-a2', 'agent_swarm_add_private_memory', { content: 'y' }))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
        } finally {
          await resumedA2.dispose()
        }
      } finally {
        await resumedCaptain.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  }, 90_000)

  it('proves a direct sibling-service write leaves the whole Team aggregate deep-equal, while the real tool face remains functional', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-private-memory-direct-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox)
      first.ctx.llm.registerAdapter(['mock'], new PassiveAdapter())
      const leadA = first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'pm-direct-create', 'agent_swarm_create', {
        name: 'Direct invariant', description: 'Deep-equality proof that private storage never mutates the Team aggregate.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'pm-direct-add', 'agent_swarm_add_member', { name: 'solo', role: 'Owns the direct invariant.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      const resolved = await memberAgent(first.ctx, memberId)
      const member = resolved.agent
      try {
        await pollUntil(async () => {
          const current = await snapshot(first!.ctx, leadA, teamId)
          return current.team.members.some(row => row.sessionId === memberId && row.phase === 'active')
        })
        // Quiesce the Team revision first (provisioning/usage accounting has
        // already settled) so the two snapshots bracket ONLY the direct call.
        await quiesceRevision(first.ctx, leadA, teamId)
        const before = await snapshot(first.ctx, leadA, teamId)
        // Direct sibling-service call with the exact live member exec: no
        // ToolRuntime, so no usage accounting rides along — this isolates
        // "private storage does not change the Team" from the legitimate
        // usage-accounting effect that a real tool invocation causes (which is
        // why the earlier test asserts content absence rather than a frozen revision).
        const direct = await first.ctx.agentSwarmPrivateMemory.add(
          { agent: member, signal: SIGNAL },
          'direct-invariant note',
          ['ev-1', 'ev-2'],
        )
        expect(direct).toMatchObject({ memoryId: 'private-memory-1', seq: 1, content: 'direct-invariant note' })
        const after = await snapshot(first.ctx, leadA, teamId)
        expect(after).toEqual(before)

        // The tool face is functional (returns success and reads back the durable
        // private memory). This is a functional return proof only — it does NOT
        // run through an AgentLoop and is NOT Session evidence. The authoritative
        // proof that real AgentLoop tool calls land replayable tool/call +
        // tool/result on the member official Session with no auto-injection lives
        // in `member-private-memory-session-evidence.spec.ts`.
        const toolAdd = await tool(first.ctx, member, 'pm-direct-tool-add', 'agent_swarm_add_private_memory', {
          content: 'tool-face note', evidence_refs: [],
        })
        expect(toolAdd).toMatchObject({ isError: false })
        const listed = await tool(first.ctx, member, 'pm-direct-list', 'agent_swarm_list_private_memory', {})
        expect(listed).toMatchObject({ isError: false })
        expect((listed.value as { memories: Array<{ content: string }> }).memories.map(row => row.content))
          .toEqual(['direct-invariant note', 'tool-face note'])
      } finally {
        await resolved.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 60_000)
})
