/** Real official Connection HTTP auth, Team storage, tool execution and cold activation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as ClientConnection from '@deepseek-ai/dsh-client-connection'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { framePredicate, frameVisibility, waitForFrameClaim } from '../src/runtime/frame-visibility.js'
import { messageClaimed } from '../src/runtime/session-acceptance.js'
import { MessageDelivery } from '../src/runtime/message-delivery.js'
import { mountRestartComposition as mount, disposeRestartComposition as dispose, restartTool as tool, RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

const ROOT = SessionId('public-root')
const ROUTE = { provider: 'public-fixture', model: 'public-model' }
class Recording extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  replyCalls = 0
  publicReply = false
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const frame = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .find(part => part.type === 'text' && part.text.startsWith('Public Team message, frame version 1.'))
    if (this.publicReply && frame?.type === 'text' && this.replyCalls < 2) {
      const data = JSON.parse(frame.text.split('Message data (JSON): ')[1]!)
      const id = ToolCallId(`public-real-reply-${++this.replyCalls}`)
      const args = JSON.stringify({ request_id: 'reply-once', reply_to: data.messageId, text: '已收到，公开回复。' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_public_reply', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_public_reply', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PRIVATE SESSION OUTPUT MUST STAY PRIVATE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class HeldRecording extends Recording {
  hold = false
  entered = false
  release!: () => void
  private readonly gate = new Promise<void>(resolve => { this.release = resolve })
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.hold && options.sessionId !== ROOT) {
      this.entered = true
      await this.gate
    }
    yield* super.stream(options)
  }
}

async function setup(sandbox: string, adapter: Recording, http = false) {
  const routes: { kind: string; path: string; handler(req: IncomingMessage, res: ServerResponse): unknown }[] = []
  let instance: Awaited<ReturnType<typeof mount>> | undefined
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/?')) { instance!.ctx.connection.authorizeIndex(req, res); return }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find(candidate => candidate.kind === 'prefix' ? path.startsWith(candidate.path + '/') : path === candidate.path)
    if (route === undefined) { res.writeHead(404).end(); return }
    Promise.resolve(route.handler(req, res)).catch(() => res.writeHead(500).end())
  })
  if (http) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  instance = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
    ctx.llm.registerAdapter([ROUTE.provider], adapter)
    if (!http) return
    ctx.provide('webServer', { host: '127.0.0.1', port, register(route: typeof routes[number]) {
      routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) }
    } } as never)
    fibers.push(await ctx.plugin(CredentialsLocal, { path: join(sandbox, 'credentials.yaml'), dshHome: sandbox, watch: false }))
    fibers.push(await ctx.plugin(ClientConnection))
  }, { captainLlmProvider: ROUTE.provider, captainModel: ROUTE.model })
  return { ...instance, base: `http://127.0.0.1:${port}`, routes,
    close: async () => { await dispose(instance!); if (http) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}

async function createTeam(f: Awaited<ReturnType<typeof setup>>, sandbox: string) {
  const root = (await f.ctx.agents.create({ sessionId: ROOT, agentOptions: ROUTE, meta: { cwd: join(sandbox, 'workspace') } })).agent
  root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare public conversation.' }] }))
  await root.whenIdle()
  const created = await tool(f.ctx, root, 'public-create', 'agent_swarm_create_managed', { name: 'Public Team', description: 'Discuss publicly without implicit tasks.' })
  expect(created.isError, JSON.stringify(created.error)).toBe(false)
  const { team_id, captain_session_id } = created.value as { team_id: string; captain_session_id: string }
  const captain = f.ctx.agents.get(SessionId(captain_session_id))!
  await captain.whenIdle()
  expect(await f.ctx.sessions.flush(root.session)).toBe(true)
  expect(await f.ctx.sessions.flush(captain.session)).toBe(true)
  return { root, captain, teamId: TeamId(team_id), scope: f.ctx.agentSwarm.scopeOf(root) }
}

it('authenticates the actual route, persists literal user input, exposes only explicit public replies and deduplicates retries', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-http-'))
  const adapter = new Recording()
  adapter.publicReply = true
  const f = await setup(sandbox, adapter, true)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    await vi.waitFor(() => expect(f.routes.some(route => route.path === '/swarm-public')).toBe(true))
    expect(() => f.ctx.connection.rpc.handle('/swarm-public/v1', async () => ({ ok: true, value: null }))).toThrow()
    const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
    expect(auth.status).toBe(303)
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const target = { rootSessionId: ROOT, teamId }
    const call = async (endpoint: string, fields: object = {}, headers: Record<string, string> = { cookie }) => {
      const response = await fetch(`${f.base}/swarm-public/v1/${endpoint}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId: 'public-test', method: `v1/${endpoint}`, payload: { schemaVersion: 1, target, ...fields } }) })
      return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
    }
    expect((await call('history', {}, {})).status).toBe(401)
    expect((await call('history', {}, { cookie, origin: 'https://untrusted.invalid' })).status).toBe(403)
    const before = await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)
    for (const forged of [{ author: { kind: 'agent', sessionId: captain.id } }, { actor: captain.id }, { principal: 'human' }, { image: 'x' }]) {
      expect((await call('append', { requestId: 'forged', text: 'deny', ...forged })).body.result).toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    }
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.revision).toBe(before.team.revision)
    const initial = await call('history')
    expect(initial.status).toBe(200)
    expect(initial.body.result).toMatchObject({ ok: true, value: { entries: [], appendEligibility: { state: 'available' } } })
    const sent = await call('append', { requestId: 'public-once', text: '  请公开回答：保持现有任务不变。  ' })
    expect(sent.body.result.ok, JSON.stringify(sent.body)).toBe(true)
    const message = sent.body.result.value.message
    expect(message.text).toBe('请公开回答：保持现有任务不变。')
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.publicChat?.messages[0]?.delivery.state).toBe('claimed')
    }, { timeout: 10_000 })
    await vi.waitFor(async () => expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat?.messages).toHaveLength(2), { timeout: 10_000 })
    await f.ctx.agents.get(captain.id)?.whenIdle()
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const row = team.publicChat!.messages[0]!
    if (row.delivery.state === 'not-requested') throw new Error('human message has no input')
    const frame = row.delivery.frame
    const persisted = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    expect(messageClaimed(persisted.events, framePredicate(frame))).toBe(true)
    expect(adapter.requests.some(request => request.sessionId === captain.id && request.messages.some(input =>
      input.role === 'user' && input.content.some(part => part.type === 'text' && part.text === frame)))).toBe(true)
    expect(team.tasks).toEqual(before.team.tasks)
    expect(team.messages).toEqual(before.team.messages)
    const count = adapter.requests.filter(request => request.sessionId === captain.id).length
    const retry = await call('append', { requestId: 'public-once', text: '请公开回答：保持现有任务不变。' })
    expect(retry.body.result.value).toMatchObject({ replayed: true, message: { id: message.id } })
    const recovered = await call('requestResult', { requestId: 'public-once' })
    expect(recovered.body.result.value).toMatchObject({ state: 'committed', message: { id: message.id } })
    expect((await call('append', { requestId: 'public-once', text: 'different' })).body.result).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_REQUEST_CONFLICT' } })
    expect(adapter.replyCalls).toBe(2)
    expect((await tool(f.ctx, root, 'forged-reply', 'agent_swarm_public_reply', { request_id: 'forged-reply', reply_to: message.id, text: 'forged' })).isError).toBe(true)
    expect((await tool(f.ctx, captain, 'stale-exec', 'agent_swarm_public_reply', { request_id: 'reply-once', reply_to: message.id, text: '已收到，公开回复。' })).isError).toBe(true)
    const page = (await call('history')).body.result.value
    expect(page.entries).toHaveLength(2)
    expect(page.entries[1]).toMatchObject({ author: { kind: 'agent', sessionId: captain.id, role: 'captain' }, delivery: { state: 'not-requested' } })
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE SESSION OUTPUT|bindingDigest|frameVersion|parentSessionId|requestId/)
    expect(adapter.requests.filter(request => request.sessionId === captain.id)).toHaveLength(count)
    expect((await call('history', { limit: 1 })).body.result.value).toMatchObject({ firstSequence: 2, hasEarlier: true, hasMore: false })
    expect((await call('history', { beforeSequence: 2, limit: 1 })).body.result.value).toMatchObject({ firstSequence: 1, hasEarlier: false, hasMore: true })
    expect((await call('history', { afterSequence: 1, limit: 1 })).body.result.value).toMatchObject({ firstSequence: 2, hasEarlier: true, hasMore: false })
    // No durability listener may never turn an in-memory claim into a receipt.
    root.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] }))
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Claim fixture frame.' }] }))
    await root.whenIdle()
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValue(false)
    expect(await frameVisibility(f.ctx, root.id, frame, SIGNAL, 'false flush', true)).toBe('unknown')
    expect(await waitForFrameClaim(f.ctx, root, frame, SIGNAL, 0, true)).toBe(false)
    flush.mockRestore()
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('recovers empty-board public input through the same owner after full teardown, and folds a lost receipt without resending', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-restart-'))
  let f = await setup(sandbox, new Recording())
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { author: { kind: 'local-operator' }, requestId: 'cold-public', text: 'Recover this exact public input.' })
    const captainId = captain.id
    await f.close()
    const adapter = new Recording()
    f = await setup(sandbox, adapter)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
      expect(team.tasks).toEqual([])
      expect(team.publicChat?.messages[0]?.delivery.state).toBe('claimed')
    }, { timeout: 10_000 })
    await f.ctx.agents.get(captainId)?.whenIdle()
    expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(1)
    expect(adapter.requests.filter(request => request.sessionId === ROOT).some(request => request.messages.some(message =>
      message.content.some(part => part.type === 'text' && part.text.startsWith('Public Team message, frame version 1.'))))).toBe(false)
    // Simulate the store-ack crash window using the real domain's ack failure.
    const ack = vi.spyOn(f.ctx.agentSwarm.domain, 'acknowledgePublicMessage').mockRejectedValue(new Error('lost store receipt'))
    const second = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { author: { kind: 'local-operator' }, requestId: 'lost-receipt', text: 'Claim once despite lost receipt.' })
    f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(() => expect(ack).toHaveBeenCalled(), { timeout: 10_000 })
    await f.ctx.agents.get(captainId)?.whenIdle()
    ack.mockRestore()
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team.publicChat?.messages[1]?.delivery.state).toBe('queued')
    await f.close()
    const finalAdapter = new Recording()
    f = await setup(sandbox, finalAdapter)
    await vi.waitFor(async () => expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team.publicChat?.messages[1]?.delivery.state).toBe('claimed'))
    expect(finalAdapter.requests).toHaveLength(0)
    const replay = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { author: { kind: 'local-operator' }, requestId: 'cold-public', text: 'Recover this exact public input.' })
    expect(replay).toMatchObject({ replayed: true, message: { id: committed.message.id } })
    expect((await f.ctx.agentSwarm.domain.publicRequestResult(scope, teamId, { kind: 'local-operator' }, 'lost-receipt'))?.id).toBe(second.message.id)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)

it('keeps actual pending input and failed-flush uncertainty queued without re-admitting or restoring a parent', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-pending-'))
  const adapter = new HeldRecording()
  const f = await setup(sandbox, adapter)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    adapter.hold = true
    await f.ctx.subagents.prompt({ requestId: 'hold-existing-activation' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Hold this fixture turn.' }] }, SIGNAL)
    await vi.waitFor(() => expect(adapter.entered).toBe(true))
    const active = f.ctx.agents.get(captain.id)!
    const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, {
      author: { kind: 'local-operator' }, requestId: 'pending-public', text: 'Pending must not be resent.' })
    if (committed.message.delivery.state === 'not-requested') throw new Error('missing public input')
    const frame = committed.message.delivery.frame
    active.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] }))
    expect(await f.ctx.sessions.flush(active.session)).toBe(true)
    expect(await frameVisibility(f.ctx, active.id, frame, SIGNAL, 'pending fixture', true)).toBe('pending')
    const prompt = vi.spyOn(f.ctx.subagents, 'prompt')
    const restore = vi.fn(async () => root)
    const delivery = new MessageDelivery(f.ctx, { domain: () => f.ctx.agentSwarm.domain, isClosing: () => false,
      scopeOf: agent => f.ctx.agentSwarm.scopeOf(agent), accountAgentUsage: async () => {}, publicRoot: restore,
      publicTeam: async () => (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team })
    await delivery.deliverPublicMessages(scope, teamId, SIGNAL)
    expect(prompt).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValue(false)
    expect(await frameVisibility(f.ctx, active.id, frame, SIGNAL, 'unknown fixture', true)).toBe('unknown')
    await delivery.deliverPublicMessages(scope, teamId, SIGNAL)
    expect(prompt).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    flush.mockRestore()
    prompt.mockRestore()
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat?.messages[0]?.delivery.state).toBe('queued')
    adapter.release()
    await active.whenIdle()
  } finally { adapter.release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)
