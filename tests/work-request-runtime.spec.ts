/** Work requests use real Connection authentication and official durable Sessions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { framePredicate, frameVisibility } from '../src/runtime/frame-visibility.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { restartTool as tool, RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { Recording, ROOT, createTeam, setup } from './helpers/public-chat-real-composition.js'

it('accepts only authenticated operator requests without fabricating a task or chat author', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-work-request-http-'))
  const adapter = new Recording(), f = await setup(sandbox, adapter, true)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    await vi.waitFor(() => expect(f.routes.some(route => route.path === '/swarm-public')).toBe(true))
    const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const call = async (endpoint: string, fields: object = {}, headers: Record<string, string> = { cookie }) => {
      const response = await fetch(`${f.base}/swarm-public/work/v1/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId: 'work-test', method: `work/v1/${endpoint}`,
          payload: { schemaVersion: 1, target: { rootSessionId: ROOT, teamId }, ...fields } }),
      })
      return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
    }
    expect((await call('activity', {}, {})).status).toBe(401)
    expect((await call('activity', {}, { cookie, origin: 'https://untrusted.invalid' })).status).toBe(403)
    for (const forged of [{ origin: { kind: 'main', sessionId: ROOT } }, { actorSessionId: captain.id }]) {
      expect((await call('submit', { requestId: 'forged', description: 'Never create this.', ...forged })).body.result)
        .toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    }
    const sent = (await call('submit', { requestId: 'work-once', description: 'Inspect the request, then decide.', acceptanceCriteria: 'No invented evidence.' })).body.result
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, value: { replayed: false, request: { origin: { kind: 'local-operator' } } } })
    const retry = (await call('submit', { requestId: 'work-once', description: 'Inspect the request, then decide.', acceptanceCriteria: 'No invented evidence.' })).body.result
    expect(retry, JSON.stringify(retry)).toMatchObject({ ok: true, value: { replayed: true, request: { id: sent.value.request.id } } })
    const result = (await call('requestResult', { requestId: 'work-once' })).body.result
    expect(result).toMatchObject({ ok: true, value: { state: 'committed', request: { id: sent.value.request.id } } })
    const conflict = (await call('submit', { requestId: 'work-once', description: 'Different payload.' })).body.result
    expect(conflict).toMatchObject({ ok: false, error: { code: 'TEAM_WORK_REQUEST_CONFLICT' } })
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(team.tasks).toHaveLength(0)
    expect(team.publicChat?.messages ?? []).toHaveLength(0)
    expect(team.messages.filter(message => 'kind' in message && message.kind === 'work-request-notice')).toHaveLength(1)
    const notice = team.messages.find(message => 'kind' in message && message.kind === 'work-request-notice')!
    expect(notice).not.toHaveProperty('senderSessionId')
    expect(notice).not.toHaveProperty('senderName')
    await vi.waitFor(async () => expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.messages.find(message => message.id === notice.id)?.phase).toBe('delivered'), { timeout: 10_000 })
    expect(await frameVisibility(f.ctx, captain.id, messageFrame(notice), SIGNAL, 'work HTTP', true)).toBe('claimed')
    expect(adapter.requests.filter(request => request.sessionId === ROOT).some(request => request.messages.some(message =>
      message.role === 'user' && framePredicate(messageFrame(notice))(message as never)))).toBe(false)
    const activity = (await call('activity')).body.result
    expect(activity, JSON.stringify(activity)).toMatchObject({ ok: true, value: {
      entries: [expect.objectContaining({ kind: 'request-proposed', actor: { kind: 'local-operator' }, workRequestId: sent.value.request.id })],
      referencedRequests: [expect.objectContaining({ id: sent.value.request.id, description: 'Inspect the request, then decide.' })],
    } })
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it.each(['unclaimed', 'lost-receipt'] as const)('recovers a work-only board after full teardown without duplicate input (%s)', async scenario => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-work-cold-'))
  let f = await setup(sandbox, new Recording())
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    const committed = await f.ctx.agentSwarm.domain.submitWorkRequest(scope, teamId, { kind: 'local-operator' },
      { requestId: 'cold-work-once', description: 'Read this original request after restart.' })
    const notice = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.messages.find(message => message.id === committed.notificationMessageId)!
    if (scenario === 'lost-receipt') {
      const ack = vi.spyOn(f.ctx.agentSwarm.domain, 'acknowledgeMessage').mockRejectedValue(new Error('lost receipt after durable model input'))
      f.ctx.agentSwarm.kickWorkRequests(scope, teamId)
      await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(scope, teamId, notice.id), { timeout: 10_000 })
      expect(await frameVisibility(f.ctx, captain.id, messageFrame(notice), SIGNAL, 'before lost-ACK teardown', true)).toBe('claimed')
      await f.ctx.agents.get(captain.id)?.whenIdle()
    }
    const before = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(before.tasks).toHaveLength(0)
    expect(before.messages[0]?.phase).toBe('queued')
    await f.close()
    const adapter = new Recording()
    f = await setup(sandbox, adapter)
    await vi.waitFor(async () => expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.messages[0]?.phase).toBe('delivered'), { timeout: 10_000 })
    await f.ctx.agents.get(captain.id)?.whenIdle()
    const after = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(after.workRequests?.requests.map(request => request.id)).toEqual([committed.request.id])
    expect(after.tasks).toHaveLength(0)
    expect(after.publicChat?.messages ?? []).toHaveLength(0)
    const persisted = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    expect(persisted.events.filter(event => event.type === 'user/message' && framePredicate(messageFrame(notice))(event.data))).toHaveLength(1)
    expect(adapter.requests.filter(request => request.sessionId === captain.id)).toHaveLength(scenario === 'unclaimed' ? 1 : 0)
    const replay = await f.ctx.agentSwarm.domain.submitWorkRequest(scope, teamId, { kind: 'local-operator' },
      { requestId: 'cold-work-once', description: 'Read this original request after restart.' })
    expect(replay).toMatchObject({ replayed: true, request: { id: committed.request.id } })
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('binds the Main tool to its exact live managed origin and rejects other Sessions', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-work-main-'))
  const f = await setup(sandbox, new Recording())
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const args = { team_id: teamId, request_id: 'main-once', description: 'A real Main request.' }
    const sent = await tool(f.ctx, root, 'work-main', 'agent_swarm_submit_work_request', args)
    expect(sent.isError, JSON.stringify(sent)).toBe(false)
    const other = (await f.ctx.agents.create({ sessionId: SessionId('other-work-main'), agentOptions: { provider: 'public-fixture', model: 'public-model' }, meta: { cwd: join(sandbox, 'workspace') } })).agent
    other.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare an unrelated Main.' }] }))
    await other.whenIdle()
    expect((await tool(f.ctx, other, 'other-work', 'agent_swarm_submit_work_request', args)).isError).toBe(true)
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async current => {
      expect((await tool(f.ctx, current, 'captain-forge-main', 'agent_swarm_submit_work_request', args)).isError).toBe(true)
      expect((await tool(f.ctx, current, 'captain-read-work', 'agent_swarm_list_work_requests', {})).value).toMatchObject({
        requests: [expect.objectContaining({ origin: 'main', main_session_id: root.id, description: args.description })],
      })
    })
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(team.workRequests?.requests).toHaveLength(1)
    expect(team.workRequests?.requests[0]?.origin).toEqual({ kind: 'main', sessionId: root.id })
    expect(team.tasks).toHaveLength(0)
    await f.ctx.agents.get(root.id)?.whenIdle()
    const getSession = f.ctx.sessions.get.bind(f.ctx.sessions)
    const replaced = vi.spyOn(f.ctx.sessions, 'get').mockImplementation(id => id === root.id ? undefined : getSession(id))
    try { expect((await tool(f.ctx, root, 'stale-work-main', 'agent_swarm_submit_work_request', args)).isError).toBe(true) }
    finally { replaced.mockRestore() }
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
