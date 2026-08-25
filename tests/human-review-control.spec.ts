/**
 * SW-I1a human review/control over the durable interaction overlay.
 *
 * Real composition mounts the plugin, which now opens the ONE
 * `agent_swarm_human` overlay domain and assembles both `CaptainLiaison`
 * (`ctx.agentSwarmHumanInteraction`) and `HumanControlGateway`
 * (`ctx.agentSwarmHumanControl`). Scenarios 42/43 use the same durable
 * request/receipt store, and the required concurrency, cancel,
 * reload-durability and ambiguous-HumanReview cases are machine-proven.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
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
import UserQuestionService, { type UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { HumanInteractionRequest } from '../src/index.js'
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

interface Stack {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: AgentSwarm.TeamId
  readonly scope: string
  pluginFiber: Fiber
}

async function mount(sandbox: string, reviewProvider = 'manual'): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  if (reviewProvider === 'human') fibers.push(await ctx.plugin(UserQuestionService))
  const pluginFiber = await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, reviewProvider })
  fibers.push(pluginFiber)
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  const lead = ctx.agentLoop.create(
    SessionId(`i1a-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('i1a-create'),
    name: 'agent_swarm_create',
    arguments: { name: 'I1a review team', description: 'Prove SW-I1a review/control boundaries on the durable overlay.' },
    agent: lead,
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  return {
    ctx,
    fibers,
    lead,
    teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id),
    scope: ctx.agentSwarm.scopeOf(lead),
    pluginFiber,
  }
}

async function addMember(stack: Stack): Promise<string> {
  const added = await stack.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('i1a-add'),
    name: 'agent_swarm_add_member',
    arguments: { name: 'worker', role: 'SW-I1a human-control worker.' },
    agent: stack.lead,
  })
  if (added.isError) throw new Error(`add failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

async function snapshot(stack: Stack) {
  return await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
}

function newRequestId(): string {
  return `human-${Math.random().toString(36).slice(2, 14)}`
}

function request(stack: Stack, overrides: Partial<HumanInteractionRequest>): HumanInteractionRequest {
  return {
    schemaVersion: 1,
    requestId: newRequestId(),
    teamId: stack.teamId,
    source: { kind: 'captain-mediated', captainSessionId: stack.lead.id },
    target: { kind: 'member', memberName: 'worker' },
    intent: 'wake-member',
    expectedTeamRevision: 1,
    createdAt: Date.now(),
    ...overrides,
  }
}

function submit(stack: Stack, control: HumanInteractionRequest) {
  const admission: AgentSwarm.HumanControlAdmission = control.source.kind === 'authenticated-human'
    ? { kind: 'authenticated-human', principalRef: control.source.principalRef ?? '' }
    : { kind: 'captain', exec: { agent: stack.lead, signal: SIGNAL } }
  return stack.ctx.agentSwarmHumanControl.submit(stack.scope, control, admission, new AbortController().signal)
}

function captainAdmission(stack: Stack) {
  return { kind: 'captain' as const, exec: { agent: stack.lead, signal: SIGNAL } }
}

async function submitError(stack: Stack, control: HumanInteractionRequest): Promise<{ code: string; message: string }> {
  try {
    await submit(stack, control)
    throw new Error('expected Human Control rejection')
  } catch (error) {
    if (error instanceof Error && error.message === 'expected Human Control rejection') throw error
    return { code: (error as { code?: string }).code ?? 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
  }
}

async function createClaimedForMember(stack: Stack, memberSessionId: string) {
  const created = await stack.ctx.agentSwarm.domain.createTask(
    stack.scope,
    stack.teamId,
    stack.lead.id,
    { subject: 'i1a-task', description: 'SW-I1a fenced work.' },
  )
  const claimed = await stack.ctx.agentSwarm.domain.claimTask(
    stack.scope,
    stack.teamId,
    stack.lead.id,
    created.id,
    created.revision,
    memberSessionId,
  )
  const after = await snapshot(stack)
  return {
    task: after.team.tasks.find(task => task.id === created.id)!,
    claim: claimed,
    attemptId: claimed.attempt.id,
    teamRevisionAfterClaim: after.team.revision,
  }
}

const roots: string[] = []
const stacks: Stack[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) {
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('HumanReviewProvider over official ctx.userQuestions', () => {
  it('accepts through the official question seam and completes the canonical task', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-human-review-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, 'human')
    stacks.push(stack)
    const provider: UserQuestionProvider = {
      async ask(input) {
        return { answers: [{ id: input.questions[0]?.id ?? 'q', selected: ['Accept'] }] }
      },
    }
    stack.ctx.userQuestions.registerProvider(provider)
    const task = await stack.ctx.agentSwarm.domain.createTask(
      stack.scope, stack.teamId, stack.lead.id, { subject: 'review me', description: 'Human review must accept.' },
    )
    const claim = await stack.ctx.agentSwarm.domain.claimTask(
      stack.scope, stack.teamId, stack.lead.id, task.id, task.revision, stack.lead.id,
    )
    await stack.ctx.agentSwarm.domain.acknowledgeAssignment(stack.scope, stack.teamId, task.id, claim.attempt.id)
    const submitted = await stack.ctx.agentSwarm.domain.submitTask(
      stack.scope, stack.teamId, stack.lead.id, task.id, claim.task.revision, claim.attempt.id, 'evidence',
    )
    const reviewed = await stack.ctx.agentSwarm.reviewTask(
      { agent: stack.lead, signal: SIGNAL },
      { taskId: task.id, expectedRevision: submitted.revision, attemptId: claim.attempt.id, decision: 'accept' },
    )
    expect(reviewed.task.status).toBe('completed')
  }, 30_000)

  it('fails closed on ambiguous or unknown HumanReview answers', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-human-review-ambiguous-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, 'human')
    stacks.push(stack)
    let selected: string[] = ['Accept', 'Reject']
    stack.ctx.userQuestions.registerProvider({
      async ask(input) {
        return { answers: [{ id: input.questions[0]?.id ?? 'q', selected }] }
      },
    })
    const task = await stack.ctx.agentSwarm.domain.createTask(
      stack.scope, stack.teamId, stack.lead.id, { subject: 'ambiguous', description: 'Must fail closed.' },
    )
    const claim = await stack.ctx.agentSwarm.domain.claimTask(
      stack.scope, stack.teamId, stack.lead.id, task.id, task.revision, stack.lead.id,
    )
    await stack.ctx.agentSwarm.domain.acknowledgeAssignment(stack.scope, stack.teamId, task.id, claim.attempt.id)
    const submitted = await stack.ctx.agentSwarm.domain.submitTask(
      stack.scope, stack.teamId, stack.lead.id, task.id, claim.task.revision, claim.attempt.id, 'evidence',
    )

    await expect(stack.ctx.agentSwarm.reviewTask(
      { agent: stack.lead, signal: SIGNAL },
      { taskId: task.id, expectedRevision: submitted.revision, attemptId: claim.attempt.id, decision: 'accept' },
    )).rejects.toMatchObject({ code: 'TEAM_HUMAN_REVIEW_INVALID_ANSWER' })

    selected = ['Maybe']
    await expect(stack.ctx.agentSwarm.reviewTask(
      { agent: stack.lead, signal: SIGNAL },
      { taskId: task.id, expectedRevision: submitted.revision, attemptId: claim.attempt.id, decision: 'accept' },
    )).rejects.toMatchObject({ code: 'TEAM_HUMAN_REVIEW_INVALID_ANSWER' })
    expect((await snapshot(stack)).team.tasks.find(item => item.id === task.id)!.status).toBe('submitted')
  }, 30_000)
})

describe('scenario 42: durable duplicate/late/expired/cancelled controls', () => {
  it('scenario 42: idempotency and late/expired/cancelled rejections never mutate or revive a newer attempt', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-scenario42-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { task: claimed, attemptId: firstAttemptId, teamRevisionAfterClaim } = await createClaimedForMember(stack, member)

    const wakeRequest = request(stack, {
      requestId: 'human-scenario42-wake-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    const wake = await submit(stack, wakeRequest)
    expect(wake.status).toBe('executed')
    const afterWake = await snapshot(stack)
    const messageCount = afterWake.team.messages.filter(message => message.phase === 'queued').length

    await expect(submit(stack, wakeRequest)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_REQUEST_CONFLICT' })
    expect((await snapshot(stack)).team.messages.filter(message => message.phase === 'queued')).toHaveLength(messageCount)

    const expired = request(stack, {
      requestId: 'human-scenario42-expired-00000002',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1,
    })
    await expect(submit(stack, expired)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_EXPIRED' })
    expect((await snapshot(stack)).team.messages.filter(message => message.phase === 'queued')).toHaveLength(messageCount)

    const cancelledRequest = request(stack, {
      requestId: 'human-scenario42-cancelled-00000003',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    await stack.ctx.agentSwarmHumanControl.cancel(stack.scope, cancelledRequest, captainAdmission(stack))
    await expect(submit(stack, cancelledRequest)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_CANCELLED' })
    expect((await snapshot(stack)).team.messages.filter(message => message.phase === 'queued')).toHaveLength(messageCount)

    const reassign = request(stack, {
      requestId: 'human-scenario42-reassign-00000004',
      intent: 'reassign-task',
      target: { kind: 'task', taskId: claimed.id },
      expectedTaskRevision: claimed.revision,
      attemptId: firstAttemptId,
      expectedTeamRevision: (await snapshot(stack)).team.revision,
      diagnostic: 'Human reassign for late probe.',
    })
    await submit(stack, reassign)
    let current = (await snapshot(stack)).team.tasks.find(task => task.id === claimed.id)!
    for (let attempt = 0; attempt < 5 && current.status === 'pending'; attempt += 1) {
      try {
        await stack.ctx.agentSwarm.domain.claimTask(
          stack.scope, stack.teamId, stack.lead.id, claimed.id, current.revision, member,
        )
        current = (await snapshot(stack)).team.tasks.find(task => task.id === claimed.id)!
        break
      } catch {
        current = (await snapshot(stack)).team.tasks.find(task => task.id === claimed.id)!
      }
    }
    expect(current.status).toBe('in_progress')
    const late = request(stack, {
      requestId: 'human-scenario42-late-00000005',
      intent: 'correct-task',
      target: { kind: 'task', taskId: claimed.id },
      expectedTaskRevision: current.revision,
      attemptId: firstAttemptId,
      expectedTeamRevision: (await snapshot(stack)).team.revision,
      body: 'This late correction must not reach the newer attempt.',
    })
    await expect(submit(stack, late)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_LATE' })
    const finalTask = (await snapshot(stack)).team.tasks.find(task => task.id === claimed.id)!
    expect(finalTask.currentAttemptId).toBe(current.currentAttemptId)
    // scenario-evidence: 42
    expect(finalTask.revision).toBe(current.revision)
  }, 45_000)
})

describe('scenario 43: stale fences reject before partial transition', () => {
  it('scenario 43: stale Team/task revision and attempt fencing reject with no partial state change', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-scenario43-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { task: claimed, attemptId: firstAttemptId, teamRevisionAfterClaim } = await createClaimedForMember(stack, member)
    const before = await snapshot(stack)

    const staleTeam = request(stack, {
      requestId: 'human-scenario43-team-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim - 1,
    })
    await expect(submit(stack, staleTeam)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_STALE_REVISION' })

    const staleTask = request(stack, {
      requestId: 'human-scenario43-task-00000002',
      intent: 'reassign-task',
      target: { kind: 'task', taskId: claimed.id },
      expectedTaskRevision: claimed.revision - 1,
      attemptId: firstAttemptId,
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    await expect(submit(stack, staleTask)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_STALE_TASK_REVISION' })

    const staleAttempt = request(stack, {
      requestId: 'human-scenario43-attempt-00000003',
      intent: 'review-task',
      target: { kind: 'task', taskId: claimed.id },
      expectedTaskRevision: claimed.revision,
      attemptId: AgentSwarm.AttemptId('attempt-not-current'),
      expectedTeamRevision: teamRevisionAfterClaim,
      decision: 'accept',
    })
    await expect(submit(stack, staleAttempt)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_ATTEMPT_STALE' })

    const after = await snapshot(stack)
    expect(after.team.tasks.find(task => task.id === claimed.id)).toMatchObject({
      status: 'in_progress',
      revision: claimed.revision,
      currentAttemptId: claimed.currentAttemptId,
    })
    // scenario-evidence: 43
    expect(after.team.revision).toBe(before.team.revision)
  }, 45_000)
})

describe('PM-required concurrency and durability', () => {
  it('two concurrent same-requestId submits produce exactly one Team mutation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-concurrent-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { teamRevisionAfterClaim } = await createClaimedForMember(stack, member)
    const before = await snapshot(stack)
    const messagesBefore = before.team.messages.length

    const control = request(stack, {
      requestId: 'human-concurrent-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    const results = await Promise.allSettled([submit(stack, control), submit(stack, control)])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const after = await snapshot(stack)
    expect(after.team.messages.length).toBe(messagesBefore + 1)
    expect((await stack.ctx.agentSwarmHumanInteraction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .find(receipt => receipt.requestId === control.requestId)?.status).toBe('executed')
  })

  it('cancel and in-flight submit serialize by requestId without overwriting each other', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-cancel-race-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { teamRevisionAfterClaim } = await createClaimedForMember(stack, member)
    const before = await snapshot(stack)
    const messagesBefore = before.team.messages.length

    const control = request(stack, {
      requestId: 'human-cancel-race-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    const results = await Promise.allSettled([
      submit(stack, control),
      stack.ctx.agentSwarmHumanControl.cancel(stack.scope, control, captainAdmission(stack)),
    ])
    const receipt = (await stack.ctx.agentSwarmHumanInteraction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .find(item => item.requestId === control.requestId)
    expect(['executed', 'cancelled']).toContain(receipt?.status)
    if (receipt?.status === 'executed') {
      expect(results[0]?.status).toBe('fulfilled')
      expect(results[1]?.status).toBe('rejected')
      expect((await snapshot(stack)).team.messages).toHaveLength(messagesBefore + 1)
    } else {
      expect(receipt?.status).toBe('cancelled')
      expect(results[0]?.status).toBe('rejected')
      expect(results[1]?.status).toBe('fulfilled')
      expect((await snapshot(stack)).team.messages).toHaveLength(messagesBefore)
    }
  })

  it('plugin dispose/reload keeps duplicate and cancel tombstones durable', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-reload-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { teamRevisionAfterClaim } = await createClaimedForMember(stack, member)

    const executedRequest = request(stack, {
      requestId: 'human-reload-executed-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    await submit(stack, executedRequest)
    const cancelledRequest = request(stack, {
      requestId: 'human-reload-cancelled-00000002',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
    })
    await stack.ctx.agentSwarmHumanControl.cancel(stack.scope, cancelledRequest, captainAdmission(stack))
    const beforeMessages = (await snapshot(stack)).team.messages.filter(message => message.phase === 'queued').length

    await stack.pluginFiber.dispose()
    stack.fibers.pop()
    const reloadedFiber = await stack.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })
    stack.fibers.push(reloadedFiber)
    stack.pluginFiber = reloadedFiber

    await expect(submit(stack, executedRequest)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_REQUEST_CONFLICT' })
    await expect(submit(stack, cancelledRequest)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_CANCELLED' })
    expect((await snapshot(stack)).team.messages.filter(message => message.phase === 'queued')).toHaveLength(beforeMessages)
  }, 45_000)
})

describe('typed control execution and free-text boundary', () => {
  it('free text is not a control intent and unattested authenticated-human fails closed', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-free-text-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const initial = await snapshot(stack)
    const invalid = request(stack, {
      requestId: 'human-free-text-00000001',
      intent: 'message',
    })
    const invalidError = await submitError(stack, invalid)
    expect(invalidError.code).toBe('TEAM_INTERACTION_INVALID')

    const forged = request(stack, {
      requestId: 'human-forged-00000002',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      source: { kind: 'authenticated-human', captainSessionId: stack.lead.id, principalRef: 'forged-principal' },
    })
    const forgedError = await submitError(stack, forged)
    expect(forgedError.code).toBe('TEAM_INTERACTION_NO_PRINCIPAL')
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
  })

  it('bounds cancel diagnostics by UTF-8 bytes without splitting a code point', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-cancel-diagnostic-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const current = await snapshot(stack)
    const control = request(stack, {
      requestId: 'human-cancel-diagnostic-00000001',
      expectedTeamRevision: current.team.revision,
    })
    const receipt = await stack.ctx.agentSwarmHumanControl.cancel(
      stack.scope,
      control,
      captainAdmission(stack),
      '界'.repeat(1_000),
    )
    expect(Buffer.byteLength(receipt.diagnostic ?? '', 'utf8')).toBeLessThanOrEqual(2_048)
    expect((receipt.diagnostic ?? '').endsWith('界')).toBe(true)
    expect((receipt.diagnostic ?? '').includes('\uFFFD')).toBe(false)
  })

  it('typed wake, correction, interrupt, reassign and review execute through the authoritative port', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-valid-controls-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { task: claimed, attemptId: firstAttemptId, teamRevisionAfterClaim } = await createClaimedForMember(stack, member)

    const wake = await submit(stack, request(stack, {
      requestId: 'human-valid-wake-00000001',
      intent: 'wake-member', target: { kind: 'member', memberName: 'worker' }, expectedTeamRevision: teamRevisionAfterClaim,
    }))
    expect(wake.status).toBe('executed')
    const afterWake = await snapshot(stack)

    const correct = await submit(stack, request(stack, {
      requestId: 'human-valid-correct-00000002',
      intent: 'correct-task', target: { kind: 'task', taskId: claimed.id },
      expectedTaskRevision: claimed.revision, attemptId: firstAttemptId, expectedTeamRevision: afterWake.team.revision,
      body: 'Correction advisory data.',
    }))
    expect(correct.routedMessageId).toBeDefined()
    const afterCorrect = await snapshot(stack)

    const interrupt = await submit(stack, request(stack, {
      requestId: 'human-valid-interrupt-00000003',
      intent: 'interrupt-member', target: { kind: 'member', memberName: 'worker' }, expectedTeamRevision: afterCorrect.team.revision,
    }))
    expect(interrupt.status).toBe('executed')
    const afterInterrupt = await snapshot(stack)

    const reassign = await submit(stack, request(stack, {
      requestId: 'human-valid-reassign-00000004',
      intent: 'reassign-task', target: { kind: 'task', taskId: claimed.id },
      expectedTaskRevision: claimed.revision, attemptId: firstAttemptId, expectedTeamRevision: afterInterrupt.team.revision,
      diagnostic: 'reassign now',
    }))
    expect(reassign.status).toBe('executed')
    const afterReassign = (await snapshot(stack)).team.tasks.find(task => task.id === claimed.id)!
    expect(afterReassign.status === 'pending' || afterReassign.currentAttemptId !== firstAttemptId).toBe(true)

    const reviewTask = await stack.ctx.agentSwarm.domain.createTask(
      stack.scope, stack.teamId, stack.lead.id, { subject: 'review-by-control', description: 'Typed review control.' },
    )
    const reviewClaim = await stack.ctx.agentSwarm.domain.claimTask(
      stack.scope, stack.teamId, stack.lead.id, reviewTask.id, reviewTask.revision, stack.lead.id,
    )
    await stack.ctx.agentSwarm.domain.acknowledgeAssignment(
      stack.scope, stack.teamId, reviewTask.id, reviewClaim.attempt.id,
    )
    const reviewSubmitted = await stack.ctx.agentSwarm.domain.submitTask(
      stack.scope, stack.teamId, stack.lead.id, reviewTask.id, reviewClaim.task.revision, reviewClaim.attempt.id, 'review output',
    )
    const review = await submit(stack, request(stack, {
      requestId: 'human-valid-review-00000005',
      intent: 'review-task', target: { kind: 'task', taskId: reviewTask.id },
      expectedTaskRevision: reviewSubmitted.revision, attemptId: reviewClaim.attempt.id,
      expectedTeamRevision: (await snapshot(stack)).team.revision, decision: 'accept',
    }))
    expect(review.status).toBe('executed')
    expect((await snapshot(stack)).team.tasks.find(task => task.id === reviewTask.id)!.status).toBe('completed')
  }, 60_000)
})
