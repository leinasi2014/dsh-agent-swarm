/**
 * Issue #83 domain contracts: the stranded self-heal's in-place retry and its
 * misfire reversal, both as single atomic Storage Domain transitions. Split
 * from `team-domain.spec.ts` at the 600-line source guardrail; the harness
 * and scenario coverage stay there.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('TeamDomain retry and reinstate transitions (issue #83)', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-retry-'))
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
    const team = await domain.createTeam(scope, 'captain-session', 'Core team', 'Verify the retry transitions')
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

  it('retries the owner\'s open attempt in place as one atomic transition (issue #83)', async () => {
    const team = await teamWithMembers(2)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'stranded',
      description: 'Healed in place.',
    })
    const claim = await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    await domain.acknowledgeAssignment(scope, team.id, task.id, claim.attempt.id)

    const retried = await domain.retryAttempt(
      scope, team.id, 'captain-session', task.id, claim.task.revision, 'member-1',
      'stranded ownership self-heal: member-1 is live and idle',
    )

    // One transition, one revision bump: the task never left in_progress and
    // never lost its owner, so no reader or scheduling lane could observe a
    // pending release between the stale fence and the fresh attempt.
    expect(retried.task).toMatchObject({
      status: 'in_progress', ownerSessionId: 'member-1', revision: claim.task.revision + 1,
    })
    expect(retried.attempt).toMatchObject({
      taskId: task.id, memberSessionId: 'member-1', phase: 'running', assignmentPhase: 'reserved',
    })
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const fenced = snapshot.team.attempts.find(attempt => attempt.id === claim.attempt.id)
    expect(fenced).toMatchObject({ phase: 'stale' })
    expect(fenced?.diagnostic).toContain('stranded ownership self-heal')
    expect(snapshot.team.tasks[0]?.currentAttemptId).toBe(retried.attempt.id)
    expect(snapshot.team.budget.usedRequests).toBe(2)

    // Guards: a stale revision, another member, and a member actor are all
    // rejected without state changes.
    await expect(domain.retryAttempt(
      scope, team.id, 'captain-session', task.id, retried.task.revision - 1, 'member-1', 'x',
    )).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    await expect(domain.retryAttempt(
      scope, team.id, 'captain-session', task.id, retried.task.revision, 'member-2', 'x',
    )).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_REASSIGNABLE' })
  })

  it('reinstates the replaced attempt when a retry misfired (issue #83)', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'misfired',
      description: 'The teardown won the race.',
    })
    const claim = await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    await domain.acknowledgeAssignment(scope, team.id, task.id, claim.attempt.id)
    const retried = await domain.retryAttempt(
      scope, team.id, 'captain-session', task.id, claim.task.revision, 'member-1',
      'stranded ownership self-heal: member-1 is live and idle',
    )

    const reinstated = await domain.reinstateAttempt(
      scope, team.id, 'captain-session', task.id, retried.task.revision, retried.attempt.id,
      'stranded ownership self-heal misfired: owner stopped being live during the retry',
    )

    // The evidence-only state is restored in one transition: the task is
    // continuously in_progress under the same owner and fences its ORIGINAL
    // (delivered) attempt again; the misfired retry is cancelled with the
    // reason retained.
    expect(reinstated).toMatchObject({
      status: 'in_progress', ownerSessionId: 'member-1', currentAttemptId: claim.attempt.id,
      revision: retried.task.revision + 1,
    })
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    const original = snapshot.team.attempts.find(attempt => attempt.id === claim.attempt.id)
    expect(original).toMatchObject({ phase: 'running', assignmentPhase: 'delivered' })
    expect(original?.diagnostic).toBeUndefined()
    const misfired = snapshot.team.attempts.find(attempt => attempt.id === retried.attempt.id)
    expect(misfired).toMatchObject({ phase: 'cancelled' })
    expect(misfired?.diagnostic).toContain('misfired')

    // Guards: the fence is required, and a delivered retry is not reversible.
    await expect(domain.reinstateAttempt(
      scope, team.id, 'captain-session', task.id, snapshot.team.tasks[0]!.revision, retried.attempt.id, 'x',
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
    await domain.retryAttempt(
      scope, team.id, 'captain-session', task.id, snapshot.team.tasks[0]!.revision, 'member-1', 'again',
    )
    const delivered = await domain.snapshot(scope, team.id, 'captain-session')
    const fresh = delivered.team.attempts.find(attempt => attempt.id === delivered.team.tasks[0]?.currentAttemptId)
    await domain.acknowledgeAssignment(scope, team.id, task.id, fresh!.id)
    const postAck = await domain.snapshot(scope, team.id, 'captain-session')
    await expect(domain.reinstateAttempt(
      scope, team.id, 'captain-session', task.id, postAck.team.tasks[0]!.revision, fresh!.id, 'x',
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_PHASE_INVALID' })
  })
})
