import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTeamState } from '../src/domain/state-validation.js'
import { TeamId, type TeamState } from '../src/domain/types.js'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'
import { CAPTAIN_ONLY_TOOLS } from '../src/runtime/prompts.js'
import { memberToolDeny } from '../src/runtime/tool-policy.js'

describe('public goal (durable, permission, CAS)', () => {
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
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-goal-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  }

  it('sets the public goal with CAS, canonical bounds, and persists across restart', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Goal team', 'goal')

    // Wrong expected revision fails loud (CAS).
    await expect(domain.setPublicGoal(scope, team.id, 'captain-session', team.revision + 1, 'future'))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    await expect(domain.setPublicGoal(scope, team.id, 'captain-session', 0, 'bad'))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })

    // Empty / whitespace / overlong rejected before commit.
    await expect(domain.setPublicGoal(scope, team.id, 'captain-session', team.revision, '   '))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_GOAL_INVALID' })
    await expect(domain.setPublicGoal(scope, team.id, 'captain-session', team.revision, 'x'.repeat(4097)))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_GOAL_INVALID' })

    // Canonical set (trimmed), CAS on current revision.
    const updated = await domain.setPublicGoal(scope, team.id, 'captain-session', team.revision, '  Ship the Team UI.  ')
    expect(updated.publicGoal).toBe('Ship the Team UI.')
    expect(updated.revision).toBe(team.revision + 1)

    // Durable restart preserves the goal.
    await stack.close(); stack = undefined as unknown as StorageStack
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    const [reloaded] = await stack.store.list(scope)
    expect(reloaded!.publicGoal).toBe('Ship the Team UI.')
    expect(() => assertTeamState(reloaded, 'reloaded')).not.toThrow()

    // Update with new CAS revision.
    const updated2 = await domain.setPublicGoal(scope, reloaded!.id, 'captain-session', reloaded!.revision, 'Ship it now.')
    expect(updated2.publicGoal).toBe('Ship it now.')
  })

  it('enforces Captain-only writes and member tool deny surface', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Perm team', 'goal perm')
    await domain.provisionMember(scope, team.id, 'captain-session', { name: 'worker', role: 'w', sessionId: 'member-w', provider: 'spawn' })
    await domain.settleMember(scope, team.id, 'member-w', { active: true })
    const live = await domain.snapshot(scope, team.id, 'captain-session')
    await expect(domain.setPublicGoal(scope, team.id, 'member-w', live.team.revision, 'hijack'))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    // Captain succeeds on the live revision.
    const set = await domain.setPublicGoal(scope, team.id, 'captain-session', live.team.revision, 'real')
    expect(set.publicGoal).toBe('real')

    expect(CAPTAIN_ONLY_TOOLS).toContain('agent_swarm_set_public_goal')
    expect(memberToolDeny([])).toContain('agent_swarm_set_public_goal')
  })

  it('rejects crafted non-canonical/oversized persisted goal via assertTeamState', () => {
    const base = {
      schemaVersion: 2,
      id: TeamId('team-aaaaaaaaaaaaaaaaaaaa'),
      revision: 2, name: 'T', description: 'D', captainSessionId: 'c', phase: 'active',
      members: [], tasks: [], attempts: [], messages: [], interactionEffects: [], memory: [],
      budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
      usageCursors: {}, nextTaskNumber: 1, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
    } as unknown as TeamState
    const ok = { ...base, publicGoal: 'Deliver.' } as unknown as TeamState
    expect(() => assertTeamState(ok, 'ok')).not.toThrow()
    const padded = structuredClone(base) as { publicGoal: string }
    padded.publicGoal = '  padded  '
    expect(() => assertTeamState(padded, 'padded')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
  })
})
