import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertTaskGraph } from '../src/domain/graph.js'
import { TeamDomain } from '../src/domain/team-domain.js'
import { DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { AttemptId, TaskId, type TeamTask } from '../src/domain/types.js'
import { openStorageStack, unitFilePath, type StorageStack } from './helpers/storage-stack.js'

const graphTask = (id: string, blockedBy: string[]): TeamTask => ({
  id: TaskId(id),
  revision: 1,
  subject: id,
  description: id,
  acceptanceCriteria: [],
  status: 'pending',
  blockedBy: blockedBy.map(TaskId),
  writeScopes: [],
  priority: 0,
  createdAt: 1,
  updatedAt: 1,
})

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

  it('scenario 1: serializes concurrent claims and rejects the stale revision', async () => {
    const team = await teamWithMembers()
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'race',
      description: 'Only one member may win.',
    })

    const claims = await Promise.allSettled([
      domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1'),
      domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-2'),
    ])

    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = claims.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'TEAM_TASK_STALE_REVISION' } })
  })

  it('requires review acceptance before canonical completion', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'implementation',
      description: 'Produce tested code.',
      acceptanceCriteria: ['tests pass'],
    })
    const claim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, task.revision, 'member-1',
    )
    const submitted = await domain.submitTask(
      scope,
      team.id,
      'member-1',
      task.id,
      claim.task.revision,
      claim.attempt.id,
      'Implemented and tested.',
      ['test:unit'],
    )
    expect(submitted.status).toBe('submitted')

    const accepted = await domain.reviewTask(
      scope,
      team.id,
      'captain-session',
      task.id,
      submitted.revision,
      claim.attempt.id,
      'accept',
    )
    expect(accepted.status).toBe('completed')
  })

  it('scenario 3: rejects every late update after attempt fencing changes', async () => {
    const team = await teamWithMembers()
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'handoff',
      description: 'Move ownership safely.',
    })
    const oldClaim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, task.revision, 'member-1',
    )
    const released = await domain.cancelAttempt(
      scope,
      team.id,
      'captain-session',
      task.id,
      oldClaim.task.revision,
      'captain reassigned the task',
    )
    const newClaim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, released.revision, 'member-2',
    )

    const late = await Promise.allSettled(Array.from({ length: 50 }, () => domain.submitTask(
      scope,
      team.id,
      'member-1',
      task.id,
      newClaim.task.revision,
      oldClaim.attempt.id,
      'late output',
    )))
    expect(late.every(result => result.status === 'rejected')).toBe(true)
    for (const result of late) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
    }
  })

  it('scenario 4: persists queued-before-delivered mailbox state across a full storage reopen', async () => {
    const team = await teamWithMembers(1)
    const message = await domain.queueMessage(
      scope, team.id, 'captain-session', 'worker-1', 'Inspect this task.', 'wakeup',
    )
    expect(message.phase).toBe('queued')

    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    let snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.pendingMessageIds).toEqual([message.id])

    await domain.acknowledgeMessage(scope, team.id, message.id)
    snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.pendingMessageIds).toEqual([])
  })

  it('scenario 11: enforces exact request and token budgets', async () => {
    const team = await teamWithMembers()
    await domain.setBudget(scope, team.id, 'captain-session', {
      tokenLimit: 10,
      requestLimit: 1,
    })
    await domain.consumeTokens(scope, team.id, 10)
    await expect(domain.consumeTokens(scope, team.id, 1)).rejects.toMatchObject({ code: 'TEAM_BUDGET_TOKENS' })
    await domain.setBudget(scope, team.id, 'captain-session', { tokenLimit: 20 })

    const first = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'first', description: 'Consume one request.',
    })
    await domain.claimTask(scope, team.id, 'captain-session', first.id, first.revision, 'member-1')
    const second = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'second', description: 'Must exceed the request budget.',
    })
    await expect(domain.claimTask(
      scope, team.id, 'captain-session', second.id, second.revision, 'member-2',
    )).rejects.toMatchObject({ code: 'TEAM_BUDGET_REQUESTS' })
  })

  it('scenario 8: rejects missing, duplicate, self, and cyclic task dependencies', () => {
    expect(() => assertTaskGraph([graphTask('task-1', ['task-2'])])).toThrowError(expect.objectContaining({ code: 'TEAM_TASK_DEPENDENCY_MISSING' }))
    expect(() => assertTaskGraph([graphTask('task-1', ['task-1'])])).toThrowError(expect.objectContaining({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' }))
    expect(() => assertTaskGraph([graphTask('task-1', []), graphTask('task-2', ['task-1', 'task-1'])])).toThrowError(expect.objectContaining({ code: 'TEAM_TASK_DEPENDENCY_DUPLICATE' }))
    expect(() => assertTaskGraph([graphTask('task-1', ['task-2']), graphTask('task-2', ['task-1'])])).toThrowError(expect.objectContaining({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' }))
  })

  it('rejects an arbitrary stale attempt id without revealing internal state', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'stale', description: 'Reject invalid capability.',
    })
    const claim = await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    await expect(domain.submitTask(
      scope,
      team.id,
      'member-1',
      task.id,
      claim.task.revision,
      AttemptId('attempt-invalid'),
      'bad',
    )).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_STALE' })
  })

  it('does not reassign a terminal task', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'terminal', description: 'Complete once.',
    })
    const claim = await domain.claimTask(
      scope, team.id, 'captain-session', task.id, task.revision, 'member-1',
    )
    const submitted = await domain.submitTask(
      scope, team.id, 'member-1', task.id, claim.task.revision, claim.attempt.id, 'done',
    )
    const completed = await domain.reviewTask(
      scope, team.id, 'captain-session', task.id, submitted.revision, claim.attempt.id, 'accept',
    )
    await expect(domain.cancelAttempt(
      scope, team.id, 'captain-session', task.id, completed.revision, 'late reassignment',
    )).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_REASSIGNABLE' })
  })

  it('scenario 12: limits the complete serialized message frame, not only its content', async () => {
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const limited = new TeamDomain(stack.store, {
      ...DEFAULT_TEAM_LIMITS,
      maxMessageBytes: 128,
    }, () => tick++)
    domain = stack.port as TeamDomain
    const team = await limited.createTeam(scope, 'captain-session', 'Frame team', 'Check full frames')
    await limited.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'receive', sessionId: 'member-1', provider: 'spawn',
    })
    await limited.settleMember(scope, team.id, 'member-1', { active: true })
    await expect(limited.queueMessage(
      scope, team.id, 'captain-session', 'worker', 'x', 'wakeup',
    )).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
  })

  it('rejects semantically corrupt persisted state before granting authority', async () => {
    const team = await teamWithMembers(1)
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'corrupt target', description: 'Break one cross-reference.',
    })
    await domain.claimTask(scope, team.id, 'captain-session', task.id, task.revision, 'member-1')
    await stack.close()

    // Zod-valid at the durable boundary, but the task references a current
    // attempt that does not exist: assertTeamState must reject on read.
    const path = unitFilePath(join(sandbox, 'storage'))
    const unit = JSON.parse(await readFile(path, 'utf8')) as { tables: { teams: Record<string, { team: { tasks: { id: string }[] } }> } }
    const record = unit.tables.teams[team.id]!
    const stored = record.team as unknown as { tasks: { id: string; currentAttemptId?: string }[] }
    stored.tasks[0]!.currentAttemptId = 'attempt-missing'
    await writeFile(path, JSON.stringify(unit, null, 2), 'utf8')

    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    const rejected: unknown = await domain.findMembership(scope, 'captain-session').catch(error => error)
    expect(rejected).toMatchObject({ code: 'TEAM_STATE_CORRUPT' })
    expect((rejected as Error).message).not.toContain(sandbox)
  })

  it('accounts committed Session usage exactly once by event sequence', async () => {
    const team = await teamWithMembers(1)
    let budget = await domain.recordSessionUsage(scope, team.id, 'member-1', 4, 15)
    expect(budget.usedTokens).toBe(15)
    budget = await domain.recordSessionUsage(scope, team.id, 'member-1', 4, 15)
    expect(budget.usedTokens).toBe(15)
    budget = await domain.recordSessionUsage(scope, team.id, 'member-1', 8, 5)
    expect(budget.usedTokens).toBe(20)
  })

  it('folds an out-of-order usage batch completely, matching single-event semantics (P2-3)', async () => {
    const team = await teamWithMembers(1)
    // A third-party Provider may submit a coalesced batch in any order; the
    // public port must not silently drop the earlier event seq.
    const budget = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [
      { eventSeq: 5, tokens: 50 },
      { eventSeq: 3, tokens: 30 },
    ])
    expect(budget.usedTokens).toBe(80)
    // Duplicate seqs inside one batch keep the replay-exactly-once fold.
    const replayed = await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [
      { eventSeq: 5, tokens: 50 },
      { eventSeq: 3, tokens: 30 },
    ])
    expect(replayed.usedTokens).toBe(80)
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.usageCursors['member-1']).toBe(5)
  })

  it('keeps the control-plane revision stable across a redundant usage replay', async () => {
    const team = await teamWithMembers(1)
    const before = await domain.snapshot(scope, team.id, 'captain-session')
    const revision = before.team.revision

    // A fully-replayed batch is a no-op write: no durability, no revise.
    await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 3, tokens: 40 }])
    await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 3, tokens: 40 }])
    const snapshot = await domain.snapshot(scope, team.id, 'captain-session')
    expect(snapshot.team.budget.usedTokens).toBe(40)
    expect(snapshot.team.usageCursors['member-1']).toBe(3)
    expect(snapshot.team.revision).toBe(revision)
  })

  it('does not advance the revision on budget/usage writes; the captain CAS stays valid', async () => {
    const team = await teamWithMembers(1)
    const revision = (await domain.snapshot(scope, team.id, 'captain-session')).team.revision

    // Usage fold (M1C) is a durable non-transition write: the ledger and the
    // per-session cursor persist, but the board revision must not move, and
    // the subsequent captain set_captain_profile with the pre-usage
    // expected_revision must succeed (previously the usage write had already
    // bumped the revision and this CAS died with TEAM_REVISION_CONFLICT).
    await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 3, tokens: 40 }])
    const afterUsage = await domain.snapshot(scope, team.id, 'captain-session')
    expect(afterUsage.team.budget.usedTokens).toBe(40)
    expect(afterUsage.team.usageCursors['member-1']).toBe(3)
    expect(afterUsage.team.revision).toBe(revision)

    await expect(domain.setCaptainProfile(
      scope, team.id, 'captain-session', revision, { displayName: 'Cap' },
    )).resolves.toMatchObject({ revision: revision + 1 })

    // Budget configuration is likewise not a board transition: set_budget keeps
    // the revision, so a control-plane op holding the pre-set_budget revision
    // still commits.
    const beforeBudgetState = await domain.snapshot(scope, team.id, 'captain-session')
    const setBudgetRevision = beforeBudgetState.team.revision
    await domain.setBudget(scope, team.id, 'captain-session', { tokenLimit: 10_000 })
    const afterBudget = await domain.snapshot(scope, team.id, 'captain-session')
    expect(afterBudget.team.budget.tokenLimit).toBe(10_000)
    expect(afterBudget.team.revision).toBe(setBudgetRevision)
    await expect(domain.setPublicGoal(
      scope, team.id, 'captain-session', setBudgetRevision, 'Ship the board.',
    )).resolves.toMatchObject({ revision: setBudgetRevision + 1 })

    // A fresh usage write after a real board transition still leaves the board
    // revision untouched (already at revision+1), so publish_announcement keeps
    // using the same expected_revision it read.
    const beforePublish = await domain.snapshot(scope, team.id, 'captain-session')
    await domain.recordSessionUsageBatch(scope, team.id, 'member-1', [{ eventSeq: 7, tokens: 5 }])
    const afterAcquire = await domain.snapshot(scope, team.id, 'captain-session')
    expect(afterAcquire.team.revision).toBe(beforePublish.team.revision)
    await expect(domain.publishAnnouncement(
      scope, team.id, 'captain-session', beforePublish.team.revision, 'Hello',
    )).resolves.toMatchObject({ team: { revision: beforePublish.team.revision + 1 } })
  })

  it('still advances the revision on genuine control-plane board transitions', async () => {
    const team = await teamWithMembers(1)
    const revision = (await domain.snapshot(scope, team.id, 'captain-session')).team.revision

    // A real board transition (captain profile) advances the revision …
    const profiled = await domain.setCaptainProfile(
      scope, team.id, 'captain-session', revision, { displayName: 'Cap' },
    )
    expect(profiled.revision).toBe(revision + 1)

    // … and a roster change (provisionMember) advances it again; the same is
    // true for task creation — none of these are collapsed into a no-revision
    // write like budget/usage are.
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker-extra', role: 'helper', sessionId: 'member-extra', provider: 'spawn',
    })
    const afterRoster = await domain.snapshot(scope, team.id, 'captain-session')
    expect(afterRoster.team.revision).toBeGreaterThan(profiled.revision)

    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'board transition', description: 'Tasks are board transitions.',
    })
    expect(task.revision).toBe(1)
    const afterTask = await domain.snapshot(scope, team.id, 'captain-session')
    expect(afterTask.team.revision).toBeGreaterThan(afterRoster.team.revision)
  })

})
