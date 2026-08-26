/**
 * Real Human Control admission beside the model-only interrupt evidence gate.
 *
 * The child is running an ordinary gated text turn (no tool/call event): the
 * model tool therefore cannot interrupt it, while a host-attested typed Human
 * Control request retains the intentional trusted Host/Human control path.
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { HumanInteractionRequest } from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

class GatedAdapter extends LlmAdapter {
  private releaseGate!: () => void
  private readonly gate = new Promise<void>(resolve => { this.releaseGate = resolve })

  open(): void {
    this.releaseGate()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await this.gate
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
}

async function mount(sandbox: string, adapter: GatedAdapter): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`human-interrupt-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('human-interrupt-create'),
    name: 'agent_swarm_create',
    arguments: { name: 'Human interrupt team', description: 'Exercise the authenticated Human Control interrupt boundary.' },
    agent: lead,
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  return { ctx, fibers, lead, teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id), scope: ctx.agentSwarm.scopeOf(lead) }
}

async function addWorker(stack: Stack): Promise<string> {
  const added = await stack.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('human-interrupt-add-worker'),
    name: 'agent_swarm_add_member',
    arguments: { name: 'worker', role: 'Human Control interruption target.' },
    agent: stack.lead,
  })
  if (added.isError) throw new Error(`add failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

async function snapshot(stack: Stack) {
  return await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
}

const roots: string[] = []
const stacks: Stack[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) {
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('authenticated Human Control interrupt', () => {
  it('keeps the exact-child Host/Human path when model timeout evidence is absent', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-human-interrupt-'))
    roots.push(sandbox)
    const adapter = new GatedAdapter()
    const stack = await mount(sandbox, adapter)
    stacks.push(stack)
    const memberSessionId = await addWorker(stack)
    const wake = await stack.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('human-interrupt-wake'),
      name: 'agent_swarm_send_message',
      arguments: { target: 'worker', content: 'Run the ordinary assigned turn.', delivery: 'wakeup' },
      agent: stack.lead,
    })
    expect(wake.isError).toBe(false)
    await vi.waitFor(() => {
      expect(stack.ctx.agents.get(SessionId(memberSessionId))?.status).toBe('running')
    }, { timeout: 5_000 })
    const exactChild = stack.ctx.agents.get(SessionId(memberSessionId))
    expect(exactChild).toBeDefined()
    expect(exactChild!.session.events.some(event => event.type === 'tool/call')).toBe(false)

    const interrupt = vi.spyOn(stack.ctx.subagents, 'interrupt')
    const before = await snapshot(stack)
    const modelAttempt = await stack.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('human-interrupt-model-without-evidence'),
      name: 'agent_swarm_interrupt_member',
      arguments: { name: 'worker' },
      agent: stack.lead,
    })
    expect(modelAttempt).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INTERRUPT_EVIDENCE_REQUIRED' } } })
    expect(interrupt).not.toHaveBeenCalled()
    expect(await snapshot(stack)).toEqual(before)

    const unregisterVerifier = stack.ctx.agentSwarmPermission.registerHumanPrincipalVerifier({
      kind: 'human-principal-verifier',
      name: 'human-interrupt-attested-host',
      verify: async (principalRef, request) => principalRef === 'operator-human-interrupt'
        && request.teamId === stack.teamId
        && request.source.captainSessionId === stack.lead.id,
    })
    try {
      const request: HumanInteractionRequest = {
        schemaVersion: 1,
        requestId: 'human-attested-interrupt-00000001',
        teamId: stack.teamId,
        source: {
          kind: 'authenticated-human',
          captainSessionId: stack.lead.id,
          principalRef: 'operator-human-interrupt',
          hostSurface: 'test-host-human-control',
        },
        target: { kind: 'member', memberName: 'worker' },
        intent: 'interrupt-member',
        expectedTeamRevision: before.team.revision,
        createdAt: Date.now(),
      }
      const receipt = await stack.ctx.agentSwarmHumanControl.submit(
        stack.scope,
        request,
        { kind: 'authenticated-human', principalRef: 'operator-human-interrupt' },
        new AbortController().signal,
      )
      expect(receipt).toMatchObject({
        requestId: request.requestId,
        teamId: stack.teamId,
        status: 'executed',
        resultingTeamRevision: before.team.revision,
      })
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(interrupt).toHaveBeenCalledWith(SessionId(memberSessionId), { kind: 'ancestor', agent: stack.lead })
      expect(stack.ctx.agents.get(SessionId(memberSessionId))).toBe(exactChild)
      expect(await snapshot(stack)).toEqual(before)
      const receipts = await stack.ctx.agentSwarmHumanInteraction.listReceipts(
        stack.scope, stack.teamId, { exec: { agent: stack.lead, signal: SIGNAL } },
      )
      expect(receipts.find(item => item.requestId === request.requestId)).toMatchObject({ status: 'executed' })

      adapter.open()
      await stack.ctx.subagents.drainContinuableChildren(stack.lead, [SessionId(memberSessionId)])
      await vi.waitFor(() => {
        expect(stack.ctx.agents.get(SessionId(memberSessionId))).toBeUndefined()
      }, { timeout: 5_000 })
    } finally {
      adapter.open()
      unregisterVerifier()
      interrupt.mockRestore()
    }
  }, 30_000)
})
