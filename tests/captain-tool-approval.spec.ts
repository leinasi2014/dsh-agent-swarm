import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, LlmAdapter, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService, { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
async function mount(adapter?: ApprovalAdapter, beforeActivate?: (ctx: Context) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'captain-gate-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  cleanup.push(() => persistence.dispose())
  await mountStorageStackOn(ctx, join(root, 'storage'))
  const loop = await ctx.plugin(AgentLoop, { agents: [] }); cleanup.push(() => loop.dispose())
  const subagents = await ctx.plugin(SubagentService); cleanup.push(() => subagents.dispose())
  const spawn = await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }); cleanup.push(() => spawn.dispose())
  const plugin = await ctx.plugin(AgentSwarm, { toolPolicy: { ask: ['approval_probe'] },
    ...(adapter === undefined ? {} : { memberLlmProvider: 'approval-mock', memberModel: 'mock' }),
  })
  cleanup.push(() => plugin.dispose())
  let effects = 0
  ctx.tools.register(defineTool({ name: 'approval_probe', description: 'A counted effect.', parameters: { value: { type: 'integer', required: true } },
    output: { schema: { type: 'integer' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async args => { effects++; return args.value } }))
  if (adapter !== undefined) ctx.llm.registerAdapter(['approval-mock'], adapter)
  const captain = await ctx.agentLoop.create(SessionId('captain'), adapter === undefined ? {} : { provider: 'approval-mock', model: 'mock' }, { cwd: root })
  const memberHeader = { cwd: root, parentSession: captain.id }
  const scope = ctx.agentSwarm.scopeOf(captain)
  const team = await ctx.agentSwarm.domain.createTeam(scope, captain.id, 'Permission test', 'Concrete member approval gate')
  if (beforeActivate !== undefined) {
    const settle = ctx.agentSwarm.domain.settleMember.bind(ctx.agentSwarm.domain)
    vi.spyOn(ctx.agentSwarm.domain, 'settleMember').mockImplementation(async (...args) => {
      if (args[3].active) await beforeActivate(ctx)
      return await settle(...args)
    })
  }
  const add = adapter === undefined ? undefined : await ctx.tools.execute({ agent: captain, name: 'agent_swarm_add_member',
    arguments: { name: 'worker', role: 'Run the approval probe once' }, signal: new AbortController().signal, callId: ToolCallId('add-worker') })
  if (add?.isError) throw new Error(JSON.stringify(add.error))
  const member = add === undefined ? await ctx.agentLoop.create(SessionId('member'), {}, memberHeader)
    : ctx.agents.get(SessionId((add.value as { session_id: string }).session_id))!
  if (adapter === undefined) {
    await ctx.agentSwarm.domain.provisionMember(scope, team.id, captain.id, { name: 'worker', role: 'worker', sessionId: member.id, provider: 'spawn' })
    await ctx.agentSwarm.domain.settleMember(scope, team.id, member.id, { active: true })
    member.session.append('turn/start', { turn: 1 })
    captain.session.append('turn/start', { turn: 1 })
  }
  let notice = ''
  const deliverySpy = vi.spyOn(ctx.agentSwarm, 'sendMessage')
  if (adapter === undefined) deliverySpy.mockImplementation(async (exec, target, content, delivery) => {
    notice = content
    const message = await ctx.agentSwarm.domain.queueMessage(scope, team.id, exec.agent!.id, target, content, delivery)
    return await ctx.agentSwarm.domain.acknowledgeMessage(scope, team.id, message.id)
  })
  const call = (agent: typeof member, name: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
    ctx.tools.execute({ agent, name, arguments: args, signal, callId: ToolCallId(crypto.randomUUID()) })
  return { ctx, captain, member, call, plugin, teamId: team.id, scope, effects: () => effects,
    requestId: () => JSON.parse(notice).request_id as string,
    requestData: () => JSON.parse(notice) as { call_id: string; root_call_id: string },
  }
}

/** Only model output is scripted; the runtime, resident children, mail and logs are real. */
class ApprovalAdapter extends LlmAdapter {
  private release!: () => void
  private readonly gate = new Promise<void>(resolve => { this.release = resolve })
  private memberIssued = false
  private readonly decisions = new Set<string>()
  readonly requests: GenerateOptions[] = []
  open(): void { this.release() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await new Promise<void>((resolve, reject) => {
      const abort = () => { reject(new Error('aborted')) }
      if (options.signal?.aborted) { abort(); return }
      options.signal?.addEventListener('abort', abort, { once: true })
      void this.gate.then(() => { options.signal?.removeEventListener('abort', abort); resolve() })
    })
    const text = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const requestId = /"request_id":"([a-z0-9-]+)"/.exec(text)?.[1]
    let tool: { name: string; args: Record<string, unknown> } | undefined
    if (requestId !== undefined && !this.decisions.has(requestId)) {
      this.decisions.add(requestId)
      tool = { name: 'agent_swarm_decide_tool_approval', args: { request_id: requestId, decision: 'approve' } }
    } else if (requestId === undefined && !this.memberIssued && text.includes('You joined Team')) {
      this.memberIssued = true
      tool = { name: 'approval_probe', args: { value: 42 } }
    }
    if (tool !== undefined) {
      const id = ToolCallId(crypto.randomUUID()), args = JSON.stringify(tool.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool.name, arguments: args } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: tool === undefined ? 'stop' : 'tool-calls' } }
  }
}

it('runs a resident member through real mailbox wakeup, Captain decision and canonical tool logs', async () => {
  const adapter = new ApprovalAdapter()
  const stack = await mount(adapter)
  expect(stack.effects()).toBe(0)
  adapter.open()
  await vi.waitFor(() => expect(stack.effects()).toBe(1), { timeout: 5_000 })
  await stack.member.whenIdle()
  await stack.captain.whenIdle()
  await stack.ctx.subagents.drainContinuableChildren(stack.captain, [stack.member.id])
  await stack.ctx.sessions.flush(stack.captain.session)
  const snap = await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.captain.id)
  const message = snap.team.messages.find(row => row.content.includes('member_tool_approval'))
  expect(message).toMatchObject({ phase: 'delivered', senderSessionId: stack.member.id, targetSessionId: stack.captain.id })
  const storedMember = await readPersistedSession(stack.ctx.sessionPersistence, stack.member.id)
  const storedCaptain = await readPersistedSession(stack.ctx.sessionPersistence, stack.captain.id)
  const descriptor = foldSubagentDescriptor(storedMember.events.slice(storedMember.inheritedEventCount ?? 0))
  expect(descriptor?.mode).toBe('continuable')
  expect(JSON.stringify(descriptor)).not.toContain('approval_probe')
  expect(hasSuccessfulToolResult(storedMember.events, 'approval_probe')).toBe(true)
  expect(storedCaptain.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('member_tool_approval'))).toBe(true)
  expect(hasSuccessfulToolResult(storedCaptain.events, 'agent_swarm_decide_tool_approval')).toBe(true)
}, 15_000)

function hasSuccessfulToolResult(events: readonly SessionEvent[], name: string): boolean {
  const call = events.find(event => event.type === 'tool/call' && event.data.name === name)
  return call?.type === 'tool/call' && events.some(event => event.type === 'tool/result'
    && event.sourceEventSeqs?.includes(call.seq) && event.data.message.content.some(block => block.type === 'tool-result'
      && block.toolCallId === call.data.callId && block.isError === false))
}

it('denies an asked tool in the real first turn before active admission commits', async () => {
  const adapter = new ApprovalAdapter()
  adapter.open()
  const stack = await mount(adapter, async () => {
    await vi.waitFor(() => expect(adapter.requests.length).toBeGreaterThanOrEqual(2))
  })
  expect(stack.effects()).toBe(0)
  const snap = await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.captain.id)
  expect(snap.team.messages).toHaveLength(0)
})

it('holds the real tool body until this member call receives its own captain decision, then consumes once', async () => {
  const stack = await mount()
  const pending = stack.call(stack.member, 'approval_probe', { value: 42 })
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  expect(stack.effects()).toBe(0)
  const request_id = stack.requestId()
  expect((await stack.call(stack.member, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
  expect(stack.effects()).toBe(0)
  expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(false)
  expect(await pending).toMatchObject({ isError: false, value: 42 })
  expect(stack.effects()).toBe(1)
  expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
})

it.each(['deny', 'abort', 'turn-change', 'unload', 'timeout', 'official-deny'] as const)('never executes on %s and rejects late decisions', async failure => {
  const stack = await mount()
  const controller = new AbortController()
  if (failure === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = stack.call(stack.member, 'approval_probe', { value: 7 }, controller.signal)
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  expect(stack.effects()).toBe(0)
  const request_id = stack.requestId()
  if (failure === 'deny') await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'deny' })
  if (failure === 'abort') controller.abort()
  if (failure === 'unload') await stack.ctx.agentSwarmPermission.dispose()
  if (failure === 'timeout') await vi.advanceTimersByTimeAsync(300_001)
  if (failure === 'turn-change') {
    stack.member.session.append('turn/start', { turn: 2 })
    expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
  }
  if (failure === 'official-deny') {
    stack.ctx.tools.guard(exec => exec.name === 'approval_probe' ? 'official denial' : undefined)
    await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })
  }
  expect((await pending).isError).toBe(true)
  expect(stack.effects()).toBe(0)
  expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
})

it('rejects another Team Captain without consuming the rightful request', async () => {
  const stack = await mount()
  const other = await stack.ctx.agentLoop.create(SessionId('foreign-captain'), {}, { cwd: 'C:/foreign' })
  await stack.ctx.agentSwarm.domain.createTeam(stack.ctx.agentSwarm.scopeOf(other), other.id, 'Foreign team', 'Cannot approve this member')
  other.session.append('turn/start', { turn: 1 })
  const pending = stack.call(stack.member, 'approval_probe', { value: 9 })
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  const request_id = stack.requestId()
  expect((await stack.call(other, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
  expect(stack.effects()).toBe(0)
  await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'deny' })
  expect((await pending).isError).toBe(true)
})

it('keeps queued approval pending until its Captain decides the original call once', async () => {
  const stack = await mount()
  let notice = ''
  vi.mocked(stack.ctx.agentSwarm.sendMessage).mockImplementation(async (exec, target, content, delivery) => {
    notice = content
    return await stack.ctx.agentSwarm.domain.queueMessage(stack.scope, stack.teamId, exec.agent!.id, target, content, delivery)
  })
  let finished = false
  const pending = stack.call(stack.member, 'approval_probe', { value: 4 })
  void pending.then(() => { finished = true })
  await vi.waitFor(() => expect(notice).not.toBe(''))
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(finished).toBe(false)
  expect(stack.effects()).toBe(0)
  const request_id = JSON.parse(notice).request_id as string
  expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(false)
  expect(await pending).toMatchObject({ isError: false, value: 4 })
  expect(stack.effects()).toBe(1)
  expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
})

it.each(['cancelled', 'obsolete'] as const)('rejects terminal %s approval mail without executing', async phase => {
  const stack = await mount()
  vi.mocked(stack.ctx.agentSwarm.sendMessage).mockImplementation(async () => ({ phase }) as never)
  expect((await stack.call(stack.member, 'approval_probe', { value: 4 })).isError).toBe(true)
  expect(stack.effects()).toBe(0)
})

it('retains approval while a real busy Captain exceeds the mailbox claim grace', async () => {
  const adapter = new ApprovalAdapter()
  let releaseCaptain!: () => void
  const captainGate = new Promise<void>(resolve => { releaseCaptain = resolve })
  let captainHeld = false
  const stream = adapter.stream.bind(adapter)
  vi.spyOn(adapter, 'stream').mockImplementation(async function* (options) {
    const text = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (text.includes('Hold Captain for approval regression') && !text.includes('member_tool_approval')) {
      captainHeld = true
      await captainGate
    }
    yield* stream(options)
  })
  const stack = await mount(adapter)
  try {
    stack.captain.followup(createUserMessage({
      content: [{ type: 'text', text: 'Hold Captain for approval regression' }],
      source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
    }))
    await vi.waitFor(() => expect(captainHeld).toBe(true), { timeout: 5_000 })
    adapter.open()
    await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled(), { timeout: 5_000 })
    const delivery = vi.mocked(stack.ctx.agentSwarm.sendMessage).mock.results[0]!
    expect(delivery.type).toBe('return')
    const message = await delivery.value
    expect(message.phase).toBe('queued')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(stack.member.status).toBe('running')
    expect(stack.effects()).toBe(0)
    releaseCaptain()
    await vi.waitFor(() => expect(stack.effects()).toBe(1), { timeout: 5_000 })
    await stack.member.whenIdle()
    await stack.captain.whenIdle()
    expect(hasSuccessfulToolResult(stack.member.session.snapshotEvents(), 'approval_probe')).toBe(true)
    expect(hasSuccessfulToolResult(stack.captain.session.snapshotEvents(), 'agent_swarm_decide_tool_approval')).toBe(true)
  } finally {
    releaseCaptain()
    adapter.open()
  }
}, 20_000)

it.each(['abort', 'timeout'] as const)('settles queued approval on %s and tells the Captain not to retry its ID', async failure => {
  const stack = await mount()
  let notice = ''
  vi.mocked(stack.ctx.agentSwarm.sendMessage).mockImplementation(async (exec, target, content, delivery) => {
    notice = content
    return await stack.ctx.agentSwarm.domain.queueMessage(stack.scope, stack.teamId, exec.agent!.id, target, content, delivery)
  })
  const controller = new AbortController()
  if (failure === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = stack.call(stack.member, 'approval_probe', { value: 4 }, controller.signal)
  await vi.waitFor(() => expect(notice).not.toBe(''))
  if (failure === 'abort') controller.abort()
  else await vi.advanceTimersByTimeAsync(300_001)
  expect((await pending).isError).toBe(true)
  expect(stack.effects()).toBe(0)
  const result = await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', {
    request_id: JSON.parse(notice).request_id as string, decision: 'approve',
  })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Do not retry this request ID')
})

it('settles the original invocation immediately when authority revalidation throws', async () => {
  const stack = await mount()
  const pending = stack.call(stack.member, 'approval_probe', { value: 8 })
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  const request_id = stack.requestId()
  const find = stack.ctx.agentSwarm.domain.findMembership.bind(stack.ctx.agentSwarm.domain)
  vi.spyOn(stack.ctx.agentSwarm.domain, 'findMembership').mockImplementation((scope, id) => {
    if (id === stack.member.id) return Promise.reject(new Error('storage read failed'))
    return find(scope, id)
  })
  expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
  expect((await pending).isError).toBe(true)
  expect(stack.effects()).toBe(0)
})

it('rechecks the whole invocation after the final asynchronous authority read', async () => {
  const stack = await mount()
  const pending = stack.call(stack.member, 'approval_probe', { value: 8 })
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  const request_id = stack.requestId()
  const find = stack.ctx.agentSwarm.domain.findMembership.bind(stack.ctx.agentSwarm.domain)
  const sessionProperty = Object.getOwnPropertyDescriptor(stack.member, 'session')!
  let reads = 0
  vi.spyOn(stack.ctx.agentSwarm.domain, 'findMembership').mockImplementation(async (scope, id) => {
    const found = await find(scope, id)
    if (id === stack.member.id && ++reads === 2) {
      Object.defineProperty(stack.member, 'session', { ...sessionProperty, value: Object.create(stack.member.session) })
    }
    return found
  })
  try {
    await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })
    expect((await pending).isError).toBe(true)
    expect(reads).toBe(2)
    expect(stack.effects()).toBe(0)
  } finally { Object.defineProperty(stack.member, 'session', sessionProperty) }
})

it('rejects a replaced tool definition even if its public name is unchanged', async () => {
  const stack = await mount()
  const pending = stack.call(stack.member, 'approval_probe', { value: 8 })
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  const request_id = stack.requestId()
  const off = stack.member.ctx.tools.register(defineTool({ name: 'approval_probe', description: 'Replacement', parameters: {},
    output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => 999 }))
  try {
    expect((await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id, decision: 'approve' })).isError).toBe(true)
    expect((await pending).isError).toBe(true)
    expect(stack.effects()).toBe(0)
  } finally { off() }
})

class ApprovalCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    return { logs: [], value: await request.bindings[0]!.functions.approval_probe!({ value: 42 }) }
  }
}

it('binds a real PTC subdispatch to its outer call while gating the inner effect', async () => {
  const stack = await mount()
  const code = await stack.ctx.plugin(ApprovalCodeRuntime); cleanup.push(() => code.dispose())
  stack.member.ctx.tools.presentAs('ptc')
  const pending = stack.ctx.tools.execute({ agent: stack.member, name: 'run_code', callId: ToolCallId('outer-call'),
    arguments: { code: 'return await tools.approval_probe({ value: 42 })', description: 'Approval dispatch test' }, signal: new AbortController().signal })
  await vi.waitFor(() => expect(stack.ctx.agentSwarm.sendMessage).toHaveBeenCalled())
  expect(stack.requestData()).toMatchObject({ root_call_id: 'outer-call' })
  expect(stack.requestData().call_id).not.toBe('outer-call')
  expect(stack.effects()).toBe(0)
  await stack.call(stack.captain, 'agent_swarm_decide_tool_approval', { request_id: stack.requestId(), decision: 'approve' })
  expect((await pending).isError).toBe(false)
  expect(stack.effects()).toBe(1)
})
