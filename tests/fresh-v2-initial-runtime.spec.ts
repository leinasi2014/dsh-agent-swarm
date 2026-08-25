import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { FreshV2InitialRuntime, type FreshV2InitialConfig } from '../src/runtime/fresh-v2-initial-runtime.js'
import {
  FailingStreamAdapter,
  FRESH_V2_ARTIFACT_CONTRACT,
  FRESH_V2_HOST_CONTRACT,
  FRESH_V2_SIGNAL,
  freshV2ToolCall,
  mountFreshV2Composition,
  WitnessProbeAdapter,
  type FreshV2Composition,
} from './helpers/fresh-v2-composition.js'

const SIGNAL = FRESH_V2_SIGNAL
const ARTIFACT_CONTRACT = FRESH_V2_ARTIFACT_CONTRACT
const INITIAL_CONFIG: FreshV2InitialConfig = {
  artifactContract: ARTIFACT_CONTRACT,
  hostContract: FRESH_V2_HOST_CONTRACT,
  legacyManifestCapacity: 0,
  memberProvider: 'spawn',
  memberDenyTools: [],
  memberSkills: [],
  memberMaxDepth: 1,
  maxMembers: 8,
  maxVerificationCommands: 8,
  maxVerificationCommandMs: 30_000,
  disposalTimeoutMs: 1_000,
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
}

const toolCall = freshV2ToolCall

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of iterable) values.push(value)
  return values
}

class MultiStepAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  targetId?: string

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const targetOrdinal = this.requests.filter(request => request.sessionId === this.targetId).length
    if (options.sessionId === this.targetId && targetOrdinal === 1) {
      const id = CallId('a1b-probe-call')
      const args = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'a1b_probe', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'a1b_probe', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = options.sessionId === this.targetId ? 'Second official step completed.' : 'Captain acknowledged.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('A1b fresh-v2 official AgentLoop vertical', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('never fences or drains a hand-built model stream, even after closing', async () => {
    const runtime = new FreshV2InitialRuntime(new Context(), INITIAL_CONFIG)
    await runtime.dispose()
    let downstreamCalls = 0
    const next = (): AsyncIterable<StreamChunk> => (async function* () {
      downstreamCalls += 1
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const handBuilt: GenerateOptions = { provider: 'mock', model: 'mock', messages: [] }
    expect(await collect(runtime.wrapModelStream(handBuilt, next))).toEqual([
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(downstreamCalls).toBe(1)
  })

  it('bounds continuation-stream disposal instead of hanging plugin shutdown', async () => {
    const runtime = new FreshV2InitialRuntime(new Context(), { ...INITIAL_CONFIG, disposalTimeoutMs: 25 })
    Object.assign(runtime, { continuation: { dispose: () => new Promise<void>(() => {}) } })
    const startedAt = Date.now()
    await expect(runtime.dispose()).rejects.toThrow(/fresh-v2 runtime disposal failed/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('keeps the default v1 activation contract and rejects unsupported fresh-v2 configuration', async () => {
    expect(AgentSwarm.inject).not.toContain('llm')
    await expect(AgentSwarm.apply(new Context(), {
      experimentalFreshV2: true,
      freshV2ArtifactContract: ARTIFACT_CONTRACT,
      freshV2HostContract: FRESH_V2_HOST_CONTRACT,
      jobsBridge: true,
    })).rejects.toMatchObject({ code: 'TEAM_EXPERIMENTAL_UNSUPPORTED_CONFIG' })
    await expect(AgentSwarm.apply(new Context(), {
      experimentalFreshV2: true,
      freshV2ArtifactContract: ARTIFACT_CONTRACT,
      freshV2HostContract: FRESH_V2_HOST_CONTRACT,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
  })

  it('keeps add_member dormant, witnesses provider entry, then admits running from durable assistant evidence', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-'))
    roots.push(sandbox)
    let teamId: string | undefined
    let mounted: FreshV2Composition<WitnessProbeAdapter> | undefined

    try {
      mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
        ? undefined
        : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
      const { ctx, fibers, workspace, storageRoot, adapter, lead } = mounted
      let pluginFiber: Fiber = mounted.pluginFiber
      const created = await toolCall(ctx, lead, 'create', 'agent_swarm_create', {
        name: 'A1b Team', description: 'Prove the real official dispatch vertical.',
      }) as { team_id: string }
      teamId = created.team_id
      const added = await toolCall(ctx, lead, 'add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Complete the first real assignment.',
      }) as { session_id: string; phase: string }
      const childId = SessionId(added.session_id)
      expect(added.phase).toBe('declared')
      expect(adapter.requests).toHaveLength(0)
      expect(ctx.agents.get(childId)).toBeUndefined()
      expect((await ctx.sessionPersistence.listSnapshots()).some(snapshot => snapshot.header.id === childId)).toBe(false)

      const createdTask = await toolCall(ctx, lead, 'task', 'agent_swarm_create_task', {
        subject: 'First vertical',
        description: 'Return one model response through the official AgentLoop.',
        acceptance_criteria: ['One official request and durable assistant evidence.'],
        target_member: 'worker',
      }) as { task_id: string; revision: number; status: string }
      expect(createdTask).toMatchObject({ task_id: 'task-1', revision: 2, status: 'in_progress' })

      await vi.waitFor(() => {
        expect(adapter.entries).toEqual([{ marked: true, phase: 'reserved', dispatchPhase: 'dispatch-entered' }])
      }, { timeout: 10_000 })
      const entered = ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!
      expect(entered.members[0]).toMatchObject({ phase: 'active', sessionId: childId })
      expect(entered.attempts[0]).toMatchObject({
        phase: 'reserved', assignmentPhase: 'delivered',
        dispatchEpochs: [{ phase: 'dispatch-entered', turn: 1, step: 1 }],
      })
      expect(adapter.requests.filter(request => request.sessionId === childId)).toHaveLength(1)
      const liveChild = ctx.agents.get(childId)
      expect(liveChild).toBeDefined()
      const assignmentMessages = liveChild!.session.events.filter(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text' && block.text.includes('Team assignment from captain.')))
      expect(assignmentMessages).toHaveLength(1)

      let replayDownstreamCalls = 0
      const replayOptions = adapter.requests.find(request => request.sessionId === childId)!
      await expect(async () => await collect(ctx.agentSwarmV2Initial.wrapModelStream(replayOptions, () => (async function* () {
        replayDownstreamCalls += 1
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })()))).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
      expect(replayDownstreamCalls).toBe(0)

      adapter.open()
      await vi.waitFor(() => {
        const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, teamId!)!
        expect(snapshot.attempts[0]).toMatchObject({
          phase: 'parked',
          dispatchEpochs: [{ phase: 'settled', assistantEvidenceType: 'assistant/message' }],
        })
      }, { timeout: 10_000 })
      await ctx.agentSwarmV2Initial.drainEvidence()
      const persisted = await ctx.sessionPersistence.load(childId)
      expect(persisted.events.some(event => event.type === 'assistant/message'
        && event.data.turn === 1 && event.data.step === 1)).toBe(true)
      expect(adapter.requests.filter(request => request.sessionId === childId)).toHaveLength(1)
      expect(await exists(join(storageRoot, 'agent_swarm_v2.json'))).toBe(true)
      expect(await exists(join(storageRoot, 'agent_swarm.json'))).toBe(false)

      let bypassCalls = 0
      const nonOwned = ctx.agentSwarmV2Initial.wrapModelStream(markAgentLoopRequest({
        provider: 'mock', model: 'mock', messages: [], sessionId: lead.id,
      }), () => (async function* () {
        bypassCalls += 1
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })())
      await pluginFiber.dispose()
      fibers.splice(fibers.indexOf(pluginFiber), 1)
      expect(await collect(nonOwned)).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
      expect(bypassCalls).toBe(1)
      pluginFiber = await ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn',
        experimentalFreshV2: true,
        freshV2ArtifactContract: ARTIFACT_CONTRACT,
        freshV2HostContract: FRESH_V2_HOST_CONTRACT,
      })
      fibers.push(pluginFiber)
      expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId)).toMatchObject({
        id: teamId,
        attempts: [{ phase: 'parked', dispatchEpochs: [{ phase: 'settled' }] }],
      })
      expect(adapter.requests.filter(request => request.sessionId === childId)).toHaveLength(1)
    } finally {
      mounted?.adapter.open()
      for (const fiber of mounted?.fibers.toReversed() ?? []) await fiber.dispose().catch(() => undefined)
    }
  })

  it('settles an entered initial dispatch from the durable Provider error boundary without reporting running', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-failure-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    try {
      const { ctx, workspace, lead, adapter } = mounted
      const created = await toolCall(ctx, lead, 'failure-create', 'agent_swarm_create', {
        name: 'Failure Team', description: 'Reject false running evidence.',
      }) as { team_id: string }
      const added = await toolCall(ctx, lead, 'failure-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Encounter a provider failure.',
      }) as { session_id: string }
      await toolCall(ctx, lead, 'failure-task', 'agent_swarm_create_task', {
        subject: 'Fail once', description: 'The adapter must fail before producing an assistant message.',
        target_member: 'worker',
      })
      await vi.waitFor(() => {
        expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(1)
      }, { timeout: 10_000 })
      await vi.waitFor(() => {
        const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
        expect(snapshot.attempts[0]).toMatchObject({
          phase: 'parked',
          parked: { parkedReason: 'turn-settled' },
          dispatchEpochs: [{
            phase: 'settled',
            turnEndEvidenceReason: 'error',
          }],
        })
        expect(snapshot.attempts[0]!.dispatchEpochs[0]).not.toHaveProperty('assistantEvidenceSeq')
      }, { timeout: 10_000 })
      await ctx.agentSwarmV2Initial.drainEvidence()
      expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(1)
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('compensates an official continuable Provider start failure without touching the model', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-start-failure-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    const unregister = mounted.ctx.subagents.registerProvider({
      name: 'fail-start',
      capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('one-shot start must not run')),
      prepareContinuable: () => Promise.reject(new Error('injected continuable start failure')),
    })
    try {
      const { ctx, workspace, lead, adapter } = mounted
      const created = await toolCall(ctx, lead, 'start-failure-create', 'agent_swarm_create', {
        name: 'Start Failure Team', description: 'Prove exact compensation before any model call.',
      }) as { team_id: string }
      await toolCall(ctx, lead, 'start-failure-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Fail during official continuable preparation.', provider: 'fail-start',
      })
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('start-failure-task'),
        name: 'agent_swarm_create_task',
        arguments: { subject: 'Never dispatch', description: 'Provider preparation fails.', target_member: 'worker' },
        agent: lead,
      })
      expect(result.isError).toBe(true)
      const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
      expect(snapshot.members[0]).toMatchObject({ phase: 'failed' })
      expect(snapshot.tasks[0]).toMatchObject({ status: 'pending' })
      expect(snapshot.attempts[0]).toMatchObject({ phase: 'cancelled', assignmentPhase: 'reserved' })
      expect(adapter.requests).toHaveLength(0)
    } finally {
      unregister()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('fails and requeues the exact initial attempt when the pre-model Session barrier fails', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-preflush-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
      ? undefined
      : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    let flushSpy: { mockRestore(): void } | undefined
    try {
      const { ctx, workspace, lead, adapter } = mounted
      const created = await toolCall(ctx, lead, 'preflush-create', 'agent_swarm_create', {
        name: 'Preflush Team', description: 'Fail before the model is admitted.',
      }) as { team_id: string }
      teamId = created.team_id
      const added = await toolCall(ctx, lead, 'preflush-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Encounter a failed Session barrier.',
      }) as { session_id: string }
      const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
      let rejected = false
      flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(session => {
        if (session.id === added.session_id && !rejected) {
          rejected = true
          return Promise.resolve(false)
        }
        return originalFlush(session)
      })
      await toolCall(ctx, lead, 'preflush-task', 'agent_swarm_create_task', {
        subject: 'No dispatch', description: 'The first durability barrier returns false.', target_member: 'worker',
      })
      await vi.waitFor(() => {
        const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
        expect(snapshot.members[0]).toMatchObject({ phase: 'failed' })
        expect(snapshot.tasks[0]).toMatchObject({ status: 'pending' })
        expect(snapshot.attempts[0]).toMatchObject({ phase: 'cancelled', assignmentPhase: 'reserved' })
      }, { timeout: 10_000 })
      expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(0)
    } finally {
      flushSpy?.mockRestore()
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('never reaches the adapter when the dispatch-witness Session barrier fails', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-witness-flush-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
      ? undefined
      : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    let flushSpy: { mockRestore(): void } | undefined
    try {
      const { ctx, workspace, lead, adapter } = mounted
      const created = await toolCall(ctx, lead, 'witness-flush-create', 'agent_swarm_create', {
        name: 'Witness Flush Team', description: 'Fail the second durability barrier.',
      }) as { team_id: string }
      teamId = created.team_id
      const added = await toolCall(ctx, lead, 'witness-flush-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Never enter the Provider.',
      }) as { session_id: string }
      const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
      let childFlushes = 0
      flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(session => {
        if (session.id === added.session_id && ++childFlushes === 2) return Promise.resolve(false)
        return originalFlush(session)
      })
      await toolCall(ctx, lead, 'witness-flush-task', 'agent_swarm_create_task', {
        subject: 'No provider entry', description: 'The witness barrier returns false.', target_member: 'worker',
      })
      await vi.waitFor(() => {
        const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
        expect(snapshot.attempts[0]).toMatchObject({
          phase: 'reserved', assignmentPhase: 'delivered',
          dispatchEpochs: [{ phase: 'dispatch-pending' }],
        })
      }, { timeout: 10_000 })
      expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(0)
    } finally {
      flushSpy?.mockRestore()
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('surfaces an assistant-evidence durability failure without inventing running state', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-evidence-flush-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
      ? undefined
      : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    let flushSpy: { mockRestore(): void } | undefined
    try {
      const { ctx, workspace, lead, adapter } = mounted
      const created = await toolCall(ctx, lead, 'evidence-flush-create', 'agent_swarm_create', {
        name: 'Evidence Flush Team', description: 'Reject non-durable assistant evidence.',
      }) as { team_id: string }
      teamId = created.team_id
      const added = await toolCall(ctx, lead, 'evidence-flush-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Produce output whose evidence flush fails.',
      }) as { session_id: string }
      const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
      flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(session => {
        const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)
        const dispatch = snapshot?.attempts[0]?.dispatchEpochs[0]
        const hasAssistant = session.events.some(event => event.type === 'assistant/message')
        if (session.id === added.session_id && dispatch?.phase === 'dispatch-entered' && hasAssistant) {
          return Promise.resolve(false)
        }
        return originalFlush(session)
      })
      await toolCall(ctx, lead, 'evidence-flush-task', 'agent_swarm_create_task', {
        subject: 'Uncommitted evidence', description: 'Return output after Provider entry.', target_member: 'worker',
      })
      await vi.waitFor(() => {
        expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(1)
      }, { timeout: 10_000 })
      adapter.open()
      await vi.waitFor(async () => {
        await expect(ctx.agentSwarmV2Initial.drainEvidence()).rejects.toThrow(/assistant evidence fold failed/)
      }, { timeout: 10_000 })
      const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
      expect(snapshot.attempts[0]).toMatchObject({
        phase: 'reserved', dispatchEpochs: [{ phase: 'dispatch-entered' }],
      })
      expect(snapshot.attempts[0]!.dispatchEpochs[0]).not.toHaveProperty('assistantEvidenceSeq')
    } finally {
      flushSpy?.mockRestore()
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('allows the official AgentLoop to advance to step two after the initial dispatch settles', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-multistep-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new MultiStepAdapter())
    let unregister: (() => void) | undefined
    try {
      const { ctx, workspace, lead, adapter } = mounted
      let probeCalls = 0
      unregister = ctx.tools.register(defineTool({
        name: 'a1b_probe',
        description: 'A1b multi-step probe.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
          render: () => [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        },
        execute: async () => {
          probeCalls += 1
          return { ok: true }
        },
      }))
      const created = await toolCall(ctx, lead, 'multi-create', 'agent_swarm_create', {
        name: 'Multi-step Team', description: 'Exercise one normal official tool step.',
      }) as { team_id: string }
      const added = await toolCall(ctx, lead, 'multi-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Call the probe then finish.',
      }) as { session_id: string }
      adapter.targetId = added.session_id
      await toolCall(ctx, lead, 'multi-task', 'agent_swarm_create_task', {
        subject: 'Two steps', description: 'Call the probe and then return a final answer.', target_member: 'worker',
      })
      await vi.waitFor(() => {
        expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(2)
        expect(probeCalls).toBe(1)
        expect(ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!.attempts[0]!.phase).toBe('parked')
      }, { timeout: 10_000 })
      const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
      expect(snapshot.attempts[0]).toMatchObject({
        phase: 'parked',
        dispatchEpochs: [{ phase: 'settled', assistantEvidenceType: 'assistant/message' }],
      })
      expect(snapshot.attempts[0]!.dispatchEpochs).toHaveLength(1)
      const child = await ctx.sessionPersistence.load(SessionId(added.session_id))
      expect(child.events.filter(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text'
          && block.text.includes('Team assignment from captain.')))).toHaveLength(1)
      expect(child.events.filter(event => event.type === 'step/start')).toHaveLength(2)
    } finally {
      unregister?.()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('admits only one targeted task and one child under concurrent create_task calls', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-race-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
      ? undefined
      : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    try {
      const { ctx, workspace, lead, adapter } = mounted
      const created = await toolCall(ctx, lead, 'race-create', 'agent_swarm_create', {
        name: 'Race Team', description: 'Prove atomic targeted admission.',
      }) as { team_id: string }
      teamId = created.team_id
      const added = await toolCall(ctx, lead, 'race-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Own at most one initial task.',
      }) as { session_id: string }
      const results = await Promise.all([
        ctx.tools.execute({
          signal: SIGNAL, callId: CallId('race-task-1'), name: 'agent_swarm_create_task',
          arguments: { subject: 'Race one', description: 'First contender.', target_member: 'worker' }, agent: lead,
        }),
        ctx.tools.execute({
          signal: SIGNAL, callId: CallId('race-task-2'), name: 'agent_swarm_create_task',
          arguments: { subject: 'Race two', description: 'Second contender.', target_member: 'worker' }, agent: lead,
        }),
      ])
      expect(results.filter(result => !result.isError)).toHaveLength(1)
      expect(results.filter(result => result.isError)).toHaveLength(1)
      await vi.waitFor(() => {
        expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(1)
      }, { timeout: 10_000 })
      const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)!
      expect(snapshot.tasks).toHaveLength(1)
      expect(snapshot.attempts).toHaveLength(1)
      expect(snapshot.tasks).toHaveLength(results.filter(result => !result.isError).length)
    } finally {
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

})
