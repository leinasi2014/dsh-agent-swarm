/**
 * Shared REAL-composition harness for the member-private-memory specs
 * (task-4 split, M-owned): a full official plugin stack (two contexts can be
 * mounted side by side over ONE real SQLite Session store and ONE real JSON
 * Storage Domain root), a recording LLM adapter that attributes every model
 * request to its issuing Session via `GenerateOptions.sessionId`, and the
 * official tool/snapshot/resume helpers the specs share. No mocks stand in
 * for host assembly.
 */
import SessionProjectionService from '@deepseek-ai/dsh-session-projection'
import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as AgentSwarm from '../../src/index.js'

export const SIGNAL = new AbortController().signal
export const CAPTAIN = SessionId('private-memory-real-captain')

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export class PassiveAdapter extends LlmAdapter {
  /** Per-request causality: which Session issued the request and its tool face. */
  readonly requests: Array<{ sessionId: string; toolNames: string[] }> = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sessionId: String(options.sessionId ?? ''), toolNames: (options.tools ?? []).map(definition => definition.name) })
    for (const chunk of textResponse('Passive.')) yield chunk
  }
}

export interface Mounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
}

export async function mount(sandbox: string, options: { toolPolicyDeny?: string[] } = {}): Promise<Mounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions', 'sessions.db') }))
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  await ctx.plugin(SessionProjectionService)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    ...(options.toolPolicyDeny === undefined ? {} : { toolPolicy: { deny: options.toolPolicyDeny } }),
  }))
  return { ctx, fibers }
}

export async function dispose(mounted: Mounted): Promise<void> {
  for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
}

export async function tool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId(callId), name, arguments: args, agent })
}

export async function snapshot(ctx: Context, lead: Agent, teamId: string) {
  return await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
}

/** Hold an explicitly resumed Agent after its provider-owned initial turn settles. */
export async function memberAgent(ctx: Context, memberId: string): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const captain = ctx.agents.get(CAPTAIN)!
  await ctx.subagents.drainContinuableChildren(captain, [SessionId(memberId)])
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(memberId) })
  return { agent: resumed.agent, dispose: async () => { await resumed.dispose() } }
}

/** Poll an async predicate until it holds (bounded, default 15s). */
export async function pollUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('pollUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Wait until the Team revision is stable across a quiet window, then return. */
export async function quiesceRevision(ctx: Context, lead: Agent, teamId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = -1
  for (;;) {
    const current = (await snapshot(ctx, lead, teamId)).team.revision
    if (current === last) {
      await new Promise(resolve => setTimeout(resolve, 120))
      const recheck = (await snapshot(ctx, lead, teamId)).team.revision
      if (recheck === current) return
      last = recheck
    } else {
      last = current
    }
    if (Date.now() > deadline) throw new Error('Team revision did not quiesce')
  }
}
