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
import { actorMembership, readerMembership, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
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
  options: { readonly scope?: 'team' | 'member'; readonly ownerSessionId?: string } = {},
): Promise<TeamState['memory'][number]> {
  let committed!: TeamState['memory'][number]
  await deps.store.transact(scope, teamId, team => {
    const actor = actorMembership(team, actorSessionId)
    const memoryScope = options.scope ?? 'team'
    let ownerSessionId: string | undefined
    if (memoryScope === 'member') {
      ownerSessionId = options.ownerSessionId ?? actorSessionId
      const owner = team.members.find(member => member.sessionId === ownerSessionId && member.phase === 'active')
      expectDomain(owner !== undefined, 'personal memory owner must be an active Team member', 'TEAM_MEMBER_NOT_FOUND')
      expectDomain(actor.role === 'captain' || ownerSessionId === actorSessionId, 'members may write only their own personal memory', 'TEAM_UNAUTHORIZED')
    } else {
      expectDomain(options.ownerSessionId === undefined, 'team memory cannot declare an owner', 'TEAM_INPUT_INVALID')
    }
    expectDomain(team.memory.length < deps.limits.maxMemories, 'team memory limit reached', 'TEAM_MEMORY_LIMIT')
    committed = {
      id: `memory-${team.nextMemoryNumber}`,
      category,
      content: nonEmpty(content, 'memory content', 16_384),
      evidenceRefs: [...evidenceRefs].map(value => nonEmpty(value, 'memory evidence reference', 2_048)),
      scope: memoryScope,
      ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
      authorSessionId: actorSessionId,
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
  // F14 read/write authority split: reads resolve through the archived
  // captain too, so a terminal aggregate stays inspectable while every
  // mutation keeps rejecting with TEAM_ARCHIVED.
  readerMembership(team, actorSessionId)
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
  readerMembership(before, actorSessionId)
  // An archived Team is terminal (F14): no later revision can ever commit,
  // so a caller whose cursor is already current resolves with the terminal
  // snapshot immediately instead of waiting out its timeout. A superseded
  // cursor still resolves through the ordinary store path.
  const team = before.phase === 'archived' ? before : await deps.store.waitForChange(scope, teamId, afterRevision, signal)
  readerMembership(team, actorSessionId)
  return statusOf(team)
}
