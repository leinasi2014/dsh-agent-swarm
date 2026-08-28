/**
 * P0 dogfood (task-5): atomic retarget / release of an unowned pending
 * directed task inside the captain-only `cancelAttempt` transaction.
 *
 * Baseline: `cancelAttempt` accepted only an open execution attempt
 * (in_progress/submitted/verifying + `currentAttemptId`), so an author-role
 * conflict on a pending (never-claimed / released) directed task could not be
 * managed — e.g. a pending task pinned to a member who cannot take it could
 * never be re-pointed without first claiming it. This suite proves the added
 * branch: a pending task with no owner/currentAttempt can be atomically
 * re-pointed to a new provisioning/active target (CAS + revision+1, no
 * attempt created, fenced, or pruned) or explicitly released back to the
 * ready pool, while the open-attempt legacy path keeps its exact semantics
 * (attempt fenced stale, task released to pending).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamId } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('pending directed task atomic retarget / release (captain-only cancelAttempt)', () => {
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

  async function teamWithMembers(count: number, extraProvisioning = 0) {
    const team = await domain.createTeam(scope, 'captain-session', 'Retarget team', 'Verify pending retarget')
    for (let index = 1; index <= count; index += 1) {
      await domain.provisionMember(scope, team.id, 'captain-session', {
        name: `worker-${index}`,
        role: `role ${index}`,
        sessionId: `member-${index}`,
        provider: 'spawn',
      })
      await domain.settleMember(scope, team.id, `member-${index}`, { active: true })
    }
    for (let index = count + 1; index <= count + extraProvisioning; index += 1) {
      await domain.provisionMember(scope, team.id, 'captain-session', {
        name: `worker-${index}`,
        role: `role ${index}`,
        sessionId: `member-${index}`,
        provider: 'spawn',
      })
    }
    return team
  }

  async function directedTask(teamId: TeamId, targetSessionId: string) {
    return await domain.createTask(scope, teamId, 'captain-session', {
      subject: 'directed',
      description: 'pinned to one member',
      targetMemberSessionId: targetSessionId,
    })
  }

  it('retargets an unowned pending directed task atomically (CAS + revision+1, no attempt side effect)', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    const retargeted = await domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision, 'author-role conflict', 'member-2',
    )
    expect(retargeted.id).toBe(task.id)
    expect(retargeted.status).toBe('pending')
    expect(retargeted.revision).toBe(task.revision + 1)
    expect(retargeted.ownerSessionId).toBeUndefined()
    expect(retargeted.currentAttemptId).toBeUndefined()
    expect(retargeted.targetMemberSessionId).toBe('member-2')
    const after = await domain.snapshot(scope, team.id, 'captain-session')
    expect(after.team.attempts).toEqual([])
    // Still strict-assigned: the task stays directed to the new active member.
    expect(after.readyTaskIds).toContain(task.id)
  })

  it('retargets onto a provisioning (not yet active) member', async () => {
    const team = await teamWithMembers(1, 1)
    const task = await directedTask(team.id, 'member-1')
    const retargeted = await domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision, 'route to provisioning', 'member-2',
    )
    expect(retargeted.targetMemberSessionId).toBe('member-2')
    expect(retargeted.revision).toBe(task.revision + 1)
    expect((await domain.snapshot(scope, team.id, 'captain-session')).team.members
      .find(member => member.sessionId === 'member-2')?.phase).toBe('provisioning')
  })

  it('releases a pending directed task back to the ready pool (no target provided)', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    const released = await domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision, 'release to pool',
    )
    expect(released.status).toBe('pending')
    expect(released.revision).toBe(task.revision + 1)
    expect(released.targetMemberSessionId).toBeUndefined()
    expect(released.ownerSessionId).toBeUndefined()
    const ready = await domain.snapshot(scope, team.id, 'captain-session')
    expect(ready.readyTaskIds).toContain(task.id)
    expect(ready.team.attempts).toEqual([])
  })

  it('rejects a stale expected_revision with TEAM_TASK_STALE_REVISION', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    await expect(domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision + 7, 'stale', 'member-2',
    )).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
  })

  it('rejects an invalid (unknown) retarget target with TEAM_ASSIGNEE_INVALID', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    await expect(domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision, 'bad target', 'missing-member',
    )).rejects.toMatchObject({ code: 'TEAM_ASSIGNEE_INVALID' })
  })

  it('rejects an unavailable (removed) retarget target with TEAM_ASSIGNEE_INVALID', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    await domain.removeMember(scope, team.id, 'captain-session', 'worker-2', 'drained')
    await expect(domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision, 'removed target', 'member-2',
    )).rejects.toMatchObject({ code: 'TEAM_ASSIGNEE_INVALID' })
  })

  it('rejects retarget of an undirected pending task when no target is provided (TEAM_TASK_NOT_REASSIGNABLE)', async () => {
    const team = await teamWithMembers(2)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'undirected',
      description: 'no directed target',
    })
    await expect(domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, task.revision, 'nothing to do',
    )).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_REASSIGNABLE' })
  })

  it('keeps the open-attempt legacy semantics untouched: attempt fenced stale, task released to pending', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    const claim = await domain.claimTask(scope, team.id, 'member-1', task.id, task.revision, 'member-1')
    expect(claim.attempt.phase).toBe('running')
    const reassigned = await domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, claim.task.revision, 'reassign open attempt', 'member-2',
    )
    expect(reassigned.status).toBe('pending')
    expect(reassigned.revision).toBe(claim.task.revision + 1)
    expect(reassigned.ownerSessionId).toBeUndefined()
    expect(reassigned.currentAttemptId).toBeUndefined()
    expect(reassigned.targetMemberSessionId).toBe('member-2')
    const after = await domain.snapshot(scope, team.id, 'captain-session')
    const fenced = after.team.attempts.find(attempt => attempt.id === claim.attempt.id)
    expect(fenced?.phase).toBe('stale')
  })

  it('requires the captain for any retarget/release (TEAM_CAPTAIN_REQUIRED)', async () => {
    const team = await teamWithMembers(2)
    const task = await directedTask(team.id, 'member-1')
    await expect(domain.cancelAttempt(
      scope, team.id, 'member-2', task.id, task.revision, 'not the captain', 'member-1',
    )).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
  })
})
