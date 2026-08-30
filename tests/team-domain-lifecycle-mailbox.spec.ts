import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import type { TeamMessage } from '../src/domain/types.js'
import { openStorageStack, unitFilePath, type StorageStack } from './helpers/storage-stack.js'

describe('TeamDomain over the official Storage Domain', () => {
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
  it('recovers interrupted provisioning idempotently and keeps retired names occupied (F12)', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limited = new TeamDomain(stack.store, {
      ...DEFAULT_TEAM_LIMITS,
      maxMembers: 1,
    }, () => tick++)
    const team = await limited.createTeam(scope, 'captain-session', 'Recovery team', 'Recover provisioning')
    await limited.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'first attempt', sessionId: 'member-orphan', provider: 'spawn',
    })

    const reloaded = new TeamDomain(stack.store, {
      ...DEFAULT_TEAM_LIMITS,
      maxMembers: 1,
    }, () => tick++)
    const recovered = await reloaded.recoverProvisioningMembers(
      scope, team.id, 'captain-session', 'runtime restarted during provisioning',
    )
    expect(recovered).toMatchObject([{ sessionId: 'member-orphan', phase: 'failed' }])
    const afterRecovery = await reloaded.snapshot(scope, team.id, 'captain-session')

    expect(await reloaded.recoverProvisioningMembers(
      scope, team.id, 'captain-session', 'second recovery pass',
    )).toEqual([])
    const afterIdempotentPass = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(afterIdempotentPass.team.revision).toBe(afterRecovery.team.revision)

    // F12 (M1C, official lifetime alignment): this test previously asserted
    // one bounded retired-slot replacement — re-provisioning the failed
    // member's name succeeded, replaced the slot and deleted the retired
    // usage cursor. Official semantics keep a used name occupied for the
    // Team's lifetime and count the retained record toward maxMembers, so
    // those assertions were inverted: the same name is now taken, and even a
    // fresh name cannot exceed the total roster bound.
    await expect(reloaded.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'replacement', sessionId: 'member-replacement', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(reloaded.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker-two', role: 'replacement', sessionId: 'member-replacement', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    const afterReplacement = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(afterReplacement.team.members).toHaveLength(1)
    expect(afterReplacement.team.members[0]).toMatchObject({ sessionId: 'member-orphan', phase: 'failed' })
    // The retired record's usage cursor is retained instead of deleted.
    expect(afterReplacement.team.usageCursors['member-orphan']).toBe(-1)
  })

  it('scenario 7: fences a removed member before requeuing their task and cancelling mail', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'owned work', description: 'Must survive member removal.',
    })
    const claim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, task.revision, 'member-1',
    )
    await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'pending', 'wakeup')
    await domain.queueMessage(scope, team.id, 'member-1', 'captain', 'member result', 'quiet')

    const removed = await domain.removeMember(
      scope, team.id, 'captain-session', 'worker-1', 'member is unavailable',
    )
    expect(removed.requeuedTaskIds).toEqual([task.id])
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.members[0]?.phase).toBe('removed')
    expect(snapshot.team.tasks[0]).toMatchObject({ status: 'pending' })
    expect(snapshot.team.tasks[0]).not.toHaveProperty('ownerSessionId')
    expect(snapshot.pendingMessageIds).toEqual([])
    expect(snapshot.team.messages).toHaveLength(2)
    expect(snapshot.team.messages.every(message => message.phase === 'cancelled')).toBe(true)
    await expect(domain.submitTask(
      scope,
      team.id,
      'member-1',
      task.id,
      snapshot.team.tasks[0]!.revision,
      claim.attempt.id,
      'late result',
    )).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
  })

  it('archives a Team atomically and permits the captain to create a new Team', async () => {
    const team = await teamWithMembers(1)
    await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'unfinished', description: 'Archive this task.',
    })
    const archived = await domain.archiveTeam(
      scope, team.id, 'captain-session', 'goal was cancelled',
    )
    expect(archived.phase).toBe('archived')
    expect(archived.tasks[0]?.status).toBe('cancelled')
    expect(await domain.findMembership(scope, 'captain-session')).toBeUndefined()

    const replacement = await domain.createTeam(
      scope, 'captain-session', 'Replacement', 'A new active goal',
    )
    expect(replacement.phase).toBe('active')
  })

  it('wakes a revision waiter from the committed state change without polling', async () => {
    const team = await teamWithMembers(1)
    const before = await domain.snapshot(scope, team.id, 'captain-session')
    const controller = new AbortController()
    const waiting = domain.waitForChange(
      scope, team.id, 'captain-session', before.team.revision, controller.signal,
    )
    await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'wake', description: 'Notify the waiter after commit.',
    })
    const changed = await waiting
    expect(changed.team.revision).toBeGreaterThan(before.team.revision)
    expect(changed.readyTaskIds).toEqual(['task-1'])
  })

  it('scenario 17: send and acknowledge more than the pending-mail quota over time without permanent mailbox exhaustion', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limits = { ...DEFAULT_TEAM_LIMITS, maxPendingMessagesPerMember: 2, maxRetainedMessages: 3 }
    const limited = new TeamDomain(stack.store, limits, () => tick++)
    const team = await limited.createTeam(scope, 'captain-session', 'Mailbox team', 'Bounded retention')
    for (const worker of ['worker-1', 'worker-2']) {
      await limited.provisionMember(scope, team.id, 'captain-session', {
        name: worker, role: 'receive', sessionId: `member-${worker.slice(-1)}`, provider: 'spawn',
      })
      await limited.settleMember(scope, team.id, `member-${worker.slice(-1)}`, { active: true })
    }

    // Quota+10 send+acknowledge cycles to one target: every send succeeds
    // because delivered receipts never occupy the admission quota.
    const quota = limits.maxPendingMessagesPerMember
    const acked: TeamMessage[] = []
    for (let index = 0; index < quota + 10; index += 1) {
      const message = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', `note ${index}`, 'wakeup')
      expect((await limited.snapshot(scope, team.id, 'captain-session')).pendingMessageIds).toEqual([message.id])
      await limited.acknowledgeMessage(scope, team.id, message.id)
      acked.push(message)
    }
    let snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.pendingMessageIds).toEqual([])
    expect(snapshot.team.messages.map(message => message.id)).toEqual(acked.slice(-3).map(message => message.id))
    expect(snapshot.team.messages.every(message => message.phase === 'delivered')).toBe(true)

    // Admission fails only on per-target pending saturation, with the
    // official structured code; a second target keeps its own quota.
    const first = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'hold one', 'quiet')
    const second = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'hold two', 'quiet')
    await expect(limited.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'over quota', 'quiet',
    )).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    const otherTarget = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-2', 'other target', 'quiet')
    expect(otherTarget.phase).toBe('queued')

    // Ordered replay across a full reload: exact pending/retained split,
    // creation order and revision continuity all survive pruning.
    const before = await limited.snapshot(scope, team.id, 'captain-session')
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const reloaded = new TeamDomain(stack.store, limits, () => tick++)
    snapshot = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.revision).toBe(before.team.revision)
    expect(snapshot.team.messages.map(message => message.id))
      .toEqual([...acked.slice(-3).map(message => message.id), first.id, second.id, otherTarget.id])
    expect(snapshot.pendingMessageIds).toEqual([first.id, second.id, otherTarget.id])

    // Draining the pending quota frees admission again — no permanent loss.
    for (const message of [first, second, otherTarget]) await reloaded.acknowledgeMessage(scope, team.id, message.id)
    const afterDrain = await reloaded.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'after drain', 'quiet')
    expect(afterDrain.phase).toBe('queued')
  })

  it('prunes only terminal receipts, never queued mail, keeping replay order', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limited = new TeamDomain(stack.store, {
      ...DEFAULT_TEAM_LIMITS,
      maxRetainedMessages: 2,
    }, () => tick++)
    const team = await limited.createTeam(scope, 'captain-session', 'Prune team', 'Queued mail survives pruning')
    for (const worker of ['worker-1', 'worker-2']) {
      await limited.provisionMember(scope, team.id, 'captain-session', {
        name: worker, role: 'receive', sessionId: `member-${worker.slice(-1)}`, provider: 'spawn',
      })
      await limited.settleMember(scope, team.id, `member-${worker.slice(-1)}`, { active: true })
    }

    const acked: TeamMessage[] = []
    for (let index = 0; index < 3; index += 1) {
      const message = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', `early ${index}`, 'wakeup')
      await limited.acknowledgeMessage(scope, team.id, message.id)
      acked.push(message)
    }
    let snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.messages.map(message => message.id)).toEqual(acked.slice(1).map(message => message.id))

    // A queued message older than later receipts must survive pruning.
    const held = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'stay queued', 'quiet')
    const later = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-2', 'later receipt', 'wakeup')
    await limited.acknowledgeMessage(scope, team.id, later.id)
    snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.messages.map(message => message.id)).toEqual([acked[2]!.id, held.id, later.id])
    expect(snapshot.team.messages.find(message => message.id === held.id)?.phase).toBe('queued')
    expect(snapshot.pendingMessageIds).toEqual([held.id])
  })

  it('bounds retained receipts when member removal cancels queued mail', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limited = new TeamDomain(stack.store, {
      ...DEFAULT_TEAM_LIMITS,
      maxRetainedMessages: 1,
    }, () => tick++)
    const team = await limited.createTeam(scope, 'captain-session', 'Cancel team', 'Cancel-path pruning')
    await limited.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker-1', role: 'receive', sessionId: 'member-1', provider: 'spawn',
    })
    await limited.settleMember(scope, team.id, 'member-1', { active: true })

    for (const content of ['first', 'second']) {
      const message = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', content, 'wakeup')
      await limited.acknowledgeMessage(scope, team.id, message.id)
    }
    const held = await limited.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'pending at removal', 'quiet')

    await limited.removeMember(scope, team.id, 'captain-session', 'worker-1', 'member is unavailable')
    const snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.messages.map(message => message.id)).toEqual([held.id])
    expect(snapshot.team.messages[0]?.phase).toBe('cancelled')
    expect(snapshot.pendingMessageIds).toEqual([])
  })

  it('loads a v1 record with 1024 retained messages and keeps correct semantics past the old lifetime cap', async () => {
    const team = await teamWithMembers(1)
    await stack.close()

    // Hand-written pre-F6 aggregate: a schema-v1 record whose retained
    // array already holds 1024 delivered receipts — the exact population
    // that permanently exhausted the old lifetime quota.
    const path = unitFilePath(join(sandbox, 'storage'))
    const unit = JSON.parse(await readFile(path, 'utf8')) as {
      tables: { teams: Record<string, { team: { revision: number; messages: unknown[] } }> }
    }
    const stored = unit.tables.teams[team.id]!.team
    stored.revision = 5
    stored.messages = Array.from({ length: 1_024 }, (_, index) => ({
      id: `message-legacy-${index}`,
      senderSessionId: 'captain-session',
      senderName: 'captain',
      targetSessionId: 'member-1',
      targetName: 'worker-1',
      content: `legacy ${index}`,
      delivery: 'wakeup',
      phase: 'delivered',
      // Timestamps stay below the suite's tick baseline (>= 1000) so the
      // creation order of legacy and post-load mail remains comparable.
      createdAt: Math.floor(index / 2),
      deliveredAt: Math.floor(index / 2),
    }))
    await writeFile(path, JSON.stringify(unit, null, 2), 'utf8')

    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    let snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.schemaVersion).toBe(2)
    expect(snapshot.team.messages).toHaveLength(1_024)
    expect(snapshot.pendingMessageIds).toEqual([])

    // The old failure point — the 1025th lifetime message — now succeeds:
    // ten more send+acknowledge cycles all commit with exact pending counts.
    for (let index = 0; index < 10; index += 1) {
      const message = await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', `post-load ${index}`, 'wakeup')
      expect((await domain.snapshot(scope, team.id, 'captain-session')).pendingMessageIds).toEqual([message.id])
      await domain.acknowledgeMessage(scope, team.id, message.id)
    }
    snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.pendingMessageIds).toEqual([])
    expect(snapshot.team.messages.length).toBeLessThanOrEqual(DEFAULT_TEAM_LIMITS.maxRetainedMessages)
    const ids = snapshot.team.messages.map(message => message.id)
    expect(ids).toContain('message-legacy-1023')
    expect(ids).not.toContain('message-legacy-0')
    expect(ids.some(id => id.startsWith('message-legacy-'))).toBe(true)
    // Ordered replay: pruning keeps the retained array creation-ordered,
    // and every transition still bumps the revision exactly once.
    const createdAt = snapshot.team.messages.map(message => message.createdAt)
    expect(createdAt).toEqual([...createdAt].toSorted((left, right) => left - right))
    expect(snapshot.team.revision).toBe(5 + 20)
  })

})
