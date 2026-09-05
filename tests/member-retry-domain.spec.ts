import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openStorageStack } from './helpers/storage-stack.js'

it('retains 64 failed attempts across real storage reopen, bounds retries atomically and preserves old billing authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retry-history-'))
  let stack = await openStorageStack(root)
  const scope = join(root, 'workspace')
  const captain = 'captain'
  try {
    const team = await stack.port.createTeam(scope, captain, 'Retry history', 'Bounded employee attempts')
    let member = await stack.port.provisionMember(scope, team.id, captain, {
      name: 'worker', role: 'Implement', sessionId: 'attempt-0', provider: 'spawn',
    })
    for (let generation = 1; generation <= 64; generation += 1) {
      await stack.port.settleMember(scope, team.id, member.sessionId, { active: false, error: 'startup failed' })
      member = await stack.port.provisionMember(scope, team.id, captain, {
        name: 'worker', role: 'Implement', sessionId: `attempt-${generation}`, provider: 'spawn', retryOf: member.sessionId,
      })
    }
    await stack.port.settleMember(scope, team.id, member.sessionId, { active: false, error: 'startup failed' })
    const before = await stack.port.snapshot(scope, team.id, captain)
    expect(before.team.members).toHaveLength(1)
    expect(before.team.members[0]?.previousSessionIds).toHaveLength(64)
    await expect(stack.port.provisionMember(scope, team.id, captain, {
      name: 'worker', role: 'Implement', sessionId: 'too-many', provider: 'spawn', retryOf: member.sessionId,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_RETRY_LIMIT' })
    expect(await stack.port.snapshot(scope, team.id, captain)).toEqual(before)
    await stack.close()
    stack = await openStorageStack(root)
    expect(await stack.port.snapshot(scope, team.id, captain)).toEqual(before)
    expect((await stack.port.findAccountingMembership(scope, 'attempt-0'))?.team.id).toBe(team.id)
    expect(await stack.port.findMembership(scope, 'attempt-0')).toBeUndefined()
    await expect(stack.port.snapshot(scope, team.id, 'attempt-0')).rejects.toBeDefined()
    await stack.port.recordSessionUsageBatch(scope, team.id, 'attempt-0', [{ eventSeq: 1, tokens: 11 }])
    await stack.port.archiveTeam(scope, team.id, captain, 'Complete')
    expect((await stack.port.findAccountingMembership(scope, 'attempt-0'))?.team.id).toBe(team.id)
    await stack.port.recordSessionUsageBatch(scope, team.id, 'attempt-0', [{ eventSeq: 1, tokens: 11 }, { eventSeq: 2, tokens: 3 }])
    expect((await stack.port.snapshot(scope, team.id, captain)).team.budget.usedTokens).toBe(14)
    await expect(stack.port.recordSessionUsageBatch(scope, team.id, 'outsider', [{ eventSeq: 1, tokens: 99 }])).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
  } finally {
    await stack.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('keeps ordinary lifetime capacity and removed names occupied while allowing distinct unprofiled employees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retry-lifetime-'))
  const stack = await openStorageStack(root)
  const scope = join(root, 'workspace')
  try {
    const team = await stack.port.createTeam(scope, 'captain', 'Lifetime', 'No replacement loophole')
    for (let index = 0; index < 8; index += 1) {
      await stack.port.provisionMember(scope, team.id, 'captain', { name: `worker-${index}`, role: 'Implement', sessionId: `session-${index}`, provider: 'spawn' })
      await stack.port.settleMember(scope, team.id, `session-${index}`, { active: true })
    }
    await stack.port.removeMember(scope, team.id, 'captain', 'worker-0', 'Removed')
    const before = await stack.port.snapshot(scope, team.id, 'captain')
    await expect(stack.port.provisionMember(scope, team.id, 'captain', {
      name: 'worker-0', role: 'Implement', sessionId: 'replacement', provider: 'spawn', retryOf: 'session-0',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_RETRY_CONFLICT' })
    await expect(stack.port.provisionMember(scope, team.id, 'captain', {
      name: 'extra', role: 'Implement', sessionId: 'extra', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    expect(await stack.port.snapshot(scope, team.id, 'captain')).toEqual(before)
  } finally {
    await stack.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('releases a failed Session directed route before retry and retains the stale attempt unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retry-directed-'))
  const stack = await openStorageStack(root)
  const scope = join(root, 'workspace')
  try {
    const team = await stack.port.createTeam(scope, 'captain', 'Directed recovery', 'Failed routes release')
    await stack.port.provisionMember(scope, team.id, 'captain', { name: 'worker', role: 'Implement', sessionId: 'old', provider: 'spawn' })
    await stack.port.settleMember(scope, team.id, 'old', { active: true })
    const pending = await stack.port.createTask(scope, team.id, 'captain', { subject: 'Pending', description: 'Directed pending', targetMemberSessionId: 'old' })
    const running = await stack.port.createTask(scope, team.id, 'captain', { subject: 'Running', description: 'Directed running', targetMemberSessionId: 'old' })
    await stack.port.claimTask(scope, team.id, 'captain', running.id, running.revision, 'old')
    await stack.port.settleMember(scope, team.id, 'old', { active: false, error: 'startup failed during admission' })
    const failed = await stack.port.snapshot(scope, team.id, 'captain')
    expect(failed.team.tasks.every(task => task.status === 'pending' && task.targetMemberSessionId === undefined)).toBe(true)
    expect(failed.team.attempts[0]).toMatchObject({ memberSessionId: 'old', phase: 'stale' })
    await stack.port.provisionMember(scope, team.id, 'captain', { name: 'worker', role: 'Implement', sessionId: 'new', provider: 'spawn', retryOf: 'old' })
    await stack.port.settleMember(scope, team.id, 'new', { active: true })
    const retried = await stack.port.snapshot(scope, team.id, 'captain')
    expect(retried.team.tasks).toEqual(failed.team.tasks)
    expect(retried.team.attempts).toEqual(failed.team.attempts)
    const ready = retried.team.tasks.find(task => task.id === pending.id)!
    expect((await stack.port.claimTask(scope, team.id, 'captain', ready.id, ready.revision, 'new')).attempt.memberSessionId).toBe('new')
  } finally {
    await stack.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
