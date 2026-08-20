import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

/**
 * Assignment-delivery checkpoint contract (issue #45): the `reserved →
 * delivered` checkpoint is fenced by the exact attempt only. Attempt
 * fencing plus the running-phase check remain the complete rejection
 * surface; neither concurrent non-task aggregate writes nor task
 * metadata revision bumps may strand the checkpoint in `reserved` (the
 * duplicate re-dispatch face).
 */
describe('TeamDomain assignment-delivery checkpoint (attempt-fenced, issue #45)', () => {
  let sandbox: string
  let scope: string
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-checkpoint-'))
    scope = join(sandbox, 'workspace')
    stack = await openStorageStack(join(sandbox, 'storage'))
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function teamWithMembers(count = 2) {
    const team = await domain.createTeam(scope, 'captain-session', 'Checkpoint team', 'Fence delivery')
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

  it('records assignment delivery separately without changing the task revision', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'dispatch checkpoint', description: 'Persist transport acceptance.',
    })
    const claim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, task.revision, 'member-1',
    )
    expect(claim.attempt.assignmentPhase).toBe('reserved')

    const delivered = await domain.acknowledgeAssignment(
      scope, team.id, task.id, claim.attempt.id,
    )
    expect(delivered.assignmentPhase).toBe('delivered')
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.tasks[0]?.revision).toBe(claim.task.revision)
  })

  it('acknowledges delivery although concurrent non-task writes land between dispatch and ack (P2-2)', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'interleaved accounting', description: 'Survive concurrent aggregate writes.',
    })
    const claim = await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    // The scheduler's own dispatch path folds usage accounting between the
    // followup delivery and the acknowledgement checkpoint, and quiet
    // mailbox acknowledgements interleave the same way: both bump the
    // aggregate revision between dispatch and ack.
    await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 2, tokens: 12 }])
    const message = await domain.queueMessage(scope, team.id, 'captain-session', 'worker-1', 'note', 'wakeup')
    await domain.acknowledgeMessage(scope, team.id, message.id)

    const delivered = await domain.acknowledgeAssignment(scope, team.id, task.id, claim.attempt.id)
    expect(delivered.assignmentPhase).toBe('delivered')

    // No duplicate-delivery face: the authoritative attempt is delivered,
    // so a reserved-attempt rescan finds nothing to re-dispatch.
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const openAttempts = snapshot.team.tasks
      .filter(candidate => candidate.status === 'in_progress' && candidate.currentAttemptId !== undefined)
      .map(candidate => snapshot.team.attempts.find(row => row.id === candidate.currentAttemptId))
    expect(openAttempts).toHaveLength(1)
    expect(openAttempts[0]?.assignmentPhase).toBe('delivered')
  })

  it('acknowledges delivery fenced by the attempt alone, tolerating task metadata revision bumps (P2-2)', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'fenced checkpoint', description: 'Attempt fencing is the only guard.',
    })
    const claim = await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    // A task write that bumps only the metadata revision without touching
    // the fencing reference (the store port admits arbitrary aggregate
    // writers; a future metadata transition would produce the same
    // shape). The pre-#45 revision CAS rejected this acknowledgement
    // with TEAM_TASK_STALE_REVISION and left the attempt reserved for
    // duplicate re-dispatch; the checkpoint must not strand on it.
    await stack.store.transact(scope, team.id, draft => {
      const index = draft.tasks.findIndex(candidate => candidate.id === task.id)
      if (index < 0) throw new Error('probe task missing from the aggregate')
      const target = draft.tasks[index]!
      draft.tasks[index] = { ...target, revision: target.revision + 1 }
    })

    const delivered = await domain.acknowledgeAssignment(scope, team.id, task.id, claim.attempt.id)
    expect(delivered.assignmentPhase).toBe('delivered')
  })

  it('still rejects an acknowledgement whose attempt lost the fencing race', async () => {
    const team = await teamWithMembers()
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'handoff fence', description: 'Only the current attempt may acknowledge.',
    })
    const oldClaim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, task.revision, 'member-1',
    )
    const released = await domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, oldClaim.task.revision, 'captain reassigned the task',
    )
    await domain.claimTask(scope, team.id, 'captain-session', task.id, released.revision, 'member-2')

    await expect(domain.acknowledgeAssignment(scope, team.id, task.id, oldClaim.attempt.id))
      .rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
  })
})
