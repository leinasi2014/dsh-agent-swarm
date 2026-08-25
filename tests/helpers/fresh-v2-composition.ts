import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  isAgentLoopRequest,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as AgentSwarm from '../../src/index.js'
import type { TeamStateV2 } from '../../src/domain/team-state-v2.js'
import { mountStorageStackOn } from './storage-stack.js'

export const FRESH_V2_SIGNAL = new AbortController().signal
export const FRESH_V2_ARTIFACT_CONTRACT = 'a'.repeat(64)

export async function freshV2ToolCall(
  ctx: Context,
  agent: Agent,
  callId: string,
  name: string,
  args: unknown,
) {
  const result = await ctx.tools.execute({
    signal: FRESH_V2_SIGNAL,
    callId: CallId(callId),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  return result.value
}

interface AdapterEntry {
  readonly marked: boolean
  readonly phase: string | undefined
  readonly dispatchPhase: string | undefined
}

export class WitnessProbeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entries: AdapterEntry[] = []
  private held: Promise<void>
  private release!: () => void

  constructor(private readonly state: () => TeamStateV2 | undefined) {
    super()
    this.held = new Promise<void>(resolveHeld => { this.release = resolveHeld })
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const snapshot = this.state()
    const attempt = snapshot?.attempts.find(candidate => candidate.phase === 'reserved' || candidate.phase === 'running')
    this.entries.push({
      marked: isAgentLoopRequest(options),
      phase: attempt?.phase,
      dispatchPhase: attempt?.dispatchEpochs[0]?.phase,
    })
    await this.held
    const text = 'A1b official loop response.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  open(): void { this.release() }
}

export class FailingStreamAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('injected adapter failure')),
      }),
    }
  }
}

export interface FreshV2Composition<T extends LlmAdapter> {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly workspace: string
  readonly storageRoot: string
  readonly adapter: T
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly pluginFiber: Fiber
}

export async function mountFreshV2Composition<T extends LlmAdapter>(
  sandbox: string,
  makeAdapter: (ctx: Context, workspace: string) => T,
  config: Partial<AgentSwarm.Config> = {},
): Promise<FreshV2Composition<T>> {
  const workspace = resolve(sandbox, 'workspace')
  const storageRoot = join(sandbox, 'storage')
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, storageRoot)
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  const adapter = makeAdapter(ctx, workspace)
  ctx.llm.registerAdapter(['mock'], adapter)
  const pluginFiber = await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    experimentalFreshV2: true,
    freshV2ArtifactContract: FRESH_V2_ARTIFACT_CONTRACT,
    ...config,
  })
  fibers.push(pluginFiber)
  const lead = ctx.agentLoop.create(
    SessionId(`a1b-lead-${Date.now()}-${Math.random()}`),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace },
  )
  return { ctx, fibers, workspace, storageRoot, adapter, lead, pluginFiber }
}
