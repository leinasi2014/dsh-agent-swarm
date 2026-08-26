import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('directed member tasks', () => {
  let sandbox: string, scope: string, stack: StorageStack, domain: TeamDomain
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-directed-')); scope = join(sandbox, 'workspace')
    stack = await openStorageStack(join(sandbox, 'storage')); domain = stack.port as TeamDomain
  })
  afterEach(async () => { await stack.close(); await rm(sandbox, { recursive: true, force: true }) })
  async function team() {
    const created = await domain.createTeam(scope, 'captain', 'Directed', 'Strict directed scheduling.')
    for (const [name, id] of [['alpha', 'member-a'], ['beta', 'member-b']] as const) {
      await domain.provisionMember(scope, created.id, 'captain', { name, role: name, sessionId: id, provider: 'spawn' })
      await domain.settleMember(scope, created.id, id, { active: true })
    }
    return created
  }
  it('rejects a wrong claim, clears reassignment and releases a removed pending target', async () => {
    const current = await team()
    const task = await domain.createTask(scope, current.id, 'captain', { subject: 'directed', description: 'alpha only', targetMemberSessionId: 'member-a' })
    await expect(domain.claimTask(scope, current.id, 'captain', task.id, task.revision, 'member-b')).rejects.toMatchObject({ code: 'TEAM_TASK_ASSIGNEE_MISMATCH' })
    const claim = await domain.claimTask(scope, current.id, 'captain', task.id, task.revision, 'member-a')
    expect((await domain.cancelAttempt(scope, current.id, 'captain', task.id, claim.task.revision, 'clear')).targetMemberSessionId).toBeUndefined()
    const routed = await domain.createTask(scope, current.id, 'captain', { subject: 'release', description: 'beta route', targetMemberSessionId: 'member-b' })
    await domain.removeMember(scope, current.id, 'captain', 'beta', 'removed')
    expect((await domain.snapshot(scope, current.id, 'captain')).team.tasks.find(value => value.id === routed.id)?.targetMemberSessionId).toBeUndefined()
  })
  it('retains the terminal historical target after member removal', async () => {
    const current = await team()
    const task = await domain.createTask(scope, current.id, 'captain', { subject: 'history', description: 'audit route', targetMemberSessionId: 'member-a' })
    const claim = await domain.claimTask(scope, current.id, 'captain', task.id, task.revision, 'member-a')
    const submitted = await domain.submitTask(scope, current.id, 'member-a', task.id, claim.task.revision, claim.attempt.id, 'done')
    await domain.reviewTask(scope, current.id, 'captain', task.id, submitted.revision, claim.attempt.id, 'accept')
    await domain.removeMember(scope, current.id, 'captain', 'alpha', 'removed')
    expect((await domain.snapshot(scope, current.id, 'captain')).team.tasks.find(value => value.id === task.id)).toMatchObject({ status: 'completed', targetMemberSessionId: 'member-a' })
  })
  it('clears pending and claimed routes when provisioning settlement fails', async () => {
    const created = await domain.createTeam(scope, 'captain', 'Directed', 'Strict directed scheduling.')
    await domain.provisionMember(scope, created.id, 'captain', { name: 'alpha', role: 'alpha', sessionId: 'member-a', provider: 'spawn' })
    const pending = await domain.createTask(scope, created.id, 'captain', { subject: 'pending', description: 'release failure', targetMemberSessionId: 'member-a' })
    await domain.settleMember(scope, created.id, 'member-a', { active: false, error: 'start failed' })
    expect((await domain.snapshot(scope, created.id, 'captain')).team.tasks.find(task => task.id === pending.id)?.targetMemberSessionId).toBeUndefined()
  })
  it('rejects invalid reassignment before changing the authoritative snapshot', async () => {
    const current = await team()
    const task = await domain.createTask(scope, current.id, 'captain', { subject: 'directed', description: 'alpha only', targetMemberSessionId: 'member-a' })
    const claim = await domain.claimTask(scope, current.id, 'captain', task.id, task.revision, 'member-a')
    const before = await domain.snapshot(scope, current.id, 'captain')
    await expect(domain.cancelAttempt(scope, current.id, 'member-b', task.id, claim.task.revision, 'no authority')).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    await expect(domain.cancelAttempt(scope, current.id, 'captain', task.id, claim.task.revision + 1, 'stale')).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    expect(await domain.snapshot(scope, current.id, 'captain')).toEqual(before)
  })
})
