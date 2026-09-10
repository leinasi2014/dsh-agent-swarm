/** Real official Connection HTTP auth, Team storage, tool execution and cold activation. */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ClientConnection from '@deepseek-ai/dsh-client-connection'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { publicDeliveries } from '../src/domain/public-message.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { framePredicate, frameVisibility, waitForFrameClaim } from '../src/runtime/frame-visibility.js'
import { messageClaimed, messagePending } from '../src/runtime/session-acceptance.js'
import { MessageDelivery } from '../src/runtime/message-delivery.js'
import { mountRestartComposition as mount, disposeRestartComposition as dispose, restartTool as tool, RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

const ROOT = SessionId('public-root')
const ROUTE = { provider: 'public-fixture', model: 'public-model' }
class Recording extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  replyCalls = 0
  publicReply = false
  private readonly repliedBySession = new Map<string, number>()
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const frame = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .find(part => part.type === 'text' && part.text.startsWith('Public Team message, frame version '))
    const replied = this.repliedBySession.get(options.sessionId ?? '') ?? 0
    if (this.publicReply && frame?.type === 'text' && replied < 2) {
      this.repliedBySession.set(options.sessionId ?? '', replied + 1)
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
    // A sibling provider preserves the real Cordis injection boundary.
    fibers.push(await ctx.plugin({ apply(webCtx: Context) {
      webCtx.provide('webServer', { host: '127.0.0.1', port, register(route: typeof routes[number]) {
        routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) }
      } } as never)
    } }))
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
  // Continuable activation may retire immediately after idle; read its
  // durable descriptor instead of flushing a stale Session object.
  expect((await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)).meta.parentSession).toBe(root.id)
  return { root, captain, teamId: TeamId(team_id), scope: f.ctx.agentSwarm.scopeOf(root) }
}

async function addPublicMembers(f: Awaited<ReturnType<typeof setup>>, root: Awaited<ReturnType<typeof createTeam>>['root'], captainId: SessionId) {
  const ids: SessionId[] = []
  await f.ctx.subagents.withContinuableChild(root, captainId, SIGNAL, async (captain, signal) => {
    for (const name of ['alpha', 'beta']) {
      const result = await f.ctx.tools.execute({ signal, callId: ToolCallId(`public-add-${name}`), name: 'agent_swarm_add_member',
        arguments: { name, role: `Public ${name} duty`, llm_provider: ROUTE.provider, model: ROUTE.model }, agent: captain })
      expect(result.isError, JSON.stringify(result)).toBe(false)
      ids.push(SessionId((result.value as { session_id: string }).session_id))
    }
  })
  await Promise.all(ids.map(id => f.ctx.agents.get(id)?.whenIdle()))
  return ids
}

/** Preserve the actual flushed cut before normal disposal cancels the Inbox. */
async function captureRestartSnapshot(source: Awaited<ReturnType<typeof setup>>, sourceRoot: string, snapshotRoot: string) {
  await source.ctx.sessionPersistence.flush()
  const headers = await source.ctx.sessionPersistence.list()
  const sessions = await Promise.all(headers.map(row => readPersistedSession(source.ctx.sessionPersistence, row.header.id, SIGNAL)))
  const unitPath = join(sourceRoot, 'storage', 'agent_swarm.json')
  const teamUnit = await readFile(unitPath, 'utf8')
  const snapshotCtx = new Context()
  const persistence = await snapshotCtx.plugin(JsonlSessionPersistence, { root: join(snapshotRoot, 'sessions', 'sessions.db'), compression: 'none' })
  try {
    for (const session of sessions) {
      const handle = await snapshotCtx.sessionPersistence.create(session.meta, { inheritedEventCount: session.inheritedEventCount })
      try { await handle.append(session.events); await handle.flush() } finally { await handle.close() }
    }
    await cp(join(sourceRoot, 'storage'), join(snapshotRoot, 'storage'), { recursive: true })
    expect(await readFile(join(snapshotRoot, 'storage', 'agent_swarm.json'), 'utf8')).toBe(teamUnit)
    expect(await readFile(unitPath, 'utf8')).toBe(teamUnit)
    // The held driver cannot change this cut. Check every Session revision so
    // a concurrent source mutation fails the fixture instead of making a mix.
    for (const before of headers) expect((await source.ctx.sessionPersistence.stat(before.header.id))?.revision).toBe(before.revision)
    return sessions
  } finally { await persistence.dispose() }
}

async function publicClient(f: Awaited<ReturnType<typeof setup>>, teamId: string) {
  const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
  expect(auth.status).toBe(303)
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
  return async (endpoint: string, fields: object = {}) => {
    const response = await fetch(`${f.base}/swarm-public/v2/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'snapshot-rpc',
        method: `v2/${endpoint}`, payload: { schemaVersion: 2, target: { rootSessionId: ROOT, teamId }, ...fields } }) })
    expect(response.status).toBe(200)
    const result = (await response.json()).result
    expect(result.ok, JSON.stringify(result)).toBe(true)
    return result.value
  }
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
      const response = await fetch(`${f.base}/swarm-public/v2/${endpoint}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId: 'public-test', method: `v2/${endpoint}`, payload: { schemaVersion: 2, target, ...fields } }) })
      return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
    }
    expect((await call('history', {}, {})).status).toBe(401)
    expect((await call('history', {}, { cookie, origin: 'https://untrusted.invalid' })).status).toBe(403)
    const before = await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)
    for (const forged of [{ author: { kind: 'agent', sessionId: captain.id } }, { actor: captain.id }, { principal: 'human' }, { image: 'x' }]) {
      expect((await call('append', { requestId: 'forged', content: [{ type: 'text', text: 'deny' }], ...forged })).body.result).toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    }
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.revision).toBe(before.team.revision)
    const initial = await call('history')
    expect(initial.status).toBe(200)
    expect(initial.body.result).toMatchObject({ ok: true, value: { entries: [], appendEligibility: { state: 'available' } } })
    const sent = await call('append', { requestId: 'public-once', content: [{ type: 'text', text: '  请公开回答：保持现有任务不变。  ' }] })
    expect(sent.body.result.ok, JSON.stringify(sent.body)).toBe(true)
    const message = sent.body.result.value.message
    expect(message.text).toBe('请公开回答：保持现有任务不变。')
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(publicDeliveries(team.publicChat!.messages[0]!)[0]?.state).toBe('claimed')
    }, { timeout: 10_000 })
    await vi.waitFor(async () => expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat?.messages).toHaveLength(2), { timeout: 10_000 })
    await f.ctx.agents.get(captain.id)?.whenIdle()
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const row = team.publicChat!.messages[0]!
    const frame = publicDeliveries(row)[0]!.frame
    const persisted = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    expect(messageClaimed(persisted.events, framePredicate(frame))).toBe(true)
    expect(adapter.requests.some(request => request.sessionId === captain.id && request.messages.some(input =>
      input.role === 'user' && input.content.some(part => part.type === 'text' && part.text === frame)))).toBe(true)
    expect(team.tasks).toEqual(before.team.tasks)
    expect(team.messages).toEqual(before.team.messages)
    const count = adapter.requests.filter(request => request.sessionId === captain.id).length
    const retry = await call('append', { requestId: 'public-once', content: [{ type: 'text', text: '请公开回答：保持现有任务不变。' }] })
    expect(retry.body.result.value).toMatchObject({ replayed: true, message: { id: message.id } })
    const recovered = await call('requestResult', { requestId: 'public-once' })
    expect(recovered.body.result.value).toMatchObject({ state: 'committed', message: { id: message.id } })
    expect((await call('append', { requestId: 'public-once', content: [{ type: 'text', text: 'different' }] })).body.result).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_REQUEST_CONFLICT' } })
    expect(adapter.replyCalls).toBe(2)
    expect((await tool(f.ctx, root, 'forged-reply', 'agent_swarm_public_reply', { request_id: 'forged-reply', reply_to: message.id, text: 'forged' })).isError).toBe(true)
    expect((await tool(f.ctx, captain, 'stale-exec', 'agent_swarm_public_reply', { request_id: 'reply-once', reply_to: message.id, text: '已收到，公开回复。' })).isError).toBe(true)
    const page = (await call('history')).body.result.value
    expect(page.entries).toHaveLength(2)
    expect(page.entries[1]).toMatchObject({ author: { kind: 'agent', sessionId: captain.id, role: 'captain' }, delivery: { kind: 'not-requested' } })
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

it.each(['empty-board', 'unfinished-task', 'mixed-new-input'] as const)('recovers public input and lost receipts across full teardown (%s)', async scenario => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-restart-'))
  let f = await setup(sandbox, new Recording())
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    const task = scenario === 'empty-board' ? undefined : await f.ctx.agentSwarm.domain.createTask(scope, teamId, captain.id,
      { subject: 'Existing unfinished work', description: 'Preserve this task through public receipt recovery.' })
    const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { author: { kind: 'local-operator' }, requestId: 'cold-public', text: 'Recover this exact public input.' })
    const captainId = captain.id
    await f.close()
    const adapter = new Recording()
    f = await setup(sandbox, adapter)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
      expect(team.tasks).toHaveLength(task === undefined ? 0 : 1)
      expect(publicDeliveries(team.publicChat!.messages[0]!)[0]?.state).toBe('claimed')
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
    expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team.publicChat!.messages[1]!)[0]?.state).toBe('queued')
    const third = scenario !== 'mixed-new-input' ? undefined : await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId,
      { author: { kind: 'local-operator' }, requestId: 'new-input', text: 'New input shares the recovery wake.' })
    await f.close()
    ack.mockRestore()
    const finalAdapter = new Recording()
    f = await setup(sandbox, finalAdapter)
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team.publicChat!.messages[1]!)[0]?.state).toBe('claimed'))
    const expectedTurns = task === undefined ? 0 : 1
    await vi.waitFor(() => expect(finalAdapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(expectedTurns))
    await f.ctx.agents.get(captainId)?.whenIdle()
    await f.ctx.agentSwarm.recoverDormantManagedTeams()
    const persisted = await readPersistedSession(f.ctx.sessionPersistence, captainId, SIGNAL)
    const inputs = persisted.events.filter(event => event.type === 'user/message').flatMap(event => event.data.content)
      .filter(part => part.type === 'text').map(part => part.text)
    for (const message of [committed.message, second.message, ...(third === undefined ? [] : [third.message])]) {
      const frame = publicDeliveries(message)[0]!.frame
      expect(inputs.filter(text => text === frame)).toHaveLength(1)
    }
    expect(inputs.filter(text => text.startsWith('The Host restarted while this managed Team still had unfinished work.')))
      .toHaveLength(scenario === 'unfinished-task' ? 1 : 0)
    const after = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captainId)).team
    expect(after.tasks).toEqual(task === undefined ? [] : [task])
    const replay = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { author: { kind: 'local-operator' }, requestId: 'cold-public', text: 'Recover this exact public input.' })
    expect(replay).toMatchObject({ replayed: true, message: { id: committed.message.id } })
    expect((await f.ctx.agentSwarm.domain.publicRequestResult(scope, teamId, { kind: 'local-operator' }, 'lost-receipt'))?.id).toBe(second.message.id)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)

it.each([
  ['remove', false], ['archive', false], ['remove', true], ['archive', true],
] as const)('fences %s completion against an in-flight public cold member observation (cancelled=%s)', async (operation, cancelled) => {
  const sandbox = await mkdtemp(join(tmpdir(), `swarm-public-exit-${operation}-`))
  const adapter = new Recording()
  const f = await setup(sandbox, adapter)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const [memberId] = await addPublicMembers(f, root, captain.id)
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async (liveCaptain) => {
      await f.ctx.subagents.drainContinuableChildren(liveCaptain, [memberId!])
      expect(f.ctx.agents.get(memberId!)).toBeUndefined()
      const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, {
        formatVersion: 2, author: { kind: 'local-operator' }, requestId: `cold-exit-${operation}`,
        content: [{ type: 'mention', memberId: memberId! }, { type: 'text', text: 'Finish this public request.' }],
      })
      const frame = publicDeliveries(committed.message)[0]!.frame
      let observed!: () => void
      const entered = new Promise<void>(resolve => { observed = resolve })
      let insideTargetPrompt = false
      const actualPrompt = f.ctx.subagents.prompt.bind(f.ctx.subagents)
      const prompt = vi.spyOn(f.ctx.subagents, 'prompt').mockImplementation(async (request, signal) => {
        if (request.childSessionId !== memberId) return await actualPrompt(request, signal)
        insideTargetPrompt = true
        try { return await actualPrompt(request, signal) } finally { insideTargetPrompt = false }
      })
      const actualObserve = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
      const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
        if (id === memberId && insideTargetPrompt) {
          observed()
          await gate
        }
        return await actualObserve(id, options)
      })
      const deliveries = vi.spyOn(MessageDelivery.prototype, 'deliverPublicMessages')
      let exitCompleted = false
      let modelsAtExit = -1
      let inputsAtExit = -1
      const cancellation = new AbortController()
      const memberModels = () => adapter.requests.filter(request => request.sessionId === memberId).length
      try {
        f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
        const draining = deliveries.mock.results.at(-1)!.value as Promise<unknown>
        await entered
        expect(f.ctx.agents.get(memberId!)).toBeUndefined()
        const exiting = (operation === 'remove'
          ? f.ctx.agentSwarm.removeMember({ agent: liveCaptain, signal: cancellation.signal }, 'alpha', 'leave during cold admission')
          : f.ctx.agentSwarm.archive({ agent: liveCaptain, signal: cancellation.signal }, 'archive during cold admission'))
          .then(async value => {
            modelsAtExit = memberModels()
            const stored = await readPersistedSession(f.ctx.sessionPersistence, memberId!, SIGNAL)
            inputsAtExit = stored.events.slice(stored.inheritedEventCount ?? 0)
              .flatMap(event => event.type === 'user/message' ? [event.data] : []).filter(framePredicate(frame)).length
            exitCompleted = true
            return value
          })
        const outcome = exiting.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
        // Give the real mutation its normal async commit/drain opportunities.
        // The held official observation must prevent a successful early return.
        await new Promise(resolve => setTimeout(resolve, 150))
        const returnedBeforeObservation = exitCompleted
        const cancelReason = new Error('Cancelled while retirement waits for public admission')
        if (cancelled) cancellation.abort(cancelReason)
        release()
        const result = await outcome
        await draining
        if (cancelled) {
          expect(result).toEqual({ ok: false, error: cancelReason })
          const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
          expect(team.phase).toBe('active')
          expect(team.members.find(member => member.sessionId === memberId)?.phase).toBe('active')
          return
        }
        expect(result).toEqual({ ok: true })
        await f.ctx.agents.get(memberId!)?.whenIdle()
        const after = await readPersistedSession(f.ctx.sessionPersistence, memberId!, SIGNAL)
        const ownInputs = after.events.slice(after.inheritedEventCount ?? 0)
          .flatMap(event => event.type === 'user/message' ? [event.data] : []).filter(framePredicate(frame))
        expect(memberModels(), 'no member model invocation may start after exit completes').toBe(modelsAtExit)
        expect(ownInputs.length, 'no public member input may arrive after exit completes').toBe(inputsAtExit)
        expect(returnedBeforeObservation, 'exit must await the official cold observation it fences').toBe(false)
        expect(ownInputs.length).toBeLessThanOrEqual(1)
        expect(f.ctx.agents.get(memberId!)).toBeUndefined()
      } finally { release(); observe.mockRestore(); prompt.mockRestore(); deliveries.mockRestore() }
    })
  } finally { release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it('cold-recovers both exact mentioned members through the Captain lease without manufacturing parent input', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-multi-cold-'))
  let f = await setup(sandbox, new Recording())
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const ids = await addPublicMembers(f, root, captain.id)
    // Finish genuine recruitment reports before sealing the public-only cut.
    await f.ctx.subagents.prompt({ requestId: 'settle-recruitment-fixture' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Fixture: finish the existing recruitment reports.' }] }, SIGNAL)
    await f.ctx.agents.get(captain.id)?.whenIdle()
    const captainBefore = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    const body = { formatVersion: 2 as const, author: { kind: 'local-operator' as const }, requestId: 'cold-multi', content: [
      { type: 'mention' as const, memberId: ids[1]! }, { type: 'text' as const, text: ' 和 ' },
      { type: 'mention' as const, memberId: ids[0]! }, { type: 'mention' as const, memberId: ids[1]! },
      { type: 'text' as const, text: '各自公开回报' },
    ] }
    const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, body)
    await f.close()
    const adapter = new Recording()
    adapter.publicReply = true
    f = await setup(sandbox, adapter)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(row => row.id === teamId)!
      expect(publicDeliveries(team.publicChat!.messages[0]!).map(row => row.state)).toEqual(['claimed', 'claimed'])
      expect(team.publicChat!.messages).toHaveLength(3)
    }, { timeout: 15_000 })
    await Promise.all(ids.map(id => f.ctx.agents.get(id)?.whenIdle()))
    const after = (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(row => row.id === teamId)!
    expect(after.tasks).toEqual([])
    expect(after.messages).toEqual([])
    expect(after.publicChat!.messages.slice(1).map(message => message.author)).toEqual(expect.arrayContaining(ids.map(sessionId => expect.objectContaining({ kind: 'agent', sessionId, role: 'member' }))))
    expect(adapter.requests.filter(request => request.sessionId === ROOT).length).toBe(0)
    const firstMemberRequest = adapter.requests.findIndex(request => ids.includes(SessionId(request.sessionId!)))
    expect(firstMemberRequest).toBe(0)
    const captainAfter = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    const newCaptainInputs = captainAfter.events.slice(captainBefore.events.length).flatMap(event => event.type === 'user/message' ? [event.data] : [])
    expect(newCaptainInputs.every(message => message.source?.kind === 'subagent-settled' || message.source?.kind === 'plugin')).toBe(true)
    expect(newCaptainInputs.some(message => message.content.some(part => part.type === 'text' && part.text.startsWith('Public Team message')))).toBe(false)
    for (const recipient of publicDeliveries(committed.message)) {
      const persisted = await readPersistedSession(f.ctx.sessionPersistence, SessionId(recipient.recipientSessionId), SIGNAL)
      const own = persisted.events.slice(persisted.inheritedEventCount)
      expect(own.filter(event => event.type === 'user/message' && framePredicate(recipient.frame)(event.data))).toHaveLength(1)
      expect(adapter.requests.some(request => request.sessionId === recipient.recipientSessionId && request.messages.some(message =>
        message.role === 'user' && message.content.some(part => part.type === 'text' && part.text === recipient.frame)))).toBe(true)
    }
    const turns = adapter.requests.length
    expect((await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, body)).message.id).toBe(committed.message.id)
    await f.ctx.agentSwarm.recoverDormantManagedTeams()
    expect(adapter.requests).toHaveLength(turns)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)

it('uses the actual authenticated bridge for legacy replay, mixed pages, exact mentions and the shared directory', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-versions-'))
  const f = await setup(sandbox, new Recording(), true)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const ids = await addPublicMembers(f, root, captain.id)
    const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const call = async (version: 1 | 2, endpoint: string, fields: object = {}) => {
      const response = await fetch(`${f.base}/swarm-public/v${version}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'version-test', method: `v${version}/${endpoint}`,
          payload: { schemaVersion: version, target: { rootSessionId: ROOT, teamId }, ...fields } }) })
      expect(response.status).toBe(200)
      return (await response.json()).result
    }
    expect(await call(1, 'append', { requestId: 'never-legacy', text: 'old client' })).toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    expect(await call(1, 'requestResult', { requestId: 'never-legacy' })).toMatchObject({ ok: true, value: { state: 'not-found' } })
    const legacy = { author: { kind: 'local-operator' as const }, requestId: 'persisted-legacy', text: '@旧名字仍是字面文本' }
    const old = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, legacy)
    expect(await call(1, 'append', { requestId: legacy.requestId, text: legacy.text })).toMatchObject({ ok: true, value: { replayed: true, message: { id: old.message.id } } })
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!)[0]?.state).toBe('claimed'))
    await f.ctx.agents.get(captain.id)?.whenIdle()
    expect(await call(2, 'requestResult', { requestId: legacy.requestId })).toMatchObject({ ok: true, value: { message: { formatVersion: 1, content: [{ type: 'text', text: legacy.text }], mentionLabels: [] } } })
    expect(await call(2, 'append', { requestId: legacy.requestId, content: [{ type: 'text', text: legacy.text }] })).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_REQUEST_CONFLICT' } })
    expect(await call(2, 'append', { requestId: 'foreign', content: [{ type: 'mention', memberId: ROOT }] })).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_RECIPIENT_INVALID' } })
    expect(await call(2, 'append', { requestId: 'unconfirmed', content: [{ type: 'text', text: '中文@名字' }] })).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_MENTION_UNCONFIRMED' } })
    expect(await call(2, 'append', { requestId: 'forged-label', content: [{ type: 'mention', memberId: ids[0], label: 'forged' }] })).toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    const body = { requestId: 'new-multi', content: [{ type: 'mention', memberId: ids[0] }, { type: 'text', text: '和' }, { type: 'mention', memberId: ids[1] }] }
    const sent = await call(2, 'append', body)
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, value: { replayed: false, message: { formatVersion: 2, delivery: { recipients: ids.map(recipientSessionId => ({ recipientSessionId })) } } } })
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[1]!).map(row => row.state)).toEqual(['claimed', 'claimed']))
    await Promise.all(ids.map(id => f.ctx.agents.get(id)?.whenIdle()))
    await f.ctx.agents.get(captain.id)?.whenIdle()
    expect(await call(1, 'history')).toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    expect(await call(1, 'history', { beforeSequence: 2 })).toMatchObject({ ok: true, value: { entries: [{ id: old.message.id }] } })
    expect(await call(1, 'requestResult', { requestId: body.requestId })).toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    expect(await call(1, 'append', { requestId: body.requestId, text: sent.value.message.text })).toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    const history = await call(2, 'history')
    expect(history.value.entries.map((row: { formatVersion: number }) => row.formatVersion)).toEqual([1, 2])
    expect(history.value.limits.maxSegments).toBe(256)
    expect(JSON.stringify(history)).not.toMatch(/frameVersion|parentSessionId|bindingDigest/)
    const directory = await call(2, 'directory', { limit: 2 })
    expect(directory, JSON.stringify(directory)).toMatchObject({ ok: true, value: { page: { totalCount: 3, returnedCount: 2, hasMore: true } } })
    const page2 = await call(2, 'directory', { cursor: directory.value.page.nextCursor, limit: 2 })
    expect(page2).toMatchObject({ ok: true, value: { directoryRevision: directory.value.directoryRevision, entries: [{ memberId: ids[1] }] } })
    const current = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    await f.ctx.agentSwarm.domain.setMemberProfile(scope, teamId, ids[0]!, current.revision, 'alpha', { displayName: '已改名' })
    expect(await call(2, 'directory', { cursor: directory.value.page.nextCursor })).toMatchObject({ ok: false, error: { code: 'SWARM_DIRECTORY_STALE' } })
    const replayed = await call(2, 'append', body)
    expect(replayed).toMatchObject({ ok: true, value: { replayed: true, message: { text: sent.value.message.text, mentionLabels: sent.value.message.mentionLabels } } })
    await f.ctx.agentSwarm.domain.archiveTeam(scope, teamId, captain.id, 'archive replay')
    expect(await call(2, 'append', body)).toMatchObject({ ok: true, value: { replayed: true } })
    expect(await call(1, 'append', { requestId: legacy.requestId, text: legacy.text })).toMatchObject({ ok: true, value: { replayed: true } })
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)

it('settles removed recipients only after durable absence and repairs an earlier claim first', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-terminal-'))
  const f = await setup(sandbox, new Recording())
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const ids = await addPublicMembers(f, root, captain.id)
    const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { formatVersion: 2, author: { kind: 'local-operator' }, requestId: 'terminal-recipients',
      content: ids.map(memberId => ({ type: 'mention' as const, memberId })) })
    const first = publicDeliveries(committed.message)[0]!
    // Real durable target claim with a missing aggregate receipt (crash cut).
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async (_captain, signal) => {
      await f.ctx.subagents.prompt({ requestId: committed.message.id as never, parentSessionId: captain.id, childSessionId: ids[0]!, mode: 'continuable',
        delivery: 'steer', content: [{ type: 'text', text: first.frame }] }, signal)
      await f.ctx.agents.get(ids[0]!)?.whenIdle()
    })
    expect(await frameVisibility(f.ctx, ids[0]!, first.frame, SIGNAL, 'lost public receipt', true)).toBe('claimed')
    await f.ctx.agentSwarm.domain.removeMember(scope, teamId, captain.id, 'alpha', 'left')
    await f.ctx.agentSwarm.domain.removeMember(scope, teamId, captain.id, 'beta', 'left')
    const prompt = vi.spyOn(f.ctx.subagents, 'prompt')
    const open = f.ctx.sessionPersistence.open.bind(f.ctx.sessionPersistence)
    const unreadable = vi.spyOn(f.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      if (args[0] === ids[1] && args[1] === 'read') throw new Error('recipient persistence temporarily unreadable')
      return await open(...args)
    })
    const delivery = new MessageDelivery(f.ctx, { domain: () => f.ctx.agentSwarm.domain, isClosing: () => false,
      scopeOf: agent => f.ctx.agentSwarm.scopeOf(agent), accountAgentUsage: async () => {},
      publicTeam: async () => (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(row => row.id === teamId) })
    try {
      await delivery.deliverPublicMessages(scope, teamId, SIGNAL)
      const afterUnknown = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!
      expect(publicDeliveries(afterUnknown).map(row => row.state)).toEqual(['claimed', 'queued'])
      unreadable.mockRestore()
      await delivery.deliverPublicMessages(scope, teamId, SIGNAL)
      const settled = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!
      expect(publicDeliveries(settled)).toMatchObject([{ state: 'claimed' }, { state: 'not-delivered', reason: 'recipient-removed' }])
      expect(prompt).not.toHaveBeenCalled()
      const archived = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, { formatVersion: 2, author: { kind: 'local-operator' }, requestId: 'archive-absent', content: [{ type: 'text', text: 'Not admitted before archive.' }] })
      await f.ctx.agentSwarm.domain.archiveTeam(scope, teamId, captain.id, 'archived')
      await delivery.deliverPublicMessages(scope, teamId, SIGNAL)
      const final = (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(row => row.id === teamId)!
      expect(publicDeliveries(final.publicChat!.messages.find(row => row.id === archived.message.id)!)).toMatchObject([{ state: 'not-delivered', reason: 'team-archived' }])
      expect(final.publicChat!.messages[0]).toEqual(settled)
      expect(prompt).not.toHaveBeenCalled()
    } finally { unreadable.mockRestore(); prompt.mockRestore() }
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it.each(['pending', 'unknown'] as const)('merges old claims and %s without re-admitting or restoring a parent', async observation => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-pending-'))
  const adapter = new HeldRecording()
  const f = await setup(sandbox, adapter)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const claimed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId,
      { author: { kind: 'local-operator' }, requestId: 'claimed-public', text: 'Already claimed but missing a receipt.' })
    adapter.hold = true
    await f.ctx.subagents.prompt({ requestId: 'hold-existing-activation' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: publicDeliveries(claimed.message)[0]!.frame }] }, SIGNAL)
    await vi.waitFor(() => expect(adapter.entered).toBe(true))
    const active = f.ctx.agents.get(captain.id)!
    const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, {
      author: { kind: 'local-operator' }, requestId: 'pending-public', text: 'Pending must not be resent.' })
    const frame = publicDeliveries(committed.message)[0]!.frame
    active.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] }))
    expect(await f.ctx.sessions.flush(active.session)).toBe(true)
    expect(await frameVisibility(f.ctx, active.id, frame, SIGNAL, 'pending fixture', true)).toBe('pending')
    const prompt = vi.spyOn(f.ctx.subagents, 'prompt')
    const restore = vi.fn(async () => root)
    const delivery = new MessageDelivery(f.ctx, { domain: () => f.ctx.agentSwarm.domain, isClosing: () => false,
      scopeOf: agent => f.ctx.agentSwarm.scopeOf(agent), accountAgentUsage: async () => {}, publicRoot: restore,
      publicTeam: async () => (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team })
    const actualFlush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const flush = observation !== 'unknown' ? undefined : vi.spyOn(f.ctx.sessions, 'flush')
      .mockResolvedValue(false).mockImplementationOnce(actualFlush)
    // The overlapping caller must inherit the first drain's claim repair and
    // deferral, rather than treating a now-claimed first row as a clean wake.
    const results = await Promise.all([delivery.deliverPublicMessages(scope, teamId, SIGNAL), delivery.deliverPublicMessages(scope, teamId, SIGNAL)])
    expect(results).toEqual([{ admitted: false, deferred: true, reconciled: 1 }, { admitted: false, deferred: true, reconciled: 1 }])
    expect(prompt).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    flush?.mockRestore()
    prompt.mockRestore()
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat?.messages.map(message => publicDeliveries(message)[0]?.state)).toEqual(['claimed', 'queued'])
    adapter.release()
    await active.whenIdle()
  } finally { adapter.release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it('keeps a durable cold pending input parked on replay, then consumes old and new public inputs once after an explicit new request', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'swarm-public-pending-source-'))
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'swarm-public-pending-snapshot-'))
  const held = new HeldRecording()
  const source = await setup(sourceRoot, held, true)
  let restarted: Awaited<ReturnType<typeof setup>> | undefined
  let sourceClosed = false
  try {
    const { root, captain, teamId, scope } = await createTeam(source, sourceRoot)
    const task = await source.ctx.agentSwarm.domain.createTask(scope, teamId, captain.id,
      { subject: 'Existing task', description: 'Public pending recovery must not add planning input.' })
    held.hold = true
    await source.ctx.subagents.prompt({ requestId: 'snapshot-existing-turn' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Hold the current fixture turn.' }] }, SIGNAL)
    await vi.waitFor(() => expect(held.entered).toBe(true))
    const callBefore = await publicClient(source, teamId)
    const request = { requestId: 'pending-original', content: [{ type: 'text', text: 'Original pending public input.' }] }
    const sent = await callBefore('append', request)
    const original = (await source.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!
    const originalFrame = publicDeliveries(original)[0]!.frame
    const active = source.ctx.agents.get(captain.id)!
    await vi.waitFor(() => expect(active.inbox.nextStep.some(message => framePredicate(originalFrame)(message))).toBe(true))
    expect(await source.ctx.sessions.flush(active.session)).toBe(true)
    expect(await frameVisibility(source.ctx, captain.id, originalFrame, SIGNAL, 'snapshot pending cut', true)).toBe('pending')
    const cut = await captureRestartSnapshot(source, sourceRoot, snapshotRoot)
    const oldSession = cut.find(session => session.meta.id === captain.id)!
    expect(messagePending(oldSession.events, framePredicate(originalFrame))).toBe(true)
    expect(messageClaimed(oldSession.events, framePredicate(originalFrame))).toBe(false)
    const originalInbox = oldSession.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      .filter(framePredicate(originalFrame))
    expect(originalInbox).toHaveLength(1)
    expect(originalInbox[0]?.source).toMatchObject({ kind: 'user', rpcId: original.id })
    // Cleanup may now clear the source Inbox; the independent durable cut is
    // already sealed and is the only storage loaded by the next Context.
    const closing = source.close()
    held.release()
    await closing
    sourceClosed = true

    const recorder = new Recording()
    restarted = await setup(snapshotRoot, recorder, true)
    const fresh = restarted
    expect(fresh.ctx.agents.get(captain.id)).toBeUndefined()
    expect(fresh.ctx.agents.get(ROOT)).toBeUndefined()
    expect(recorder.requests).toHaveLength(0)
    expect(await frameVisibility(fresh.ctx, captain.id, originalFrame, SIGNAL, 'cold pending snapshot', true)).toBe('pending')
    const call = await publicClient(fresh, teamId)
    const drains = vi.spyOn(MessageDelivery.prototype, 'deliverPublicMessages')
    const prompt = vi.spyOn(fresh.ctx.subagents, 'prompt')
    try {
      expect(await call('requestResult', { requestId: request.requestId })).toMatchObject({ state: 'committed', message: { id: sent.message.id, delivery: { recipients: [{ state: 'queued' }] } } })
      expect(await call('append', request)).toMatchObject({ replayed: true, message: { id: sent.message.id, delivery: { recipients: [{ state: 'queued' }] } } })
      const replayDrain = await drains.mock.results.at(-1)!.value
      expect(replayDrain).toMatchObject({ admitted: false, deferred: true })
      expect(prompt).not.toHaveBeenCalled()
      expect(recorder.requests).toHaveLength(0)
      expect(fresh.ctx.agents.get(captain.id)).toBeUndefined()
      expect(fresh.ctx.agents.get(ROOT)).toBeUndefined()

      const unreadable = vi.spyOn(fresh.ctx.sessionPersistence, 'open').mockRejectedValue(new Error('fixture read unavailable'))
      try {
        fresh.ctx.agentSwarm.kickPublicMessages(scope, teamId)
        const unknownDrain = await drains.mock.results.at(-1)!.value
        expect(unknownDrain).toMatchObject({ admitted: false, deferred: true })
        expect(prompt).not.toHaveBeenCalled()
        expect(recorder.requests).toHaveLength(0)
      } finally { unreadable.mockRestore() }

      const continued = await call('append', { requestId: 'explicit-new-public-input', content: [{ type: 'text', text: 'Continue with this new public input.' }] })
      expect(continued).toMatchObject({ replayed: false })
      await vi.waitFor(async () => expect((await fresh.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat?.messages
        .map(message => publicDeliveries(message)[0]?.state)).toEqual(['claimed', 'claimed']), { timeout: 10_000 })
      await fresh.ctx.agents.get(captain.id)?.whenIdle()
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(prompt.mock.calls[0]?.[0].requestId).toBe(continued.message.id)
      const after = (await fresh.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(after.tasks).toEqual([task])
      expect(after.publicChat?.messages[0]).toMatchObject({ id: original.id, delivery: { recipients: [{ frame: originalFrame, state: 'claimed' }] } })
      const stored = await readPersistedSession(fresh.ctx.sessionPersistence, captain.id, SIGNAL)
      const messages = after.publicChat!.messages
      const requests = recorder.requests.filter(value => value.sessionId === captain.id)
      expect(requests).toHaveLength(1)
      for (const message of messages) {
        const frame = publicDeliveries(message)[0]!.frame
        const insertions = stored.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).filter(framePredicate(frame))
        const claims = stored.events.flatMap(event => event.type === 'user/message' ? [event.data] : []).filter(framePredicate(frame))
        expect(insertions).toHaveLength(1)
        expect(claims).toHaveLength(1)
        expect(claims[0]?.id).toBe(insertions[0]?.id)
        if (message.id === original.id) expect(claims[0]?.id).toBe(originalInbox[0]?.id)
        expect(requests[0]?.messages.filter(row => row.role === 'user').flatMap(row => row.content)
          .filter(part => part.type === 'text' && part.text === frame)).toHaveLength(1)
      }
      expect(stored.events.flatMap(event => event.type === 'user/message' ? event.data.content : [])
        .some(part => part.type === 'text' && part.text.startsWith('The Host restarted while this managed Team still had unfinished work.'))).toBe(false)
    } finally { prompt.mockRestore(); drains.mockRestore() }
  } finally {
    held.release()
    if (!sourceClosed) await source.close()
    await restarted?.close()
    await Promise.all([sourceRoot, snapshotRoot].map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  }
}, 30_000)
