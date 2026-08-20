/**
 * F7 (M1B): bounded retained attempt history with no stale-id
 * resurrection, over the real official storage stack.
 *
 * Retention is a per-task bound (`maxRetainedAttempts`): every terminal
 * transition prunes the oldest terminal attempts beyond the newest N of
 * their task inside the same aggregate transaction, exactly like the F6
 * mailbox receipts. The anti-resurrection red line is proven directly:
 * after pruning, a pruned attempt id is still fencing-rejected with
 * `TEAM_ATTEMPT_STALE`, because worker updates fence against the task's
 * never-pruned `currentAttemptId`, while new generations allocate from a
 * watermark derived from the retained maximum generation — the pruning
 * order guarantees that maximum is the historical maximum, so no retired
 * generation is ever reused (scenario 18).
 */
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { AttemptId, TaskId, type TeamState } from '../src/domain/types.js'
import { openStorageStack, unitFilePath, type StorageStack } from './helpers/storage-stack.js'

describe('TeamDomain attempt retention (F7)', () => {
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

  async function teamWithWorkers(count: number, on: TeamDomain = domain): Promise<TeamState> {
    const team = await on.createTeam(scope, 'captain-session', 'Retention team', 'Bound attempt history')
    for (let index = 1; index <= count; index += 1) {
      await on.provisionMember(scope, team.id, 'captain-session', {
        name: `worker-${index}`, role: 'execute', sessionId: `member-${index}`, provider: 'spawn',
      })
      await on.settleMember(scope, team.id, `member-${index}`, { active: true })
    }
    return team
  }

  it('scenario 18: repeated claim/reassign cycles keep attempt history bounded while pruned ids stay stale', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limits = { ...DEFAULT_TEAM_LIMITS, maxRetainedAttempts: 3 }
    const limited = new TeamDomain(stack.store, limits, () => tick++)
    const team = await teamWithWorkers(2, limited)
    const task = await limited.createTask(scope, team.id, 'captain-session', {
      subject: 'churn', description: 'Survive many claim/reassign cycles.',
    })
    // An unrelated task held open by another member: its current attempt is
    // never pruning-eligible and keeps its own per-task retention budget.
    const stable = await limited.createTask(scope, team.id, 'captain-session', {
      subject: 'stable', description: 'Keep one live attempt.',
    })
    const stableClaim = await limited.claimTask(scope, team.id, 'captain-session', stable.id, stable.revision, 'member-2')

    const churned: { id: string; generation: number }[] = []
    let revision = task.revision
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      const claim = await limited.claimTask(scope, team.id, 'captain-session', task.id, revision, 'member-1')
      churned.push({ id: claim.attempt.id, generation: claim.attempt.generation })
      const released = await limited.cancelAttempt(
        scope, team.id, 'captain-session', task.id, claim.task.revision, `cycle ${cycle}`,
      )
      revision = released.revision
    }
    // Fencing generations stay strictly monotonic across the whole history:
    // claim k uses generation k even while older attempts are pruned.
    expect(churned.map(attempt => attempt.generation)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))

    let snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    const retained = snapshot.team.attempts.filter(attempt => attempt.taskId === task.id)
    expect(retained).toHaveLength(limits.maxRetainedAttempts)
    expect(retained.map(attempt => attempt.generation)).toEqual([10, 11, 12])
    // The newest terminal attempt stays auditable with its full diagnostic.
    expect(retained[2]).toMatchObject({ generation: 12, phase: 'stale', diagnostic: 'cycle 12' })
    expect(snapshot.team.attempts.some(attempt => attempt.id === stableClaim.attempt.id)).toBe(true)
    expect(snapshot.team.attempts.find(attempt => attempt.id === stableClaim.attempt.id)?.phase).toBe('running')

    // Anti-resurrection red line: a pruned attempt id is still fencing-
    // rejected with TEAM_ATTEMPT_STALE at the current revision — never
    // TEAM_ATTEMPT_NOT_FOUND and never accepted.
    const pending = snapshot.team.tasks.find(candidate => candidate.id === task.id)!.revision
    for (const index of [0, 10]) {
      await expect(limited.submitTask(
        scope, team.id, 'member-1', task.id, pending, AttemptId(churned[index]!.id), 'late output', [],
      )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
    }

    // team.json stays bounded: the whole unit file holds the retained
    // window plus the fixed aggregate envelope, not one record per
    // historical claim (the unpruned 12-cycle aggregate measures 6801
    // bytes; the retained window measures 4227).
    const raw = await readFile(unitFilePath(join(sandbox, 'storage')), 'utf8')
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(5_120)

    // Ordered replay across a full reload: retained identities, creation
    // order and revision continuity all survive pruning.
    const before = await limited.snapshot(scope, team.id, 'captain-session')
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const reloaded = new TeamDomain(stack.store, limits, () => tick++)
    snapshot = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.revision).toBe(before.team.revision)
    expect(snapshot.team.attempts).toEqual(before.team.attempts)

    // The generation watermark survives the reload: the next claim fences
    // past every historical generation, pruned or retained.
    const next = await reloaded.claimTask(scope, team.id, 'captain-session', task.id, pending, 'member-1')
    expect(next.attempt.generation).toBe(13)
    await expect(reloaded.submitTask(
      scope, team.id, 'member-1', task.id, next.task.revision, AttemptId(churned[0]!.id), 'post-reload late', [],
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
  })

  it('keeps the referenced current attempt of a completed task while pruning older terminal attempts', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limits = { ...DEFAULT_TEAM_LIMITS, maxRetainedAttempts: 2 }
    const limited = new TeamDomain(stack.store, limits, () => tick++)
    const team = await teamWithWorkers(1, limited)
    const task = await limited.createTask(scope, team.id, 'captain-session', {
      subject: 'finish', description: 'Accept once after churn.',
    })

    let revision = task.revision
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const claim = await limited.claimTask(scope, team.id, 'captain-session', task.id, revision, 'member-1')
      const released = await limited.cancelAttempt(
        scope, team.id, 'captain-session', task.id, claim.task.revision, `cycle ${cycle}`,
      )
      revision = released.revision
    }
    const final = await limited.claimTask(scope, team.id, 'captain-session', task.id, revision, 'member-1')
    const submitted = await limited.submitTask(
      scope, team.id, 'member-1', task.id, final.task.revision, final.attempt.id, 'done', ['test:unit'],
    )
    const completed = await limited.reviewTask(
      scope, team.id, 'captain-session', task.id, submitted.revision, final.attempt.id, 'accept',
    )
    expect(completed.status).toBe('completed')

    // A completed task keeps referencing its accepted attempt: pruning
    // bounds the older terminal history without breaking the reference.
    const snapshot = await limited.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.attempts).toHaveLength(3)
    expect(snapshot.team.attempts.map(attempt => attempt.generation)).toEqual([2, 3, 4])
    expect(snapshot.team.attempts.map(attempt => attempt.phase)).toEqual(['stale', 'stale', 'accepted'])
    expect(snapshot.team.tasks[0]?.currentAttemptId).toBe(final.attempt.id)

    // The stored state stays referentially valid across a full reload.
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const reloaded = new TeamDomain(stack.store, limits, () => tick++)
    const after = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(after.team.attempts).toEqual(snapshot.team.attempts)
    expect(after.team.tasks[0]).toMatchObject({ status: 'completed', currentAttemptId: final.attempt.id })
  })

  it('loads a v1 record with 300 retained attempts and prunes lazily on the next terminal transition', async () => {
    const team = await teamWithWorkers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'legacy churn', description: 'Pre-F7 attempt population.',
    })
    expect(task.id).toBe(TaskId('task-1'))
    await stack.close()

    // Hand-written pre-F7 aggregate: a schema-v1 record whose attempts
    // array already holds 300 terminal (stale) generations of one task —
    // the exact population that grew team.json without a limit.
    const path = unitFilePath(join(sandbox, 'storage'))
    const unit = JSON.parse(await readFile(path, 'utf8')) as {
      tables: { teams: Record<string, { team: { revision: number; attempts: unknown[] } }> }
    }
    const stored = unit.tables.teams[team.id]!.team
    stored.revision = 5
    stored.attempts = Array.from({ length: 300 }, (_, index) => ({
      id: `attempt-legacy-${index + 1}`,
      taskId: 'task-1',
      generation: index + 1,
      memberSessionId: 'member-1',
      phase: 'stale',
      assignmentPhase: 'reserved',
      evidence: [],
      diagnostic: `legacy cycle ${index + 1}`,
      // Timestamps stay below the suite's tick baseline (>= 1000) so the
      // creation order of legacy and post-load attempts stays comparable.
      createdAt: Math.floor(index / 2),
      updatedAt: Math.floor(index / 2),
    }))
    await writeFile(path, JSON.stringify(unit, null, 2), 'utf8')

    const limits = { ...DEFAULT_TEAM_LIMITS, maxRetainedAttempts: 2 }
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const reloaded = new TeamDomain(stack.store, limits, () => tick++)
    let snapshot = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.schemaVersion).toBe(1)
    expect(snapshot.team.attempts).toHaveLength(300)

    // The record shape is unchanged, so the load itself never prunes; the
    // first claim fences from the retained generation watermark (301), and
    // the following terminal transition prunes lazily to the newest two.
    const claim = await reloaded.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    expect(claim.attempt.generation).toBe(301)
    snapshot = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.attempts).toHaveLength(301)
    const released = await reloaded.cancelAttempt(
      scope, team.id, 'captain-session', task.id, claim.task.revision, 'prune the legacy history',
    )
    snapshot = await reloaded.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.attempts).toHaveLength(2)
    expect(snapshot.team.attempts.map(attempt => attempt.generation)).toEqual([300, 301])
    expect(snapshot.team.tasks[0]?.revision).toBe(released.revision)

    // The watermark derives from the retained maximum, not the array
    // length: the next generation is 302, never a reused historical one.
    const next = await reloaded.claimTask(scope, team.id, 'captain-session', task.id, released.revision, 'member-1')
    expect(next.attempt.generation).toBe(302)

    // Pruned legacy ids stay fencing-rejected with the exact stale code.
    await expect(reloaded.submitTask(
      scope, team.id, 'member-1', task.id, next.task.revision, AttemptId('attempt-legacy-1'), 'late legacy output', [],
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
    await expect(reloaded.submitTask(
      scope, team.id, 'member-1', task.id, next.task.revision, AttemptId('attempt-legacy-299'), 'late legacy output', [],
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
  })
})
