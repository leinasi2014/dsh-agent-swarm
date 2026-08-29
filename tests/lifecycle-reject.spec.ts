import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('review reject lifecycle (no auto-redelivery to old strict target)', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  afterEach(async () => {
    if (stack !== undefined) await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function open() {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-reject-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  }

  it('reject requeues to the general ready pool, not the same strict target', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Reject team', 'lifecycle')
    for (const [name, id] of [['alpha', 'member-a'], ['beta', 'member-b']] as const) {
      await domain.provisionMember(scope, team.id, 'captain-session', { name, role: 'worker', sessionId: id, provider: 'spawn' })
      await domain.settleMember(scope, team.id, id, { active: true })
    }

    // Task strictly targeted at member-a.
    const task = await domain.createTask(scope, team.id, 'captain-session', {
      subject: 'reject-target',
      description: 'Prove reject clears the old strict target.',
      targetMemberSessionId: 'member-a',
    })

    const claimed = await domain.claimTask(scope, team.id, 'member-a', task.id, task.revision, 'member-a')
    const submitted = await domain.submitTask(scope, team.id, 'member-a', task.id, claimed.task.revision, claimed.attempt.id, 'draft')
    const rejected = await domain.reviewTask(scope, team.id, 'captain-session', task.id, submitted.revision, claimed.attempt.id, 'reject', 'not good enough')

    // status pending, no owner, AND the old strict target is cleared (never
    // auto-redelivered to member-a).
    expect(rejected.status).toBe('pending')
    expect(rejected.ownerSessionId).toBeUndefined()
    expect(rejected.targetMemberSessionId).toBeUndefined()
  })
})
