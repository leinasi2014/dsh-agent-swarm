/** I1b-1A: canonical Team aggregate relay-once evidence, no overlay fake. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TEAM_LIMITS, TeamDomain } from '../src/domain/team-domain.js'
import { queueMessageOnce } from '../src/domain/team-domain-interaction.js'
import type { TeamDomainDeps } from '../src/domain/team-domain-shared.js'
import { TeamId, type TeamState } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const stacks: StorageStack[] = []
const roots: string[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) await stack.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function v1(id: string): TeamState {
  return {
    schemaVersion: 1, id: TeamId(id), revision: 1, name: 'I1b', description: 'v1 migration fixture',
    captainSessionId: 'captain', phase: 'active',
    members: [{ name: 'worker', role: 'worker', sessionId: 'worker', provider: 'spawn', phase: 'active', createdAt: 1 }],
    tasks: [], attempts: [], messages: [], budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 }, usageCursors: { captain: -1 }, memory: [], nextTaskNumber: 1, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
  }
}

describe('I1b relay-once Team aggregate authority', () => {
  it('upgrades v1 before exposure and keeps replay, conflict, capacity and scope isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1b-domain-'))
    roots.push(root)
    const stack = await openStorageStack(join(root, 'storage'))
    stacks.push(stack)
    const scope = join(root, 'scope-a')
    const legacy = v1('team-i1b-domain-0001')
    await stack.store.createUniqueForCaptain(scope, legacy)
    const firstRead = await stack.store.read(scope, legacy.id)
    expect(firstRead).toMatchObject({ schemaVersion: 2, interactionEffects: [] })
    await stack.close()
    stacks.splice(stacks.indexOf(stack), 1)
    const reopened = await openStorageStack(join(root, 'storage'))
    stacks.push(reopened)
    expect(await reopened.store.read(scope, legacy.id)).toMatchObject({ schemaVersion: 2, interactionEffects: [] })

    const domain = new TeamDomain(reopened.store, { ...DEFAULT_TEAM_LIMITS, maxInteractionEffects: 1 })
    const first = await domain.queueMemberQuestionRelayOnce(scope, legacy.id, 'worker', 'human-i1b-domain-00000001', 'private question')
    const replay = await domain.queueMemberQuestionRelayOnce(scope, legacy.id, 'worker', 'human-i1b-domain-00000001', 'private question')
    expect(replay).toMatchObject({ replayed: true, messageId: first.messageId, effect: { effectId: first.effect.effectId } })
    expect(first.effect.bodyDigest).not.toContain('private question')
    expect(JSON.stringify(first.effect)).not.toContain('private question')
    await expect(domain.queueMemberQuestionRelayOnce(scope, legacy.id, 'worker', 'human-i1b-domain-00000001', 'changed question'))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_EFFECT_CONFLICT' })
    await expect(domain.queueMemberQuestionRelayOnce(scope, legacy.id, 'worker', 'human-i1b-domain-00000002', 'second question'))
      .rejects.toMatchObject({ code: 'TEAM_INTERACTION_EFFECT_CAPACITY' })
    const current = await reopened.store.read(scope, legacy.id)
    expect(current?.messages.filter(message => message.content === 'private question')).toHaveLength(1)
    expect(current?.interactionEffects).toHaveLength(1)
    const other = await reopened.port.createTeam(scope, 'other-captain', 'Other I1b', 'Cross-Team isolation')
    await reopened.port.provisionMember(scope, other.id, 'other-captain', { name: 'worker', role: 'Worker', sessionId: 'other-worker', provider: 'spawn' })
    await reopened.port.settleMember(scope, other.id, 'other-worker', { active: true })
    const otherEffect = await domain.queueMemberQuestionRelayOnce(scope, other.id, 'other-worker', 'human-i1b-domain-00000001', 'private question')
    expect(otherEffect.effect.effectId).not.toBe(first.effect.effectId)
    await expect(domain.queueMemberQuestionRelayOnce(join(root, 'scope-b'), legacy.id, 'worker', 'human-i1b-domain-00000001', 'private question'))
      .rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })
  })

  it('retains relay-once evidence after normal terminal-mail pruning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1b-prune-'))
    roots.push(root)
    const stack = await openStorageStack(join(root, 'storage'))
    stacks.push(stack)
    const scope = join(root, 'scope')
    const team = await stack.port.createTeam(scope, 'captain-prune', 'I1b prune', 'Permanent effect evidence')
    await stack.port.provisionMember(scope, team.id, 'captain-prune', { name: 'worker', role: 'Worker', sessionId: 'worker-prune', provider: 'spawn' })
    await stack.port.settleMember(scope, team.id, 'worker-prune', { active: true })
    const domain = new TeamDomain(stack.store, { ...DEFAULT_TEAM_LIMITS, maxRetainedMessages: 1 })
    const first = await domain.queueMemberQuestionRelayOnce(scope, team.id, 'worker-prune', 'human-i1b-prune-00000001', 'private relay')
    await domain.acknowledgeMessage(scope, team.id, first.messageId)
    const ordinary = await domain.queueMessage(scope, team.id, 'worker-prune', 'captain', 'ordinary terminal mail', 'wakeup')
    await domain.acknowledgeMessage(scope, team.id, ordinary.id)

    const pruned = await stack.store.read(scope, team.id)
    expect(pruned?.messages.map(message => message.id)).toEqual([ordinary.id])
    expect(pruned?.interactionEffects).toHaveLength(1)
    const replay = await domain.queueMemberQuestionRelayOnce(scope, team.id, 'worker-prune', 'human-i1b-prune-00000001', 'private relay')
    expect(replay).toMatchObject({ replayed: true, messageId: first.messageId, effect: { effectId: first.effect.effectId } })
    expect(replay.message).toBeUndefined()
    const afterReplay = await stack.store.read(scope, team.id)
    expect(afterReplay?.messages.map(message => message.id)).toEqual([ordinary.id])
    expect(afterReplay?.interactionEffects).toHaveLength(1)
  })

  it('rejects each altered fixed binding before any replay mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-i1b-binding-'))
    roots.push(root)
    const stack = await openStorageStack(join(root, 'storage'))
    stacks.push(stack)
    const scope = join(root, 'scope')
    const team = await stack.port.createTeam(scope, 'captain-binding', 'I1b binding', 'Fixed relay binding')
    await stack.port.provisionMember(scope, team.id, 'captain-binding', { name: 'worker', role: 'Worker', sessionId: 'worker-binding', provider: 'spawn' })
    await stack.port.settleMember(scope, team.id, 'worker-binding', { active: true })
    const deps: TeamDomainDeps = { store: stack.store, limits: DEFAULT_TEAM_LIMITS, now: () => 99 }
    const input = {
      requestId: 'human-i1b-binding-00000001' as const,
      step: 'member-question-relay-mail' as const,
      senderSessionId: 'worker-binding', targetName: 'captain', content: 'same body', delivery: 'wakeup' as const,
    }
    const first = await queueMessageOnce(deps, scope, team.id, input)
    for (const changed of [
      { ...input, senderSessionId: 'captain-binding' },
      { ...input, targetName: 'worker' },
      { ...input, content: 'changed body' },
      { ...input, delivery: 'quiet' as const },
    ]) {
      await expect(queueMessageOnce(deps, scope, team.id, changed)).rejects.toMatchObject({ code: 'TEAM_INTERACTION_EFFECT_CONFLICT' })
    }
    const after = await stack.store.read(scope, team.id)
    expect(after?.messages).toHaveLength(1)
    expect(after?.interactionEffects).toHaveLength(1)
    expect(after?.interactionEffects?.[0]).toMatchObject({ effectId: first.effect.effectId, resultingTeamRevision: first.effect.resultingTeamRevision })
  })
})
