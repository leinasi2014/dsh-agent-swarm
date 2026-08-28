/**
 * Mail-obsolescence fault-injection / component coverage (task-4, C2 & C7).
 *
 * task-3's `tests/mail-obsolescence.spec.ts` already proves C1 (task
 * completed -> obsolete, never woken), C3 (attempt replaced -> obsolete),
 * C4 (target removed -> obsolete predicate), C5 (explicit supersede ->
 * auditable obsolete) and C6 (restart rebuild). This suite closes the
 * remaining acceptance surface:
 *
 * - C2: a causal task CANCELLED (not merely completed) settles the queued
 *   message obsolete.
 * - C7: no-duplicate / no-loop across the delivery scan — an obsolete
 *   settlement is single-terminal and idempotent under concurrent admission
 *   (the aggregate serializes, exactly one terminal record, no throw loop),
 *   a delivered acknowledgement likewise settles exactly once, and the
 *   delivery-scan projection (`pendingMessageIds`) contains precisely the
 *   still-live queued subset — obsolete/delivered mail is never re-scanned,
 *   so it can never wake its target.
 * - First-false-on-baseline: the C2/scan assertions only hold because the
 *   candidate adds the obsolete phase and its pending-projection exclusion;
 *   on the pre-candidate baseline the late queued message stayed `queued`
 *   (still eligible for delivery/wake) and these tests would fail.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { messageObsoleteReason } from '../src/domain/team-domain-mailbox.js'
import type { TeamId, TeamMessage, TeamState } from '../src/domain/types.js'
import { FaultableBackend, openFaultableStack, type StorageStack } from './helpers/storage-stack.js'

async function teamWithWorker(domain: TeamDomain, scope: string) {
  const team = await domain.createTeam(scope, 'captain-session', 'Fault team', 'C2+C7')
  await domain.provisionMember(scope, team.id, 'captain-session', {
    name: 'worker-1', role: 'worker', sessionId: 'member-1', provider: 'spawn',
  })
  await domain.settleMember(scope, team.id, 'member-1', { active: true })
  return team
}

async function openClaimedTask(domain: TeamDomain, scope: string, teamId: TeamId) {
  const task = await domain.createTask(scope, teamId, 'captain-session', {
    subject: 't', description: 'd', acceptanceCriteria: ['ok'],
  })
  const seated = await domain.claimTask(scope, teamId, 'member-1', task.id, task.revision)
  return { task: seated.task, attemptId: seated.attempt.id, revision: seated.task.revision }
}

function inTeam(team: TeamState, messageId: string): TeamMessage {
  const message = team.messages.find(candidate => candidate.id === messageId)
  if (message === undefined) throw new Error(`message ${messageId} missing`)
  return message
}

describe('mail-obsolescence fault-injection C2 + C7 over the official Storage Domain', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openFaultableStack(new FaultableBackend(), () => tick++)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('settles a queued message obsolete when its causal task is cancelled (C2)', async () => {
    const team = await teamWithWorker(domain, scope)
    const { task, attemptId, revision } = await openClaimedTask(domain, scope, team.id)
    const message = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'late note', 'wakeup',
      { taskId: task.id, attemptId, revision },
    )
    // Fabricate the authoritative terminal task state (status cancelled) the
    // funnel re-derives against — archive is the only domain path that cancels
    // a task, and it also cancels queued mail, so a synthetic aggregate is the
    // precise way to pin the predicate's cancelled branch.
    const base = (await domain.snapshot(scope, team.id, 'captain-session')).team
    const cancelledFixture = {
      ...base,
      tasks: base.tasks.map(t => ({ ...t, status: 'cancelled' as const })),
    } as unknown as TeamState
    const reason = messageObsoleteReason(cancelledFixture, message)
    expect(reason).toContain('cancelled')
    await domain.markMessageObsolete(scope, team.id, message.id, reason!)
    const settled = await domain.snapshot(scope, team.id, 'captain-session')
    const obsolete = inTeam(settled.team, message.id)
    expect(obsolete.phase).toBe('obsolete')
    expect(obsolete.obsoletedReason).toContain('cancelled')
    // The delivery scan iterates ONLY pending ids: an obsolete message is never
    // delivered, injected, followed-up or used to wake (C2 "不 wake").
    expect(settled.pendingMessageIds).not.toContain(message.id)
  })

  it('settles obsolete exactly once and idempotently under concurrent admission (C7 no-duplicate / no-loop)', async () => {
    const team = await teamWithWorker(domain, scope)
    const { task, attemptId, revision } = await openClaimedTask(domain, scope, team.id)
    const message = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'concurrent target', 'wakeup',
      { taskId: task.id, attemptId, revision },
    )
    const submitted = await domain.submitTask(scope, team.id, 'member-1', task.id, revision, attemptId, 'done')
    await domain.reviewTask(scope, team.id, 'captain-session', task.id, submitted.revision, attemptId, 'accept')
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const reason = messageObsoleteReason(snapshot.team, inTeam(snapshot.team, message.id))!
    expect(reason).toBeDefined()

    // Eight barriers all try to settle the SAME queued message obsolete. The
    // aggregate transaction serializes them: exactly one terminal record, no
    // duplicate rows, and none of the concurrent callers throws (no loop).
    const results = await Promise.all(
      Array.from({ length: 8 }, () => domain.markMessageObsolete(scope, team.id, message.id, reason)),
    )
    const settled = await domain.snapshot(scope, team.id, 'captain-session')
    const obsolete = settled.team.messages.filter(candidate => candidate.id === message.id)
    expect(obsolete).toHaveLength(1)
    expect(obsolete[0]!.phase).toBe('obsolete')
    expect(results.every(r => r.phase === 'obsolete')).toBe(true)
    expect(settled.pendingMessageIds).not.toContain(message.id)
    expect(settled.pendingMessageIds).toHaveLength(0)
  })

  it('acknowledges delivered exactly once and idempotently (C7 no duplicate delivery)', async () => {
    const team = await teamWithWorker(domain, scope)
    const message = await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'live', 'quiet')
    expect(message.phase).toBe('queued')
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => domain.acknowledgeMessage(scope, team.id, message.id)),
    )
    const settled = await domain.snapshot(scope, team.id, 'captain-session')
    const delivered = settled.team.messages.filter(candidate => candidate.id === message.id)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.phase).toBe('delivered')
    expect(outcomes.every(r => r.phase === 'delivered')).toBe(true)
    // A delivered message is never re-scanned (no re-delivery / no loop).
    expect(settled.pendingMessageIds).not.toContain(message.id)
  })

  it('leaves only the live queued subset in the delivery-scan projection (C7 full-path no loop)', async () => {
    const team = await teamWithWorker(domain, scope)
    const { task, attemptId, revision } = await openClaimedTask(domain, scope, team.id)
    const doomed = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'will go obsolete', 'wakeup',
      { taskId: task.id, attemptId, revision },
    )
    const live1 = await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'live one', 'quiet')
    const live2 = await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'live two', 'quiet')
    const submitted = await domain.submitTask(scope, team.id, 'member-1', task.id, revision, attemptId, 'done')
    await domain.reviewTask(scope, team.id, 'captain-session', task.id, submitted.revision, attemptId, 'accept')

    const before = await domain.snapshot(scope, team.id, 'captain-session')
    const reason = messageObsoleteReason(before.team, inTeam(before.team, doomed.id))!
    await domain.markMessageObsolete(scope, team.id, doomed.id, reason)

    const after = await domain.snapshot(scope, team.id, 'captain-session')
    const pending = after.pendingMessageIds
    expect(pending).toContain(live1.id)
    expect(pending).toContain(live2.id)
    expect(pending).not.toContain(doomed.id)
    // The scan set equals exactly the live queued set — no duplicate, no
    // obsolete/delivered leak, no terminal row still owed a delivery.
    const queuedIds = after.team.messages.filter(m => m.phase === 'queued').map(m => m.id)
    expect([...pending].sort()).toEqual([...queuedIds].sort())
  })

  it('first-false-on-baseline: a late queued causal message would have stayed wake-eligible absent the obsolete phase', async () => {
    const team = await teamWithWorker(domain, scope)
    const { task, attemptId, revision } = await openClaimedTask(domain, scope, team.id)
    const message = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'late', 'wakeup',
      { taskId: task.id, attemptId, revision },
    )
    const submitted = await domain.submitTask(scope, team.id, 'member-1', task.id, revision, attemptId, 'done')
    await domain.reviewTask(scope, team.id, 'captain-session', task.id, submitted.revision, attemptId, 'accept')
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const reason = messageObsoleteReason(snapshot.team, inTeam(snapshot.team, message.id))
    // On the pre-candidate baseline the funnel did not exist: the late queued
    // message stayed `queued` and stayed in the pending (wake-eligible) set.
    expect(reason).toBeDefined()
    await domain.markMessageObsolete(scope, team.id, message.id, reason!)
    const settled = await domain.snapshot(scope, team.id, 'captain-session')
    expect(settled.pendingMessageIds).not.toContain(message.id)
  })
})
