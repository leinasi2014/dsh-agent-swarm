/** Public messages: the real Storage Domain is the only commit/once authority. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TEAM_LIMITS, TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, unitFilePath, type StorageStack } from './helpers/storage-stack.js'

const roots: string[] = []
const stacks: StorageStack[] = []
afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) await stack.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'swarm-public-domain-'))
  roots.push(root)
  const storage = join(root, 'storage')
  const stack = await openStorageStack(storage)
  stacks.push(stack)
  const scope = join(root, 'workspace')
  const team = await stack.port.createTeam(scope, 'captain', 'Public Team', 'Public communication', -1, 'managed:main:turn:public-test')
  const domain = new TeamDomain(stack.store)
  return { root, storage, stack, scope, team, domain }
}

const human = (requestId: string, text = 'Please reply publicly') => ({ requestId, text, author: { kind: 'local-operator' as const } })

describe('public message aggregate', () => {
  it('keeps old Teams unchanged, then commits one message, request credential and frozen input atomically under concurrent retries', async () => {
    const f = await fixture()
    expect((await f.stack.store.read(f.scope, f.team.id))?.publicChat).toBeUndefined()
    const results = await Promise.all(Array.from({ length: 8 }, () => f.domain.appendPublicMessage(f.scope, f.team.id, human('human-1'))))
    expect(new Set(results.map(result => result.message.id)).size).toBe(1)
    expect(results.filter(result => !result.replayed)).toHaveLength(1)
    const stored = (await f.stack.store.read(f.scope, f.team.id))!
    expect(stored.publicChat?.messages).toHaveLength(1)
    expect(stored.messages).toEqual([])
    expect(stored.tasks).toEqual([])
    const message = stored.publicChat!.messages[0]!
    expect(message).toMatchObject({ sequence: 1, author: { kind: 'local-operator' }, requestId: 'human-1',
      delivery: { state: 'queued', recipientSessionId: 'captain', frameVersion: 1 } })
    expect(message.delivery.state).toBe('queued')
    if (message.delivery.state !== 'not-requested') {
      expect(message.delivery.frame).toContain(message.id)
      expect(message.delivery.frame).toContain('captain')
      expect(message.delivery.frame).toContain('Please reply publicly')
    }
    expect(stored.revision).toBe(f.team.revision + 1)
  })

  it('rejects request-content conflicts and exhausted count/byte capacity without losing once evidence', async () => {
    const f = await fixture()
    const domain = new TeamDomain(f.stack.store, { ...DEFAULT_TEAM_LIMITS, maxPublicMessages: 1 })
    const first = await domain.appendPublicMessage(f.scope, f.team.id, human('one'))
    await expect(domain.appendPublicMessage(f.scope, f.team.id, human('one', 'different'))).rejects.toMatchObject({ code: 'TEAM_PUBLIC_REQUEST_CONFLICT' })
    await expect(domain.appendPublicMessage(f.scope, f.team.id, human('two'))).rejects.toMatchObject({ code: 'TEAM_PUBLIC_CAPACITY' })
    expect((await domain.appendPublicMessage(f.scope, f.team.id, human('one'))).message.id).toBe(first.message.id)
    const tight = new TeamDomain(f.stack.store, { ...DEFAULT_TEAM_LIMITS, maxPublicBytes: 64 })
    await expect(tight.appendPublicMessage(f.scope, f.team.id, human('three', 'x'))).rejects.toMatchObject({ code: 'TEAM_PUBLIC_CAPACITY' })
    expect((await f.stack.store.read(f.scope, f.team.id))?.publicChat?.messages).toHaveLength(1)
  })

  it('preserves original author display and exact delivery frame across rename and real close/reopen', async () => {
    const f = await fixture()
    const first = await f.domain.appendPublicMessage(f.scope, f.team.id, human('cold-human'))
    await f.domain.setCaptainProfile(f.scope, f.team.id, 'captain', first.teamRevision, { displayName: 'New name' })
    await f.stack.close()
    stacks.splice(stacks.indexOf(f.stack), 1)
    const reopened = await openStorageStack(f.storage)
    stacks.push(reopened)
    const domain = new TeamDomain(reopened.store)
    expect((await domain.appendPublicMessage(f.scope, f.team.id, human('cold-human'))).message).toEqual(first.message)
    expect(await domain.publicRequestResult(f.scope, f.team.id, { kind: 'local-operator' }, 'cold-human')).toEqual(first.message)
    const claimed = await domain.acknowledgePublicMessage(f.scope, f.team.id, first.message.id, 'captain')
    expect(claimed.delivery).toMatchObject({ state: 'claimed', frameVersion: 1 })
    expect(await domain.acknowledgePublicMessage(f.scope, f.team.id, first.message.id, 'captain')).toEqual(claimed)
    expect((await domain.appendPublicMessage(f.scope, f.team.id, human('cold-human'))).message).toEqual(claimed)
  })

  it('admits only current Team agents for explicit replies and never schedules a reply for consumption', async () => {
    const f = await fixture()
    const original = await f.domain.appendPublicMessage(f.scope, f.team.id, human('question'))
    const reply = { requestId: 'reply-1', text: 'My public answer', replyTo: original.message.id, author: { kind: 'agent' as const, sessionId: 'captain' } }
    const first = await f.domain.appendPublicMessage(f.scope, f.team.id, reply)
    expect(first.message).toMatchObject({ author: { kind: 'agent', sessionId: 'captain', role: 'captain', name: 'captain' }, delivery: { state: 'not-requested' } })
    expect((await f.domain.appendPublicMessage(f.scope, f.team.id, reply)).message.id).toBe(first.message.id)
    await expect(f.domain.appendPublicMessage(f.scope, f.team.id, { ...reply, requestId: 'outsider', author: { kind: 'agent', sessionId: 'outsider' } }))
      .rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    await expect(f.domain.appendPublicMessage(f.scope, f.team.id, { ...reply, requestId: 'bad-reply', replyTo: 'other-team-message' }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_REPLY_INVALID' })
    await expect(f.domain.appendPublicMessage(f.scope, f.team.id, { requestId: 'no-reply', text: 'no reference', author: { kind: 'agent', sessionId: 'captain' } }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_REPLY_INVALID' })
    await expect(f.domain.appendPublicMessage(join(f.root, 'other-scope'), f.team.id, human('question'))).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })
  })

  it('enforces UTF-8 text bounds and binds replyTo into the once identity', async () => {
    const f = await fixture()
    const domain = new TeamDomain(f.stack.store, { ...DEFAULT_TEAM_LIMITS, maxPublicTextBytes: 6 })
    const first = await domain.appendPublicMessage(f.scope, f.team.id, human('utf8', '中文'))
    await expect(domain.appendPublicMessage(f.scope, f.team.id, human('oversize', '中文文'))).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
    await expect(domain.appendPublicMessage(f.scope, f.team.id, { ...human('utf8', '中文'), replyTo: first.message.id }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_REQUEST_CONFLICT' })
    await expect(domain.appendPublicMessage(f.scope, f.team.id, human('   ', 'x'))).rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })
    expect(await domain.publicRequestResult(f.scope, f.team.id, { kind: 'local-operator' }, 'not-yet-committed')).toBeUndefined()
  })

  it('fails a stale Host target fence before a new append and preserves replay after revision changes', async () => {
    const f = await fixture()
    const first = await f.domain.appendPublicMessage(f.scope, f.team.id, { ...human('fenced'), expectedTeamRevision: f.team.revision, expectedCaptainSessionId: 'captain' })
    await expect(f.domain.appendPublicMessage(f.scope, f.team.id, { ...human('new-fenced'), expectedTeamRevision: f.team.revision, expectedCaptainSessionId: 'captain' }))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    expect((await f.domain.appendPublicMessage(f.scope, f.team.id, { ...human('fenced'), expectedTeamRevision: f.team.revision, expectedCaptainSessionId: 'captain' })).message.id).toBe(first.message.id)
  })

  it('rejects malformed durable public records on reopen instead of silently ignoring them', async () => {
    const f = await fixture()
    await f.domain.appendPublicMessage(f.scope, f.team.id, human('durable'))
    await f.stack.close()
    stacks.splice(stacks.indexOf(f.stack), 1)
    const path = unitFilePath(f.storage)
    const unit = JSON.parse(await readFile(path, 'utf8'))
    unit.tables.teams[f.team.id].team.publicChat.messages[0].delivery.recipientSessionId = 'other-captain'
    await writeFile(path, JSON.stringify(unit), 'utf8')
    let failure: unknown
    try { const opened = await openStorageStack(f.storage); await opened.close() } catch (error) { failure = error }
    expect(failure).toBeDefined()
  })
})
