/**
 * Shared harness for the real-composition scheduling suites (issues #12):
 * the official AgentLoop + in-process spawn + JSONL persistence + storage
 * stack graph, one gated LLM adapter that holds member turns open for
 * deterministic `running`/`idle` membership, and the small probes the
 * scheduling-discipline and stranded-ownership specs share.
 */
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { vi } from 'vitest'
import * as AgentSwarm from '../../src/index.js'
import { mountStorageStackOn } from './storage-stack.js'

export const SIGNAL = new AbortController().signal

/**
 * Holds member model turns open until `open()` (same contract as the
 * official-compat suite): every held turn keeps its agent deterministically
 * `running`, and each `open()` releases exactly the currently held turns
 * while re-arming for later ones. The hold is abortable, so an interrupt or
 * drain rejects the stream like a cancelled network call.
 */
export class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private gate: Promise<void>
  private releaseCurrent!: () => void

  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const held = this.gate
    const signal = options.signal
    if (signal !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) {
          abort()
          return
        }
        const admit = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        signal.addEventListener('abort', abort, { once: true })
        void held.then(admit, admit)
      })
    } else {
      await held
    }
    const text = 'Held turn released.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Release the currently held turns; later turns are held again. */
  open(): void {
    const release = this.releaseCurrent
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
    release()
  }
}

export async function toolCall(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

export interface Composition {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly adapter: GatedAdapter
  readonly pluginFiber: Fiber
  readonly lead: Agent
  readonly teamId: string
  readonly scope: string
}

/** Mount the real composition with the given grace bound and scheduler Provider. */
export async function mount(
  sandbox: string,
  strandedAfterMs: number,
  schedulerProvider: string = 'priority-ready',
  pluginOptions: { jobsBridge?: boolean, executionRoots?: boolean, executionRootsBase?: string } = {},
): Promise<Composition> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const adapter = new GatedAdapter()
  await mountAgentLoopTestDependencies(ctx)
  // Tracked so teardown disposes the sqlite handle before the caller's
  // sandbox cleanup deletes the database directory (Windows: an open
  // node:sqlite handle blocks deletion with EPERM/EBUSY).
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  const pluginFiber = await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs, schedulerProvider,
    jobsBridge: pluginOptions.jobsBridge === true,
    ...(pluginOptions.executionRoots === undefined ? {} : { executionRoots: pluginOptions.executionRoots }),
    ...(pluginOptions.executionRootsBase === undefined ? {} : { executionRootsBase: pluginOptions.executionRootsBase }),
  })
  fibers.push(pluginFiber)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`sched-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await toolCall(ctx, lead, 'create', 'agent_swarm_create', {
    name: 'Scheduling discipline team', description: 'Prove the F10 scheduler discipline over real services.',
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  const teamId = (created.value as { team_id: string }).team_id
  return { ctx, fibers, adapter, pluginFiber, lead, teamId, scope: ctx.agentSwarm.scopeOf(lead) }
}

export async function addMember(composition: Composition, name: string): Promise<string> {
  const added = await toolCall(composition.ctx, composition.lead, `add-${name}`, 'agent_swarm_add_member', {
    name, role: 'Exercise the F10 scheduling discipline.',
  })
  if (added.isError) throw new Error(`add_member failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

export async function snapshotOf(composition: Composition) {
  return await composition.ctx.agentSwarm.domain.snapshot(
    composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id,
  )
}

/** One recorded followup delivery with the target's live status at call time. */
export interface FollowupRecord { readonly text: string; readonly targetStatus: 'idle' | 'running' | 'cold' }

export function spyFollowup(composition: Composition): { readonly records: FollowupRecord[]; restore(): void } {
  const records: FollowupRecord[] = []
  const { ctx } = composition
  const followup = ctx.subagents.followup.bind(ctx.subagents)
  const spy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
    for (const block of content) {
      if (block.type === 'text') {
        const live = ctx.agents.get(childId)
        records.push({ text: block.text, targetStatus: live === undefined ? 'cold' : live.status })
      }
    }
    return await followup(parent, childId, content, options)
  })
  return { records, restore: () => spy.mockRestore() }
}

/**
 * Release held turns until the captain stays idle: every settled continuable
 * child wakes the captain with a settlement notice, so one gate opening can
 * queue several notice turns that must all drain before the captain's
 * recovery path can drive a scheduling pass.
 */
export async function settleCaptain(adapter: GatedAdapter, lead: Agent): Promise<void> {
  await vi.waitFor(async () => {
    adapter.open()
    await new Promise(resolve => setTimeout(resolve, 150))
    expectIdle(lead)
  }, { timeout: 5_000 })
}

/**
 * Deterministically drive captain-recovery scheduling passes until `assert`
 * holds. `recoverAgent` only requests a pass while the captain is `idle`
 * (correct product semantics: a mid-work agent must not self-schedule), and
 * on a slow runner a settlement notice can land after `settleCaptain`'s exit
 * window, holding the captain `running` on a gated turn. Each poll therefore
 * releases the currently held turns (letting such notices settle) and
 * re-drives the recovery path whenever the captain is idle, until the
 * caller's condition is met. Only safe while a premature gate opening is
 * harmless (members cold or mid-idempotent reserved re-delivery) — for
 * windows that depend on a member turn staying held, use `settleCaptain`
 * once and a single explicit drive instead.
 */
export async function driveRecoveryPasses(
  composition: Composition,
  assert: () => void | Promise<void>,
): Promise<void> {
  await vi.waitFor(async () => {
    composition.adapter.open()
    if (composition.lead.status === 'idle') await composition.ctx.agentSwarm.recoverAgent(composition.lead)
    await assert()
  }, { timeout: 15_000 })
}

function expectIdle(lead: Agent): void {
  if (lead.status !== 'idle') throw new Error(`captain is ${lead.status}, expected idle`)
}
