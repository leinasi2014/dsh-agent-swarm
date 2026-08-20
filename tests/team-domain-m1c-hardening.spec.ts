/**
 * M1C companion hardening (issue #13): F11 ambiguous membership fail-loud,
 * F12 official name-lifetime alignment, F14 archived read-only snapshots and
 * the usage write-coalescing batch (sequence-cursor idempotency).
 *
 * Domain-level evidence over the same real official storage stack as the
 * protocol suite; the runtime seams (bounded disposal F4, depthLimit
 * preflight F15) are covered by the composition and provisioning suites.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('M1C companion hardening over the official Storage Domain', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-m1c-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('rejects ambiguous membership across multiple active teams instead of silently picking the first (F11)', async () => {
    const first = await domain.createTeam(scope, 'captain-session', 'First team', 'Host the shared member')
    await domain.provisionMember(scope, first.id, 'captain-session', {
      name: 'shared-worker', role: 'also founds a team', sessionId: 'member-1', provider: 'spawn',
    })
    await domain.settleMember(scope, first.id, 'member-1', { active: true })
    const second = await domain.createTeam(scope, 'member-1', 'Nested team', 'Founded by the first team member')

    const ambiguous: unknown = await domain.findMembership(scope, 'member-1').catch(error => error)
    expect(ambiguous).toMatchObject({ code: 'TEAM_MEMBERSHIP_AMBIGUOUS' })
    expect((ambiguous as Error).message).toContain(first.id)
    expect((ambiguous as Error).message).toContain(second.id)
    await expect(domain.requireMembership(scope, 'member-1')).rejects.toMatchObject({ code: 'TEAM_MEMBERSHIP_AMBIGUOUS' })

    // Unambiguous identities keep resolving exactly as before.
    expect(await domain.findMembership(scope, 'captain-session')).toMatchObject({ role: 'captain', team: { id: first.id } })
  })

  it('never reuses a retired member name (F12: official lifetime alignment)', async () => {
    const team = await domain.createTeam(scope, 'captain-session', 'Names team', 'Member names live for the Team lifetime')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'first attempt', sessionId: 'member-orphan', provider: 'spawn',
    })
    const recovered = await domain.recoverProvisioningMembers(scope, team.id, 'captain-session', 'runtime restarted')
    expect(recovered).toMatchObject([{ sessionId: 'member-orphan', phase: 'failed' }])

    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'replacement', sessionId: 'member-replacement', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })

    // A removed member's name stays occupied for the Team's lifetime too.
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'temp-worker', role: 'to be removed', sessionId: 'member-temp', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-temp', { active: true })
    await domain.removeMember(scope, team.id, 'captain-session', 'temp-worker', 'rotation')
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'temp-worker', role: 'successor', sessionId: 'member-successor', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })

    // A fresh name is still admitted and the retired records stay retained.
    const replacement = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker-two', role: 'replacement', sessionId: 'member-replacement', provider: 'spawn',
    })
    expect(replacement).toMatchObject({ name: 'worker-two', phase: 'provisioning' })
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.members).toHaveLength(3)
    expect(snapshot.team.members.map(member => member.phase)).toEqual(['failed', 'removed', 'provisioning'])
    expect(snapshot.team.usageCursors['member-orphan']).toBe(-1)
  })

  it('counts retired members toward the maxMembers bound (F12)', async () => {
    const limited = new TeamDomain(stack.store, { ...DEFAULT_TEAM_LIMITS, maxMembers: 1 }, () => tick++)
    const team = await limited.createTeam(scope, 'captain-session', 'One slot team', 'Retired names still occupy the bound')
    await limited.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'first attempt', sessionId: 'member-orphan', provider: 'spawn',
    })
    await limited.recoverProvisioningMembers(scope, team.id, 'captain-session', 'interrupted')

    await expect(limited.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker-two', role: 'different name', sessionId: 'member-replacement', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    const snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.members).toHaveLength(1)
  })

  it('serves terminal snapshots to the archived captain while mutations stay rejected (F14)', async () => {
    const team = await domain.createTeam(scope, 'captain-session', 'Archive team', 'Read-only after archive')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'leaves open work', sessionId: 'member-1', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-1', { active: true })
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'unfinished', description: 'Must be cancelled at archive.',
    })
    await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    await domain.queueMessage(scope, team.id, 'captain-session', 'worker', 'still queued', 'wakeup')

    const archived = await domain.archiveTeam(scope, team.id, 'captain-session', 'work concluded')
    expect(archived.phase).toBe('archived')

    // Reads return the terminal snapshot...
    const terminal = await domain.snapshot(scope, team.id, 'captain-session')
    expect(terminal.team.phase).toBe('archived')
    expect(terminal.team.tasks[0]).toMatchObject({ status: 'cancelled' })
    expect(terminal.pendingMessageIds).toEqual([])

    // ...immediately, even when the caller's cursor is already current: an
    // archived Team can never commit a later revision.
    const current = await domain.waitForChange(scope, team.id, 'captain-session', terminal.team.revision, AbortSignal.timeout(1_500))
    expect(current.team.revision).toBe(terminal.team.revision)

    // A superseded cursor still resolves through the ordinary path.
    const superseded = await domain.waitForChange(scope, team.id, 'captain-session', terminal.team.revision - 1, AbortSignal.timeout(1_500))
    expect(superseded.team.revision).toBe(terminal.team.revision)

    // Members were removed at archive: they are not archived readers.
    await expect(domain.snapshot(scope, team.id, 'member-1')).rejects.toMatchObject({ code: 'TEAM_ARCHIVED' })

    // Mutations stay rejected on the archived aggregate.
    await expect(domain.createTask(scope, team.id, 'captain-session', {
      subject: 'late', description: 'Must be rejected.',
    })).rejects.toMatchObject({ code: 'TEAM_ARCHIVED' })

    // Active-team membership resolution ignores archived teams, while the
    // read path resolves the archived captain — and prefers the captain's
    // next active Team once one exists.
    expect(await domain.findMembership(scope, 'captain-session')).toBeUndefined()
    expect(await domain.findReadMembership(scope, 'captain-session')).toMatchObject({ role: 'captain', team: { id: team.id } })
    const next = await domain.createTeam(scope, 'captain-session', 'Next team', 'Founded after archiving')
    expect(await domain.findReadMembership(scope, 'captain-session')).toMatchObject({ role: 'captain', team: { id: next.id } })
  })

  it('coalesces usage event batches idempotently by sequence across a reopen', async () => {
    const team = await domain.createTeam(scope, 'captain-session', 'Usage team', 'Batch accounting')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'spend tokens', sessionId: 'member-1', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-1', { active: true })

    let budget = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [
      { eventSeq: 4, tokens: 15 },
      { eventSeq: 8, tokens: 5 },
    ])
    expect(budget.usedTokens).toBe(20)
    // Replayed batches and single events never double-count.
    budget = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [
      { eventSeq: 4, tokens: 15 },
      { eventSeq: 8, tokens: 5 },
    ])
    expect(budget.usedTokens).toBe(20)
    budget = await domain.recordSessionUsage(scope, team.id, 'member-1', 8, 99)
    expect(budget.usedTokens).toBe(20)
    // An out-of-order older event stays below the cursor.
    budget = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 6, tokens: 50 }])
    expect(budget.usedTokens).toBe(20)
    budget = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 12, tokens: 7 }])
    expect(budget.usedTokens).toBe(27)

    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    const reloaded = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [
      { eventSeq: 4, tokens: 15 },
      { eventSeq: 8, tokens: 5 },
      { eventSeq: 12, tokens: 7 },
    ])
    expect(reloaded.usedTokens).toBe(27)
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.usageCursors['member-1']).toBe(12)
  })
})
