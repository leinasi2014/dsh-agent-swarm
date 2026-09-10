/** Multi-mention commits use the real Team aggregate and exact recipient identities. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { publicDeliveries } from '../src/domain/public-message.js'

const opened: { root: string; stack: StorageStack }[] = []
afterEach(async () => {
  for (const { root, stack } of opened.splice(0).toReversed()) {
    await stack.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'swarm-mentions-'))
  const stack = await openStorageStack(join(root, 'storage'))
  opened.push({ root, stack })
  const scope = join(root, 'workspace')
  const team = await stack.port.createTeam(scope, 'captain', 'Team', 'Mentions', -1, 'managed:main:turn:mentions')
  await stack.port.provisionMember(scope, team.id, 'captain', { name: 'a', role: 'builder', sessionId: 'member-a', provider: 'spawn' })
  await stack.port.settleMember(scope, team.id, 'member-a', { active: true })
  await stack.port.provisionMember(scope, team.id, 'captain', { name: 'b', role: 'reviewer', sessionId: 'member-b', provider: 'spawn' })
  await stack.port.settleMember(scope, team.id, 'member-b', { active: true })
  return { ...stack, scope, team }
}

const input = () => ({ formatVersion: 2 as const, author: { kind: 'local-operator' as const }, requestId: 'mentions-1', content: [
  { type: 'text' as const, text: '请' }, { type: 'mention' as const, memberId: 'member-b' },
  { type: 'text' as const, text: '与' }, { type: 'mention' as const, memberId: 'member-a' },
  { type: 'mention' as const, memberId: 'member-b' },
] })

describe('public mentions v2', () => {
  it('requires the real official callback lease for a cold intermediate parent', () => {
    expect(typeof Reflect.get(SubagentRuntime.prototype, 'withContinuableChild')).toBe('function')
  })

  it('commits all deduplicated recipient intents together while preserving mention order', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 5 }, () => f.port.appendPublicMessage(f.scope, f.team.id, input())))
    expect(new Set(results.map(row => row.message.id)).size).toBe(1)
    expect(results.filter(row => !row.replayed)).toHaveLength(1)
    expect(results[0]!.message).toMatchObject({ formatVersion: 2, content: input().content,
      mentionLabels: [{ memberId: 'member-b', label: 'b' }, { memberId: 'member-a', label: 'a' }],
      delivery: { kind: 'requested', recipients: [
        { state: 'queued', recipientSessionId: 'member-b', parentSessionId: 'captain', frameVersion: 2 },
        { state: 'queued', recipientSessionId: 'member-a', parentSessionId: 'captain', frameVersion: 2 },
      ] } })
    expect((await f.store.read(f.scope, f.team.id))!.publicChat!.messages).toHaveLength(1)
  })

  it('rejects the whole new append if one recipient is not the current Team member', async () => {
    const f = await fixture()
    const before = await f.store.read(f.scope, f.team.id)
    await expect(f.port.appendPublicMessage(f.scope, f.team.id, { ...input(), content: [
      ...input().content, { type: 'mention' as const, memberId: 'foreign-or-old-session' },
    ] })).rejects.toMatchObject({ code: 'TEAM_PUBLIC_RECIPIENT_INVALID' })
    expect(await f.store.read(f.scope, f.team.id)).toEqual(before)
  })

  it('keeps terminal receipts immutable and settles each recipient independently', async () => {
    const f = await fixture()
    const { message } = await f.port.appendPublicMessage(f.scope, f.team.id, input())
    await f.port.acknowledgePublicMessage(f.scope, f.team.id, message.id, 'member-a')
    await f.port.removeMember(f.scope, f.team.id, 'captain', 'b', 'removed')
    const settled = await f.port.settlePublicMessage(f.scope, f.team.id, message.id, 'member-b', 'recipient-removed')
    expect(publicDeliveries(settled)).toMatchObject([
      { state: 'not-delivered', reason: 'recipient-removed' }, { state: 'claimed' },
    ])
    const late = await f.port.acknowledgePublicMessage(f.scope, f.team.id, message.id, 'member-b')
    expect(late).toEqual(settled)
    expect((await f.store.read(f.scope, f.team.id))!.publicChat!.messages[0]).toEqual(settled)
  })

  it('replays frozen v2 facts after removal, archive and lower admission limits', async () => {
    const f = await fixture()
    const committed = await f.port.appendPublicMessage(f.scope, f.team.id, input())
    await f.port.removeMember(f.scope, f.team.id, 'captain', 'b', 'removed')
    await f.port.archiveTeam(f.scope, f.team.id, 'captain', 'done')
    const lowered = new TeamDomain(f.store, { ...DEFAULT_TEAM_LIMITS, maxPublicSegments: 1, maxPublicTextBytes: 1, maxPublicBytes: 1 })
    const retried = await lowered.appendPublicMessage(f.scope, f.team.id, input())
    expect(retried.replayed).toBe(true)
    expect(retried.message).toEqual(committed.message)
    await expect(lowered.appendPublicMessage(f.scope, f.team.id, { author: { kind: 'local-operator' }, requestId: input().requestId, text: committed.message.text }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_REQUEST_CONFLICT' })
  })

  it('admits legacy replay literally but enforces mention confirmation on new human v2 text', async () => {
    const f = await fixture()
    const legacy = { author: { kind: 'local-operator' as const }, requestId: 'old-at', text: '@旧名字' }
    const first = await f.port.appendPublicMessage(f.scope, f.team.id, legacy)
    expect((await f.port.appendPublicMessage(f.scope, f.team.id, legacy)).message).toEqual(first.message)
    const before = await f.store.read(f.scope, f.team.id)
    await expect(f.port.appendPublicMessage(f.scope, f.team.id, { formatVersion: 2, author: legacy.author, requestId: 'new-at', content: [{ type: 'text', text: '@旧名字' }] }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_MENTION_UNCONFIRMED' })
    expect(await f.store.read(f.scope, f.team.id)).toEqual(before)
    const reply = await f.port.appendPublicMessage(f.scope, f.team.id, { formatVersion: 2, author: { kind: 'agent', sessionId: 'member-a' }, requestId: 'reply-at', replyTo: first.message.id, content: [{ type: 'text', text: '@字面回报' }] })
    expect(reply.message.text).toBe('@字面回报')
    expect(publicDeliveries(reply.message)).toEqual([])
  })
})
