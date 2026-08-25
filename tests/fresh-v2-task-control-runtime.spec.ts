import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  freshV2ToolCall as toolCall,
  mountFreshV2Composition,
  WitnessProbeAdapter,
} from './helpers/fresh-v2-composition.js'
import type { TeamStateV2 } from '../src/domain/team-state-v2.js'
import {
  ownsFreshV2ModelPermit,
  retireFreshV2ModelPermit,
  type FreshV2ModelPermit,
} from '../src/runtime/fresh-v2-model-permit.js'

class SubmitTaskAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly state: () => TeamStateV2 | undefined) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const task = this.state()?.tasks.find(candidate => candidate.status === 'in_progress')
    if (task?.currentAttemptId !== undefined) {
      const id = CallId('submit-from-real-model')
      const args = JSON.stringify({
        task_id: task.id,
        expected_revision: task.revision,
        attempt_id: task.currentAttemptId,
        output: 'result from the official Agent Loop',
        evidence: ['session:assistant-message'],
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_submit_task', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_submit_task', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'Submission recorded.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('fresh-v2 official Agent Loop task-control races', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('accepts submit only through a real official Agent Loop tool-call after assistant evidence', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-v2-submit-race-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new SubmitTaskAdapter(() => teamId === undefined
      ? undefined : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    try {
      const { ctx, workspace, lead, adapter } = mounted
      teamId = (await toolCall(ctx, lead, 'submit-race-create', 'agent_swarm_create', {
        name: 'Submit Race', description: 'Submission wins the late-result race.',
      }) as { team_id: string }).team_id
      const added = await toolCall(ctx, lead, 'submit-race-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Submit through the official Agent Loop.',
      }) as { session_id: string }
      await toolCall(ctx, lead, 'submit-race-task', 'agent_swarm_create_task', {
        subject: 'Real submit', description: 'Use the registered submission tool.', target_member: 'worker',
      })
      await vi.waitFor(() => {
        expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId!)!.tasks[0]!.status).toBe('submitted')
      }, { timeout: 10_000 })
      expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId)).toMatchObject({
        tasks: [{ status: 'submitted' }],
        attempts: [{ phase: 'submitted', dispatchEpochs: [{ phase: 'settled' }] }],
      })
      const persisted = await ctx.sessionPersistence.load(SessionId(added.session_id))
      const assistant = persisted.events.find(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'agent_swarm_submit_task'))
      const call = persisted.events.find(event => event.type === 'tool/call'
        && event.data.name === 'agent_swarm_submit_task')
      expect(assistant?.seq).toBeLessThan(call?.seq ?? 0)
      expect(adapter.requests.filter(request => request.sessionId === added.session_id).length).toBeGreaterThanOrEqual(1)
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('fences captain reassignment before interrupting an entered Provider', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-v2-reassign-race-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
      ? undefined : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    try {
      const { ctx, workspace, lead, adapter } = mounted
      teamId = (await toolCall(ctx, lead, 'reassign-race-create', 'agent_swarm_create', {
        name: 'Reassign Race', description: 'The captain fence wins before interruption.',
      }) as { team_id: string }).team_id
      const added = await toolCall(ctx, lead, 'reassign-race-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Be atomically replaced.',
      }) as { session_id: string }
      await toolCall(ctx, lead, 'reassign-race-task', 'agent_swarm_create_task', {
        subject: 'Race', description: 'Reassign while Provider is held.', target_member: 'worker',
      })
      await vi.waitFor(() => {
        expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId!)!.attempts[0]!.dispatchEpochs[0]!.phase)
          .toBe('dispatch-entered')
      }, { timeout: 10_000 })
      const task = ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!.tasks[0]!
      await toolCall(ctx, lead, 'reassign-race-control', 'agent_swarm_reassign_task', {
        task_id: task.id, expected_revision: task.revision, reason: 'captain replaced the attempt',
      })
      expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId)).toMatchObject({
        tasks: [{ status: 'pending' }],
        attempts: [{ phase: 'stale', dispatchEpochs: [{ phase: 'superseded' }] }],
      })
      adapter.open()
      await new Promise(resolve => setTimeout(resolve, 50))
      await ctx.agentSwarmV2Initial.drainEvidence()
      expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!.tasks[0]!.status).toBe('pending')
      expect(adapter.requests.filter(request => request.sessionId === added.session_id)).toHaveLength(1)
    } finally {
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('blocks Provider entry when captain reassigns after agent/request issued its one-shot permit', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-v2-permit-race-'))
    roots.push(sandbox)
    let teamId: string | undefined
    const mounted = await mountFreshV2Composition(sandbox, (ctx, workspace) => new WitnessProbeAdapter(() => teamId === undefined
      ? undefined : ctx.agentSwarmV2Initial.snapshot(workspace, teamId)))
    let unblock!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    const gateEntered = new Promise<void>(resolve => { entered = resolve })
    let targetId: string | undefined
    const disposeGate = mounted.ctx.on('agent/request', async ({ agent }, next) => {
      if (agent.id === targetId) {
        entered()
        await blocked
      }
      return await next()
    }, { global: true })
    try {
      const { ctx, workspace, lead, adapter } = mounted
      teamId = (await toolCall(ctx, lead, 'permit-race-create', 'agent_swarm_create', {
        name: 'Permit Race', description: 'Fence after request admission but before Provider entry.',
      }) as { team_id: string }).team_id
      targetId = (await toolCall(ctx, lead, 'permit-race-add', 'agent_swarm_add_member', {
        name: 'worker', role: 'Never reach Provider after reassignment.',
      }) as { session_id: string }).session_id
      await toolCall(ctx, lead, 'permit-race-task', 'agent_swarm_create_task', {
        subject: 'Race', description: 'Pause after the request gate.', target_member: 'worker',
      })
      await gateEntered
      const task = ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!.tasks[0]!
      await toolCall(ctx, lead, 'permit-race-reassign', 'agent_swarm_reassign_task', {
        task_id: task.id, expected_revision: task.revision, reason: 'replace after permit',
      })
      unblock()
      await vi.waitFor(() => {
        expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId!)!.attempts[0]!.phase).toBe('stale')
      }, { timeout: 10_000 })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(adapter.requests.filter(request => request.sessionId === targetId)).toHaveLength(0)
      expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!.tasks[0]!.status).toBe('pending')
    } finally {
      unblock()
      await disposeGate()
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('retires the stale exact signal without poisoning a later permit for the same member', () => {
    const memberId = 'member-permit-reuse'
    const oldSignal = new AbortController().signal
    const nextSignal = new AbortController().signal
    const permits = new Map<string, FreshV2ModelPermit>([[memberId, { signal: oldSignal, turn: 1, step: 1 }]])
    const retired = new WeakSet<AbortSignal>()
    retireFreshV2ModelPermit(permits, retired, memberId)
    expect(() => ownsFreshV2ModelPermit(
      permits, retired, { sessionId: memberId, signal: oldSignal } as GenerateOptions, 'test',
    )).toThrowError(expect.objectContaining({ code: 'TEAM_ATTEMPT_STALE' }))
    permits.set(memberId, { signal: nextSignal, turn: 2, step: 1 })
    expect(ownsFreshV2ModelPermit(
      permits, retired, { sessionId: memberId, signal: nextSignal } as GenerateOptions, 'test',
    )).toBe(true)
  })
})
