/** Real authenticated Connection, official continuations and cold Session persistence. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { ROOT, Recording, setup, createTeam, addPublicMembers } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { PNG_IMAGE, ImageRecording, setupImages } from './helpers/public-images-real-composition.js'

async function client(f: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(() => expect(f.routes.some(route => route.path === '/swarm-member-chat'), JSON.stringify(f.routes)).toBe(true))
  const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
  return async (endpoint: string, payload: object, headers: Record<string, string> = { cookie }) => {
    const response = await fetch(`${f.base}/swarm-member-chat/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ type: 'client-request',
        rpcId: randomUUID(), method: endpoint, payload: { schemaVersion: 1, ...payload } }) })
    return { status: response.status, result: response.headers.get('content-type')?.includes('json') ? (await response.json()).result : undefined }
  }
}

it('sends unchanged human input to the exact cold member and can send again after both children retire', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-member-chat-'))
  let f = await setup(sandbox, new Recording(), true)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const [alpha, beta] = await addPublicMembers(f, root, captain.id)
    await f.close()
    const adapter = new Recording()
    f = await setup(sandbox, adapter, true)
    expect(f.ctx.agents.get(ROOT)).toBeUndefined()
    expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    const call = await client(f)
    const selected = await call('target', { sessionId: alpha })
    expect(selected.status).toBe(200)
    expect(selected.result).toEqual({ ok: true, value: { schemaVersion: 1, target: { rootSessionId: ROOT, teamId },
      name: 'alpha', sessionId: alpha, captainSessionId: captain.id } })
    expect(f.ctx.agents.get(ROOT)).toBeUndefined()
    const before = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    for (const text of ['  原样私聊\nhello @beta  ', 'Second message after idle.']) {
      const requestId = randomUUID()
      const sent = await call('prompt', { target: selected.result.value.target, name: 'alpha', sessionId: alpha,
        requestId, content: [{ type: 'text', text }], delivery: 'queue', clientTimeZone: 'Asia/Shanghai' })
      expect(sent.result, JSON.stringify(sent)).toMatchObject({ ok: true, value: { schemaVersion: 1, sessionId: alpha, messageId: expect.any(String) } })
      await vi.waitFor(async () => {
        const persisted = await readPersistedSession(f.ctx.sessionPersistence, alpha!, SIGNAL)
        const messages = persisted.events.filter(event => event.type === 'user/message' && event.data.id === sent.result.value.messageId)
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ data: { content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: requestId, clientTimeZone: 'Asia/Shanghai' } } })
        expect(f.ctx.agents.get(alpha!)).toBeUndefined()
        expect(f.ctx.agents.get(captain.id)).toBeUndefined()
      }, { timeout: 10_000 })
    }
    expect(adapter.requests.filter(request => request.sessionId === alpha)).toHaveLength(2)
    expect(adapter.requests.filter(request => request.sessionId === beta)).toHaveLength(0)
    expect(JSON.stringify(adapter.requests)).not.toContain('Agent Swarm transport maintenance v1:')
    const after = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(after.tasks).toEqual(before.tasks)
    expect(after.publicChat).toEqual(before.publicChat)
    expect(after.messages).toEqual(before.messages)
    expect((await call('target', { sessionId: alpha }, {})).status).toBe(401)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('rejects stale or forged member addresses and preserves ordered text/image content through official admission', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-member-image-')), adapter = new ImageRecording()
  const f = await setupImages(sandbox, adapter)
  try {
    const { root, captain, teamId } = await createTeam(f, sandbox)
    const [alpha, beta] = await addPublicMembers(f, root, captain.id)
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    const call = await client(f)
    const input = { target: { rootSessionId: ROOT, teamId }, name: 'alpha', sessionId: alpha,
      requestId: randomUUID(), content: [{ type: 'text', text: '  before\n' }, PNG_IMAGE, { type: 'text', text: '\nafter  ' }], delivery: 'steer' }
    for (const fields of [{ name: 'beta' }, { sessionId: beta }, { sessionId: captain.id }, { target: { rootSessionId: captain.id, teamId } },
      { target: { rootSessionId: ROOT, teamId: 'other-team' } }, { source: { kind: 'user' } },
      { content: [{ type: 'image', attachment: { id: 'forged' } }] }, { content: [{ type: 'file', receiptId: 'unsupported-file' }] }]) {
      expect((await call('prompt', { ...input, ...fields })).result.ok).toBe(false)
      expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    }
    const invalid = await call('prompt', { ...input, content: [{ ...PNG_IMAGE, data: 'AQID' }] })
    expect(invalid.result).toMatchObject({ ok: false, error: { code: 'subagent/attachment-invalid' } })
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    const admission = vi.spyOn(f.ctx.attachments, 'admitPromptContent')
    const sent = await call('prompt', input)
    expect(sent.result, JSON.stringify(sent)).toMatchObject({ ok: true, value: { sessionId: alpha } })
    expect(admission).toHaveBeenCalledWith(input.content)
    await vi.waitFor(() => expect(f.ctx.agents.get(alpha!)).toBeUndefined())
    const persisted = await readPersistedSession(f.ctx.sessionPersistence, alpha!, SIGNAL)
    const message = persisted.events.find(event => event.type === 'user/message' && event.data.id === sent.result.value.messageId)
    expect(message).toMatchObject({ data: { source: { kind: 'user', rpcId: input.requestId },
      content: [{ type: 'text', text: '  before\n' }, { type: 'image', attachment: { name: PNG_IMAGE.name } }, { type: 'text', text: '\nafter  ' }] } })
    if (message?.type !== 'user/message' || message.data.content[1]?.type !== 'image') throw new Error('Missing actual image event')
    const image = await f.ctx.attachments.readImage(message.data.content[1].attachment)
    expect(image.data.byteLength).toBeGreaterThan(0)
    expect(image.ref).toMatchObject({ width: 1, height: 1, name: PNG_IMAGE.name })
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it('rechecks canonical membership after cold Main restoration before admitting any private input', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-member-rebound-'))
  let f = await setup(sandbox, new Recording(), true)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const [alpha] = await addPublicMembers(f, root, captain.id)
    await f.close()
    f = await setup(sandbox, new Recording(), true)
    const call = await client(f)
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    const spy = vi.spyOn(f.ctx.agents, 'resume').mockImplementationOnce(async (...args) => {
      const handle = await resume(...args)
      await f.ctx.agentSwarm.domain.removeMember(scope, teamId, captain.id, 'alpha', 'Concurrent canonical membership change')
      return handle
    })
    const prompt = vi.spyOn(f.ctx.subagents, 'prompt')
    const result = await call('prompt', { target: { rootSessionId: ROOT, teamId }, name: 'alpha', sessionId: alpha,
      requestId: randomUUID(), content: [{ type: 'text', text: 'must not arrive' }], delivery: 'queue' })
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ resumeSessionId: ROOT })
    expect(result.result).toMatchObject({ ok: false, error: { code: 'SWARM_MEMBER_CHAT_UNAVAILABLE' } })
    expect(prompt).not.toHaveBeenCalled()
    expect((await call('target', { sessionId: alpha })).result.ok).toBe(false)
  } finally { vi.restoreAllMocks(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it.each(['remove', 'close'] as const)('coordinates %s with a real image prompt still awaiting official attachment admission', async action => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-member-admission-'))
  const f = await setupImages(sandbox)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const [alpha] = await addPublicMembers(f, root, captain.id)
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    const call = await client(f)
    const admit = f.ctx.attachments.admitPromptContent.bind(f.ctx.attachments)
    let entered = false
    vi.spyOn(f.ctx.attachments, 'admitPromptContent').mockImplementationOnce(async content => {
      entered = true; await gate; return admit(content)
    })
    const requestId = randomUUID()
    const pending = call('prompt', { target: { rootSessionId: ROOT, teamId }, name: 'alpha', sessionId: alpha,
      requestId, content: [PNG_IMAGE], delivery: 'queue' })
    await vi.waitFor(() => expect(entered).toBe(true))
    const liveCaptain = f.ctx.agents.get(captain.id)!
    expect(liveCaptain).toBeDefined()
    if (action === 'remove') {
      const removed = f.ctx.agentSwarm.removeMember({ agent: liveCaptain, signal: SIGNAL }, 'alpha', 'Remove after in-flight human admission')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.members.find(row => row.name === 'alpha')?.phase).toBe('active')
      release()
      expect((await pending).result.ok).toBe(true)
      await removed
      expect((await call('prompt', { target: { rootSessionId: ROOT, teamId }, name: 'alpha', sessionId: alpha,
        requestId: randomUUID(), content: [{ type: 'text', text: 'after removal' }], delivery: 'queue' })).result.ok).toBe(false)
    } else {
      const close = f.ctx.agentSwarm.dispose()
      await vi.waitFor(() => expect(f.ctx.agentSwarm.closingSignal.aborted).toBe(true))
      release()
      expect((await pending).result.ok).toBe(false)
      await close
      const persisted = await readPersistedSession(f.ctx.sessionPersistence, alpha!, SIGNAL)
      expect(persisted.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'user'
        && 'rpcId' in event.data.source && event.data.source.rpcId === requestId)).toBe(false)
    }
  } finally { release(); vi.restoreAllMocks(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 25_000)
