/** Real official Connection HTTP auth, Team storage, tool execution and cold activation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { publicDeliveries } from '../src/domain/public-message.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { framePredicate, frameVisibility, waitForFrameClaim } from '../src/runtime/frame-visibility.js'
import { messageClaimed, messagePending } from '../src/runtime/session-acceptance.js'
import { MessageDelivery } from '../src/runtime/message-delivery.js'
import { restartTool as tool, RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { ROOT, Recording, HeldRecording, setup, createTeam, addPublicMembers, captureRestartSnapshot, publicClient } from './helpers/public-chat-real-composition.js'

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
    // Idle only joins the Agent driver; the continuation's durable flush can
    // still be pending. Seal the cut after this exact fixture turn is stored.
    const captainBefore = await vi.waitFor(async () => {
      const persisted = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
      const fixtureInputs = persisted.events.filter(event => event.type === 'user/message'
        && event.data.source?.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'settle-recruitment-fixture'
        && framePredicate('Fixture: finish the existing recruitment reports.')(event.data))
      expect(fixtureInputs).toHaveLength(1)
      const fixture = fixtureInputs[0]!
      const turn = persisted.events.findLast(event => event.type === 'turn/start' && event.seq < fixture.seq)
      expect(turn?.type).toBe('turn/start')
      expect(persisted.events.some(event => event.type === 'turn/end' && event.seq > fixture.seq
        && turn?.type === 'turn/start' && event.data.turn === turn.data.turn && event.data.reason.kind === 'completed')).toBe(true)
      return persisted
    }, { timeout: 10_000 })
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
    const inputSources = newCaptainInputs.map(message => ({ kind: message.source?.kind,
      rpcId: message.source?.kind === 'user' && 'rpcId' in message.source ? message.source.rpcId : undefined }))
    expect(newCaptainInputs.every(message => message.source?.kind === 'subagent-settled' || message.source?.kind === 'plugin'), JSON.stringify(inputSources)).toBe(true)
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
    // Two sequential cold recipients each have a 5s durable-claim window.
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[1]!).map(row => row.state)).toEqual(['claimed', 'claimed']), { timeout: 10_000 })
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
    // whenIdle does not imply the continuable activation has retired. The
    // persistence fault below must govern beta before any public debt exists.
    await vi.waitFor(() => {
      expect(f.ctx.agents.get(ids[1]!)).toBeUndefined()
      expect(f.ctx.sessions.get(ids[1]!)).toBeUndefined()
    })
    const prompt = vi.spyOn(f.ctx.subagents, 'prompt')
    const open = f.ctx.sessionPersistence.open.bind(f.ctx.sessionPersistence)
    const unreadable = vi.spyOn(f.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      if (args[0] === ids[1] && args[1] === 'read') throw new Error('recipient persistence temporarily unreadable')
      return await open(...args)
    })
    const lostReceipt = vi.spyOn(f.ctx.agentSwarm.domain, 'acknowledgePublicMessage').mockRejectedValue(new Error('lost aggregate receipt'))
    try {
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
      expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!).map(row => row.state)).toEqual(['queued', 'queued'])
      lostReceipt.mockRestore()
      prompt.mockClear()
      // Force the real recovery pass into the old race window, with the
      // read fault already active; background idle recovery stays enabled.
      expect(f.ctx.agents.get(ids[1]!)).toBeUndefined()
      await f.ctx.agentSwarm.recoverAgent(captain)
      expect(unreadable.mock.calls.some(args => args[0] === ids[1] && args[1] === 'read')).toBe(true)
      const delivery = new MessageDelivery(f.ctx, { domain: () => f.ctx.agentSwarm.domain, isClosing: () => false,
        scopeOf: agent => f.ctx.agentSwarm.scopeOf(agent), accountAgentUsage: async () => {},
        publicTeam: async () => (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(row => row.id === teamId) })
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
    } finally { lostReceipt.mockRestore(); unreadable.mockRestore(); prompt.mockRestore() }
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
