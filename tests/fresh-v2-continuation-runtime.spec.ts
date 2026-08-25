import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamStateV2 } from '../src/domain/team-state-v2.js'
import {
  freshV2ToolCall,
  mountFreshV2Composition,
  type FreshV2Composition,
} from './helpers/fresh-v2-composition.js'

class TwoTurnContinuationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entries: Array<{ readonly attemptId?: string; readonly generation?: number; readonly dispatch?: string }> = []
  childId?: string

  constructor(private readonly snapshot: () => TeamStateV2 | undefined) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const team = this.snapshot()
    const attempt = team?.attempts[0]
    this.entries.push({
      ...(attempt === undefined ? {} : { attemptId: attempt.id, generation: attempt.generation }),
      ...(attempt?.dispatchEpochs.at(-1) === undefined ? {} : { dispatch: attempt.dispatchEpochs.at(-1)!.phase }),
    })
    if (options.sessionId !== this.childId) {
      yield* textResponse('Captain response.')
      return
    }
    const childOrdinal = this.requests.filter(request => request.sessionId === this.childId).length
    if (childOrdinal === 1) {
      const task = team!.tasks[0]!
      const id = CallId('request-continuation-a2a')
      const args = JSON.stringify({
        task_id: task.id,
        expected_revision: task.revision,
        attempt_id: attempt!.id,
        idempotency_key: 'after-initial-turn',
        wake_condition: 'Continue the exact same implementation task after this turn.',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_continue_task', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_continue_task', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* textResponse(childOrdinal === 2 ? 'Initial turn checkpoint complete.' : 'Continuation turn complete.')
  }
}

async function* textResponse(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('A2a official same-Attempt continuation vertical', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('runs two official turns under one Attempt and refuses a later unframed wake', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a2a-runtime-'))
    roots.push(sandbox)
    let teamId: string | undefined
    let mounted: FreshV2Composition<TwoTurnContinuationAdapter> | undefined
    try {
      mounted = await mountFreshV2Composition(sandbox, (ctx: Context, workspace: string) => new TwoTurnContinuationAdapter(
        () => teamId === undefined ? undefined : ctx.agentSwarmV2Initial.snapshot(workspace, teamId),
      ))
      const { ctx, workspace, lead, adapter } = mounted
      const team = await freshV2ToolCall(ctx, lead, 'a2a-create', 'agent_swarm_create', {
        name: 'A2a Team', description: 'Prove one explicit same-Attempt continuation.',
      }) as { team_id: string }
      teamId = team.team_id
      const member = await freshV2ToolCall(ctx, lead, 'a2a-member', 'agent_swarm_add_member', {
        name: 'worker', role: 'Continue one exact task across official turns.',
      }) as { session_id: string }
      adapter.childId = member.session_id
      const task = await freshV2ToolCall(ctx, lead, 'a2a-task', 'agent_swarm_create_task', {
        subject: 'Two-turn implementation',
        description: 'Request exactly one continuation, then finish the second official turn.',
        target_member: 'worker',
      }) as { task_id: string }

      await vi.waitFor(() => {
        expect(adapter.requests.filter(request => request.sessionId === member.session_id)).toHaveLength(3)
      }, { timeout: 15_000 })
      await ctx.agentSwarmV2Initial.drainEvidence()
      const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!
      expect(snapshot.tasks[0]).toMatchObject({ id: task.task_id, status: 'in_progress' })
      expect(snapshot.attempts).toHaveLength(1)
      expect(snapshot.attempts[0]).toMatchObject({ generation: 1, phase: 'parked' })
      expect(snapshot.attempts[0]!.dispatchEpochs).toHaveLength(2)
      expect(snapshot.attempts[0]!.dispatchEpochs).toEqual([
        expect.objectContaining({ kind: 'initial', ordinal: 1, phase: 'settled', turn: 1 }),
        expect.objectContaining({ kind: 'continuation', ordinal: 2, phase: 'settled', turn: 2 }),
      ])
      expect(snapshot.interactionEffects).toEqual([
        expect.objectContaining({ kind: 'continuation', status: 'settled', taskId: task.task_id }),
      ])
      expect(new Set(adapter.entries.filter((_entry, index) => adapter.requests[index]?.sessionId === member.session_id)
        .map(entry => entry.attemptId))).toEqual(new Set([snapshot.attempts[0]!.id]))
      expect(adapter.entries.findLast((_entry, index) => adapter.requests[index]?.sessionId === member.session_id))
        .toMatchObject({ generation: 1, dispatch: 'dispatch-entered' })

      const persisted = await ctx.sessionPersistence.load(SessionId(member.session_id))
      const continuationFrames = persisted.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin' && event.data.source.plugin === 'dsh-agent-swarm'
        && event.data.content.some(block => block.type === 'text' && block.text.includes('<agent-swarm-continuation>')))
      expect(continuationFrames).toHaveLength(1)

      await ctx.subagents.followup(
        lead,
        SessionId(member.session_id),
        [{ type: 'text', text: 'Ordinary message must not impersonate continuation.' }],
        { source: { kind: 'plugin', plugin: 'test' }, signal: AbortSignal.timeout(5_000) },
      )
      await vi.waitFor(async () => {
        const afterRejectedWake = await ctx.sessionPersistence.load(SessionId(member.session_id))
        expect(afterRejectedWake.events.some(event => event.type === 'turn/end' && event.data.turn === 3)).toBe(true)
      }, { timeout: 10_000 })
      expect(adapter.requests.filter(request => request.sessionId === member.session_id)).toHaveLength(3)
      expect(ctx.agentSwarmV2Initial.snapshot(workspace, teamId)!.attempts[0]).toMatchObject({
        id: snapshot.attempts[0]!.id, generation: 1, phase: 'parked',
      })
    } finally {
      for (const fiber of mounted?.fibers.toReversed() ?? []) await fiber.dispose().catch(() => undefined)
    }
  }, 30_000)
})
