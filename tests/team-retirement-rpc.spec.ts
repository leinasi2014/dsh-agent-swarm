/** The authenticated operator can retire a cold Team without impersonating its Captain. */
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HeldRecording, Recording, ROOT, addPublicMembers, captureRestartSnapshot, createTeam, publicClient, setup } from './helpers/public-chat-real-composition.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamRetirementStore } from '../src/storage/team-retirement-store.js'
import { publicDeliveries } from '../src/domain/public-message.js'
import { framePredicate, frameVisibility } from '../src/runtime/frame-visibility.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, unlink: vi.fn(actual.unlink) }
})

async function retirementClient(f: Awaited<ReturnType<typeof setup>>, teamId: string) {
  const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
  return async (endpoint: string, fields: object = {}) => {
    const method = `team/v1/${endpoint}`
    const response = await fetch(`${f.base}/swarm-public/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'retirement-proof', method,
        payload: { schemaVersion: 1, target: { rootSessionId: ROOT, teamId }, ...fields } }) })
    expect(response.status).toBe(200)
    return (await response.json()).result
  }
}

it('deletes exclusive Sessions and private memory, preserves Main and project files, and replays after Team disappearance', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-retirement-delete-'))
  const adapter = new Recording()
  const f = await setup(sandbox, adapter, true)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const members = await addPublicMembers(f, root, captain.id)
    const signal = new AbortController().signal
    await f.ctx.subagents.withContinuableChild(root, captain.id, signal, (lead, parentSignal) =>
      f.ctx.subagents.withContinuableChild(lead, members[0]!, parentSignal, async member => {
        await f.ctx.agentSwarmPrivateMemory.add({ agent: member, signal: parentSignal }, 'retirement-private-secret', [])
      }))
    await writeFile(join(sandbox, 'project-output.blend'), 'preserved Blender evidence')
    const call = await retirementClient(f, teamId)
    const preview = await call('preview')
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, value: { deletion: { available: true }, counts: { sessions: 3, memories: 1 } } })
    const request = { requestId: 'permanent-delete-once', action: 'delete', expectedTeamRevision: preview.value.teamRevision, previewDigest: preview.value.previewDigest }
    const beforeCalls = adapter.requests.length
    const result = await call('execute', request)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { state: 'completed', action: 'delete' } })
    expect(await f.ctx.agentSwarm.listTeamAggregates(scope)).toHaveLength(0)
    for (const id of [captain.id, ...members]) {
      expect(await f.ctx.sessionPersistence.stat(id)).toBeUndefined()
      expect(f.ctx.agents.get(id)).toBeUndefined()
      expect(f.ctx.sessions.get(id)).toBeUndefined()
      await expect(f.ctx.sessionPersistence.open(id, 'read')).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
    }
    expect(await f.ctx.sessionPersistence.stat(ROOT)).toBeDefined()
    expect(f.ctx.agents.get(ROOT)).toBe(root)
    expect(await readFile(join(sandbox, 'project-output.blend'), 'utf8')).toBe('preserved Blender evidence')
    expect(await readFile(join(sandbox, 'storage', 'agent_swarm_member_private_memory.json'), 'utf8')).not.toContain('retirement-private-secret')
    expect(adapter.requests).toHaveLength(beforeCalls)
    expect(await call('execute', request)).toMatchObject({ ok: true, value: { state: 'completed', replayed: true } })
    expect(await call('requestResult', { requestId: request.requestId })).toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(await f.ctx.sessionPersistence.stat(SessionId('public-root'))).toBeDefined()
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('recovers a stopped deletion receipt after partial physical removal and a completely new Host composition', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retirement-host-recovery-'))
  let f = await setup(sandbox, new Recording(), true)
  let opened = true
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const members = await addPublicMembers(f, root, captain.id)
    const signal = new AbortController().signal
    await f.ctx.subagents.withContinuableChild(root, captain.id, signal, (lead, parentSignal) =>
      f.ctx.subagents.withContinuableChild(lead, members[0]!, parentSignal, async member => {
        await f.ctx.agentSwarmPrivateMemory.add({ agent: member, signal: parentSignal }, 'recovery-private-memory', [])
      }))
    // Seed retained terminal evidence in the already opened public domain;
    // running workflow settlement is exercised by the real bridge test.
    await f.ctx.storageDomain.get('agent_swarm_workflow')!.table('runs').put('recovery-run', { schemaVersion: 1, runId: 'recovery-run', scope, teamId, meta: { name: 'Recovery fixture', description: 'Retained workflow evidence' },
      state: 'completed', stopReason: 'completed', agentsStarted: 0, createdAt: 1, updatedAt: 2, settledAt: 2 })
    await writeFile(join(sandbox, 'preserved-output.blend'), 'preserve actual project output')
    const call = await retirementClient(f, teamId), preview = await call('preview')
    expect(preview.value.counts).toMatchObject({ memories: 1, workflowRuns: 1 })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(unlink).mockImplementationOnce(async path => { await actual.unlink(path); throw new Error('Host stopped after physical unlink') })
    const request = { action: 'delete', requestId: 'resume-original-receipt', expectedTeamRevision: preview.value.teamRevision, previewDigest: preview.value.previewDigest }
    expect(await call('execute', request)).toMatchObject({ ok: false })
    expect(await call('requestResult', { requestId: request.requestId })).toMatchObject({ ok: true, value: { state: 'pending' } })
    expect(await readFile(join(sandbox, 'storage', 'agent_swarm_retirement.json'), 'utf8')).toMatch(/"stage"\s*:\s*"stopped"/u)
    vi.mocked(unlink).mockRestore()
    await f.close(); opened = false
    const recorder = new Recording()
    f = await setup(sandbox, recorder, true); opened = true
    const recovered = await retirementClient(f, teamId)
    expect(await recovered('requestResult', { requestId: request.requestId })).toMatchObject({ ok: true, value: { state: 'completed', replayed: true } })
    expect(await f.ctx.agentSwarm.listTeamAggregates(scope)).toEqual([])
    for (const id of [captain.id, ...members]) expect(await f.ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(await f.ctx.sessionPersistence.stat(ROOT)).toBeDefined()
    expect(await readFile(join(sandbox, 'preserved-output.blend'), 'utf8')).toBe('preserve actual project output')
    expect(await readFile(join(sandbox, 'storage', 'agent_swarm_member_private_memory.json'), 'utf8')).not.toContain('recovery-private-memory')
    expect(await readFile(join(sandbox, 'storage', 'agent_swarm_workflow.json'), 'utf8')).not.toContain('recovery-run')
    expect(recorder.requests).toHaveLength(0)
    expect(await recovered('execute', request)).toMatchObject({ ok: true, value: { state: 'completed', replayed: true } })
  } finally { vi.mocked(unlink).mockRestore(); if (opened) await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('stops a busy Captain and settles exclusively owned cold pending public input without changing claimed history or waking a model', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'retirement-busy-source-'))
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'retirement-cold-pending-'))
  const held = new HeldRecording(), source = await setup(sourceRoot, held, true)
  let cold: Awaited<ReturnType<typeof setup>> | undefined
  const signal = new AbortController().signal
  try {
    const { root, captain, teamId, scope } = await createTeam(source, sourceRoot)
    const send = await publicClient(source, teamId)
    await send('append', { requestId: 'claimed-before-retirement', content: [{ type: 'text', text: 'Already consumed input.' }] })
    await vi.waitFor(async () => {
      const team = (await source.ctx.agentSwarm.listTeamAggregates(scope))[0]!
      expect(publicDeliveries(team.publicChat!.messages[0]!)[0]?.state).toBe('claimed')
    })
    held.hold = true
    await source.ctx.subagents.prompt({ requestId: 'busy-at-retirement' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Hold current work.' }] }, signal)
    await vi.waitFor(() => expect(held.entered).toBe(true))
    await send('append', { requestId: 'pending-at-retirement', content: [{ type: 'text', text: 'Pending input to be settled.' }] })
    const pending = (await source.ctx.agentSwarm.listTeamAggregates(scope))[0]!.publicChat!.messages[1]!
    const frame = publicDeliveries(pending)[0]!.frame
    const active = source.ctx.agents.get(captain.id)!
    await vi.waitFor(() => expect(active.inbox.nextStep.some(framePredicate(frame))).toBe(true))
    expect(await source.ctx.sessions.flush(active.session)).toBe(true)
    expect(await frameVisibility(source.ctx, captain.id, frame, signal, 'retirement cut', true)).toBe('pending')
    await captureRestartSnapshot(source, sourceRoot, snapshotRoot)
    const stop = await retirementClient(source, teamId)
    const before = await stop('preview')
    const stopping = stop('execute', { action: 'archive', requestId: 'busy-archive', expectedTeamRevision: before.value.teamRevision })
    let earlyResult: unknown
    void stopping.then(value => { earlyResult = value })
    await vi.waitFor(() => {
      if (earlyResult !== undefined) expect(earlyResult).toMatchObject({ ok: true })
      expect(source.ctx.agentSwarm.retirement.isRetired(scope, teamId)).toBe(true)
    }, { timeout: 10_000 })
    held.release()
    expect(await stopping).toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(source.ctx.agents.get(captain.id)).toBeUndefined()
    expect(source.ctx.sessions.get(captain.id)).toBeUndefined()
    expect(source.ctx.agents.get(root.id)).toBe(root)

    const recorder = new Recording()
    cold = await setup(snapshotRoot, recorder, true)
    expect(cold.ctx.agents.get(captain.id)).toBeUndefined()
    expect(await frameVisibility(cold.ctx, captain.id, frame, signal, 'cold retirement cut', true)).toBe('pending')
    const archive = await retirementClient(cold, teamId)
    const fresh = await archive('preview')
    expect(await archive('execute', { action: 'archive', requestId: 'cold-archive', expectedTeamRevision: fresh.value.teamRevision })).toMatchObject({ ok: true, value: { state: 'completed' } })
    const messages = (await cold.ctx.agentSwarm.listTeamAggregates(scope))[0]!.publicChat!.messages
    expect(publicDeliveries(messages[0]!)[0]).toMatchObject({ state: 'claimed' })
    expect(publicDeliveries(messages[1]!)[0]).toMatchObject({ state: 'not-delivered', reason: 'team-archived' })
    expect(recorder.requests).toHaveLength(0)
    expect(cold.ctx.agents.get(captain.id)).toBeUndefined()
    expect(await frameVisibility(cold.ctx, captain.id, frame, signal, 'preserved cold inbox history', true)).toBe('pending')
  } finally {
    held.release(); await cold?.close(); await source.close()
    await Promise.all([sourceRoot, snapshotRoot].map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  }
}, 30_000)

it.each(['header', 'artifact'] as const)('preserves replacement content when a frozen Session %s identity changes before stopping', async changed => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-retirement-replacement-'))
  const f = await setup(sandbox, new Recording(), true)
  let restore = () => {}
  let replacementDirectory = ''
  try {
    const { captain, teamId } = await createTeam(f, sandbox)
    const call = await retirementClient(f, teamId)
    const preview = await call('preview')
    const original = TeamRetirementStore.prototype.put
    let replaced = false
    const spy = vi.spyOn(TeamRetirementStore.prototype, 'put').mockImplementation(async function (this: TeamRetirementStore, receipt) {
      await original.call(this, receipt)
      if (replaced || receipt.teamId !== teamId || receipt.stage !== 'frozen') return
      replaced = true
      const frozen = receipt.sessions.find(row => row.id === captain.id)!
      replacementDirectory = frozen.artifact!.directory
      const old = (await f.ctx.sessionPersistence.stat(captain.id))!.header
      await rename(frozen.artifact!.directory, join(sandbox, 'preserved-original-session'))
      const replacement = await f.ctx.sessionPersistence.create({ ...old, createdAt: old.createdAt + (changed === 'header' ? 100 : 0) })
      try { await replacement.flush() } finally { await replacement.close() }
      await writeFile(join(frozen.artifact!.directory, 'replacement-evidence'), 'replacement data must survive')
    })
    restore = () => { spy.mockRestore() }
    const result = await call('execute', { requestId: 'frozen-original-only', action: 'delete', expectedTeamRevision: preview.value.teamRevision, previewDigest: preview.value.previewDigest })
    expect(result).toMatchObject({ ok: false, error: { code: 'TEAM_RETIREMENT_SESSION_CONFLICT' } })
    expect(replaced).toBe(true)
    expect((await f.ctx.sessionPersistence.stat(captain.id))?.header.createdAt).toBeGreaterThan(100)
    expect(await readFile(join(replacementDirectory, 'replacement-evidence'), 'utf8')).toBe('replacement data must survive')
    expect(await call('requestResult', { requestId: 'frozen-original-only' })).toMatchObject({ ok: true, value: { state: 'pending' } })
  } finally { restore(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('requires a new confirmation when an already admitted descendant materializes while its parent is stopping', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retirement-growing-scope-'))
  const f = await setup(sandbox, new Recording(), true)
  let restore = () => {}
  try {
    const { captain, teamId } = await createTeam(f, sandbox)
    const call = await retirementClient(f, teamId)
    const preview = await call('preview')
    const original = TeamRetirementStore.prototype.put
    let added = false
    const childId = SessionId('late-owned-descendant')
    const spy = vi.spyOn(TeamRetirementStore.prototype, 'put').mockImplementation(async function (this: TeamRetirementStore, receipt) {
      await original.call(this, receipt)
      if (added || receipt.teamId !== teamId || receipt.stage !== 'frozen') return
      added = true
      // Public persistence completes a previously admitted child's durable
      // artifact after the initial manifest. No model or new live Agent starts.
      const parent = (await f.ctx.sessionPersistence.stat(captain.id))!.header
      const child = await f.ctx.sessionPersistence.create({ ...parent, id: childId, parentSession: captain.id, createdAt: parent.createdAt + 1 })
      try { await child.flush() } finally { await child.close() }
    })
    restore = () => { spy.mockRestore() }
    const request = { action: 'delete', requestId: 'original-scope', expectedTeamRevision: preview.value.teamRevision, previewDigest: preview.value.previewDigest }
    expect(await call('execute', request)).toMatchObject({ ok: true, value: { state: 'confirmation-required', counts: { sessions: 2 } } })
    for (const id of [captain.id, childId]) expect(await f.ctx.sessionPersistence.stat(id)).toBeDefined()
    expect(await call('execute', request)).toMatchObject({ ok: true, value: { state: 'confirmation-required', replayed: true } })
    const expanded = await call('preview')
    expect(expanded.value.counts.sessions).toBe(2)
    expect(await call('execute', { ...request, requestId: 'confirmed-expanded-scope', expectedTeamRevision: expanded.value.teamRevision, previewDigest: expanded.value.previewDigest }))
      .toMatchObject({ ok: true, value: { state: 'completed' } })
    for (const id of [captain.id, childId]) expect(await f.ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(await f.ctx.sessionPersistence.stat(ROOT)).toBeDefined()
  } finally { restore(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('preserves an ordinary fork and a Session shared by another workspace while deleting only the exclusive Team branch', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retirement-protected-sessions-'))
  const f = await setup(sandbox, new Recording(), true)
  const signal = new AbortController().signal
  try {
    const { root, captain, teamId } = await createTeam(f, sandbox)
    const members = await addPublicMembers(f, root, captain.id)
    const fork = await f.ctx.subagents.withContinuableChild(root, captain.id, signal, async lead => {
      const independent = f.ctx.sessions.fork(lead.session, undefined, SessionId('independent-ordinary-fork'))
      expect(independent.header.isSeeded).toBe(true)
      const stored = await f.ctx.sessionPersistence.create(independent.header, { inheritedEventCount: independent.inheritedEventCount })
      try { await stored.append(independent.snapshotEvents()); await stored.flush() } finally { await stored.close() }
      return independent
    })
    const otherScope = join(sandbox, 'unrelated-workspace')
    const other = await f.ctx.agentSwarm.domain.createTeam(otherScope, members[0]!, 'Unrelated Team', 'Protect shared Session across scope', -1)
    const beforeShared = await readPersistedSession(f.ctx.sessionPersistence, members[0]!, signal)
    const beforeFork = await readPersistedSession(f.ctx.sessionPersistence, fork.id, signal)
    const call = await retirementClient(f, teamId)
    const preview = await call('preview')
    expect(preview).toMatchObject({ ok: true, value: { counts: { sessions: 2, protectedSessions: 3 } } })
    expect(await call('execute', { action: 'delete', requestId: 'exclusive-only', expectedTeamRevision: preview.value.teamRevision, previewDigest: preview.value.previewDigest }))
      .toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(await f.ctx.sessionPersistence.stat(captain.id)).toBeUndefined()
    expect(await f.ctx.sessionPersistence.stat(members[1]!)).toBeUndefined()
    expect(await readPersistedSession(f.ctx.sessionPersistence, members[0]!, signal)).toEqual(beforeShared)
    expect(await readPersistedSession(f.ctx.sessionPersistence, fork.id, signal)).toEqual(beforeFork)
    expect(f.ctx.sessions.get(fork.id)).toBe(fork)
    expect((await f.ctx.agentSwarm.listTeamAggregates(otherScope))[0]).toEqual(other)
    expect(f.ctx.agents.get(ROOT)).toBe(root)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('archives through authenticated operator RPC and preserves the archived Team and Session history', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-retirement-http-'))
  const adapter = new Recording()
  const f = await setup(sandbox, adapter, true)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const memberIds = await addPublicMembers(f, root, captain.id)
    await vi.waitFor(() => expect(f.routes.some(route => route.path === '/swarm-public')).toBe(true))
    const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const before = (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)!
    const input = { schemaVersion: 1, target: { rootSessionId: ROOT, teamId }, requestId: 'operator-archive-once',
      expectedTeamRevision: before.revision, action: 'archive' }
    const call = async (payload: object, authenticated = true) => {
      const response = await fetch(f.base + '/swarm-public/team/v1/execute', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
        body: JSON.stringify({ type: 'client-request', rpcId: 'retirement-proof', method: 'team/v1/execute', payload }),
      })
      return { status: response.status, result: response.headers.get('content-type')?.includes('json') ? (await response.json()).result : undefined }
    }
    expect((await call(input, false)).status).toBe(401)
    expect((await call({ ...input, actorSessionId: captain.id })).result).toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    const archived = await call(input)
    expect(archived.result, JSON.stringify(archived.result)).toMatchObject({ ok: true, value: { state: 'completed', action: 'archive' } })
    expect((await f.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)?.phase).toBe('archived')
    expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    expect(await f.ctx.sessionPersistence.stat(captain.id)).toBeDefined()
    expect(await f.ctx.sessionPersistence.stat(ROOT)).toBeDefined()
    const beforeCalls = adapter.requests.length
    const historyCall = await retirementClient(f, teamId)
    const membersResponse = await fetch(f.base + '/swarm/v1', { method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: ROOT, teamId } }) })
    const members = await membersResponse.json()
    expect(members, JSON.stringify(members)).toMatchObject({ ok: true, value: { binding: { rootSessionId: captain.id, teamId } } })
    expect(members.value.members.map((row: { historySessionId?: string }) => row.historySessionId)).toEqual(memberIds)
    expect(members.value.members.every((row: { phase: string; sessionId?: string; composition: { state: string; reason: string } }) =>
      row.phase === 'removed' && row.sessionId === undefined && row.composition.state === 'unavailable' && row.composition.reason === 'removed')).toBe(true)
    expect(await historyCall('history', { sessionId: memberIds[0], cursor: 0 })).toMatchObject({ ok: true, value: { readonly: true, sessionId: memberIds[0] } })
    expect(memberIds.every(id => f.ctx.agents.get(id) === undefined && f.ctx.sessions.get(id) === undefined)).toBe(true)
    const history = await historyCall('history', { sessionId: captain.id, cursor: 0 })
    expect(history, JSON.stringify(history)).toMatchObject({ ok: true, value: { readonly: true, sessionId: captain.id } })
    expect(history.value.entries.some((entry: { role: string; content: string }) => entry.role === 'assistant' && entry.content.includes('PRIVATE SESSION OUTPUT MUST STAY PRIVATE'))).toBe(true)
    expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    await expect(f.ctx.agents.resume({ resumeSessionId: captain.id })).rejects.toMatchObject({ code: 'TEAM_RETIRED' })
    expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    expect(f.ctx.sessions.get(captain.id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(beforeCalls)
    expect(await f.ctx.sessionPersistence.stat(captain.id)).toBeDefined()
    expect((await call(input)).result).toMatchObject({ ok: true, value: { state: 'completed', action: 'archive', replayed: true } })
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
