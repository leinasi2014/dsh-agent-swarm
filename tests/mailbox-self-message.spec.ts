/**
 * Mailbox self-addressed admission (issue #61, M1D regression review P2-2).
 *
 * The official agent-team `sendAdmitted` rejects a resolved target equal to
 * the caller with `TEAM_SELF_MESSAGE` before quota admission (official
 * `packages/experimental/agent-team/src/mailbox.ts`). This suite proves the
 * domain layer carries the same admission: both self-send forms — the
 * captain addressing the `captain` pseudo-name (exact or folded variant) and
 * a member addressing its own name — reject with the official code inside
 * the aggregate transaction, leaving message count and revision untouched,
 * while both legal directions (captain → member, member → captain) stay
 * admitted.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const SELF_MESSAGE = { code: 'TEAM_SELF_MESSAGE', message: 'a Team member cannot message itself' }

describe('mailbox self-addressed admission over the official Storage Domain', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function teamWithMembers(count = 2) {
    const team = await domain.createTeam(scope, 'captain-session', 'Core team', 'Verify the protocol')
    for (let index = 1; index <= count; index += 1) {
      await domain.provisionMember(scope, team.id, 'captain-session', {
        name: `worker-${index}`,
        role: `role ${index}`,
        sessionId: `member-${index}`,
        provider: 'spawn',
      })
      await domain.settleMember(scope, team.id, `member-${index}`, { active: true })
    }
    return team
  }

  it('rejects captain mail addressed to the captain pseudo-name in exact and folded form (issue #61)', async () => {
    const team = await teamWithMembers(2)
    // The wakeup form is the pathological one the regression review caught:
    // once admitted it is permanently undeliverable (the captain has no
    // parent session to follow up) and erodes its own pending quota.
    await expect(domain.queueMessage(
      scope, team.id, 'captain-session', 'captain', 'note to self', 'wakeup',
    )).rejects.toMatchObject(SELF_MESSAGE)
    // ' Captain ' folds through the NFC + name-fold policy onto the same
    // reserved pseudo-name, so it resolves to the captain session too.
    await expect(domain.queueMessage(
      scope, team.id, 'captain-session', ' Captain ', 'folded self', 'quiet',
    )).rejects.toMatchObject(SELF_MESSAGE)
  })

  it('rejects member mail addressed to the member own name (issue #61)', async () => {
    const team = await teamWithMembers(2)
    await expect(domain.queueMessage(
      scope, team.id, 'member-1', 'worker-1', 'note to self', 'wakeup',
    )).rejects.toMatchObject(SELF_MESSAGE)
  })

  it('leaves no queue side effects: message count, ids and revision are untouched', async () => {
    const team = await teamWithMembers(2)
    const before = await domain.snapshot(scope, team.id, 'captain-session')
    await Promise.allSettled([
      domain.queueMessage(scope, team.id, 'captain-session', 'captain', 'self', 'wakeup'),
      domain.queueMessage(scope, team.id, 'member-1', 'worker-1', 'self', 'quiet'),
    ])
    const after = await domain.snapshot(scope, team.id, 'captain-session')
    expect(after.team.messages).toEqual(before.team.messages)
    expect(after.team.revision).toBe(before.team.revision)
    expect(after.pendingMessageIds).toEqual([])
  })

  it('keeps both legal directions admitted: captain to member and member to captain', async () => {
    const team = await teamWithMembers(2)
    const toMember = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'assignment note', 'quiet',
    )
    const toCaptain = await domain.queueMessage(
      scope, team.id, 'member-1', 'captain', 'report back', 'quiet',
    )
    expect(toMember.phase).toBe('queued')
    expect(toCaptain.phase).toBe('queued')
    expect((await domain.snapshot(scope, team.id, 'captain-session')).pendingMessageIds)
      .toEqual([toMember.id, toCaptain.id])
  })
})
