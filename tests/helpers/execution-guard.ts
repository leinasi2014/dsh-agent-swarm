import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as AgentSwarm from '../../src/index.js'
import { mountStorageStackOn } from './storage-stack.js'

export class GuardAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(readonly generate: (options: GenerateOptions, index: number) => AsyncIterable<StreamChunk>) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return this.generate(options, this.requests.length)
  }
}
export async function* toolChunks(index: number, name: string, args: unknown = {}): AsyncIterable<StreamChunk> {
  const id = ToolCallId(`guard-call-${index}`)
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
export async function* doneChunks(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'Done.' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
export function prompt(text = 'Exercise the bounded execution guard.') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
export async function mountGuard(adapter: GuardAdapter, config: AgentSwarm.Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-execution-guard-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const dispose = async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
    fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions.db') }))
    await mountStorageStackOn(ctx, join(root, 'storage'))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
    fibers.push(await ctx.plugin(SubagentService))
    fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
    const plugin = await ctx.plugin(AgentSwarm, { ...config, strandedAfterMs: 0 })
    fibers.push(plugin)
    ctx.llm.registerAdapter(['guard'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('guard-captain'), { provider: 'guard', model: 'guard' }, { cwd: root })
    const execute = async (name: string, args: unknown = {}, target: Agent = agent) => await ctx.tools.execute({
      agent: target, callId: ToolCallId(`setup-${name}`), name, arguments: args, signal: new AbortController().signal,
    })
    const created = await execute('agent_swarm_create', { name: 'Guard', description: 'Real execution containment.' })
    if (created.isError) throw new Error(JSON.stringify(created.error))
    return { ctx, agent, plugin, execute, dispose, fibers, root }
  } catch (error) { await dispose(); throw error }
}
