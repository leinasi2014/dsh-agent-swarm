/**
 * Cross-Team budget adoption (M2-5, issue #79): the domain operation that
 * decouples the budget lifecycle from the workflow run — one captain's
 * sequential run Teams consume a single carried ledger. Domain-level evidence
 * over the same real official storage stack as the protocol suite; the
 * bridge-driven carry, both faces' wake accounting, exhaustion convergence
 * and reload consistency are proven by the composition suite
 * (`tests/budget-runs.spec.ts`, docs/08 scenario 49).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('Cross-Team budget adoption over the official Storage Domain (M2-5)', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-budget-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  /** One fresh captained Team with the given active members. */
  async function teamWithMembers(captain: string, count: number) {
    const team = await domain.createTeam(scope, captain, 'Run team', 'Ledger continuity')
    for (let index = 1; index <= count; index += 1) {
      await domain.provisionMember(scope, team.id, captain, {
        name: `worker-${index}`, role: 'worker', sessionId: `${team.id}-member-${index}`, provider: 'spawn',
      })
      await domain.settleMember(scope, team.id, `${team.id}-member-${index}`, { active: true })
    }
    return team
  }

  it('scenario 49: adopts a carried budget across Teams and honors its remaining allowance', async () => {
    // Run 1's Team: configured limits plus consumed usage, then archived.
    const first = await teamWithMembers('captain-session', 2)
    await domain.setBudget(scope, first.id, 'captain-session', { tokenLimit: 100, requestLimit: 2 })
    const taskOne = await domain.createTask(scope, first.id, 'captain-session', {
      subject: 'first', description: 'Consume one request.',
    })
    await domain.claimTask(scope, first.id, 'captain-session', taskOne.id, taskOne.revision, `${first.id}-member-1`)
    await domain.consumeTokens(scope, first.id, 40)
    await domain.archiveTeam(scope, first.id, 'captain-session', 'run settled')
    const archived = await domain.snapshot(scope, first.id, 'captain-session')
    expect(archived.team.budget).toMatchObject({ tokenLimit: 100, requestLimit: 2, usedTokens: 40, usedRequests: 1 })

    // Run 2's Team (same captain; the prior is archived): the carried face —
    // limits AND used counters together — seeds the fresh ledger in one shot.
    const second = await teamWithMembers('captain-session', 2)
    const adopted = await domain.adoptBudget(scope, second.id, 'captain-session', archived.team.budget)
    expect(adopted).toEqual(archived.team.budget)

    // The carried allowance is honored: the second claim exhausts the
    // carried request budget, the third is structurally rejected.
    const taskTwo = await domain.createTask(scope, second.id, 'captain-session', {
      subject: 'second', description: 'The last admitted request.',
    })
    await domain.claimTask(scope, second.id, 'captain-session', taskTwo.id, taskTwo.revision, `${second.id}-member-1`)
    const taskThree = await domain.createTask(scope, second.id, 'captain-session', {
      subject: 'third', description: 'Must be rejected on the carried ledger.',
    })
    await expect(domain.claimTask(
      scope, second.id, 'captain-session', taskThree.id, taskThree.revision, `${second.id}-member-2`,
    )).rejects.toMatchObject({ code: 'TEAM_BUDGET_REQUESTS' })

    // Adoption is a fresh-ledger seed, never an overwrite of a live one.
    await expect(domain.adoptBudget(
      scope, second.id, 'captain-session', { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    )).rejects.toMatchObject({ code: 'TEAM_BUDGET_INVALID' })
    // And it stays captain authority.
    await domain.provisionMember(scope, second.id, 'captain-session', {
      name: 'worker-3', role: 'worker', sessionId: 'member-9', provider: 'spawn',
    })
    await domain.settleMember(scope, second.id, 'member-9', { active: true })
    await expect(domain.adoptBudget(
      scope, second.id, 'member-9', { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    )).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    // A carried face below its own usage never seeds.
    const third = await domain.createTeam(scope, 'other-captain', 'Third team', 'Validation target')
    await expect(domain.adoptBudget(
      scope, third.id, 'other-captain', { usedTokens: 10, usedRequests: 0, usedRetries: 0, tokenLimit: 5 },
    )).rejects.toMatchObject({ code: 'TEAM_BUDGET_INVALID' })
  })
})
