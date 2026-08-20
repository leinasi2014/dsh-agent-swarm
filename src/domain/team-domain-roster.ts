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
import {
  actorMembership,
  attemptOf,
  clearTaskExecution,
  nonEmpty,
  replaceAttempt,
  replaceTask,
  type TeamDomainDeps,
} from './team-domain-shared.js'
import { TeamId, type TaskId, type TeamMember, type TeamMembership, type TeamState } from './types.js'
import type { TeamScope } from './team-domain-port.js'

function memberName(value: string): string {
  const normalized = value.trim().toLowerCase()
  expectDomain(/^[a-z][a-z0-9-]{0,63}$/.test(normalized), 'member name must be lowercase kebab-case', 'TEAM_MEMBER_NAME_INVALID')
  expectDomain(normalized !== 'captain', 'member name "captain" is reserved', 'TEAM_MEMBER_NAME_RESERVED')
  return normalized
}

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

export async function findMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
  for (const team of await deps.store.list(scope)) {
    if (team.phase !== 'active') continue
    if (team.captainSessionId === sessionId) return { team, role: 'captain', name: 'captain' }
    const member = team.members.find(candidate => candidate.sessionId === sessionId && candidate.phase === 'active')
    if (member !== undefined) return { team, role: 'member', name: member.name }
  }
  return undefined
}

export async function requireMembership(deps: TeamDomainDeps, scope: TeamScope, sessionId: string): Promise<TeamMembership> {
  const membership = await findMembership(deps, scope, sessionId)
  if (membership === undefined) throw new TeamDomainError('caller does not belong to an active team', 'TEAM_NOT_JOINED')
  return membership
}

export async function provisionMember(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  input: { name: string; role: string; sessionId: string; provider: string },
): Promise<TeamMember> {
  let committed!: TeamMember
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can add members', 'TEAM_CAPTAIN_REQUIRED')
    const occupiedMembers = team.members.filter(candidate => candidate.phase === 'active' || candidate.phase === 'provisioning')
    expectDomain(occupiedMembers.length < deps.limits.maxMembers, 'team member limit reached', 'TEAM_MEMBER_LIMIT')
    const name = memberName(input.name)
    expectDomain(!occupiedMembers.some(candidate => candidate.name === name), `active member name "${name}" is already in use`, 'TEAM_MEMBER_NAME_REUSED')
    const timestamp = deps.now()
    committed = {
      name,
      role: nonEmpty(input.role, 'member role', 2_048),
      sessionId: input.sessionId,
      provider: nonEmpty(input.provider, 'member provider', 128),
      phase: 'provisioning',
      createdAt: timestamp,
    }
    const reusableIndex = team.members.findIndex(candidate => candidate.phase === 'failed' || candidate.phase === 'removed')
    const usageCursors = { ...team.usageCursors }
    if (reusableIndex === -1) {
      team.members.push(committed)
    } else {
      const retired = team.members[reusableIndex]!
      team.members[reusableIndex] = committed
      delete usageCursors[retired.sessionId]
    }
    usageCursors[input.sessionId] = -1
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
    const normalizedName = memberName(name)
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
    Object.assign(team, { phase: 'archived' as const })
    committed = team
  })
  return structuredClone(committed)
}
