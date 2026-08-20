/**
 * Team memory ledger and derived read projections of the Team protocol
 * core.
 *
 * Appends durable team memories and projects the authoritative aggregate
 * into status snapshots (task readiness, pending mail) for direct reads
 * and revision waits. Projections are derived state only — the stored
 * aggregate stays the single authority and is never reconstructed from
 * them.
 */
import { expectDomain, TeamDomainError } from './error.js'
import { isTaskReady } from './graph.js'
import { actorMembership, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import type { TeamId, TeamMemoryCategory, TeamState, TeamStatusSnapshot } from './types.js'
import type { TeamScope } from './team-domain-port.js'

/** One authoritative aggregate plus its derived readiness/mailbox projections. */
function statusOf(team: TeamState): TeamStatusSnapshot {
  return {
    team,
    readyTaskIds: team.tasks.filter(task => isTaskReady(team.tasks, task)).map(task => task.id),
    pendingMessageIds: team.messages.filter(message => message.phase === 'queued').map(message => message.id),
  }
}

export async function addMemory(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  actorSessionId: string,
  category: TeamMemoryCategory,
  content: string,
  evidenceRefs: readonly string[],
): Promise<TeamState['memory'][number]> {
  let committed!: TeamState['memory'][number]
  await deps.store.transact(scope, teamId, team => {
    actorMembership(team, actorSessionId)
    expectDomain(team.memory.length < deps.limits.maxMemories, 'team memory limit reached', 'TEAM_MEMORY_LIMIT')
    committed = {
      id: `memory-${team.nextMemoryNumber}`,
      category,
      content: nonEmpty(content, 'memory content', 16_384),
      evidenceRefs: [...evidenceRefs].map(value => nonEmpty(value, 'memory evidence reference', 2_048)),
      createdAt: deps.now(),
    }
    team.memory.push(committed)
    Object.assign(team, { nextMemoryNumber: team.nextMemoryNumber + 1 })
  })
  return structuredClone(committed)
}

export async function snapshot(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  actorSessionId: string,
): Promise<TeamStatusSnapshot> {
  const team = await deps.store.read(scope, teamId)
  if (team === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
  actorMembership(team, actorSessionId)
  return statusOf(team)
}

export async function waitForChange(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  actorSessionId: string,
  afterRevision: number,
  signal: AbortSignal,
): Promise<TeamStatusSnapshot> {
  expectDomain(Number.isSafeInteger(afterRevision) && afterRevision >= 0, 'afterRevision must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
  const before = await deps.store.read(scope, teamId)
  if (before === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
  actorMembership(before, actorSessionId)
  const team = await deps.store.waitForChange(scope, teamId, afterRevision, signal)
  actorMembership(team, actorSessionId)
  return statusOf(team)
}
