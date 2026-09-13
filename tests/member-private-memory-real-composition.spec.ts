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
 *  6. v2 maintenance rows fold through the REAL tool face: `agent_swarm_list_
 *     private_memory` output passes its strict output schema with the folded
 *     fold-metadata/provenance fields present (no duplicated schema, no cast).
 *  7. (task-4) The real `agent_swarm_maintain_private_memory` face writes v2
 *     rows through host assembly, replays legal retries, keeps legacy v1 adds
 *     intact, and is visible CAUSALLY on the owning member's own model
 *     requests; with an explicit Team `toolPolicy.deny` the same call is
 *     denied and the tool face disappears from that member's requests.
 *
 * Shared mount/adapter/resume helpers live in
 * `./helpers/private-memory-composition.ts` (M-owned, 600-line split).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPTAIN, PassiveAdapter, SIGNAL, dispose, memberAgent, mount, pollUntil, quiesceRevision, snapshot, tool, type Mounted,
} from './helpers/private-memory-composition.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PRIVATE_MEMORY_DOMAIN_NAME } from '../src/storage/member-private-memory.js'

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
      const leadA = await first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
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

      // Capture the baseline AFTER the roster settles into active (member
      // activation settlement can itself bump the Team revision) so the private-
      // memory writes are the only operation between the two snapshots.
      await pollUntil(async () => {
        const current = await snapshot(first!.ctx, leadA, teamId)
        return current.team.members.filter(member => member.sessionId === memberAId || member.sessionId === memberBId).every(member => member.phase === 'active')
      })
      const memberAResolved = await memberAgent(first.ctx, memberAId)
      const memberBResolved = await memberAgent(first.ctx, memberBId)
      const memberA = memberAResolved.agent
      const memberB = memberBResolved.agent
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
        const outsiderA = await first.ctx.agentLoop.create(SessionId('pm-outsider-a'), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
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
      const leadA = await first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'pm-direct-create', 'agent_swarm_create', {
        name: 'Direct invariant', description: 'Deep-equality proof that private storage never mutates the Team aggregate.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'pm-direct-add', 'agent_swarm_add_member', { name: 'solo', role: 'Owns the direct invariant.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      await pollUntil(async () => {
          const current = await snapshot(first!.ctx, leadA, teamId)
          return current.team.members.some(row => row.sessionId === memberId && row.phase === 'active')
      })
      const resolved = await memberAgent(first.ctx, memberId)
      const member = resolved.agent
      try {
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

  it('folds strict v2 rows into agent_swarm_list_private_memory output that passes the real strict tool-output validation', async () => {
    // Root-accepted reader-acceptance gap (2026-09): the 27 existing tool-path
    // cases are v1-only; the extended row shape must be proven through the REAL
    // ctx.tools.execute face, whose strict output schema (additionalProperties:
    // false, no duplicated schema, no cast) rejects any field it does not know.
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-private-memory-v2-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      // ---- Context A: real composition seeds ONE legacy v1 note via the tool face ----
      first = await mount(sandbox)
      first.ctx.llm.registerAdapter(['mock'], new PassiveAdapter())
      const leadA = await first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'pm2-create', 'agent_swarm_create', {
        name: 'V2 fold proof', description: 'Prove v2 maintenance rows surface through the strict tool output.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'pm2-add', 'agent_swarm_add_member', { name: 'foldy', role: 'Owns the v2 fold proof.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      await pollUntil(async () => {
        const current = await snapshot(first!.ctx, leadA, teamId)
        return current.team.members.some(row => row.sessionId === memberId && row.phase === 'active')
      })
      const resolved = await memberAgent(first.ctx, memberId)
      const scope = first.ctx.agentSwarm.scopeOf(resolved.agent)
      try {
        const seed = await tool(first.ctx, resolved.agent, 'pm2-seed', 'agent_swarm_add_private_memory', { content: 'base note', evidence_refs: [] })
        expect(seed).toMatchObject({ isError: false, value: { memory_id: 'private-memory-1', seq: 1 } })
      } finally {
        await resolved.dispose()
      }

      // ---- medium fully closed, THEN raw-append STRICT v2 rows (add + replace) ----
      await dispose(first)
      first = undefined
      const unitFile = join(sandbox, 'storage', `${PRIVATE_MEMORY_DOMAIN_NAME}.json`)
      const unit = JSON.parse(await readFile(unitFile, 'utf8')) as { tables: { memories: Record<string, unknown> } }
      const v2Key = (seq: number) => JSON.stringify([scope, teamId, memberId, seq])
      unit.tables.memories[v2Key(2)] = {
        schemaVersion: 2, operation: 'add', scope, teamId, memberSessionId: memberId, seq: 2,
        operationId: 'op-fold-add', provenance: { kind: 'task', taskId: 'task-fold', teamRevision: 5, observedAt: 123 },
        createdAt: 1000, content: 'added by v2', evidenceRefs: ['ref-fold'], tags: ['m1', 'tag'], applicability: 'when folding',
      }
      unit.tables.memories[v2Key(3)] = {
        schemaVersion: 2, operation: 'replace', scope, teamId, memberSessionId: memberId, seq: 3,
        operationId: 'op-fold-replace', provenance: { kind: 'task', taskId: 'task-fold-replace', teamRevision: 5, observedAt: 124 },
        createdAt: 1001, targetMemoryId: 'private-memory-1', expectedHeadSeq: 1,
        content: 'replaced base', evidenceRefs: ['ref-replaced'], tags: ['replacement'], applicability: 'when replacing',
      }
      await writeFile(unitFile, `${JSON.stringify(unit, null, 2)}\n`, 'utf8')

      // ---- Context B: real cold reopen; the ACTUAL tool face reads the fold ----
      second = await mount(sandbox)
      second.ctx.llm.registerAdapter(['mock'], new PassiveAdapter())
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      const resumedMember = await second.ctx.agents.resume({ resumeSessionId: SessionId(memberId) })
      try {
        const listed = await tool(second.ctx, resumedMember.agent, 'pm2-list', 'agent_swarm_list_private_memory', {})
        // Reaching `isError: false` at all means the strict tool OUTPUT schema
        // accepted the extended rows — the proof the plain row() unit tests cannot give.
        expect(listed).toMatchObject({ isError: false })
        const memories = (listed.value as { memories: Array<Record<string, unknown>> }).memories
        // Folded creation order: superseded old note KEEPS offset 0; the v2 add
        // and the replace result are appended at their operation positions.
        expect(memories.map(row => row.memory_id)).toEqual(['private-memory-1', 'private-memory-2', 'private-memory-3'])
        expect(memories[0]).toMatchObject({
          content: 'base note', seq: 1, status: 'superseded', head_seq: 3, superseded_by: 'private-memory-3',
        })
        // The legacy payload's origin stays UNKNOWN: no fabricated provenance field.
        expect('provenance' in memories[0]!).toBe(false)
        expect(memories[1]).toMatchObject({
          content: 'added by v2', seq: 2, status: 'active', head_seq: 2,
          tags: ['m1', 'tag'], applicability: 'when folding',
          created_via: { operation_id: 'op-fold-add', operation: 'add', seq: 2 },
          provenance: { kind: 'task', task_id: 'task-fold', team_revision: 5, observed_at: 123 },
        })
        expect(memories[2]).toMatchObject({
          content: 'replaced base', seq: 3, status: 'active', head_seq: 3,
          tags: ['replacement'], applicability: 'when replacing',
          created_via: { operation_id: 'op-fold-replace', operation: 'replace', seq: 3 },
          provenance: { kind: 'task', task_id: 'task-fold-replace', team_revision: 5, observed_at: 124 },
        })
      } finally {
        await resumedMember.dispose()
        await resumedCaptain.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  }, 90_000)

  it('writes durable v2 maintenance through the REAL agent_swarm_maintain_private_memory tool face (host-assembled registration)', async () => {
    // Task-4 writer acceptance (contract 5): the tool is registered through the
    // real plugin assembly (tools/index.ts), visible in the member's next model
    // request, executes only for the owning member with strict input/output,
    // replays legal retries, and the legacy add tool keeps writing v1-only.
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-private-memory-writes-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox)
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const leadA = await first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'pm3-create', 'agent_swarm_create', {
        name: 'Writes proof', description: 'Prove the maintenance tool face end to end.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'pm3-add', 'agent_swarm_add_member', { name: 'writyy', role: 'Owns the maintenance writes proof.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      await pollUntil(async () => {
        const current = await snapshot(first!.ctx, leadA, teamId)
        return current.team.members.some(row => row.sessionId === memberId && row.phase === 'active')
      })
      const resolved = await memberAgent(first.ctx, memberId)
      try {
        const seed = await tool(first.ctx, resolved.agent, 'pm3-seed', 'agent_swarm_add_private_memory', { content: 'base note', evidence_refs: [] })
        expect(seed).toMatchObject({ isError: false, value: { memory_id: 'private-memory-1', seq: 1 } })

        const reviseArgs = {
          operation: 'revise', operation_id: 'op-tool-revise', target_memory_id: 'private-memory-1', expected_head_seq: 1,
          content: 'tool revision', evidence_refs: [], tags: ['rev'], applicability: 'when listed',
        }
        const revise = await tool(first.ctx, resolved.agent, 'pm3-revise', 'agent_swarm_maintain_private_memory', reviseArgs)
        expect(revise).toMatchObject({
          isError: false,
          value: {
            operation_id: 'op-tool-revise', operation: 'revise', operation_seq: 2,
            result_memory_id: 'private-memory-1', head_seq: 2, status: 'active', replayed: false,
          },
        })
        expect('replaced_memory_id' in (revise.value as object)).toBe(false)
        // A legal retry (stable operation_id, same normalized input) replays the
        // ORIGINAL receipt through the strict output schema and appends nothing.
        const retry = await tool(first.ctx, resolved.agent, 'pm3-retry', 'agent_swarm_maintain_private_memory', reviseArgs)
        expect(retry).toMatchObject({ isError: false, value: { ...(revise.value as object), replayed: true } })
        // The same operation_id with different content is a conflict with zero side effects.
        expect(await tool(first.ctx, resolved.agent, 'pm3-conflict', 'agent_swarm_maintain_private_memory', { ...reviseArgs, content: 'DIFFERENT' }))
          .toMatchObject({ isError: true })
        // A payload-bearing branch missing one of the four full-replacement fields rejects.
        const { applicability: _applicability, ...missingField } = reviseArgs
        expect(await tool(first.ctx, resolved.agent, 'pm3-missing', 'agent_swarm_maintain_private_memory', { ...missingField, operation_id: 'op-tool-missing' }))
          .toMatchObject({ isError: true })
        // A forged identity face (member-external caller) is rejected: the captain cannot write a member's memory.
        expect(await tool(first.ctx, leadA, 'pm3-captain', 'agent_swarm_maintain_private_memory', {
          operation: 'add', operation_id: 'op-tool-captain', content: 'not yours', evidence_refs: [], tags: [], applicability: '',
        })).toMatchObject({ isError: true })
        // A v2 maintenance add lands its own note at max-seq+1 — the id derives
        // from the PHYSICAL seq (the revise above already took seq 2), so this
        // note is private-memory-3 at seq 3.
        const v2add = await tool(first.ctx, resolved.agent, 'pm3-v2add', 'agent_swarm_maintain_private_memory', {
          operation: 'add', operation_id: 'op-tool-add', content: 'tool maintenance note', evidence_refs: ['ref-t'], tags: ['tool'], applicability: '',
        })
        expect(v2add).toMatchObject({
          isError: false,
          value: { operation_id: 'op-tool-add', operation: 'add', operation_seq: 3, result_memory_id: 'private-memory-3', head_seq: 3, status: 'active', replayed: false },
        })
        // ...and the legacy tool append STILL writes v1 without colliding (next physical seq 4).
        const legacy = await tool(first.ctx, resolved.agent, 'pm3-legacy', 'agent_swarm_add_private_memory', { content: 'legacy after maintenance', evidence_refs: [] })
        expect(legacy).toMatchObject({ isError: false, value: { memory_id: 'private-memory-4', seq: 4 } })

        const listed = await tool(first.ctx, resolved.agent, 'pm3-list', 'agent_swarm_list_private_memory', {})
        expect(listed).toMatchObject({ isError: false })
        const memories = (listed.value as { memories: Array<Record<string, unknown>> }).memories
        expect(memories.map(row => row.memory_id)).toEqual(['private-memory-1', 'private-memory-3', 'private-memory-4'])
        expect(memories[0]).toMatchObject({ content: 'tool revision', seq: 1, head_seq: 2, status: 'active', tags: ['rev'], applicability: 'when listed' })
        expect(memories[1]).toMatchObject({ content: 'tool maintenance note', seq: 3, head_seq: 3, created_via: { operation_id: 'op-tool-add', operation: 'add', seq: 3 } })
        // The untouched legacy row keeps the historical shape: NO head_seq/extra fields.
        expect(memories[2]!.content).toBe('legacy after maintenance')
        expect('head_seq' in memories[2]!).toBe(false)

        // Tool DEFINITION visibility CAUSALLY bound to the OWNING member: the
        // member's own real model requests (identified by request sessionId)
        // carry the maintenance face (permission-policy wiring is what makes
        // the face model-visible); an arbitrary request in the aggregate is not
        // claimed as proof.
        const memberRequests = adapter.requests.filter(request => request.sessionId === memberId)
        expect(memberRequests.length).toBeGreaterThan(0)
        const memberTools = memberRequests.at(-1)!.toolNames
        expect(memberTools).toContain('agent_swarm_maintain_private_memory')
        expect(memberTools).toContain('agent_swarm_add_private_memory')
      } finally {
        await resolved.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)

  it('rejects the maintenance tool through the real Team tool-policy deny and hides it from the member model requests', async () => {
    // Explicit deny precedence (task-4 acceptance): with the established
    // official `toolPolicy.deny` entry, the owning member's real
    // ctx.tools.execute of agent_swarm_maintain_private_memory is denied by the
    // Team tool policy (fail closed) — while the unlisted private-memory list
    // tool stays available and the DENIED tool is absent from the member's
    // model-request tool face (visibility follows the policy, per the existing
    // permission-composition contract).
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-private-memory-deny-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    try {
      first = await mount(sandbox, { toolPolicyDeny: ['agent_swarm_maintain_private_memory'] })
      const adapter = new PassiveAdapter()
      first.ctx.llm.registerAdapter(['mock'], adapter)
      const leadA = await first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'pm4-create', 'agent_swarm_create', {
        name: 'Deny proof', description: 'Prove tool-policy deny reaches the maintenance tool.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'pm4-add', 'agent_swarm_add_member', { name: 'denyee', role: 'Owns the deny proof.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      await pollUntil(async () => {
        const current = await snapshot(first!.ctx, leadA, teamId)
        return current.team.members.some(row => row.sessionId === memberId && row.phase === 'active')
      })
      const resolved = await memberAgent(first.ctx, memberId)
      try {
        const denied = await tool(first.ctx, resolved.agent, 'pm4-maintain', 'agent_swarm_maintain_private_memory', {
          operation: 'add', operation_id: 'op-denied', content: 'must never persist', evidence_refs: [], tags: [], applicability: '',
        })
        expect(denied).toMatchObject({ isError: true })
        expect(JSON.stringify(denied.error)).toContain('denied by the Team tool policy')
        // The policy denied ONLY the maintenance tool: the sibling reader stays available.
        const listed = await tool(first.ctx, resolved.agent, 'pm4-list', 'agent_swarm_list_private_memory', {})
        expect(listed).toMatchObject({ isError: false, value: { memories: [] } })
        // Model visibility follows the deny CAUSALLY for this member's own
        // requests: the member's real model request tool face never carried
        // the denied tool, while the allowed private-memory reader did.
        const memberRequests = adapter.requests.filter(request => request.sessionId === memberId)
        expect(memberRequests.length).toBeGreaterThan(0)
        const memberTools = memberRequests.at(-1)!.toolNames
        expect(memberTools).not.toContain('agent_swarm_maintain_private_memory')
        expect(memberTools).toContain('agent_swarm_list_private_memory')
      } finally {
        await resolved.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
    }
  }, 90_000)
})
