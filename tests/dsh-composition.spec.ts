import { readdir } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const SIGNAL = new AbortController().signal

function textResponse(
  text: string,
  cache: Pick<TokenUsage, 'cacheReadTokens' | 'cacheWriteTokens'> = {},
): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length, ...cache } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  billedTokens = 0
  cacheTokens = 0

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift() ?? textResponse('Acknowledged.')
    for (const chunk of response) {
      if (chunk.type === 'usage') {
        this.cacheTokens += (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
        this.billedTokens += chunk.usage.inputTokens
          + chunk.usage.outputTokens
          + (chunk.usage.cacheReadTokens ?? 0)
          + (chunk.usage.cacheWriteTokens ?? 0)
      }
      yield chunk
    }
  }
}

async function successfulTool(
  ctx: Context,
  agent: Agent,
  callId: string,
  name: string,
  args: unknown,
) {
  const result = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(callId),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  }
  return result.value
}

describe('DSH rc.8 composition', () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('mounts tools, starts a continuable member, schedules work, and drains on unload', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-composition-'))
    roots.push(sandbox)
    const workspace = join(sandbox, 'workspace')
    const sessionRoot = join(sandbox, 'sessions')
    const ctx = new Context()
    const fibers: Fiber[] = []

    try {
      await mountAgentLoopTestDependencies(ctx)
      fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot }))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      const pluginFiber = await ctx.plugin(AgentSwarm, {
        stateDir: '.team-test',
        memberProvider: 'spawn',
        memberMaxDepth: 1,
        schedulerProvider: 'test-scheduler',
        reviewProvider: 'test-review',
      })
      fibers.push(pluginFiber)
      expect(ctx.agentSwarm).toBeDefined()
      let schedulerCalls = 0
      let reviewCalls = 0
      const schedulerProvider = {
        select: ({ availableMembers, readyTasks }) => {
          schedulerCalls += 1
          const member = availableMembers[0]
          const task = readyTasks[0]
          return member === undefined || task === undefined
            ? []
            : [{ memberSessionId: member.sessionId, taskId: task.id }]
        },
      } satisfies AgentSwarm.TeamSchedulerProvider
      const unregisterScheduler = ctx.agentSwarm.registerSchedulerProvider('test-scheduler', schedulerProvider)
      const reviewProvider = {
        review: input => {
          reviewCalls += 1
          return { decision: input.requestedDecision, diagnostic: 'composition provider accepted' }
        },
      } satisfies AgentSwarm.TeamReviewProvider
      const unregisterReview = ctx.agentSwarm.registerReviewProvider('test-review', reviewProvider)

      const adapter = new ScriptedAdapter([
        textResponse('Member ready.', { cacheReadTokens: 100, cacheWriteTokens: 50 }),
        textResponse('Assignment received.'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      const lead = ctx.agentLoop.create(
        SessionId('composition-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: workspace },
      )

      const created = await successfulTool(ctx, lead, 'create', 'agent_swarm_create', {
        name: 'Composition team',
        description: 'Prove the plugin runs inside the real DSH rc.8 service graph.',
      }) as { team_id: string }
      expect(created.team_id).toMatch(/^team-/)

      const added = await successfulTool(ctx, lead, 'add', 'agent_swarm_add_member', {
        name: 'runtime-worker',
        role: 'Validate runtime composition',
      }) as { session_id: string; phase: string }
      expect(added.phase).toBe('active')

      let memberAgent: Agent | undefined
      await vi.waitFor(() => {
        memberAgent = ctx.agents.get(SessionId(added.session_id))
        expect(memberAgent?.status).toBe('idle')
      }, { timeout: 5_000 })
      if (memberAgent === undefined) throw new Error('member Agent disappeared before the idle checkpoint')

      await successfulTool(ctx, lead, 'task', 'agent_swarm_create_task', {
        subject: 'Composition proof',
        description: 'Receive this assignment through continuable subagent followup.',
        acceptance_criteria: ['The member receives one followup request.'],
      })

      await vi.waitFor(async () => {
        const status = await successfulTool(
          ctx, lead, `status-${Date.now()}`, 'agent_swarm_status', {},
        ) as { members: number; tasks: number; task_summary: string; used_tokens: number }
        expect(status.members).toBe(1)
        expect(status.tasks).toBe(1)
        expect(status.task_summary).toMatch(/in_progress .*attempt=/)
        expect(status.used_tokens).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
      expect(adapter.requests.length).toBeLessThan(10)
      expect(JSON.stringify(adapter.requests)).toContain('Composition proof')
      expect(schedulerCalls).toBeGreaterThan(0)

      const beforeReview = await ctx.agentSwarm.domain.snapshot(
        ctx.agentSwarm.stateRoot(lead), AgentSwarm.TeamId(created.team_id), lead.id,
      )
      const assignedTask = beforeReview.team.tasks[0]!
      const assignedAttempt = beforeReview.team.attempts.find(attempt => attempt.id === assignedTask.currentAttemptId)!
      expect(adapter.cacheTokens).toBe(150)
      expect(beforeReview.team.budget.usedTokens).toBe(adapter.billedTokens)
      const staleResult = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('stale-submit'),
        name: 'agent_swarm_submit_task',
        arguments: {
          task_id: assignedTask.id,
          expected_revision: assignedTask.revision,
          attempt_id: 'attempt-invalid',
          output: 'This stale submission must not commit.',
        },
        agent: memberAgent,
      })
      expect(staleResult).toMatchObject({
        isError: true,
        error: { info: { name: 'TeamDomainError', code: 'TEAM_ATTEMPT_STALE' } },
      })
      const submitted = await ctx.agentSwarm.domain.submitTask(
        ctx.agentSwarm.stateRoot(lead),
        beforeReview.team.id,
        added.session_id,
        assignedTask.id,
        assignedTask.revision,
        assignedAttempt.id,
        'Composition evidence.',
      )
      const reviewed = await successfulTool(ctx, lead, 'review', 'agent_swarm_review_task', {
        task_id: submitted.id,
        expected_revision: submitted.revision,
        attempt_id: assignedAttempt.id,
        decision: 'accept',
      }) as { status: string; decision: string }
      expect(reviewed).toMatchObject({ status: 'completed', decision: 'accept' })
      expect(reviewCalls).toBe(1)

      unregisterScheduler()
      const missingScheduler = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('missing-scheduler'),
        name: 'agent_swarm_create_task',
        arguments: { subject: 'must not persist', description: 'Missing scheduler must fail before commit.' },
        agent: lead,
      })
      expect(missingScheduler).toMatchObject({
        isError: true,
        error: { info: { code: 'TEAM_SCHEDULER_PROVIDER_MISSING' } },
      })
      const restoreScheduler = ctx.agentSwarm.registerSchedulerProvider('test-scheduler', schedulerProvider)
      unregisterReview()
      const missingReview = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('missing-review'),
        name: 'agent_swarm_create_task',
        arguments: { subject: 'must also not persist', description: 'Missing review must fail before commit.' },
        agent: lead,
      })
      expect(missingReview).toMatchObject({
        isError: true,
        error: { info: { code: 'TEAM_REVIEW_PROVIDER_MISSING' } },
      })
      const restoreReview = ctx.agentSwarm.registerReviewProvider('test-review', reviewProvider)
      const afterProviderFailures = await ctx.agentSwarm.domain.snapshot(
        ctx.agentSwarm.stateRoot(lead), AgentSwarm.TeamId(created.team_id), lead.id,
      )
      expect(afterProviderFailures.team.tasks).toHaveLength(1)
      restoreScheduler()
      restoreReview()

      const stateFiles = await readdir(join(workspace, '.team-test'), { recursive: true })
      expect(stateFiles.some(name => name.endsWith('.json'))).toBe(true)

      const firstRuntime = ctx.agentSwarm
      await pluginFiber.dispose()
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(added.session_id))).toBeUndefined()
      }, { timeout: 5_000 })
      await firstRuntime.domain.queueMessage(
        firstRuntime.stateRoot(lead),
        AgentSwarm.TeamId(created.team_id),
        lead.id,
        'runtime-worker',
        'Recover this queued message after reload.',
        'wakeup',
      )

      const reloadedFiber = await ctx.plugin(AgentSwarm, {
        stateDir: '.team-test',
        memberProvider: 'spawn',
        memberMaxDepth: 1,
      })
      fibers.push(reloadedFiber)
      await vi.waitFor(async () => {
        const reloaded = await successfulTool(ctx, lead, `reload-status-${Date.now()}`, 'agent_swarm_status', {}) as {
          members: number
          tasks: number
          queued_messages: number
        }
        expect(reloaded).toMatchObject({ members: 1, tasks: 1, queued_messages: 0 })
        expect(JSON.stringify(adapter.requests)).toContain('Recover this queued message after reload.')
      }, { timeout: 5_000 })
      await reloadedFiber.dispose()
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(added.session_id))).toBeUndefined()
      }, { timeout: 5_000 })

      const afterUnload = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('after-unload'),
        name: 'agent_swarm_status',
        arguments: {},
        agent: lead,
      })
      expect(afterUnload).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 15_000)

  it('retains ownership of a started child when activation commit and immediate drain fail', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-member-failure-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []

    try {
      await mountAgentLoopTestDependencies(ctx)
      fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions') }))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      fibers.push(await ctx.plugin(SubagentService))
      fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
      const pluginFiber = await ctx.plugin(AgentSwarm, {
        stateDir: '.team-test',
        memberProvider: 'spawn',
        memberMaxDepth: 1,
      })
      fibers.push(pluginFiber)

      ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('Started before commit failure.')]))
      const lead = ctx.agentLoop.create(
        SessionId('failure-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )
      const created = await successfulTool(ctx, lead, 'failure-create', 'agent_swarm_create', {
        name: 'Failure recovery team',
        description: 'Prove a started child remains owned after two cleanup failures.',
      }) as { team_id: string }

      const settle = vi.spyOn(ctx.agentSwarm.domain, 'settleMember')
      settle.mockRejectedValueOnce(new Error('simulated activation commit failure'))
      const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
      drain.mockRejectedValueOnce(new Error('simulated immediate drain failure'))

      const failedAdd = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('failure-add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'fragile-worker', role: 'Exercise cleanup ownership.' },
        agent: lead,
      })
      expect(failedAdd).toMatchObject({ isError: true, error: { message: 'simulated activation commit failure' } })

      const snapshot = await ctx.agentSwarm.domain.snapshot(
        ctx.agentSwarm.stateRoot(lead), AgentSwarm.TeamId(created.team_id), lead.id,
      )
      const failedMember = snapshot.team.members[0]!
      expect(failedMember.phase).toBe('failed')
      expect(drain).toHaveBeenCalledTimes(1)

      await pluginFiber.dispose()
      expect(drain.mock.calls.length).toBeGreaterThanOrEqual(2)
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(failedMember.sessionId))).toBeUndefined()
      }, { timeout: 5_000 })
      settle.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 15_000)
})
