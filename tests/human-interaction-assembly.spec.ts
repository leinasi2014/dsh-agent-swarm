/**
 * SW-I1a assembled human interaction.
 *
 * Real-composition proof that plugin `apply`:
 * - wires the official `ctx.userQuestions` presentation for member
 *   questions and resolves the exact live root captain from the durable
 *   record's `source.captainSessionId`;
 * - fails closed when that optional official service is absent;
 * - rejects malformed official answers (not exactly one, wrong question id,
 *   empty custom) before any answer mail is routed;
 * - owns the human overlay/domain lifecycle in ONE effect: mount readmits
 *   both headless services, dispose unprovides them before closing the
 *   overlay/domain, reload reopens the same durable overlay, and a mid-setup
 *   provide conflict closes the just-opened domain instead of leaking it.
 *
 * Restart-safe reconciliation remains explicitly open: scenario 45 proves
 * only the process-local quarantine and durable-marker evidence ceiling.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestionService, { type AskUserQuestionRequest, type UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { HumanInteractionRequest } from '../src/index.js'
import { truncateUtf8 } from '../src/human/human-control-gateway.js'
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

interface BaseMount {
  readonly ctx: Context
  readonly fibers: Fiber[]
}

async function mountBase(sandbox: string, withQuestions: boolean): Promise<BaseMount> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  if (withQuestions) fibers.push(await ctx.plugin(UserQuestionService))
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  return { ctx, fibers }
}

interface Stack extends BaseMount {
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: AgentSwarm.TeamId
  readonly scope: string
  pluginFiber: Fiber
}

async function mount(sandbox: string, withQuestions = true): Promise<Stack> {
  const base = await mountBase(sandbox, withQuestions)
  const pluginFiber = await base.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })
  base.fibers.push(pluginFiber)
  const lead = base.ctx.agentLoop.create(
    SessionId(`i1a-assembly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await base.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('i1a-assembly-create'),
    name: 'agent_swarm_create',
    arguments: { name: 'I1a assembly team', description: 'Prove assembled human interaction.' },
    agent: lead,
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  return {
    ...base,
    lead,
    teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id),
    scope: base.ctx.agentSwarm.scopeOf(lead),
    pluginFiber,
  }
}

async function addMember(stack: Stack): Promise<string> {
  const added = await stack.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('i1a-assembly-add'),
    name: 'agent_swarm_add_member',
    arguments: { name: 'worker', role: 'Assembly worker.' },
    agent: stack.lead,
  })
  if (added.isError) throw new Error(`add failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

async function snapshot(stack: Stack) {
  return await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
}

async function relayQuestion(stack: Stack, memberSessionId: string, requestId: string, body: string) {
  const current = await snapshot(stack)
  const member = liveMember(stack, memberSessionId)
  return stack.ctx.agentSwarmHumanInteraction.relayMemberQuestion({
    scope: stack.scope,
    teamId: stack.teamId,
    memberSessionId,
    body,
    expectedTeamRevision: current.team.revision,
    requestId,
  }, { exec: { agent: member, signal: SIGNAL } })
}

function captainAdmission(stack: Stack): AgentSwarm.HumanInteractionAdmission {
  return { exec: { agent: stack.lead, signal: SIGNAL } }
}

const roots: string[] = []
const stacks: Stack[] = []
const detachAgents: Array<() => void> = []

function liveMember(stack: Stack, memberSessionId: string): Agent {
  const existing = stack.ctx.agents.get(SessionId(memberSessionId))
  if (existing !== undefined) return existing
  const id = SessionId(memberSessionId)
  const member = {
    id,
    session: { id, header: { cwd: join(stack.scope, 'member') } },
  } as unknown as Agent
  detachAgents.push(stack.ctx.agents.enter(member, stack.lead))
  return member
}

afterEach(async () => {
  for (const detach of detachAgents.splice(0).toReversed()) detach()
  for (const stack of stacks.splice(0).toReversed()) {
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('assembled SW-I1a captain question presentation', () => {
  it('full chain: member relay -> live root captain -> official ctx.userQuestions -> answer mail', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-fullchain-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, true)
    stacks.push(stack)
    const member = await addMember(stack)
    const seen: AskUserQuestionRequest[] = []
    const provider: UserQuestionProvider & { seen: AskUserQuestionRequest[] } = {
      seen,
      async ask(input) {
        seen.push(input)
        return { answers: [{ id: input.questions[0]?.id ?? 'missing', selected: [], custom: 'Answer via official questions.' }] }
      },
    }
    stack.ctx.userQuestions.registerProvider(provider)
    const teamAfterMember = await snapshot(stack)
    const relayed = await relayQuestion(stack, member, 'human-assembly-full-00000001', 'Should I proceed?')
    expect(relayed.status).toBe('acknowledged')
    expect(relayed.routedMessageId).toBeDefined()

    const presentInput = {
      scope: stack.scope,
      requestId: relayed.requestId,
      captainSessionId: stack.lead.id,
    }
    const [presented, concurrentReplay] = await Promise.all([
      stack.ctx.agentSwarmHumanInteraction.presentQuestion(presentInput, captainAdmission(stack)),
      stack.ctx.agentSwarmHumanInteraction.presentQuestion(presentInput, captainAdmission(stack)),
    ])
    expect(presented.status).toBe('executed')
    expect(concurrentReplay).toEqual(presented)
    expect(presented.answerMessageId).toBeDefined()
    expect(presented.answerMessageId).not.toBe(relayed.routedMessageId)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.agent).toBe(stack.lead)
    expect(seen[0]?.questions[0]?.id).toBe('question-human-assembly-full-00000001')
    expect(seen[0]?.questions[0]?.question).toBe('Should I proceed?')

    const after = await snapshot(stack)
    expect(after.team.messages.filter(message =>
      message.senderName === 'captain' && message.targetName === 'worker' && message.content === 'Answer via official questions.',
    )).toHaveLength(1)
    expect(teamAfterMember.team.messages.filter(message => message.senderName === 'worker')).toHaveLength(0)
  }, 45_000)

  it('caller-bound liaison rejects real member/root ids asserted by the wrong live caller with zero side effects', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-liaison-provenance-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, true)
    stacks.push(stack)
    const memberId = await addMember(stack)
    const member = liveMember(stack, memberId)
    const seen: AskUserQuestionRequest[] = []
    stack.ctx.userQuestions.registerProvider({
      async ask(input) {
        seen.push(input)
        return { answers: [{ id: input.questions[0]?.id ?? 'missing', selected: [], custom: 'safe answer' }] }
      },
    })
    const current = await snapshot(stack)
    const forgedRelay = {
      scope: stack.scope,
      teamId: stack.teamId,
      memberSessionId: memberId,
      body: 'payload names a real member',
      expectedTeamRevision: current.team.revision,
      requestId: 'human-forged-relay-00000001',
    }
    await expect(stack.ctx.agentSwarmHumanInteraction.relayMemberQuestion(
      forgedRelay,
      captainAdmission(stack),
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_MEMBER_REQUIRED' })
    expect((await snapshot(stack)).team.messages).toHaveLength(current.team.messages.length)
    expect(await stack.ctx.agentSwarmHumanInteraction.listReceipts(
      stack.scope,
      stack.teamId,
      captainAdmission(stack),
    )).toHaveLength(0)

    const relayed = await stack.ctx.agentSwarmHumanInteraction.relayMemberQuestion(
      forgedRelay,
      { exec: { agent: member, signal: SIGNAL } },
    )
    expect(relayed.status).toBe('acknowledged')
    const memberAdmission = { exec: { agent: member, signal: SIGNAL } }
    await expect(stack.ctx.agentSwarmHumanInteraction.presentQuestion({
      scope: stack.scope,
      requestId: relayed.requestId,
      captainSessionId: stack.lead.id,
    }, memberAdmission)).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    await expect(stack.ctx.agentSwarmHumanInteraction.listReceipts(
      stack.scope,
      stack.teamId,
      memberAdmission,
    )).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    await expect(stack.ctx.agentSwarmHumanInteraction.reconcile(
      stack.scope,
      stack.teamId,
      memberAdmission,
    )).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    expect(seen).toHaveLength(0)
    const after = await snapshot(stack)
    expect(after.team.messages.filter(message => message.senderName === 'captain')).toHaveLength(0)
    expect((await stack.ctx.agentSwarmHumanInteraction.listReceipts(
      stack.scope,
      stack.teamId,
      captainAdmission(stack),
    )).find(item => item.requestId === relayed.requestId)?.status).toBe('acknowledged')
  }, 45_000)

  it('fails closed when the official user-questions service is not composed', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-missing-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, false)
    stacks.push(stack)
    const member = await addMember(stack)
    const relayed = await relayQuestion(stack, member, 'human-assembly-missing-00000002', 'Anybody there?')
    expect(relayed.status).toBe('acknowledged')

    const presented = await stack.ctx.agentSwarmHumanInteraction.presentQuestion({
      scope: stack.scope,
      requestId: relayed.requestId,
      captainSessionId: stack.lead.id,
    }, captainAdmission(stack))
    expect(presented.status).toBe('failed')
    expect(presented.code).toBe('TEAM_INTERACTION_PROVIDER_MISSING')
    expect(presented.answerMessageId).toBeUndefined()
    expect((await snapshot(stack)).team.messages.filter(message => message.senderName === 'captain')).toHaveLength(0)
  }, 45_000)

  it('strictly rejects not-exactly-one, wrong-id and empty-custom official answers', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-invalid-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, true)
    stacks.push(stack)
    const member = await addMember(stack)
    let mode: 'multiple' | 'wrong-id' | 'empty-custom' = 'multiple'
    stack.ctx.userQuestions.registerProvider({
      async ask(input) {
        const id = input.questions[0]?.id ?? 'missing'
        if (mode === 'multiple') return { answers: [{ id, selected: [], custom: 'one' }, { id, selected: [], custom: 'two' }] }
        if (mode === 'wrong-id') return { answers: [{ id: 'question-someone-else', selected: [], custom: 'wrong target' }] }
        return { answers: [{ id, selected: [], custom: '   ' }] }
      },
    })

    const cases: Array<{ requestId: string; mode: 'multiple' | 'wrong-id' | 'empty-custom'; body: string }> = [
      { requestId: 'human-assembly-multiple-00000003', mode: 'multiple', body: 'Multiple answers?' },
      { requestId: 'human-assembly-wrongid-00000004', mode: 'wrong-id', body: 'Wrong question id?' },
      { requestId: 'human-assembly-empty-00000005', mode: 'empty-custom', body: 'Empty custom?' },
    ]
    for (const item of cases) {
      mode = item.mode
      const relayed = await relayQuestion(stack, member, item.requestId, item.body)
      expect(relayed.status).toBe('acknowledged')
      await expect(stack.ctx.agentSwarmHumanInteraction.presentQuestion({
        scope: stack.scope,
        requestId: relayed.requestId,
        captainSessionId: stack.lead.id,
      }, captainAdmission(stack))).rejects.toMatchObject({ code: 'TEAM_HUMAN_QUESTIONS_INVALID_ANSWER' })
    }
    expect((await snapshot(stack)).team.messages.filter(message => message.senderName === 'captain')).toHaveLength(0)
  }, 60_000)
})

describe('human domain lifecycle ownership', () => {
  it('mount/dispose: services are admitted, then unprovided before overlay/domain close', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-lifecycle-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, false)
    stacks.push(stack)
    const interaction = stack.ctx.agentSwarmHumanInteraction
    const control = stack.ctx.agentSwarmHumanControl
    expect(stack.ctx.get('agentSwarmHumanInteraction')).toBeDefined()
    expect(stack.ctx.get('agentSwarmHumanControl')).toBeDefined()

    await stack.pluginFiber.dispose()
    stack.fibers.pop()
    expect(stack.ctx.get('agentSwarmHumanInteraction')).toBeUndefined()
    expect(stack.ctx.get('agentSwarmHumanControl')).toBeUndefined()
    await expect(interaction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_STORE_CLOSED' })
    await expect(control.submit(
      stack.scope,
      {
        schemaVersion: 1,
        requestId: 'human-lifecycle-after-00000001',
        teamId: stack.teamId,
        source: { kind: 'captain-mediated', captainSessionId: stack.lead.id },
        target: { kind: 'member', memberName: 'worker' },
        intent: 'wake-member',
        expectedTeamRevision: 1,
        createdAt: Date.now(),
      },
      { kind: 'captain', exec: { agent: stack.lead, signal: SIGNAL } },
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_STORE_CLOSED' })
  }, 45_000)

  it('reload: the same storage root reopens the overlay and readmits both host services', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-reload-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, false)
    stacks.push(stack)
    const oldInteraction = stack.ctx.agentSwarmHumanInteraction
    const member = await addMember(stack)
    const relayed = await relayQuestion(stack, member, 'human-assembly-reload-00000006', 'Durable before reload')
    expect(relayed.status).toBe('acknowledged')

    await stack.pluginFiber.dispose()
    stack.fibers.pop()
    const reloadedFiber = await stack.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })
    stack.fibers.push(reloadedFiber)
    stack.pluginFiber = reloadedFiber
    expect(stack.ctx.get('agentSwarmHumanInteraction')).toBeDefined()
    expect(stack.ctx.get('agentSwarmHumanControl')).toBeDefined()
    await expect(oldInteraction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_STORE_CLOSED' })
    expect((await stack.ctx.agentSwarmHumanInteraction.listReceipts(stack.scope, stack.teamId, captainAdmission(stack)))
      .find(receipt => receipt.requestId === relayed.requestId)?.status).toBe('acknowledged')
  }, 60_000)

  it('mid-setup failure closes the just-opened human domain instead of leaking it', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-conflict-'))
    roots.push(sandbox)
    const base = await mountBase(sandbox, true)
    const conflictDisposer = base.ctx.reflect.provide('agentSwarmHumanControl', {})
    try {
      await expect(base.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })).rejects.toThrow()
      // The failing setup opened `agent_swarm_human` before the provide
      // conflict; the single owner effect must have closed it, so the name is
      // free again and a fresh open succeeds.
      const reopened = await base.ctx.storageDomain.open(AgentSwarm.humanInteractionDomainSpec)
      expect(reopened).toBeDefined()
      await reopened.close()
    } finally {
      await conflictDisposer()
      for (const fiber of base.fibers.toReversed()) await fiber.dispose()
    }
  }, 45_000)
  it('second provide conflict unprovides control before closing overlay/domain and leaves both services invisible', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-i1a-assembly-conflict-interaction-'))
    roots.push(sandbox)
    const base = await mountBase(sandbox, true)
    const conflictDisposer = base.ctx.reflect.provide('agentSwarmHumanInteraction', {})
    let conflictDisposed = false
    try {
      // control provide succeeds first; interaction provide throws second.
      await expect(base.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })).rejects.toThrow()
      // Remove the pre-seeded conflict so only plugin-owned admissions remain visible.
      await conflictDisposer()
      conflictDisposed = true
      expect(base.ctx.get('agentSwarmHumanControl')).toBeUndefined()
      expect(base.ctx.get('agentSwarmHumanInteraction')).toBeUndefined()
      // The overlay/domain must have been closed in admission->storage order.
      const reopened = await base.ctx.storageDomain.open(AgentSwarm.humanInteractionDomainSpec)
      expect(reopened).toBeDefined()
      await reopened.close()
    } finally {
      if (!conflictDisposed) await conflictDisposer()
      for (const fiber of base.fibers.toReversed()) await fiber.dispose()
    }
  }, 45_000)
})

describe('semantic utilities', () => {
  it('sameHumanInteractionRequest compares schemaVersion and createdAt', () => {
    const base: HumanInteractionRequest = {
      schemaVersion: 1,
      requestId: 'human-semantic-utils-00000001',
      teamId: AgentSwarm.TeamId('team-semantic-utils'),
      source: { kind: 'captain-mediated', captainSessionId: 'captain-util' },
      target: { kind: 'member', memberName: 'worker' },
      intent: 'wake-member',
      expectedTeamRevision: 1,
      createdAt: 10,
    }
    expect(AgentSwarm.sameHumanInteractionRequest(base, { ...base })).toBe(true)
    expect(AgentSwarm.sameHumanInteractionRequest(base, { ...base, createdAt: 11 })).toBe(false)
    expect(AgentSwarm.sameHumanInteractionRequest(base, {
      ...base,
      schemaVersion: 2,
    } as unknown as HumanInteractionRequest)).toBe(false)
  })

  it('truncateUtf8 accumulates code points linearly and never splits a character', () => {
    expect(truncateUtf8('a😀b', 5)).toBe('a😀')
    expect(truncateUtf8('😀x', 4)).toBe('😀')
    expect(truncateUtf8('😀😀', 3)).toBe('')
    expect(truncateUtf8('hello', 5)).toBe('hello')
    const huge = '😀'.repeat(50_000) + 'x'
    expect([...truncateUtf8(huge, 20_000)]).toHaveLength(5_000)
  })
})
