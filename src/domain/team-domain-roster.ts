/**
 * Team lifecycle and membership roster of the Team protocol core.
 *
 * Owns aggregate creation, captain/member membership resolution,
 * provisioning settlement and crash recovery, member removal (fencing the
 * removed member's attempts, requeueing their open tasks, cancelling
 * their queued mail) and whole-Team archival. Every transition runs inside
 * one aggregate transaction and publishes state only after the durable
 * commit succeeded.
 */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { pruneRetainedAttempts } from './team-domain-board.js'
import { pruneRetainedMessages } from './team-domain-mailbox.js'
import {
  actorMembership,
  attemptOf,
  clearTaskExecution,
  nonEmpty,
  normalizeMemberName,
  replaceAttempt,
  replaceTask,
  type TeamDomainDeps,
} from './team-domain-shared.js'
import { TeamId, type TaskId, type TeamMember, type TeamMemberProvisionInput, type TeamMembership, type TeamState } from './types.js'
import type { TeamScope } from './team-domain-port.js'

export async function createTeam(
  deps: TeamDomainDeps,
  scope: TeamScope,
  captainSessionId: string,
  name: string,
  description: string,
  captainUsageSeq: number,
): Promise<TeamState> {
  expectDomain(Number.isSafeInteger(captainUsageSeq) && captainUsageSeq >= -1, 'captain usage seq is invalid', 'TEAM_INPUT_INVALID')
  const timestamp = deps.now()
  const team: TeamState = {
    schemaVersion: 1,
    id: TeamId(`team-${randomUUID()}`),
    revision: 1,
    name: nonEmpty(name, 'team name', 128),
    description: nonEmpty(description, 'team description', 16_384),
    captainSessionId,
    phase: 'active',
    members: [],
    tasks: [],
    attempts: [],
    messages: [],
    budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: { [captainSessionId]: captainUsageSeq },
    memory: [],
    nextTaskNumber: 1,
    nextMemoryNumber: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  await deps.store.createUniqueForCaptain(scope, team)
  return structuredClone(team)
}

/**
 * Resolve one session's active-Team membership, failing loud on ambiguity
 * (F11): this domain permits a member to found its own Team in the same
 * scope, so one session can genuinely match several active Teams. silently
 * picking the first would route authority and accounting arbitrarily;
 * `TEAM_MEMBERSHIP_AMBIGUOUS` names every matched Team instead.
 */
export async function findMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
  const matches: TeamMembership[] = []
  for (const team of await deps.store.list(scope)) {
    if (team.phase !== 'active') continue
    if (team.captainSessionId === sessionId) {
      matches.push({ team, role: 'captain', name: 'captain' })
      continue
    }
    const member = team.members.find(candidate => candidate.sessionId === sessionId && candidate.phase === 'active')
    if (member !== undefined) matches.push({ team, role: 'member', name: member.name })
  }
  if (matches.length > 1) {
    throw new TeamDomainError(
      `session "${sessionId}" belongs to multiple active teams: ${matches.map(match => match.team.id).join(', ')}`,
      'TEAM_MEMBERSHIP_AMBIGUOUS',
    )
  }
  return matches[0]
}

export async function requireMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership> {
  const membership = await findMembership(deps, scope, sessionId)
  if (membership === undefined) throw new TeamDomainError('caller does not belong to an active team', 'TEAM_NOT_JOINED')
  return membership
}

/**
 * The read-side membership resolution (F14): active-Team membership wins, and
 * a session captain of exactly one archived Team keeps read access to that
 * terminal aggregate. Captain of several archived Teams is the same ambiguity
 * and fails loud the same way.
 */
export async function findReadMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
  const active = await findMembership(deps, scope, sessionId)
  if (active !== undefined) return active
  const archivedCaptained = (await deps.store.list(scope))
    .filter(team => team.phase !== 'active' && team.captainSessionId === sessionId)
  if (archivedCaptained.length > 1) {
    throw new TeamDomainError(
      `session "${sessionId}" captained multiple archived teams: ${archivedCaptained.map(team => team.id).join(', ')}`,
      'TEAM_MEMBERSHIP_AMBIGUOUS',
    )
  }
  return archivedCaptained.length === 0 ? undefined : { team: archivedCaptained[0]!, role: 'captain', name: 'captain' }
}

export async function requireReadMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership> {
  const membership = await findReadMembership(deps, scope, sessionId)
  if (membership === undefined) {
    throw new TeamDomainError('caller is not an active participant or archived captain', 'TEAM_NOT_JOINED')
  }
  return membership
}

/**
 * The usage-accounting membership resolution (issue #92): a billing flush must
 * resolve the Team that `recordSessionUsageBatch` itself would accept — the
 * captain or a roster row at ANY member phase, in an active Team first — not
 * the authority-facing active-phase-only match of {@link findMembership}. A
 * member's first turn streams (and bills) while its roster row is still
 * `provisioning` (the record commits before `startContinuable`, `active`
 * settles only after the child accepts); an authority resolution there
 * returned `undefined` and the flush silently discarded real usage, relying on
 * a recovery refold that nothing guaranteed. Drain-time and post-archive usage
 * faces the same asymmetry, so non-active Teams are a fallback tier exactly
 * like the F14 read split. Ambiguity within one tier keeps failing loud with
 * `TEAM_MEMBERSHIP_AMBIGUOUS`; a cross-tier match resolves to the live ledger.
 */
export async function findAccountingMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
  const activeMatches: TeamMembership[] = []
  const settledMatches: TeamMembership[] = []
  for (const team of await deps.store.list(scope)) {
    if (team.captainSessionId === sessionId) {
      ;(team.phase === 'active' ? activeMatches : settledMatches).push({ team, role: 'captain', name: 'captain' })
      continue
    }
    const member = team.members.find(candidate => candidate.sessionId === sessionId)
    if (member !== undefined) {
      ;(team.phase === 'active' ? activeMatches : settledMatches).push({ team, role: 'member', name: member.name })
    }
  }
  const matches = activeMatches.length > 0 ? activeMatches : settledMatches
  if (matches.length > 1) {
    throw new TeamDomainError(
      `session "${sessionId}" belongs to multiple ${activeMatches.length > 0 ? 'active' : 'non-active'} teams: ${matches.map(match => match.team.id).join(', ')}`,
      'TEAM_MEMBERSHIP_AMBIGUOUS',
    )
  }
  return matches[0]
}

export async function provisionMember(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  input: TeamMemberProvisionInput,
): Promise<TeamMember> {
  let committed!: TeamMember
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can add members', 'TEAM_CAPTAIN_REQUIRED')
    // Official name-lifetime alignment (F12): a member name is immutable and
    // never reusable — `failed`/`removed` records stay in the roster with
    // their names occupied for the Team's lifetime, and the total roster size
    // (not only occupied rows) is what `maxMembers` bounds, matching the
    // official experimental roster (`TEAM_MEMBER_NAME_TAKEN`, members.size).
    const name = normalizeMemberName(input.name)
    expectDomain(
      !team.members.some(candidate => candidate.name === name),
      `member name "${name}" was already used in this Team`,
      'TEAM_MEMBER_NAME_TAKEN',
    )
    expectDomain(team.members.length < deps.limits.maxMembers, 'team member limit reached', 'TEAM_MEMBER_LIMIT')
    const deniedTools = input.deniedTools?.map(value => nonEmpty(value, 'denied tool name', 256))
    const assignedSkills = input.assignedSkills?.map(value => nonEmpty(value, 'assigned Skill name', 128))
    expectDomain((deniedTools?.length ?? 0) <= 256, 'member denied tool snapshot is too large', 'TEAM_INPUT_INVALID')
    expectDomain((assignedSkills?.length ?? 0) <= 32, 'member assigned Skill snapshot is too large', 'TEAM_INPUT_INVALID')
    const timestamp = deps.now()
    committed = {
      name,
      role: nonEmpty(input.role, 'member role', 2_048),
      sessionId: input.sessionId,
      provider: nonEmpty(input.provider, 'member provider', 128),
      ...(input.llmProvider === undefined ? {} : { llmProvider: nonEmpty(input.llmProvider, 'member LLM provider', 128) }),
      ...(input.model === undefined ? {} : { model: nonEmpty(input.model, 'member model', 256) }),
      ...(input.modelSource === undefined ? {} : { modelSource: input.modelSource }),
      ...(deniedTools === undefined ? {} : { deniedTools }),
      ...(assignedSkills === undefined ? {} : { assignedSkills }),
      phase: 'provisioning',
      createdAt: timestamp,
    }
    team.members.push(committed)
    const usageCursors = { ...team.usageCursors, [input.sessionId]: -1 }
    Object.assign(team, { usageCursors })
  })
  return structuredClone(committed)
}

export async function settleMember(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  sessionId: string,
  outcome: { active: true } | { active: false; error: string },
): Promise<TeamMember> {
  let committed!: TeamMember
  await deps.store.transact(scope, teamId, team => {
    const index = team.members.findIndex(candidate => candidate.sessionId === sessionId)
    expectDomain(index >= 0, 'provisioning member not found', 'TEAM_MEMBER_NOT_FOUND')
    const current = team.members[index]!
    expectDomain(current.phase === 'provisioning', 'member is no longer provisioning', 'TEAM_MEMBER_PHASE_INVALID')
    committed = outcome.active
      ? { ...current, phase: 'active' }
      : { ...current, phase: 'failed', error: nonEmpty(outcome.error, 'member error', 4_096) }
    team.members[index] = committed
  })
  return structuredClone(committed)
}

export async function recoverProvisioningMembers(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  diagnostic: string,
): Promise<TeamMember[]> {
  const recovered: TeamMember[] = []
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can recover members', 'TEAM_CAPTAIN_REQUIRED')
    const reason = nonEmpty(diagnostic, 'member recovery diagnostic', 4_096)
    for (let index = 0; index < team.members.length; index += 1) {
      const member = team.members[index]!
      if (member.phase !== 'provisioning') continue
      const failed = { ...member, phase: 'failed' as const, error: reason }
      team.members[index] = failed
      recovered.push(failed)
    }
  })
  return structuredClone(recovered)
}

export async function removeMember(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  name: string,
  diagnostic: string,
): Promise<{ member: TeamMember; requeuedTaskIds: TaskId[] }> {
  let committedMember!: TeamMember
  const requeuedTaskIds: TaskId[] = []
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can remove members', 'TEAM_CAPTAIN_REQUIRED')
    const normalizedName = normalizeMemberName(name)
    const index = team.members.findIndex(member => member.name === normalizedName && member.phase === 'active')
    expectDomain(index >= 0, `active member "${normalizedName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    const current = team.members[index]!
    const timestamp = deps.now()
    const reason = nonEmpty(diagnostic, 'member removal diagnostic', 8_192)
    committedMember = { ...current, phase: 'removed', error: reason }
    team.members[index] = committedMember

    for (const task of team.tasks) {
      if (task.ownerSessionId !== current.sessionId || !['in_progress', 'submitted', 'verifying'].includes(task.status)) continue
      if (task.currentAttemptId !== undefined) {
        const attempt = attemptOf(team, task.currentAttemptId)
        replaceAttempt(team, { ...attempt, phase: 'stale', diagnostic: reason, updatedAt: timestamp })
      }
      const requeued = clearTaskExecution(task, {
        revision: task.revision + 1,
        status: 'pending',
        updatedAt: timestamp,
      })
      replaceTask(team, requeued)
      requeuedTaskIds.push(task.id)
    }
    for (let messageIndex = 0; messageIndex < team.messages.length; messageIndex += 1) {
      const message = team.messages[messageIndex]!
      if (message.phase === 'queued' && (message.targetSessionId === current.sessionId || message.senderSessionId === current.sessionId)) {
        team.messages[messageIndex] = { ...message, phase: 'cancelled' }
      }
    }
    pruneRetainedMessages(team, deps.limits.maxRetainedMessages)
    pruneRetainedAttempts(team, deps.limits.maxRetainedAttempts)
  })
  return { member: structuredClone(committedMember), requeuedTaskIds: [...requeuedTaskIds] }
}

export async function archiveTeam(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  diagnostic: string,
): Promise<TeamState> {
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can archive the Team', 'TEAM_CAPTAIN_REQUIRED')
    const timestamp = deps.now()
    const reason = nonEmpty(diagnostic, 'archive diagnostic', 8_192)
    for (let index = 0; index < team.members.length; index += 1) {
      const member = team.members[index]!
      if (member.phase === 'active' || member.phase === 'provisioning') {
        team.members[index] = { ...member, phase: 'removed', error: reason }
      }
    }
    for (const task of team.tasks) {
      if (!['pending', 'in_progress', 'submitted', 'verifying'].includes(task.status)) continue
      if (task.currentAttemptId !== undefined) {
        const attempt = attemptOf(team, task.currentAttemptId)
        replaceAttempt(team, { ...attempt, phase: 'stale', diagnostic: reason, updatedAt: timestamp })
      }
      replaceTask(team, clearTaskExecution(task, {
        revision: task.revision + 1,
        status: 'cancelled',
        updatedAt: timestamp,
      }))
    }
    for (let index = 0; index < team.messages.length; index += 1) {
      const message = team.messages[index]!
      if (message.phase === 'queued') team.messages[index] = { ...message, phase: 'cancelled' }
    }
    pruneRetainedMessages(team, deps.limits.maxRetainedMessages)
    pruneRetainedAttempts(team, deps.limits.maxRetainedAttempts)
    Object.assign(team, { phase: 'archived' as const })
    committed = team
  })
  return structuredClone(committed)
}
