/**
 * The actual restart boundary for the current single-Team authority.
 *
 * This intentionally is not a fresh-v2 continuation test.  It uses two
 * entirely separate Cordis Contexts over one real SQLite Session store and
 * one real Storage Domain root.  An already-delivered assignment must not be
 * replayed just because its continuable child is cold after a restart.  The
 * Captain's existing durable wakeup mail is the explicit recovery action.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamMember, TeamState } from '../src/domain/types.js'
import { MemberProfileReader } from '../src/runtime/member-profile-reader.js'
import { MEMBER_HIDDEN_TOOLS } from '../src/runtime/prompts.js'
import {
  disposeRestartComposition as dispose,
  mountRestartComposition as mount,
  RESTART_SIGNAL as SIGNAL,
  restartSnapshot as snapshot,
  restartTool as tool,
  type RestartMounted as Mounted,
} from './helpers/restart-real-composition.js'

const CAPTAIN = SessionId('restart-real-captain')

function latestUserText(options: GenerateOptions): string {
  const message = options.messages.toReversed().find(candidate => candidate.role === 'user')
  return message?.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n') ?? ''
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Context A only establishes durable history; it never submits work. */
class InitialAdapter extends LlmAdapter {
  workerId: string | undefined
  workerRequests = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === this.workerId) this.workerRequests += 1
    for (const chunk of textResponse('Context A checkpoint.')) yield chunk
  }
}

/** Context B holds the explicit recovery turn open until queued quiet mail is folded. */
class RecoveryAdapter extends LlmAdapter {
  workerId: string | undefined
  memberRequests = 0
  wakeRequests = 0
  private releaseWake!: () => void
  private readonly wakeGate = new Promise<void>(resolve => { this.releaseWake = resolve })

  constructor(private readonly attempt: () => { taskId: string; revision: number; attemptId: string }) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  releaseSubmission(): void { this.releaseWake() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.workerId) {
      for (const chunk of textResponse('Captain recovery acknowledgement.')) yield chunk
      return
    }
    this.memberRequests += 1
    const text = latestUserText(options)
    if (!text.includes('resume the exact current attempt')) {
      for (const chunk of textResponse('No autonomous continuation.')) yield chunk
      return
    }
    this.wakeRequests += 1
    await this.wakeGate
    const attempt = this.attempt()
    const id = CallId('restart-real-submit')
    const argumentsJson = JSON.stringify({
      task_id: attempt.taskId,
      expected_revision: attempt.revision,
      attempt_id: attempt.attemptId,
      output: 'Recovered the exact durable attempt after an explicit wakeup.',
      evidence: ['two-context-sqlite-restart'],
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_submit_task', argumentsDelta: argumentsJson }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_submit_task', arguments: argumentsJson } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => {
    if (event.type !== 'user/message') return []
    return event.data.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
  })
}

describe('real restart continuation over the current Team authority', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('requires one explicit durable wakeup to resume an already delivered attempt, then submits and reviews the same attempt', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-restart-continuation-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      // Context A: create the real Team/continuable child and leave an
      // assignment already claimed into durable member history.
      // Context A only establishes its durable checkpoint.  Disable the
      // self-heal there so a slow initial turn -> drain cannot race a short
      // grace before the intended restart boundary exists.
      first = await mount(sandbox, 0)
      const initial = new InitialAdapter()
      first.ctx.llm.registerAdapter(['mock'], initial)
      const leadA = first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'restart-create', 'agent_swarm_create', {
        name: 'Restart continuation', description: 'Prove an explicit recovery of one durable attempt.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'restart-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Own the single recovered attempt.',
      })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      initial.workerId = memberId
      const taskCreated = await tool(first.ctx, leadA, 'restart-task', 'agent_swarm_create_task', {
        subject: 'Durable restart task', description: 'The same attempt must never be assigned twice after restart.', target_member: 'worker',
      })
      expect(taskCreated.isError).toBe(false)

      let frozen!: { taskId: string; revision: number; attemptId: string; generation: number; memberId: string }
      await vi.waitFor(async () => {
        const current = await snapshot(first!.ctx, leadA, teamId)
        const task = current.team.tasks[0]!
        const attempt = current.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
        expect(task).toMatchObject({ status: 'in_progress', ownerSessionId: memberId })
        expect(attempt).toMatchObject({ phase: 'running', assignmentPhase: 'delivered', memberSessionId: memberId })
        frozen = { taskId: task.id, revision: task.revision, attemptId: attempt!.id, generation: attempt!.generation, memberId }
      }, { timeout: 15_000 })
      await vi.waitFor(async () => {
        const stored = await first!.ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        expect(userTexts(stored.events).filter(text => text.includes('Team assignment from captain.'))).toHaveLength(1)
      }, { timeout: 15_000 })

      // Make the active descriptor cold before queuing quiet mail. This is the
      // persisted post-restart shape, without pretending an in-process drain
      // is a process crash.
      const resident = first.ctx.agents.get(SessionId(memberId))
      if (resident !== undefined) first.ctx.subagents.interrupt(SessionId(memberId), { kind: 'ancestor', agent: leadA })
      await first.ctx.subagents.drainContinuableChildren(leadA, [SessionId(memberId)])
      await vi.waitFor(() => expect(first!.ctx.agents.get(SessionId(memberId))).toBeUndefined(), { timeout: 15_000 })
      const quiet = await tool(first.ctx, leadA, 'restart-quiet', 'agent_swarm_send_message', {
        target: 'worker', content: 'quiet checkpoint survives until a real wakeup.', delivery: 'quiet',
      })
      expect(quiet).toMatchObject({ isError: false, value: { phase: 'queued' } })
      const beforeRestart = await snapshot(first.ctx, leadA, teamId)
      expect(beforeRestart.team.messages.find(message => message.id === (quiet.value as { message_id: string }).message_id)).toMatchObject({ phase: 'queued', delivery: 'quiet' })

      // Every Context A fiber is gone before Context B opens the same durable
      // SQLite and Storage roots.
      await dispose(first)
      first = undefined

      // Context B: no copied runtime, no fresh Team state and no automatic
      // assignment replay. The root captain is resumed through the official
      // persistence seam, then the public recovery entry is driven twice.
      // Context B proves the cold owner remains inert even after an enabled
      // grace has elapsed and real recovery passes are driven.
      second = await mount(sandbox, 50)
      const recovered = new RecoveryAdapter(() => ({ taskId: frozen.taskId, revision: frozen.revision, attemptId: frozen.attemptId }))
      recovered.workerId = memberId
      second.ctx.llm.registerAdapter(['mock'], recovered)
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      const leadB = resumedCaptain.agent
      const rawFollowup = second.ctx.subagents.followup.bind(second.ctx.subagents)
      const follows: Array<{ target: string; text: string; wasCold: boolean }> = []
      const followup = vi.spyOn(second.ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        follows.push({
          target: String(childId),
          text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
          wasCold: second!.ctx.agents.get(childId) === undefined,
        })
        return await rawFollowup(parent, childId, content, options)
      })
      try {
        await second.ctx.agentSwarm.recoverAgent(leadB)
        await second.ctx.agentSwarm.recoverAgent(leadB)
        // Advance beyond the enabled stranded-owner grace and drive the same
        // public entry once more: a cold continuable member remains wakeup-
        // resumable, never an autonomous retry/reassignment candidate.
        await new Promise(resolve => setTimeout(resolve, 150))
        await second.ctx.agentSwarm.recoverAgent(leadB)
        const stillCold = await snapshot(second.ctx, leadB, teamId)
        const task = stillCold.team.tasks.find(candidate => candidate.id === frozen.taskId)!
        const attempt = stillCold.team.attempts.find(candidate => candidate.id === frozen.attemptId)!
        expect(task).toMatchObject({ status: 'in_progress', revision: frozen.revision, ownerSessionId: frozen.memberId, currentAttemptId: frozen.attemptId })
        expect(attempt).toMatchObject({ phase: 'running', assignmentPhase: 'delivered', generation: frozen.generation, memberSessionId: frozen.memberId })
        expect(second.ctx.agents.get(SessionId(memberId))).toBeUndefined()
        expect(recovered.memberRequests).toBe(0)
        expect(follows.filter(record => record.target === memberId)).toEqual([])
        expect(stillCold.team.messages.find(message => message.id === (quiet.value as { message_id: string }).message_id)).toMatchObject({ phase: 'queued', delivery: 'quiet' })

        // The one authorized recovery command is ordinary durable wakeup mail;
        // it resumes the exact cold descriptor and does not create/reassign an
        // attempt. Hold the recovered turn so the old quiet frame is folded
        // through the normal mailbox path while the target is live.
        const wake = await tool(second.ctx, leadB, 'restart-wake', 'agent_swarm_send_message', {
          target: 'worker', content: 'resume the exact current attempt after restart.', delivery: 'wakeup',
        })
        expect(wake.isError).toBe(false)
        await vi.waitFor(() => expect(recovered.wakeRequests).toBe(1), { timeout: 15_000 })
        const liveMember = second.ctx.agents.get(SessionId(memberId))
        if (liveMember === undefined) throw new Error('the explicit wakeup did not cold-resume the exact member')
        // The stale failure is exercised only through the exact Agent that
        // the Team wakeup created.  A separate `agents.resume()` call here
        // would invalidate the core proof by becoming an unaccounted recovery
        // path of its own.
        const beforeStale = await snapshot(second.ctx, leadB, teamId)
        const stale = await tool(second.ctx, liveMember, 'restart-stale', 'agent_swarm_submit_task', {
          task_id: frozen.taskId, expected_revision: frozen.revision, attempt_id: 'attempt-not-current', output: 'must not commit',
        })
        expect(stale).toMatchObject({ isError: true, error: { info: { code: 'TEAM_ATTEMPT_STALE' } } })
        expect(await snapshot(second.ctx, leadB, teamId)).toEqual(beforeStale)
        await second.ctx.agentSwarm.recoverAgent(leadB)
        await vi.waitFor(async () => {
          const current = await snapshot(second!.ctx, leadB, teamId)
          expect(current.team.messages.find(message => message.id === (quiet.value as { message_id: string }).message_id)).toMatchObject({ phase: 'delivered' })
        }, { timeout: 15_000 })
        expect(follows.filter(record => record.target === memberId && record.text.includes('resume the exact current attempt'))).toEqual([
          expect.objectContaining({ wasCold: true }),
        ])
        expect(follows.filter(record => record.target === memberId && record.text.includes('Team assignment from captain.'))).toEqual([])

        recovered.releaseSubmission()
        await vi.waitFor(async () => {
          const current = await snapshot(second!.ctx, leadB, teamId)
          expect(current.team.tasks.find(candidate => candidate.id === frozen.taskId)).toMatchObject({ status: 'submitted', revision: frozen.revision + 1, currentAttemptId: frozen.attemptId })
          expect(current.team.attempts.find(candidate => candidate.id === frozen.attemptId)).toMatchObject({ phase: 'submitted', generation: frozen.generation })
        }, { timeout: 15_000 })
        const submitted = (await snapshot(second.ctx, leadB, teamId)).team.tasks.find(candidate => candidate.id === frozen.taskId)!
        const review = await tool(second.ctx, leadB, 'restart-review', 'agent_swarm_review_task', {
          task_id: frozen.taskId, expected_revision: submitted.revision, attempt_id: frozen.attemptId, decision: 'accept',
        })
        expect(review).toMatchObject({ isError: false, value: { status: 'completed', decision: 'accept' } })
        const final = await snapshot(second.ctx, leadB, teamId)
        expect(final.team.tasks.find(candidate => candidate.id === frozen.taskId)).toMatchObject({ status: 'completed', currentAttemptId: frozen.attemptId })
        expect(final.team.attempts).toEqual([expect.objectContaining({ id: frozen.attemptId, generation: frozen.generation, phase: 'accepted' })])
        const persisted = await second.ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
        const texts = userTexts(persisted.events)
        expect(texts.filter(text => text.includes('Team assignment from captain.'))).toHaveLength(1)
        expect(texts.filter(text => text.includes('resume the exact current attempt after restart.'))).toHaveLength(1)
        expect(texts.filter(text => text.includes('quiet checkpoint survives until a real wakeup.'))).toHaveLength(1)
        expect(recovered.wakeRequests).toBe(1)
      } finally {
        followup.mockRestore()
        await resumedCaptain.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  }, 60_000)

  it('lists bounded Team memories from the single durable aggregate after a full SQLite and Storage reopen', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-memory-list-reload-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      first = await mount(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new InitialAdapter())
      const leadA = first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'memory-create', 'agent_swarm_create', {
        name: 'Memory list reload', description: 'Prove bounded durable Team-memory reads.',
      })
      expect(created.isError).toBe(false)
      const teamId = (created.value as { team_id: string }).team_id
      const added = await tool(first.ctx, leadA, 'memory-member', 'agent_swarm_add_member', {
        name: 'reader', role: 'Read the Team memory ledger.',
      })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      await vi.waitFor(async () => {
        expect((await snapshot(first!.ctx, leadA, teamId)).team.members).toContainEqual(expect.objectContaining({ sessionId: memberId, phase: 'active' }))
      }, { timeout: 15_000 })
      const resident = first.ctx.agents.get(SessionId(memberId))
      const resumedMember = resident === undefined ? await first.ctx.agents.resume({ resumeSessionId: SessionId(memberId) }) : undefined
      const member = resident ?? resumedMember?.agent
      if (member === undefined) throw new Error('member was not resumable for Team-memory read proof')
      try {
        expect(await tool(first.ctx, member, 'memory-add-member', 'agent_swarm_add_memory', {
          category: 'lesson', content: 'Use durable evidence.', evidence_refs: Array.from({ length: 33 }, (_value, index) => `attempt-${index + 1}`),
        })).toMatchObject({ isError: false })
        expect(await tool(first.ctx, leadA, 'memory-add-captain', 'agent_swarm_add_memory', {
          category: 'decision', content: 'Review before release.', evidence_refs: ['review-1'],
        })).toMatchObject({ isError: false })
        expect(await tool(first.ctx, leadA, 'memory-add-context', 'agent_swarm_add_memory', {
          category: 'context', content: 'Canvas handoff context.', evidence_refs: [],
        })).toMatchObject({ isError: false })

        const beforeRead = await snapshot(first.ctx, leadA, teamId)
        const memberRead = await tool(first.ctx, member, 'memory-member-read', 'agent_swarm_list_memory', {})
        expect(memberRead).toMatchObject({ isError: false })
        expect((memberRead.value as { memories: Array<{ memory_id: string }> }).memories.map(row => row.memory_id))
          .toEqual(['memory-1', 'memory-2', 'memory-3'])
        const page = await tool(first.ctx, leadA, 'memory-page', 'agent_swarm_list_memory', { limit: 2 })
        expect(page).toMatchObject({ isError: false, value: { next_cursor: 2 } })
        expect((page.value as { memories: Array<{ category: string; content: string; evidence_refs: string[]; evidence_refs_truncated: boolean; created_at: number }> }).memories)
          .toEqual([
            expect.objectContaining({
              category: 'lesson', content: 'Use durable evidence.',
              evidence_refs: Array.from({ length: 32 }, (_value, index) => `attempt-${index + 1}`), evidence_refs_truncated: true,
            }),
            expect.objectContaining({ category: 'decision', content: 'Review before release.', evidence_refs: ['review-1'], evidence_refs_truncated: false }),
          ])
        const page2 = await tool(first.ctx, leadA, 'memory-page-2', 'agent_swarm_list_memory', { cursor: 2, limit: 2 })
        expect(page2).toMatchObject({ isError: false })
        expect([
          ...(page.value as { memories: Array<{ memory_id: string }> }).memories,
          ...(page2.value as { memories: Array<{ memory_id: string }> }).memories,
        ].map(row => row.memory_id)).toEqual(['memory-1', 'memory-2', 'memory-3'])
        const filtered = await tool(first.ctx, leadA, 'memory-filter', 'agent_swarm_list_memory', { category: 'decision', query: 'REVIEW' })
        expect(filtered).toMatchObject({ isError: false, value: { memories: [expect.objectContaining({ memory_id: 'memory-2' })] } })
        for (const args of [{ cursor: -1 }, { limit: 0 }, { limit: 101 }, { query: '   ' }, { query: 'x'.repeat(1_025) }]) {
          expect(await tool(first.ctx, leadA, `memory-invalid-${JSON.stringify(args)}`, 'agent_swarm_list_memory', args))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
        }
        const outsider = first.ctx.agentLoop.create(SessionId('memory-outsider'), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
        expect(await tool(first.ctx, outsider, 'memory-outsider', 'agent_swarm_list_memory', {}))
          .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
        expect(await snapshot(first.ctx, leadA, teamId)).toEqual(beforeRead)
      } finally {
        await resumedMember?.dispose()
      }

      await dispose(first)
      first = undefined
      second = await mount(sandbox, 0)
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      try {
        const reloaded = await tool(second.ctx, resumedCaptain.agent, 'memory-reload', 'agent_swarm_list_memory', { cursor: 2, limit: 2 })
        expect(reloaded).toMatchObject({
          isError: false,
          value: { memories: [expect.objectContaining({ memory_id: 'memory-3', category: 'context', content: 'Canvas handoff context.', evidence_refs: [] })] },
        })
        expect((await snapshot(second.ctx, resumedCaptain.agent, teamId)).team.memory).toHaveLength(3)
        expect(await tool(second.ctx, resumedCaptain.agent, 'memory-archive', 'agent_swarm_archive', {
          reason: 'Close the read-authority proof.',
        })).toMatchObject({ isError: false })
        expect(await tool(second.ctx, resumedCaptain.agent, 'memory-archived-captain', 'agent_swarm_list_memory', {}))
          .toMatchObject({ isError: false, value: { memories: expect.any(Array) } })
        const resumedReader = await second.ctx.agents.resume({ resumeSessionId: SessionId(memberId) })
        try {
          expect(await tool(second.ctx, resumedReader.agent, 'memory-archived-member', 'agent_swarm_list_memory', {}))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
        } finally {
          await resumedReader.dispose()
        }
      } finally {
        await resumedCaptain.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  }, 60_000)

  it('reads durable member profiles after a full reopen without resuming children, and isolates a missing descriptor row', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-member-profiles-reload-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      first = await mount(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new InitialAdapter())
      const leadA = first.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
      const created = await tool(first.ctx, leadA, 'profiles-create', 'agent_swarm_create', {
        name: 'Member profiles', description: 'Read durable child composition without a live child.',
      })
      expect(created).toMatchObject({ isError: false })
      const teamId = (created.value as { team_id: string }).team_id
      const healthy = await tool(first.ctx, leadA, 'profiles-add-healthy', 'agent_swarm_add_member', {
        name: 'profile-reader', role: 'Read durable member composition.', model: 'profile-model', deny_tools: ['agent_swarm_list_jobs'],
      })
      const damaged = await tool(first.ctx, leadA, 'profiles-add-damaged', 'agent_swarm_add_member', {
        name: 'profile-damaged', role: 'Exercise a missing descriptor row.',
      })
      if (healthy.isError) throw new Error(`profiles-add-healthy failed: ${JSON.stringify(healthy.error)}`)
      if (damaged.isError) throw new Error(`profiles-add-damaged failed: ${JSON.stringify(damaged.error)}`)
      const healthyId = (healthy.value as { session_id: string }).session_id
      const damagedId = (damaged.value as { session_id: string }).session_id
      await vi.waitFor(async () => {
        const members = (await snapshot(first!.ctx, leadA, teamId)).team.members
        expect(members).toContainEqual(expect.objectContaining({ sessionId: healthyId, phase: 'active' }))
        expect(members).toContainEqual(expect.objectContaining({ sessionId: damagedId, phase: 'active' }))
      }, { timeout: 15_000 })

      await dispose(first)
      first = undefined
      // Fault only the durable child descriptor evidence, after Context A
      // closed every real SQLite handle. Reclassifying it as an ignorable
      // foreign event preserves the official contiguous-log contract while
      // making `foldSubagentDescriptor()` honestly find no descriptor. The
      // Team aggregate and all other child history remain untouched.
      const database = new DatabaseSync(join(sandbox, 'sessions', 'sessions.db'))
      try {
        const replaced = database.prepare("UPDATE events SET type = 'member-profile-test/removed-descriptor', ignorable = 1 WHERE session_id = ? AND type = 'subagent/descriptor'").run(damagedId)
        expect(Number(replaced.changes)).toBe(1)
      } finally {
        database.close()
      }

      second = await mount(sandbox, 0)
      const coldOnly = new InitialAdapter()
      coldOnly.workerId = healthyId
      second.ctx.llm.registerAdapter(['mock'], coldOnly)
      const resumedCaptain = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      try {
        expect(second.ctx.agents.get(SessionId(healthyId))).toBeUndefined()
        expect(second.ctx.agents.get(SessionId(damagedId))).toBeUndefined()
        const before = await snapshot(second.ctx, resumedCaptain.agent, teamId)
        const listed = await tool(second.ctx, resumedCaptain.agent, 'profiles-list', 'agent_swarm_list_members', {})
        expect(listed).toMatchObject({ isError: false })
        const value = listed.value as { members: Array<Record<string, unknown>>; next_cursor?: number }
        expect(value.next_cursor).toBeUndefined()
        expect(value.members.map(member => member.name)).toEqual(['profile-reader', 'profile-damaged'])
        expect(value.members[0]).toMatchObject({
          name: 'profile-reader', role: 'Read durable member composition.', phase: 'active',
          profile_state: 'available', profile_reason: 'available', runtime_provider: 'spawn',
          llm_provider: 'mock', model: 'profile-model', persona_configured: true,
          denied_tools: [...MEMBER_HIDDEN_TOOLS, 'agent_swarm_list_jobs'],
        })
        expect(value.members[0]).not.toHaveProperty('preset_id')
        expect(value.members[0]).not.toHaveProperty('session_id')
        expect(value.members[1]).toMatchObject({
          name: 'profile-damaged', phase: 'active', runtime_provider: 'spawn',
          profile_state: 'invalid', profile_reason: 'not_continuable',
        })
        expect(value.members[1]).not.toHaveProperty('llm_provider')
        expect(value.members[1]).not.toHaveProperty('persona_configured')
        expect(coldOnly.workerRequests).toBe(0)
        expect(second.ctx.agents.get(SessionId(healthyId))).toBeUndefined()
        expect(second.ctx.agents.get(SessionId(damagedId))).toBeUndefined()
        expect(await snapshot(second.ctx, resumedCaptain.agent, teamId)).toEqual(before)

        const active = await tool(second.ctx, resumedCaptain.agent, 'profiles-active-page', 'agent_swarm_list_members', {
          phase: 'active', limit: 1,
        })
        expect(active).toMatchObject({ isError: false, value: { next_cursor: 1 } })
        expect((active.value as { members: Array<{ name: string }> }).members.map(member => member.name)).toEqual(['profile-reader'])
        for (const args of [{ cursor: -1 }, { limit: 0 }, { limit: 51 }]) {
          expect(await tool(second.ctx, resumedCaptain.agent, `profiles-invalid-${JSON.stringify(args)}`, 'agent_swarm_list_members', args))
            .toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
        }
        const outsider = second.ctx.agentLoop.create(SessionId('profiles-outsider'), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
        expect(await tool(second.ctx, outsider, 'profiles-outsider', 'agent_swarm_list_members', {}))
          .toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
        expect(await snapshot(second.ctx, resumedCaptain.agent, teamId)).toEqual(before)
      } finally {
        await resumedCaptain.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  }, 60_000)

  it('keeps missing-session taxonomy and caller cancellation explicit without inventing a profile', async () => {
    const missing = new Error('session "member-profile-session" not found')
    const reader = new MemberProfileReader({
      sessionPersistence: { inspect: vi.fn(async () => { throw missing }) },
    } as unknown as Context)
    const team = { id: 'member-profile-team', captainSessionId: 'member-profile-captain' } as TeamState
    const member = (phase: TeamMember['phase']) => ({
      name: 'profile-member', role: 'Profile fixture', phase, createdAt: 1,
      sessionId: 'member-profile-session', provider: 'spawn',
    }) as TeamMember
    await expect(reader.list(team, [member('provisioning')], SIGNAL)).resolves.toMatchObject([
      { profileState: 'pending', profileReason: 'provisioning', runtimeProvider: 'spawn' },
    ])
    await expect(reader.list(team, [member('failed')], SIGNAL)).resolves.toMatchObject([
      { profileState: 'unavailable', profileReason: 'inspection_failed', runtimeProvider: 'spawn' },
    ])
    await expect(reader.list(team, [member('removed')], SIGNAL)).resolves.toMatchObject([
      { profileState: 'unavailable', profileReason: 'inspection_failed', runtimeProvider: 'spawn' },
    ])
    await expect(reader.list(team, [member('active')], SIGNAL)).resolves.toMatchObject([
      { profileState: 'invalid', profileReason: 'active_session_missing', runtimeProvider: 'spawn' },
    ])
    const aborted = new AbortController()
    aborted.abort()
    await expect(reader.list(team, [member('active')], aborted.signal))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_PROFILE_ABORTED' })
  })
})
