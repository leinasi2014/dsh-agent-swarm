/**
 * Issue #193 regression (RED): concurrent Team operations racing on the
 * `agent_swarm.json` namespace write.
 *
 * Root cause: `StorageDomainTeamStore` serializes per-team (`teamLocks`) and
 * per-scope (`scopeLocks`) process-locally, but every durable Team write still
 * funnels through the SAME `domain.table('teams').put(...)` unit, and the
 * @deepseek-ai/dsh-storage-json backend publishes every put as an atomic
 * whole-file replacement (temp write + fsync + rename()). The store does NOT
 * globally serialize the `agent_swarm.json` UNIT, so two Team operations
 * writing the same unit concurrently issue OVERLAPPING atomic rename()
 * publishes and the rename contention surfaces as a transient EPERM.
 *
 * Deterministic reproduction (design route 1): a shared fault backend whose
 * record-write path holds the unit in flight across a real async gap and
 * rejects a concurrent SECOND write to the SAME unit with a coded `EPERM`.
 * Because the Storage Domain write chain serializes per-domain, the overlap is
 * produced by TWO domain handles over the SAME medium (a second store/domain
 * instance sharing the unit), exactly the "more than one store instance"
 * shape that reaches the backend with no unit-level ordering.
 *
 * The unfixed store surfaces the transient EPERM to the caller; the test
 * asserts every concurrent transition commits and the durable state is
 * consistent, so it fails red until the runtime fix globally serializes the
 * unit write (or retries the transient contention).
 */
import { describe, expect, it } from 'vitest'
import { TaskId, TeamId, type TeamState, type TeamTask } from '../src/domain/types.js'
import { FaultableBackend, openFaultableStack, type StorageStack } from './helpers/storage-stack.js'

const TEAM_DOMAIN_UNIT = 'agent_swarm'

/** A valid schema-v2 Team aggregate (no v1→v2 upgrade write in the transact). */
function raceTeam(id: string, captain = 'captain-session'): TeamState {
  const timestamp = 1
  return {
    schemaVersion: 2,
    id: TeamId(id),
    revision: 1,
    name: 'Race team',
    description: 'Concurrent namespace-write race fixture',
    captainSessionId: captain,
    phase: 'active',
    members: [],
    tasks: [],
    attempts: [],
    messages: [],
    interactionEffects: [],
    budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: { [captain]: -1 },
    memory: [],
    nextTaskNumber: 1,
    nextMemoryNumber: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function raceTask(id: string): TeamTask {
  return {
    id: TaskId(id),
    revision: 1,
    subject: id,
    description: id,
    acceptanceCriteria: [],
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('concurrent Team operations racing on the agent_swarm namespace write (issue #193)', () => {
  it('commits every concurrent transition by retrying/publishing the unit serially, with no transient EPERM surfacing', async () => {
    const backend = new FaultableBackend()
    const scope = 'shared-workspace'
    let tick = 1_000
    const now = (): number => tick++

    // One writer store creates both Teams over the shared medium.
    const writer: StorageStack = await openFaultableStack(backend, now)
    try {
      const teamA = raceTeam('team-race-namespace-0001', 'captain-a')
      const teamB = raceTeam('team-race-namespace-0002', 'captain-b')
      await writer.store.createUniqueForCaptain(scope, teamA)
      await writer.store.createUniqueForCaptain(scope, teamB)

      // A second store/domain instance opens the SAME unit from the medium. Its
      // domain write chain is independent, so its puts are NOT ordered against
      // the writer's puts — this is the cross-instance unit race.
      const peer: StorageStack = await openFaultableStack(backend, now)
      try {
        // Confirm the peer observed both Teams through the shared medium.
        expect((await peer.store.list(scope)).map(team => team.id)).toEqual([teamA.id, teamB.id])

        // Arm unit-level rename contention on the shared unit.
        backend.contendUnitName = TEAM_DOMAIN_UNIT

        const results = await Promise.all([
          writer.store.transact(scope, teamA.id, draft => {
            Object.assign(draft, { name: 'Race team A (transition)' })
            draft.tasks.push(raceTask(`task-a-race`))
            return 'A-committed'
          }),
          peer.store.transact(scope, teamB.id, draft => {
            Object.assign(draft, { name: 'Race team B (transition)' })
            draft.tasks.push(raceTask(`task-b-race`))
            return 'B-committed'
          }),
        ])

        // Route 1 assertion: the race must not surface a transient EPERM to the
        // caller — both concurrent transitions commit (the store retries or
        // globally serializes the unit write).
        expect(results).toEqual(['A-committed', 'B-committed'])

        // A fresh read of the shared medium must be consistent — all Teams
        // present, revisions advanced exactly once, and every transition's
        // effect persisted (no silent data loss from an overlapping rename()).
        const verify: StorageStack = await openFaultableStack(backend, now)
        try {
          const teams = await verify.store.list(scope)
          expect(teams).toHaveLength(2)
          const storedA = teams.find(team => team.id === teamA.id)
          const storedB = teams.find(team => team.id === teamB.id)
          expect(storedA).toMatchObject({ revision: 2, name: 'Race team A (transition)' })
          expect(storedB).toMatchObject({ revision: 2, name: 'Race team B (transition)' })
          expect(storedA?.tasks.map(task => task.id)).toEqual([TaskId('task-a-race')])
          expect(storedB?.tasks.map(task => task.id)).toEqual([TaskId('task-b-race')])
        } finally {
          await verify.close()
        }
      } finally {
        await peer.close()
      }
    } finally {
      await writer.close()
    }
  })
})
