/**
 * SW-I1a semantic requestId reuse guard.
 *
 * When the overlay already holds a request id, submit/cancel must first
 * compare the FULL request semantics through the shared helper. A different
 * payload reusing the id is always TEAM_INTERACTION_REQUEST_CONFLICT — it
 * must not return another request's cancelled receipt or cancel a mismatched
 * pending record.
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
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
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

async function mount(sandbox: string): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  const pluginFiber = await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, lazyMemberStart: false })
  fibers.push(pluginFiber)
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  const lead = ctx.agentLoop.create(
    SessionId(`i1a-reuse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('i1a-reuse-create'),
    name: 'agent_swarm_create',
    arguments: { name: 'I1a reuse team', description: 'Semantic requestId reuse guard.' },
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
    callId: CallId('i1a-reuse-add'),
    name: 'agent_swarm_add_member',
    arguments: { name: 'worker', role: 'Reuse guard worker.' },
    agent: stack.lead,
  })
  if (added.isError) throw new Error(`add failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

async function snapshot(stack: Stack) {
  return await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
}

function request(stack: Stack, overrides: Partial<HumanInteractionRequest>): HumanInteractionRequest {
  return {
    schemaVersion: 1,
    requestId: `human-${Math.random().toString(36).slice(2, 14)}`,
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
  return stack.ctx.agentSwarmHumanControl.submit(
    stack.scope,
    control,
    { kind: 'captain', exec: { agent: stack.lead, signal: SIGNAL } },
    new AbortController().signal,
  )
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
    { subject: 'i1a-reuse-task', description: 'Fenced work for reuse guard.' },
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

describe('semantic requestId reuse', () => {
  it('submit/cancel with a different payload on an existing requestId conflict, never returning/cancelling the other receipt', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-semantic-reuse-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    stacks.push(stack)
    const member = await addMember(stack)
    const { teamRevisionAfterClaim } = await createClaimedForMember(stack, member)

    const original = request(stack, {
      requestId: 'human-semantic-original-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
      body: 'original semantics',
    })
    await submit(stack, original)
    const messagesAfterOriginal = (await snapshot(stack)).team.messages.length

    const differentSubmit = request(stack, {
      requestId: 'human-semantic-original-00000001',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
      body: 'different semantics must conflict',
    })
    const submitConflict = await submitError(stack, differentSubmit)
    expect(submitConflict.code).toBe('TEAM_INTERACTION_REQUEST_CONFLICT')
    await expect(stack.ctx.agentSwarmHumanControl.cancel(stack.scope, differentSubmit, captainAdmission(stack)))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_REQUEST_CONFLICT' })
    expect((await snapshot(stack)).team.messages).toHaveLength(messagesAfterOriginal)
    expect((await stack.ctx.agentSwarmHumanInteraction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .find(receipt => receipt.requestId === original.requestId)?.status).toBe('executed')

    const cancelledOriginal = request(stack, {
      requestId: 'human-semantic-cancelled-00000002',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
      body: 'cancelled semantics',
    })
    await stack.ctx.agentSwarmHumanControl.cancel(stack.scope, cancelledOriginal, captainAdmission(stack))
    const differentCancelled = request(stack, {
      requestId: 'human-semantic-cancelled-00000002',
      intent: 'wake-member',
      target: { kind: 'member', memberName: 'worker' },
      expectedTeamRevision: teamRevisionAfterClaim,
      body: 'different payload on a cancelled id',
    })
    const cancelledSubmitConflict = await submitError(stack, differentCancelled)
    expect(cancelledSubmitConflict.code).toBe('TEAM_INTERACTION_REQUEST_CONFLICT')
    await expect(stack.ctx.agentSwarmHumanControl.cancel(stack.scope, differentCancelled, captainAdmission(stack)))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_REQUEST_CONFLICT' })
    expect((await stack.ctx.agentSwarmHumanInteraction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .find(receipt => receipt.requestId === cancelledOriginal.requestId)?.status).toBe('cancelled')
  })
})
