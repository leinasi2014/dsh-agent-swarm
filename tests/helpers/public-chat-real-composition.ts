/** Shared real Host, HTTP authentication, model recording and durable restart fixtures. */
import { cp, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ClientConnection from '@deepseek-ai/dsh-client-connection'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect } from 'vitest'
import { TeamId } from '../../src/domain/types.js'
import { readPersistedSession } from '../../src/runtime/persisted-session.js'
import { mountRestartComposition as mount, disposeRestartComposition as dispose, restartTool as tool, RESTART_SIGNAL as SIGNAL } from './restart-real-composition.js'

export const ROOT = SessionId('public-root')
const ROUTE = { provider: 'public-fixture', model: 'public-model' }
export class Recording extends LlmAdapter {
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

export class HeldRecording extends Recording {
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

export async function setup(sandbox: string, adapter: Recording, http = false, beforeSwarm?: (ctx: Context, fibers: Fiber[]) => Promise<void>) {
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
    await beforeSwarm?.(ctx, fibers)
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

export async function createTeam(f: Awaited<ReturnType<typeof setup>>, sandbox: string) {
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

export async function addPublicMembers(f: Awaited<ReturnType<typeof setup>>, root: Awaited<ReturnType<typeof createTeam>>['root'], captainId: SessionId) {
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
export async function captureRestartSnapshot(source: Awaited<ReturnType<typeof setup>>, sourceRoot: string, snapshotRoot: string) {
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

export async function publicClient(f: Awaited<ReturnType<typeof setup>>, teamId: string) {
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
