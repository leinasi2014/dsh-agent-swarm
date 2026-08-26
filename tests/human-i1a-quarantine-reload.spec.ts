import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestionService, { type UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { HumanInteractionRequest } from '../src/index.js'
const SIGNAL = new AbortController().signal
const CAPTAIN_ID = SessionId('i1a-quarantine-reload-captain')
const REQUEST_ID = 'human-quarantine-reload-00000001'
class ImmediateAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Ready.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
interface StorageWrite {
  readonly unit: string
  readonly table: string
  readonly key: string
  readonly outcome: 'stored' | 'rejected'
  readonly requestId?: string
  readonly receiptStatus?: string
  readonly receiptCode?: string
}
class PersistentInteractionFaultBackend implements StorageBackend {
  readonly writes: StorageWrite[] = []
  readonly kv: KvFacet
  private failedTerminalReceipt = false
  private failedTeamRelayWrite = false
  private readonly media = new Map<string, { tables: Map<string, Map<string, unknown>>; global: unknown }>()

  constructor(
    private readonly requestId: string,
    private readonly failStatus = 'executed',
    private readonly teamRelayWriteFault: 'none' | 'before-persist' | 'after-persist' = 'none',
  ) {
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        let unit = this.media.get(descriptor.name)
        if (unit === undefined) {
          unit = { tables: new Map(), global: null }
          this.media.set(descriptor.name, unit)
        }
        return {
          loadAll: async () => {
            const tables: Record<string, Record<string, unknown>> = {}
            for (const table of descriptor.tables) {
              tables[table] = Object.fromEntries(
                [...(unit?.tables.get(table) ?? new Map<string, unknown>())]
                  .map(([key, value]) => [key, structuredClone(value)]),
              )
            }
            return { tables, global: structuredClone(unit?.global ?? null) }
          },
          putRecord: async (table, key, value) => {
            const receipt = this.interactionReceipt(descriptor.name, table, value)
            const teamRelayRequestId = this.teamRelayRequestId(descriptor.name, table, value)
            const write: StorageWrite = {
              unit: descriptor.name,
              table,
              key,
              outcome: 'stored',
              ...(receipt?.requestId === undefined ? {} : { requestId: receipt.requestId }),
              ...(receipt?.status === undefined ? {} : { receiptStatus: receipt.status }),
              ...(receipt?.code === undefined ? {} : { receiptCode: receipt.code }),
              ...(teamRelayRequestId === undefined ? {} : { requestId: teamRelayRequestId }),
            }
            if (!this.failedTerminalReceipt
              && receipt?.requestId === this.requestId
              && receipt.status === this.failStatus) {
              this.failedTerminalReceipt = true
              this.writes.push({ ...write, outcome: 'rejected' })
              throw new Error('injected terminal receipt write failure')
            }
            if (!this.failedTeamRelayWrite && teamRelayRequestId === this.requestId && this.teamRelayWriteFault === 'before-persist') {
              this.failedTeamRelayWrite = true
              this.writes.push({ ...write, outcome: 'rejected' })
              throw new Error('injected Team write failure before persistence')
            }
            let records = unit?.tables.get(table)
            if (records === undefined) {
              records = new Map()
              unit?.tables.set(table, records)
            }
            records.set(key, structuredClone(value))
            this.writes.push(write)
            if (!this.failedTeamRelayWrite && teamRelayRequestId === this.requestId && this.teamRelayWriteFault === 'after-persist') {
              this.failedTeamRelayWrite = true
              throw new Error('injected Team write failure after persistence')
            }
          },
          deleteRecord: async (table, key) => {
            unit?.tables.get(table)?.delete(key)
          },
          setGlobal: async value => {
            if (unit !== undefined) unit.global = structuredClone(value)
          },
          close: async () => {},
        }
      },
    }
  }

  async close(): Promise<void> {}

  private interactionReceipt(unit: string, table: string, value: unknown): {
    readonly requestId?: string
    readonly status?: string
    readonly code?: string
  } | undefined {
    if (unit !== 'agent_swarm_human' || table !== 'interactions' || typeof value !== 'object' || value === null) return undefined
    const record = value as { request?: { requestId?: unknown }; receipt?: { status?: unknown; code?: unknown } }
    return {
      ...(typeof record.request?.requestId === 'string' ? { requestId: record.request.requestId } : {}),
      ...(typeof record.receipt?.status === 'string' ? { status: record.receipt.status } : {}),
      ...(typeof record.receipt?.code === 'string' ? { code: record.receipt.code } : {}),
    }
  }

  private teamRelayRequestId(unit: string, table: string, value: unknown): string | undefined {
    if (unit !== 'agent_swarm' || table !== 'teams' || typeof value !== 'object' || value === null) return undefined
    const team = (value as { team?: { interactionEffects?: unknown } }).team
    if (!Array.isArray(team?.interactionEffects)) return undefined
    const effect = team.interactionEffects.find(candidate => typeof candidate === 'object' && candidate !== null
      && (candidate as { step?: unknown }).step === 'member-question-relay-mail') as { requestId?: unknown } | undefined
    return typeof effect?.requestId === 'string' ? effect.requestId : undefined
  }
}

interface Stack {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly scope: string
  readonly teamId: AgentSwarm.TeamId
}

const roots: string[] = []
const stacks: Stack[] = []

async function dispose(stack: Stack): Promise<void> {
  const index = stacks.indexOf(stack)
  if (index >= 0) stacks.splice(index, 1)
  for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const stack of stacks.splice(0).toReversed()) await dispose(stack)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function mount(
  root: string,
  backend: PersistentInteractionFaultBackend,
  existingTeamId?: AgentSwarm.TeamId,
  withQuestions = false,
): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions', 'sessions.db') }))
  fibers.push(await ctx.plugin(Storage))
  ctx.storage.backend.register('quarantine-fault', backend)
  ctx.provide(storageBackendServiceKey('quarantine-fault'), backend)
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'quarantine-fault' }))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  if (withQuestions) fibers.push(await ctx.plugin(UserQuestionService))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())

  const lead = ctx.agentLoop.create(CAPTAIN_ID, { provider: 'mock', model: 'mock' }, { cwd: join(root, 'workspace') })
  const scope = ctx.agentSwarm.scopeOf(lead)
  let teamId = existingTeamId
  if (teamId === undefined) {
    const created = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('i1a-quarantine-create'),
      name: 'agent_swarm_create',
      arguments: { name: 'I1a quarantine reload', description: 'Real durable outcome-unknown boundary.' },
      agent: lead,
    })
    if (created.isError) throw new Error(`team create failed: ${JSON.stringify(created.error)}`)
    teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
  }
  const stack = { ctx, fibers, lead, scope, teamId }
  stacks.push(stack)
  return stack
}

function captainAdmission(stack: Stack): AgentSwarm.HumanControlAdmission {
  return { kind: 'captain', exec: { agent: stack.lead, signal: SIGNAL } }
}

function interactionAdmission(stack: Stack): AgentSwarm.HumanInteractionAdmission {
  return { exec: { agent: stack.lead, signal: SIGNAL } }
}

async function snapshot(stack: Stack) {
  return await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
}

async function stableSnapshot(stack: Stack) {
  let current = await snapshot(stack)
  for (let index = 0; index < 20; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    const next = await snapshot(stack)
    if (next.team.revision === current.team.revision) return next
    current = next
  }
  return current
}

async function addMember(stack: Stack): Promise<string> {
  const added = await stack.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('i1a-quarantine-add-member'),
    name: 'agent_swarm_add_member',
    arguments: { name: 'worker', role: 'Durable quarantine test worker.' },
    agent: stack.lead,
  })
  if (added.isError) throw new Error(`member add failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

function wakeRequest(stack: Stack, expectedTeamRevision: number, expiresAt: number): HumanInteractionRequest {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    teamId: stack.teamId,
    source: { kind: 'captain-mediated', captainSessionId: stack.lead.id },
    target: { kind: 'member', memberName: 'worker' },
    intent: 'wake-member',
    body: 'Wake only once despite a receipt fault.',
    expectedTeamRevision,
    createdAt: Date.now(),
    expiresAt,
  }
}

describe('SW-I1a durable outcome-unknown quarantine', () => {
  it('recovers one v2 relay-mail acknowledgement after a real Context reopen without a duplicate mail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1b-relay-once-reload-'))
    roots.push(root)
    const requestId = 'human-i1b-relay-once-00000001'
    const backend = new PersistentInteractionFaultBackend(requestId, 'acknowledged')
    const first = await mount(root, backend)
    const memberId = SessionId(await addMember(first))
    await first.ctx.subagents.drainContinuableChildren(first.lead, [memberId])
    const memberHandle = await first.lead.ctx.agents.resume({
      resumeSessionId: memberId, agentOptions: { provider: 'mock', model: 'mock' }, signal: SIGNAL,
    })
    const before = await stableSnapshot(first)
    const input = {
      scope: first.scope, teamId: first.teamId, memberSessionId: memberId,
      body: 'Persist this relay exactly once.', expectedTeamRevision: before.team.revision, requestId,
    }
    await expect(first.ctx.agentSwarmHumanInteraction.relayMemberQuestion(input, { exec: { agent: memberHandle.agent, signal: SIGNAL } }))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_RECEIPT_PENDING' })
    expect((await snapshot(first)).team.messages.filter(message => message.content === input.body)).toHaveLength(1)
    await memberHandle.dispose()
    await dispose(first)

    const second = await mount(root, backend, first.teamId)
    const beforeReconcile = await snapshot(second)
    const receipts = await second.ctx.agentSwarmHumanInteraction.reconcile(second.scope, second.teamId, interactionAdmission(second))
    expect(receipts.find(receipt => receipt.requestId === requestId)).toMatchObject({ status: 'acknowledged' })
    const after = await snapshot(second)
    expect(after.team.messages.filter(message => message.content === input.body)).toHaveLength(1)
    expect(after.team.interactionEffects).toHaveLength(1)
    expect(after.team.interactionEffects?.[0]).toMatchObject({ requestId, step: 'member-question-relay-mail' })
    expect(after.team.interactionEffects?.[0]?.bodyDigest).not.toContain(input.body)
    expect(after.team.revision).toBeGreaterThanOrEqual(beforeReconcile.team.revision)
  }, 45_000)

  it('freshly reads back a Team relay persisted before its backend threw, then only projects acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1b-team-after-persist-'))
    roots.push(root)
    const requestId = 'human-i1b-team-after-persist-00000001'
    const backend = new PersistentInteractionFaultBackend(requestId, 'never', 'after-persist')
    const first = await mount(root, backend)
    const memberId = SessionId(await addMember(first))
    await first.ctx.subagents.drainContinuableChildren(first.lead, [memberId])
    const member = await first.lead.ctx.agents.resume({
      resumeSessionId: memberId, agentOptions: { provider: 'mock', model: 'mock' }, signal: SIGNAL,
    })
    const before = await stableSnapshot(first)
    const input = {
      scope: first.scope, teamId: first.teamId, memberSessionId: memberId,
      body: 'The Team medium may commit before the caller learns it.', expectedTeamRevision: before.team.revision, requestId,
    }
    await expect(first.ctx.agentSwarmHumanInteraction.relayMemberQuestion(input, { exec: { agent: member.agent, signal: SIGNAL } }))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    expect((await first.ctx.agentSwarmHumanInteraction.listReceipts(first.scope, first.teamId, interactionAdmission(first)))
      .find(receipt => receipt.requestId === requestId)).toMatchObject({ status: 'pending', code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    await member.dispose()
    await dispose(first)

    const second = await mount(root, backend, first.teamId)
    const reconciled = await second.ctx.agentSwarmHumanInteraction.reconcile(second.scope, second.teamId, interactionAdmission(second))
    expect(reconciled.find(receipt => receipt.requestId === requestId)).toMatchObject({ status: 'acknowledged' })
    expect(reconciled.find(receipt => receipt.requestId === requestId)?.code).toBeUndefined()
    const after = await snapshot(second)
    expect(after.team.messages.filter(message => message.content === input.body)).toHaveLength(1)
    expect(after.team.interactionEffects).toHaveLength(1)
    expect(after.team.interactionEffects?.[0]?.resultingTeamRevision).toBe(after.team.revision)
    expect(backend.writes.filter(write => write.unit === 'agent_swarm' && write.requestId === requestId)).toHaveLength(1)
  }, 45_000)

  it('marks an epoch-2 relay not-applied only after a fresh read proves the Team write absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1b-team-before-persist-'))
    roots.push(root)
    const requestId = 'human-i1b-team-before-persist-00000001'
    const backend = new PersistentInteractionFaultBackend(requestId, 'never', 'before-persist')
    const first = await mount(root, backend)
    const memberId = SessionId(await addMember(first))
    await first.ctx.subagents.drainContinuableChildren(first.lead, [memberId])
    const member = await first.lead.ctx.agents.resume({
      resumeSessionId: memberId, agentOptions: { provider: 'mock', model: 'mock' }, signal: SIGNAL,
    })
    const before = await stableSnapshot(first)
    const input = {
      scope: first.scope, teamId: first.teamId, memberSessionId: memberId,
      body: 'Do not infer absence in the original process.', expectedTeamRevision: before.team.revision, requestId,
    }
    await expect(first.ctx.agentSwarmHumanInteraction.relayMemberQuestion(input, { exec: { agent: member.agent, signal: SIGNAL } }))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    await member.dispose()
    await dispose(first)

    const second = await mount(root, backend, first.teamId)
    const reconciled = await second.ctx.agentSwarmHumanInteraction.reconcile(second.scope, second.teamId, interactionAdmission(second))
    expect(reconciled.find(receipt => receipt.requestId === requestId)).toMatchObject({
      status: 'failed', code: 'TEAM_INTERACTION_EFFECT_NOT_APPLIED',
    })
    const after = await snapshot(second)
    expect(after.team.messages.filter(message => message.content === input.body)).toHaveLength(0)
    expect(after.team.interactionEffects).toHaveLength(0)
    expect(backend.writes.filter(write => write.unit === 'agent_swarm' && write.requestId === requestId && write.outcome === 'stored')).toHaveLength(0)
  }, 45_000)

  it('reopens an official question/answer-mail fault without asking or delivering twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1a-question-quarantine-reload-'))
    roots.push(root)
    const requestId = 'human-question-quarantine-reload-00000001'
    const backend = new PersistentInteractionFaultBackend(requestId)
    let firstQuestions = 0
    const first = await mount(root, backend, undefined, true)
    const memberId = SessionId(await addMember(first))
    // Resume the persisted child from captain scope: a real direct child, not a test double.
    await first.ctx.subagents.drainContinuableChildren(first.lead, [memberId])
    await vi.waitFor(() => {
      expect(first.ctx.agents.get(memberId)).toBeUndefined()
    }, { timeout: 8_000, interval: 10 })
    const memberHandle = await first.lead.ctx.agents.resume({
      resumeSessionId: memberId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    const member = memberHandle.agent
    expect(first.ctx.agents.get(memberId)).toBe(member)
    expect(first.ctx.agents.roots().some(agent => agent === member)).toBe(false)
    expect(first.ctx.agents.isOwnedBy(memberId, first.lead)).toBe(true)
    first.ctx.userQuestions.registerProvider({
      async ask(input) {
        firstQuestions += 1
        return { answers: [{ id: input.questions[0]?.id ?? 'missing', selected: [], custom: 'Answer only once.' }] }
      },
    } satisfies UserQuestionProvider)
    const beforeRelay = await stableSnapshot(first)
    const relayed = await first.ctx.agentSwarmHumanInteraction.relayMemberQuestion({
      scope: first.scope,
      teamId: first.teamId,
      memberSessionId: memberId,
      body: 'Should the test continue?',
      expectedTeamRevision: beforeRelay.team.revision,
      requestId,
    }, { exec: { agent: member, signal: SIGNAL } })
    expect(relayed.status).toBe('acknowledged')

    const presentInput = {
      scope: first.scope,
      teamId: first.teamId,
      requestId,
      captainSessionId: first.lead.id,
    }
    const answerEffectStart = backend.writes.length
    await expect(first.ctx.agentSwarmHumanInteraction.presentQuestion(
      presentInput,
      interactionAdmission(first),
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    expect(firstQuestions).toBe(1)
    expect((await snapshot(first)).team.messages.filter(message =>
      message.senderName === 'captain' && message.targetName === 'worker' && message.content === 'Answer only once.',
    )).toHaveLength(1)

    await memberHandle.dispose()
    await dispose(first)
    let reopenedQuestions = 0
    const second = await mount(root, backend, first.teamId, true)
    second.ctx.userQuestions.registerProvider({
      async ask() {
        reopenedQuestions += 1
        return { answers: [] }
      },
    } satisfies UserQuestionProvider)
    const replayInput = { ...presentInput, scope: second.scope, teamId: second.teamId, captainSessionId: second.lead.id }
    await expect(second.ctx.agentSwarmHumanInteraction.presentQuestion(
      replayInput,
      interactionAdmission(second),
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    // `member-question` re-enters through presentQuestion; wake-member covers control paths below.
    const reconciled = await second.ctx.agentSwarmHumanInteraction.reconcile(
      second.scope,
      second.teamId,
      interactionAdmission(second),
    )
    expect(reconciled.find(receipt => receipt.requestId === requestId)).toMatchObject({
      status: 'acknowledged', code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
    })
    expect(firstQuestions).toBe(1)
    expect(reopenedQuestions).toBe(0)
    expect((await snapshot(second)).team.messages.filter(message =>
      message.senderName === 'captain' && message.targetName === 'worker' && message.content === 'Answer only once.',
    )).toHaveLength(1)
    const teamEffect = backend.writes.findIndex((write, index) =>
      index >= answerEffectStart && write.unit === 'agent_swarm' && write.outcome === 'stored',
    )
    const failedTerminal = backend.writes.findIndex((write, index) =>
      index >= answerEffectStart
      && write.outcome === 'rejected'
      && write.requestId === requestId
      && write.receiptStatus === 'executed',
    )
    const quarantined = backend.writes.findIndex((write, index) =>
      index >= answerEffectStart
      && write.outcome === 'stored'
      && write.requestId === requestId
      && write.receiptCode === 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
    )
    expect(teamEffect).toBeGreaterThanOrEqual(0)
    expect(failedTerminal).toBeGreaterThan(teamEffect)
    expect(quarantined).toBeGreaterThan(failedTerminal)
  }, 45_000)

  it('reopens the real media without replaying or overwriting a quarantined wake effect', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1a-quarantine-reload-'))
    roots.push(root)
    const backend = new PersistentInteractionFaultBackend(REQUEST_ID)

    const first = await mount(root, backend)
    await addMember(first)
    const before = await stableSnapshot(first)
    const request = wakeRequest(first, before.team.revision, now + 1)
    const wakeEffectStart = backend.writes.length
    await expect(first.ctx.agentSwarmHumanControl.submit(
      first.scope,
      request,
      captainAdmission(first),
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    const firstTeam = await snapshot(first)
    expect(firstTeam.team.messages.filter(message =>
      message.senderName === 'captain'
      && message.targetName === 'worker'
      && message.content === request.body,
    )).toHaveLength(1)
    expect((await first.ctx.agentSwarmHumanInteraction.listReceipts(
      first.scope,
      first.teamId,
      interactionAdmission(first),
    )).find(receipt => receipt.requestId === REQUEST_ID)).toMatchObject({
      status: 'pending', code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
    })

    // Context 2 opens fresh services over the same on-disk roots.
    await dispose(first)
    now += 2
    const second = await mount(root, backend, first.teamId)
    const reopened = await snapshot(second)
    expect(reopened.team.messages.filter(message =>
      message.senderName === 'captain'
      && message.targetName === 'worker'
      && message.content === request.body,
    )).toHaveLength(1)
    const receipt = (await second.ctx.agentSwarmHumanInteraction.listReceipts(
      second.scope,
      second.teamId,
      interactionAdmission(second),
    )).find(item => item.requestId === REQUEST_ID)
    expect(receipt).toMatchObject({ status: 'pending', code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })

    const resend = vi.spyOn(second.ctx.agentSwarm, 'sendMessage')
    await expect(second.ctx.agentSwarmHumanControl.submit(
      second.scope,
      request,
      captainAdmission(second),
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    await expect(second.ctx.agentSwarmHumanControl.cancel(
      second.scope,
      request,
      captainAdmission(second),
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    await expect(second.ctx.agentSwarmHumanControl.submit(
      second.scope,
      { ...request, body: 'Different payload must not replace a quarantined request.' },
      captainAdmission(second),
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    await expect(second.ctx.agentSwarmHumanControl.submit(
      second.scope,
      { ...request, teamId: AgentSwarm.TeamId('other-team') },
      captainAdmission(second),
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    await expect(second.ctx.agentSwarmHumanControl.submit(
      'other-workspace-scope',
      request,
      captainAdmission(second),
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
    await expect(second.ctx.agentSwarmHumanInteraction.presentQuestion({
      scope: second.scope,
      teamId: second.teamId,
      requestId: REQUEST_ID,
      captainSessionId: second.lead.id,
    }, interactionAdmission(second))).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    const reconciled = await second.ctx.agentSwarmHumanInteraction.reconcile(
      second.scope,
      second.teamId,
      interactionAdmission(second),
    )
    expect(reconciled.find(item => item.requestId === REQUEST_ID)).toMatchObject({
      status: 'pending', code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
    })
    expect(resend).not.toHaveBeenCalled()

    const finalTeam = await snapshot(second)
    expect(finalTeam.team.messages.filter(message =>
      message.senderName === 'captain'
      && message.targetName === 'worker'
      && message.content === request.body,
    )).toHaveLength(1)
    await expect(second.ctx.agentSwarmHumanInteraction.listReceipts(
      second.scope,
      AgentSwarm.TeamId('other-team'),
      interactionAdmission(second),
    )).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    await expect(second.ctx.agentSwarmHumanInteraction.listReceipts(
      'other-workspace-scope',
      second.teamId,
      interactionAdmission(second),
    )).rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
    const teamEffect = backend.writes.findIndex((write, index) =>
      index >= wakeEffectStart && write.unit === 'agent_swarm' && write.outcome === 'stored',
    )
    const failedTerminal = backend.writes.findIndex((write, index) =>
      index >= wakeEffectStart
      && write.outcome === 'rejected'
      && write.requestId === REQUEST_ID
      && write.receiptStatus === 'executed',
    )
    const quarantined = backend.writes.findIndex((write, index) =>
      index >= wakeEffectStart
      && write.outcome === 'stored'
      && write.requestId === REQUEST_ID
      && write.receiptCode === 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
    )
    expect(teamEffect).toBeGreaterThanOrEqual(0)
    expect(failedTerminal).toBeGreaterThan(teamEffect)
    expect(quarantined).toBeGreaterThan(failedTerminal)
  }, 45_000)
})
