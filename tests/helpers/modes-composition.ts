/**
 * Shared harness for the M2-3 orchestration-mode and dual-owner suites
 * (issue #77): the full official composition (AgentLoop + durable stack +
 * continuable subagents) with the swarm plugin's `orchestrationMode` /
 * `workflowBridge` co-config, one gated content-aware member adapter whose
 * turns park until released and whose assignment turns either submit a real
 * `agent_swarm_submit_task` call or park forever, and the followup spy both
 * suites use to prove single-delivery (no double wake).
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
import { expect, vi } from 'vitest'
import * as AgentSwarm from '../../src/index.js'
import { mountStorageStackOn } from './storage-stack.js'

/** Assignment-frame identity fields a member must echo in its submission. */
const ASSIGNMENT_RE = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/

/** The per-test plugin co-config the M2-3 suites vary over. */
export interface ModesPluginConfig {
  readonly orchestrationMode?: 'adaptive' | 'workflow'
  readonly workflowBridge?: boolean
  /** Stranded-ownership grace bound; small when a suite needs the window. */
  readonly strandedAfterMs?: number
  /** Roster quota passthrough (node-mapping suite's fan-out backpressure). */
  readonly maxMembers?: number
  /**
   * Fixed captain session id for the mounted lead (the reload suites remount
   * the same sandbox and need the same durable captain identity); random by
   * default.
   */
  readonly leadSessionId?: string
  /** Per-attempt execution-root co-config (M3-1, issue #100). */
  readonly executionRoots?: boolean
  readonly executionRootsBase?: string
}

export interface ModesComposition {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly adapter: GatedMemberAdapter
  readonly lead: Agent
}

/**
 * Content-aware gated member adapter: every model turn parks on the gate
 * (deterministic `running` membership, abortable like a cancelled call) and
 * decides only at release. A released turn that carries a Team assignment
 * frame answers with one real `agent_swarm_submit_task` tool call when
 * {@link submit} is armed, or plain text when it is not (the parked-owner
 * scenarios); every other turn answers plain text. Flipping {@link submit}
 * between turns re-arms the behavior of the next release.
 */
export class GatedMemberAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private calls = 0
  private gate: Promise<void>
  private releaseCurrent!: () => void

  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
  }

  /** Whether the next released assignment turn submits (`false` = park). */
  submit = false

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /** Release the currently held turns; later turns are held again. */
  open(): void {
    const release = this.releaseCurrent
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
    release()
  }

  private lastUserText(options: GenerateOptions): string {
    for (let index = options.messages.length - 1; index >= 0; index -= 1) {
      const message = options.messages[index]!
      if (message.role !== 'user') continue
      return message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    }
    return ''
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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
        void this.gate.then(admit, admit)
      })
    } else {
      await this.gate
    }
    // Decision at release time: a flip between turns re-arms the behavior.
    const assignment = ASSIGNMENT_RE.exec(this.lastUserText(options))
    if (this.submit && assignment !== null) {
      const [, taskId, revision, attemptId] = assignment
      const id = CallId(`modes-submit-${(this.calls += 1)}`)
      const args = JSON.stringify({
        task_id: taskId,
        expected_revision: Number(revision),
        attempt_id: attemptId,
        output: `Modes member output for ${taskId}.`,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_submit_task', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_submit_task', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 24 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Member parked.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Member parked.' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mount the official composition with the swarm plugin's M2-3 co-config. */
export async function mountModesComposition(sandbox: string, config: ModesPluginConfig): Promise<ModesComposition> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    schedulerProvider: 'priority-ready',
    reviewProvider: 'manual',
    ...(config.orchestrationMode === undefined ? {} : { orchestrationMode: config.orchestrationMode }),
    ...(config.workflowBridge === undefined ? {} : { workflowBridge: config.workflowBridge }),
    ...(config.strandedAfterMs === undefined ? {} : { strandedAfterMs: config.strandedAfterMs }),
    ...(config.maxMembers === undefined ? {} : { maxMembers: config.maxMembers }),
    ...(config.executionRoots === undefined ? {} : { executionRoots: config.executionRoots }),
    ...(config.executionRootsBase === undefined ? {} : { executionRootsBase: config.executionRootsBase }),
  }))
  const adapter = new GatedMemberAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(config.leadSessionId ?? `modes-lead-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  return { ctx, fibers, adapter, lead }
}

const SIGNAL = new AbortController().signal

/** One captain tool call over the real tools service. */
export async function toolCall(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

/** One recorded followup delivery with its text (single-delivery proofs). */
export interface FollowupTextRecord { readonly text: string }

/** Spy on `ctx.subagents.followup`, recording every text frame delivered. */
export function spyFollowupText(composition: ModesComposition): { readonly records: FollowupTextRecord[]; restore(): void } {
  const records: FollowupTextRecord[] = []
  const { ctx } = composition
  const followup = ctx.subagents.followup.bind(ctx.subagents)
  const spy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
    for (const block of content) {
      if (block.type === 'text') records.push({ text: block.text })
    }
    return await followup(parent, childId, content, options)
  })
  return { records, restore: () => spy.mockRestore() }
}

/** The billed tokens of one session's assistant events (budget expectation). */
export function billedTokensOf(agent: Agent | undefined): number {
  if (agent === undefined) return 0
  let tokens = 0
  for (const event of agent.session.events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    tokens += event.data.usage.inputTokens
      + event.data.usage.outputTokens
      + (event.data.usage.cacheReadTokens ?? 0)
      + (event.data.usage.cacheWriteTokens ?? 0)
  }
  return tokens
}

/** Capture the TeamDomainError one synchronous runtime call must throw. */
export function captureDomainError(action: () => void): AgentSwarm.TeamDomainError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSwarm.TeamDomainError)
    return error as AgentSwarm.TeamDomainError
  }
  throw new Error('expected a TeamDomainError, got a resolution')
}
