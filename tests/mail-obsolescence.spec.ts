/**
 * Mail-obsolescence causal fence (task-3): causal identity persistence and
 * rebuild, the four pre-delivery obsolete classes, and explicit supersede
 * audit.
 *
 * The single obsolete decision funnel lives in
 * `team-domain-mailbox.messageObsoleteReason` and is consumed exactly at
 * delivery admission (`message-delivery.deliverQueuedMessage`), which settles
 * an obsolete message terminal via `markMessageObsolete` instead of injecting,
 * following-up or waking its target. This suite proves the derived decision
 * against the authoritative aggregate for every class and that the obsolete
 * settlement removes the message from the pending (delivery-scan) projection —
 * so the scan can never wake it — plus that causal identity round-trips the
 * durable store across a restart-style reopen (C6 rebuild).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { messageObsoleteReason } from '../src/domain/team-domain-mailbox.js'
import type { AttemptId, TeamId, TeamMessage, TeamState, TeamTask } from '../src/domain/types.js'
import {
  FaultableBackend,
  openFaultableStack,
  type StorageStack,
} from './helpers/storage-stack.js'

async function teamWithWorker(domain: TeamDomain, scope: string) {
  const team = await domain.createTeam(scope, 'captain-session', 'Core team', 'causal fence')
  await domain.provisionMember(scope, team.id, 'captain-session', {
    name: 'worker-1', role: 'worker', sessionId: 'member-1', provider: 'spawn',
  })
  await domain.settleMember(scope, team.id, 'member-1', { active: true })
  return team
}

async function openClaimedTask(domain: TeamDomain, scope: string, teamId: TeamId): Promise<{ task: TeamTask; attemptId: AttemptId; revision: number }> {
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

describe('mail-obsolescence causal fence over the official Storage Domain', () => {
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

  it('persists causal identity and rebuilds it across a restart-style reopen (C6)', async () => {
    const backend = new FaultableBackend()
    const first = await openFaultableStack(backend, () => tick++)
    let firstTeam: TeamId | undefined
    try {
      const team = await (first.port as TeamDomain).createTeam(scope, 'captain-session', 'Core team', 'causal fence')
      firstTeam = team.id
      await (first.port as TeamDomain).provisionMember(scope, team.id, 'captain-session', {
        name: 'worker-1', role: 'worker', sessionId: 'member-1', provider: 'spawn',
      })
      await (first.port as TeamDomain).settleMember(scope, team.id, 'member-1', { active: true })
      const task = await (first.port as TeamDomain).createTask(scope, team.id, 'captain-session', {
        subject: 't', description: 'd', acceptanceCriteria: ['ok'],
      })
      const seated = await (first.port as TeamDomain).claimTask(scope, team.id, 'member-1', task.id, task.revision)
      const message = await (first.port as TeamDomain).queueMessage(
        scope, team.id, 'captain-session', 'worker-1', 'bound', 'wakeup',
        { taskId: seated.task.id, attemptId: seated.attempt.id, revision: seated.task.revision },
      )
      expect(message.causal).toEqual({ taskId: seated.task.id, attemptId: seated.attempt.id, revision: seated.task.revision })
      expect(message.phase).toBe('queued')
    } finally {
      await first.close()
    }

    // Rebuild: the same backend medium reopened on a fresh context/services
    // stack is equivalent to a process restart — the aggregate (and its
    // message causal identity + phase) must be fully reconstructable from it.
    const reopened = await openFaultableStack(backend, () => tick++)
    try {
      const snapshot = await reopened.port.snapshot(scope, firstTeam, 'captain-session')
      const rebuilt = snapshot.team.messages[0]!
      expect(rebuilt.phase).toBe('queued')
      expect(rebuilt.causal).toEqual({ taskId: expect.any(String), attemptId: expect.any(String), revision: expect.any(Number) })
      expect(snapshot.pendingMessageIds).toContain(rebuilt.id)
      expect(messageObsoleteReason(snapshot.team, rebuilt)).toBeUndefined()
    } finally {
      await reopened.close()
    }
  })

  it('marks a message obsolete when its causal task completes, so it is never woken (C1)', async () => {
    const team = await teamWithWorker(domain, scope)
    const { task, attemptId, revision } = await openClaimedTask(domain, scope, team.id)
    const message = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'late note', 'wakeup',
      { taskId: task.id, attemptId, revision },
    )
    // Complete the task: submit then review-accept.
    const submitted = await domain.submitTask(scope, team.id, 'member-1', task.id, revision, attemptId, 'done')
    await domain.reviewTask(scope, team.id, 'captain-session', task.id, submitted.revision, attemptId, 'accept')

    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const live = inTeam(snapshot.team, message.id)
    const reason = messageObsoleteReason(snapshot.team, live)
    expect(reason).toContain('completed')

    await domain.markMessageObsolete(scope, team.id, message.id, reason!)
    const settled = await domain.snapshot(scope, team.id, 'captain-session')
    const obsolete = inTeam(settled.team, message.id)
    expect(obsolete.phase).toBe('obsolete')
    expect(obsolete.obsoletedReason).toContain('completed')
    expect(obsolete.obsoletedAt).toBeGreaterThan(0)
    // The delivery scan iterates ONLY pending ids, so an obsolete message can
    // never be injected, followed-up or used to wake its target.
    expect(settled.pendingMessageIds).not.toContain(message.id)
  })

  it('marks a message obsolete when its causal attempt is replaced by reassignment (C3)', async () => {
    const team = await teamWithWorker(domain, scope)
    const { task, attemptId, revision } = await openClaimedTask(domain, scope, team.id)
    const message = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'stale bound', 'wakeup',
      { taskId: task.id, attemptId, revision },
    )
    // Reassign: cancelAttempt fences the attempt stale and clears current.
    await domain.cancelAttempt(scope, team.id, 'captain-session', task.id, revision, 'reassign')

    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const reason = messageObsoleteReason(snapshot.team, inTeam(snapshot.team, message.id))
    expect(reason).toContain('no longer current')
    await domain.markMessageObsolete(scope, team.id, message.id, reason!)
    const settled = await domain.snapshot(scope, team.id, 'captain-session')
    expect(inTeam(settled.team, message.id).phase).toBe('obsolete')
  })

  it('derives obsolete for a queued message to a removed target member (C4)', async () => {
    // Constructor path enforces an active target at queue time, and removeMember
    // cancels already-queued mail to/from the member, so the removed branch of
    // the funnel is defense-in-depth for any straggler. Prove the predicate
    // derives it from a removed roster row without inventing a second queue.
    const removedTarget = 'session-removed'
    const fixture = {
      members: [{ name: 'gone', role: 'r', sessionId: removedTarget, provider: 'p', phase: 'removed', createdAt: 1 }],
      tasks: [],
      attempts: [],
      messages: [{ id: 'message-fixture', senderSessionId: 's', senderName: 's', targetSessionId: removedTarget, targetName: 'gone', content: 'x', delivery: 'wakeup', phase: 'queued', createdAt: 1 }],
    } as unknown as TeamState
    const reason = messageObsoleteReason(fixture, fixture.messages[0]!)
    expect(reason).toContain('removed')
  })

  it('explicit supersede settles the superseded still-pending message obsolete and is auditable (C5)', async () => {
    const team = await teamWithWorker(domain, scope)
    const first = await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'first', 'wakeup')
    expect(first.phase).toBe('queued')
    const second = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'replacement', 'wakeup',
      undefined, first.id,
    )
    expect(second.supersedes).toBe(first.id)
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const superseded = inTeam(snapshot.team, first.id)
    expect(superseded.phase).toBe('obsolete')
    expect(superseded.supersededBy).toBe(second.id)
    expect(superseded.obsoletedReason).toContain('superseded')
    expect(superseded.obsoletedAt).toBeGreaterThan(0)
    // Only the live replacement is pending for delivery/wake.
    expect(snapshot.pendingMessageIds).toEqual([second.id])
  })

  it('rejects a causal attempt that does not belong to the declared causal task', async () => {
    const team = await teamWithWorker(domain, scope)
    // A second worker claims the second task so both attempts are live.
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker-2', role: 'worker', sessionId: 'member-2', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-2', { active: true })
    const first = await openClaimedTask(domain, scope, team.id)
    const secondTask = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 't2', description: 'd2', acceptanceCriteria: ['ok'],
    })
    const seated = await domain.claimTask(scope, team.id, 'member-2', secondTask.id, secondTask.revision)
    await expect(domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'mismatch', 'quiet',
      { taskId: first.task.id, attemptId: seated.attempt.id },
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_TASK_MISMATCH' })
  })
})
