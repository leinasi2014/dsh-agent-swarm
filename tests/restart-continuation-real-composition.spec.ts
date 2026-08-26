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
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const SIGNAL = new AbortController().signal
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

interface Mounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
}

async function mount(sandbox: string, strandedAfterMs: number): Promise<Mounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  // Mount every official prerequisite locally rather than using the testkit
  // helper: it returns void, whereas a process-restart proof must own and
  // reverse-dispose every Context fiber before reopening durable media.
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  // These three official Storage fibers must belong to this mounted Context's
  // disposal set. `mountStorageStackOn()` intentionally returns void for
  // shared fixtures, which would leave this restart boundary half-open.
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs }))
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
})
