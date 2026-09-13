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
import { expect } from 'vitest'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, ToolCallId, LlmAdapter, type GenerateOptions, type LlmCallConfig, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
  readonly requests: Array<{ sessionId: string; toolNames: string[]; options: GenerateOptions }> = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sessionId: String(options.sessionId ?? ''), toolNames: (options.tools ?? []).map(definition => definition.name), options })
    for (const chunk of textResponse('Passive.')) yield chunk
  }
}

export interface Mounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
}

export interface MountOptions {
  toolPolicyDeny?: string[]
  /** Explicit operator ASK tier (narrowing pass-through; default behavior unchanged). */
  toolPolicyAsk?: string[]
  /** Host-configured recall tier; unknown to the pre-M2 config, passed through. */
  privateMemoryRecall?: 'disabled' | 'active-task'
  /** An OUTER `llm/stream` waterfall listener, registered BEFORE the plugin,
   *  so plugin-side recall runs INNER (closer to the adapter's next). */
  llmStreamOuterGate?: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
  /** An OUTER `system-prompt/assemble` waterfall listener, registered BEFORE
   *  the AgentSwarm plugin (mirroring the llm/stream outer gate), so the hook
   *  sits outermost: after `await next()` it observes/adjusts the FINAL
   *  assembly, including everything the plugin and other inner listeners
   *  contributed on the return path. Official waterfall signature only. */
  assemblyHook?: (assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>
  /** An `agent/request` waterfall listener registered AFTER the AgentSwarm
   *  plugin: runs inside the official per-step request window after assembly
   *  froze (dsh-agent-loop lib/index.js:1143-1153), on the official payload
   *  { agent, turn, step, signal } → Promise<LlmCallConfig>. */
  agentRequestHook?: (payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>
}

export async function mount(sandbox: string, options: MountOptions = {}): Promise<Mounted> {
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
  if (options.llmStreamOuterGate !== undefined) {
    const gate = options.llmStreamOuterGate
    ctx.on('llm/stream', (gateOptions, next) => gate(gateOptions, next))
  }
  if (options.assemblyHook !== undefined) {
    const hook = options.assemblyHook
    ctx.on('system-prompt/assemble', async (assembly, context, next) => await hook(assembly, context, next))
  }
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    ...(options.toolPolicyDeny === undefined && options.toolPolicyAsk === undefined ? {} : {
      toolPolicy: {
        ...(options.toolPolicyDeny === undefined ? {} : { deny: options.toolPolicyDeny }),
        ...(options.toolPolicyAsk === undefined ? {} : { ask: options.toolPolicyAsk }),
      },
    }),
    ...(options.privateMemoryRecall === undefined ? {} : { privateMemoryRecall: options.privateMemoryRecall } as Record<string, unknown>),
  }))
  if (options.agentRequestHook !== undefined) {
    const hook = options.agentRequestHook
    ctx.on('agent/request', async (request, next) => await hook(request as { agent: Agent; turn: number; step: number; signal: AbortSignal }, next))
  }
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

/**
 * Hold an explicitly resumed Agent after its provider-owned initial turn
 * settles. `agentOptions` is only needed when the resumed handle will drive
 * model calls (a bare resume carries no provider/model route; see dsh-agent-
 * loop resumeWith → setupAndPublish(options.agentOptions ?? {})). M1's
 * storage-tool usage keeps the bare default.
 */
export async function memberAgent(ctx: Context, memberId: string, agentOptions?: { provider: string; model: string }): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const captain = ctx.agents.get(CAPTAIN)!
  await ctx.subagents.drainContinuableChildren(captain, [SessionId(memberId)])
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(memberId), ...(agentOptions === undefined ? {} : { agentOptions }) })
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

// ---------------------------------------------------------------------------
// Recall-composition helpers (moved verbatim from
// tests/member-private-memory-recall-real-composition.spec.ts for reuse by
// the context slice; semantics and public paths unchanged).
// ---------------------------------------------------------------------------

export const RECALL_MARKER = '<private-memory-recall'

export function requestText(request: { options: GenerateOptions }): string {
  const blocks = (request.options.messages ?? []).flatMap(message => [...message.content])
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

export function memberRequests(adapter: PassiveAdapter, memberId: string) {
  return adapter.requests.filter(request => request.sessionId === memberId)
}

/** One real AgentLoop turn: official follow-up prompt, settled at whenIdle. */
export async function runMemberTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

export interface Setup {
  readonly lead: Agent
  readonly teamId: string
  readonly memberId: string
  readonly memberName: string
}

export async function setupActiveMember(mounted: Mounted, memberName: string, workspaceCwd: string): Promise<Setup> {
  const lead = await mounted.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: workspaceCwd })
  const created = await tool(mounted.ctx, lead, 'rc-create', 'agent_swarm_create', {
    name: 'Recall proof', description: 'Prove active-task private-memory recall.',
  })
  expect(created.isError).toBe(false)
  const teamId = (created.value as { team_id: string }).team_id
  const added = await tool(mounted.ctx, lead, 'rc-add', 'agent_swarm_add_member', { name: memberName, role: 'Owns the recall proof.' })
  expect(added.isError).toBe(false)
  const memberId = (added.value as { session_id: string }).session_id
  await pollUntil(async () => {
    const current = await snapshot(mounted.ctx, lead, teamId)
    return current.team.members.some(row => row.sessionId === memberId && row.phase === 'active')
  })
  // Deterministic idle point BEFORE any baseline: the activation turn (and
  // its model request) fully settled through the official drain seam.
  await mounted.ctx.subagents.drainContinuableChildren(lead, [SessionId(memberId)])
  return { lead, teamId, memberId, memberName }
}

export async function claimRecallTask(mounted: Mounted, setup: Setup): Promise<void> {
  const domain = mounted.ctx.agentSwarm.domain
  const scope = mounted.ctx.agentSwarm.scopeOf(setup.lead)
  const task = await domain.createTask(scope, AgentSwarm.TeamId(setup.teamId), String(CAPTAIN), {
    subject: 'recallprobe selection exercise',
    description: 'the recallprobe note informs the selection exercise',
    acceptanceCriteria: ['recallprobe evidence handled'],
  })
  await domain.claimTask(scope, AgentSwarm.TeamId(setup.teamId), String(CAPTAIN), task.id, task.revision, SessionId(setup.memberId))
}

export async function writeMatchingNote(mounted: Mounted, agent: Agent): Promise<{ memoryId: string; headSeq: number }> {
  const wrote = await tool(mounted.ctx, agent, 'rc-note', 'agent_swarm_maintain_private_memory', {
    operation: 'add', operation_id: 'op-recall-note', content: 'recallprobe lesson: bind head CAS to the newest operation seq',
    evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
  })
  expect(wrote.isError).toBe(false)
  const value = wrote.value as { result_memory_id: string; head_seq: number }
  return { memoryId: value.result_memory_id, headSeq: value.head_seq }
}

/**
 * Root gap ① (request-bound admission): capture the frozen request OPTIONS
 * only; every re-entry is a NEW public `ctx.llm.stream(frozen)` dispatch,
 * which re-runs the whole `llm/stream` waterfall (outer gate + the plugin's
 * own guard). The captured waterfall `next()` closure is deliberately NOT
 * re-invoked — cordis composes it with a destructive `cbs.shift()`, so a
 * second call bypasses every guard and would fake a RED. The gate's
 * cumulative `entries` count proves each re-entry really re-ran the guards.
 * Honest layer: this covers the public `llm/stream` dispatch entry; it does
 * NOT claim to exercise the separate `dsh-llm-retry` / `agent/request-error`
 * official recovery policy. Observable refusal = the public stream ITERATOR
 * throws (the official contract keeps middleware/consumer failures thrown;
 * only adapter-level failures become error finish chunks — the test never
 * fabricates or asserts finish blocks).
 */
export interface CaptureState {
  targetSessionId: string
  entries: number
  frozen: GenerateOptions | undefined
}

export async function reentryOnce(ctx: Context, frozen: GenerateOptions): Promise<{ threw: boolean }> {
  try {
    for await (const chunk of ctx.llm.stream(frozen)) {
      void chunk // Drain; only the terminal observable behavior matters.
    }
    return { threw: false }
  } catch {
    return { threw: true }
  }
}

/** Durable invalidation through the member's own live tool face, verified by official read-back. */
export async function invalidateNote(mounted: Mounted, member: Agent, note: { memoryId: string; headSeq: number }): Promise<void> {
  const invalidated = await tool(mounted.ctx, member, 'rc-bound-invalidate', 'agent_swarm_maintain_private_memory', {
    operation: 'invalidate', operation_id: 'op-bound-invalidate', target_memory_id: note.memoryId, expected_head_seq: note.headSeq,
  })
  expect(invalidated.isError, 'the durable invalidation must succeed').toBe(false)
  const listed = await tool(mounted.ctx, member, 'rc-bound-list', 'agent_swarm_list_private_memory', {})
  const rows = (listed.value as { memories: Array<{ memory_id: string; status: string }> }).memories
  expect(rows.find(row => row.memory_id === note.memoryId)?.status).toBe('invalidated')
}

/**
 * The CURRENT private contribution text carried by the LATEST official
 * runtime-context message (named snapshot sections), or '' when absent —
 * the official read shared by late-change assertions (never scanning all
 * history to fish a PASS).
 */
export function latestNamedContribution(options: GenerateOptions, name: string): string {
  const latest = (options.messages ?? []).findLast(message => message.role === 'user' && message.source?.kind === 'plugin'
    && message.source.plugin === '@deepseek-ai/dsh-system-prompt')
  if (latest === undefined) return ''
  const source = latest.source
  if (source === undefined || !('sections' in source)) return ''
  return (source as { readonly sections: ReadonlyArray<{ name: string; text: string }> })
    .sections.filter(section => section.name === name).map(section => section.text).join('')
}

/** Mounting + active member + eligible task + one matching note, all real official steps. */
export async function boundSetup(mounted: Mounted, memberName: string, workspaceCwd: string, memberModel = 'mock'): Promise<{ setup: Setup; resolved: { agent: Agent; dispose: () => Promise<void> }; note: { memoryId: string; headSeq: number } }> {
  const setup = await setupActiveMember(mounted, memberName, workspaceCwd)
  const resolved = await memberAgent(mounted.ctx, setup.memberId, { provider: 'mock', model: memberModel })
  expect(mounted.ctx.agents.get(SessionId(setup.memberId))).toBe(resolved.agent)
  await claimRecallTask(mounted, setup)
  const note = await writeMatchingNote(mounted, resolved.agent)
  return { setup, resolved, note }
}
