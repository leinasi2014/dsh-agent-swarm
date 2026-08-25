import { randomUUID } from 'node:crypto'
import { budgetAvailable, outstandingReservationTokens, reservationAdmissible } from './team-domain-budget.js'
import { TeamDomainError } from './error.js'
import { isTaskReady } from './graph.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import {
  DispatchId,
  TeamEffectId,
  type ModelDispatchEpoch,
  type TaskAttemptV2,
  type TeamMemberV2,
  type TeamStateV2,
} from './team-state-v2.js'
import { AttemptId, TaskId, TeamId, type TeamTask } from './types.js'
import type { TeamScope } from './team-domain-port.js'

function requireText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new TeamDomainError(`${label} is empty or too large`, 'TEAM_INPUT_INVALID')
  }
  return normalized
}

function requireDigest(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TeamDomainError(`${label} is not a canonical SHA-256 digest`, 'TEAM_INPUT_INVALID')
  return value
}

function memberOf(team: TeamStateV2, sessionId: string): TeamMemberV2 {
  const member = team.members.find(candidate => candidate.sessionId === sessionId)
  if (member === undefined) throw new TeamDomainError('Team member not found', 'TEAM_MEMBER_NOT_FOUND')
  return member
}

function taskOf(team: TeamStateV2, taskId: string): TeamTask {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new TeamDomainError(`task "${taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
  return task
}

function attemptOf(team: TeamStateV2, attemptId: string): TaskAttemptV2 {
  const attempt = team.attempts.find(candidate => candidate.id === attemptId)
  if (attempt === undefined) throw new TeamDomainError(`attempt "${attemptId}" is stale`, 'TEAM_ATTEMPT_STALE')
  return attempt
}

function replaceMember(team: TeamStateV2, member: TeamMemberV2): void {
  const index = team.members.findIndex(candidate => candidate.sessionId === member.sessionId)
  if (index < 0) throw new TeamDomainError('Team member not found', 'TEAM_MEMBER_NOT_FOUND')
  team.members[index] = member
}

function replaceTask(team: TeamStateV2, task: TeamTask): void {
  const index = team.tasks.findIndex(candidate => candidate.id === task.id)
  if (index < 0) throw new TeamDomainError(`task "${task.id}" not found`, 'TEAM_TASK_NOT_FOUND')
  team.tasks[index] = task
}

function replaceAttempt(team: TeamStateV2, attempt: TaskAttemptV2): void {
  const index = team.attempts.findIndex(candidate => candidate.id === attempt.id)
  if (index < 0) throw new TeamDomainError(`attempt "${attempt.id}" is stale`, 'TEAM_ATTEMPT_STALE')
  team.attempts[index] = attempt
}

function requireCaptain(team: TeamStateV2, sessionId: string): void {
  if (team.captainSessionId !== sessionId || team.phase !== 'active') {
    throw new TeamDomainError('only the active Team captain may perform this transition', 'TEAM_CAPTAIN_REQUIRED')
  }
}

function nextGeneration(team: TeamStateV2, taskId: string): number {
  return team.attempts.reduce((maximum, attempt) => attempt.taskId === taskId
    ? Math.max(maximum, attempt.generation)
    : maximum, 0) + 1
}

export interface DeclareMemberV2Input {
  readonly name: string
  readonly role: string
  readonly sessionId: string
  readonly provider: string
  readonly llmProvider?: string
  readonly model?: string
  readonly modelSource: TeamMemberV2['modelSource']
  readonly deniedTools: readonly string[]
  readonly assignedSkills: readonly string[]
  readonly maxDepth: number
}

export interface InitialDispatchCheckpoint {
  readonly initialPromptDigest: string
  readonly messageSeq: number
  readonly turn: number
  readonly step: number
  readonly witnessCapabilityDigest: string
  readonly dispatchId: string
  readonly effectId: string
}

/** Pure v2 first-start transactions; Agent/Session I/O remains in A1b. */
export class TeamV2StartDomain {
  constructor(
    private readonly store: StorageDomainTeamStoreV2,
    private readonly deps: {
      readonly now?: () => number
      readonly newTeamId?: () => string
      readonly newAttemptId?: () => string
      readonly maxMembers?: number
    } = {},
  ) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  async createTeam(scope: TeamScope, captainSessionId: string, name: string, description: string): Promise<TeamStateV2> {
    const timestamp = this.now()
    const team: TeamStateV2 = {
      schemaVersion: 2,
      id: TeamId(this.deps.newTeamId?.() ?? `team-${randomUUID()}`),
      revision: 1,
      name: requireText(name, 'team name', 128),
      description: requireText(description, 'team description', 16_384),
      captainSessionId: requireText(captainSessionId, 'captain Session id', 512),
      phase: 'active',
      members: [],
      tasks: [],
      attempts: [],
      messages: [],
      interactionEffects: [],
      budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
      usageCursors: { [captainSessionId]: -1 },
      memory: [],
      nextTaskNumber: 1,
      nextMemoryNumber: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.store.createUniqueForCaptain(scope, team)
    return structuredClone(team)
  }

  async declareMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: DeclareMemberV2Input,
  ): Promise<TeamMemberV2> {
    let committed!: TeamMemberV2
    await this.store.transact(scope, teamId, team => {
      requireCaptain(team, captainSessionId)
      const name = requireText(input.name, 'member name', 128)
      if (team.members.some(member => member.name === name || member.sessionId === input.sessionId)) {
        throw new TeamDomainError('member name or Session identity is already occupied', 'TEAM_MEMBER_NAME_TAKEN')
      }
      if (team.members.length >= (this.deps.maxMembers ?? 64)) throw new TeamDomainError('team member limit reached', 'TEAM_MEMBER_LIMIT')
      if (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 0) throw new TeamDomainError('member maxDepth is invalid', 'TEAM_INPUT_INVALID')
      const deniedTools = [...input.deniedTools].map(value => requireText(value, 'denied tool', 256))
      const assignedSkills = [...input.assignedSkills].map(value => requireText(value, 'assigned Skill', 128))
      if (new Set(deniedTools).size !== deniedTools.length || new Set(assignedSkills).size !== assignedSkills.length) {
        throw new TeamDomainError('member profile lists contain duplicates', 'TEAM_INPUT_INVALID')
      }
      committed = {
        name,
        role: requireText(input.role, 'member role', 2_048),
        sessionId: requireText(input.sessionId, 'member Session id', 512),
        provider: requireText(input.provider, 'member Provider', 128),
        ...(input.llmProvider === undefined ? {} : { llmProvider: requireText(input.llmProvider, 'member LLM Provider', 128) }),
        ...(input.model === undefined ? {} : { model: requireText(input.model, 'member model', 256) }),
        modelSource: input.modelSource,
        deniedTools,
        assignedSkills,
        maxDepth: input.maxDepth,
        phase: 'declared',
        createdAt: this.now(),
      }
      team.members.push(committed)
      Object.assign(team, { usageCursors: { ...team.usageCursors, [committed.sessionId]: -1 } })
    })
    return structuredClone(committed)
  }

  async createTask(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: Pick<TeamTask, 'subject' | 'description'> & Partial<Pick<TeamTask, 'acceptanceCriteria' | 'blockedBy' | 'writeScopes' | 'priority' | 'targetMemberSessionId'>>,
  ): Promise<TeamTask> {
    let committed!: TeamTask
    await this.store.transact(scope, teamId, team => {
      requireCaptain(team, captainSessionId)
      const timestamp = this.now()
      committed = {
        id: TaskId(`task-${team.nextTaskNumber}`),
        revision: 1,
        subject: requireText(input.subject, 'task subject', 512),
        description: requireText(input.description, 'task description', 64_000),
        acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
        status: 'pending',
        blockedBy: [...(input.blockedBy ?? [])],
        writeScopes: [...(input.writeScopes ?? [])],
        priority: input.priority ?? 0,
        ...(input.targetMemberSessionId === undefined ? {} : { targetMemberSessionId: input.targetMemberSessionId }),
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      team.tasks.push(committed)
      Object.assign(team, { nextTaskNumber: team.nextTaskNumber + 1 })
    })
    return structuredClone(committed)
  }

  async reserveInitialAssignment(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedTaskRevision: number,
    memberSessionId: string,
    initialPromptDigest: string,
  ): Promise<{ task: TeamTask; member: TeamMemberV2; attempt: TaskAttemptV2 }> {
    let result!: { task: TeamTask; member: TeamMemberV2; attempt: TaskAttemptV2 }
    await this.store.transact(scope, teamId, team => {
      requireCaptain(team, captainSessionId)
      const task = taskOf(team, taskId)
      if (task.revision !== expectedTaskRevision) throw new TeamDomainError('stale task revision', 'TEAM_TASK_STALE_REVISION')
      const member = memberOf(team, memberSessionId)
      if (member.phase !== 'declared') throw new TeamDomainError('member is not declared', 'TEAM_MEMBER_PHASE_INVALID')
      if (!isTaskReady(team.tasks, task)) throw new TeamDomainError('task is not ready', 'TEAM_TASK_NOT_READY')
      if (task.targetMemberSessionId !== undefined && task.targetMemberSessionId !== memberSessionId) {
        throw new TeamDomainError('task targets another member', 'TEAM_TASK_ASSIGNEE_MISMATCH')
      }
      if (team.tasks.some(candidate => candidate.ownerSessionId === memberSessionId
        && ['in_progress', 'submitted', 'verifying'].includes(candidate.status))) {
        throw new TeamDomainError('member already owns open work', 'TEAM_MEMBER_BUSY')
      }
      budgetAvailable(team.budget, this.now())
      const floor = task.reservationTokens ?? 0
      if (!reservationAdmissible(team.budget, outstandingReservationTokens(team.tasks), floor)) {
        throw new TeamDomainError('task reservation exceeds remaining budget', 'TEAM_BUDGET_RESERVATION')
      }
      const timestamp = this.now()
      const attempt: TaskAttemptV2 = {
        id: AttemptId(this.deps.newAttemptId?.() ?? `attempt-${randomUUID()}`),
        taskId,
        generation: nextGeneration(team, taskId),
        memberSessionId,
        phase: 'reserved',
        assignmentPhase: 'reserved',
        dispatchEpochs: [],
        evidence: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const reservedTask: TeamTask = {
        ...task,
        revision: task.revision + 1,
        status: 'in_progress',
        ownerSessionId: memberSessionId,
        currentAttemptId: attempt.id,
        updatedAt: timestamp,
      }
      const starting: TeamMemberV2 = {
        ...member,
        phase: 'starting',
        startingAttemptId: attempt.id,
        initialPromptDigest: requireDigest(initialPromptDigest, 'initial prompt digest'),
      }
      replaceTask(team, reservedTask)
      replaceMember(team, starting)
      team.attempts.push(attempt)
      Object.assign(team, { budget: { ...team.budget, usedRequests: team.budget.usedRequests + 1 } })
      result = { task: reservedTask, member: starting, attempt }
    })
    return structuredClone(result)
  }

  async settleInitialAssignment(
    scope: TeamScope,
    teamId: TeamId,
    memberSessionId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    checkpoint: InitialDispatchCheckpoint,
  ): Promise<{ member: TeamMemberV2; attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }> {
    let result!: { member: TeamMemberV2; attempt: TaskAttemptV2; dispatch: ModelDispatchEpoch }
    await this.store.transact(scope, teamId, team => {
      const member = memberOf(team, memberSessionId)
      const task = taskOf(team, taskId)
      const attempt = attemptOf(team, attemptId)
      const existing = attempt.dispatchEpochs[0]
      if (member.phase === 'active' && attempt.assignmentPhase === 'delivered' && existing !== undefined) {
        if (existing.dispatchId !== checkpoint.dispatchId || existing.effectId !== checkpoint.effectId
          || existing.turn !== checkpoint.turn || existing.step !== checkpoint.step
          || existing.messageSeq !== checkpoint.messageSeq
          || member.initialPromptDigest !== checkpoint.initialPromptDigest) {
          throw new TeamDomainError('initial assignment checkpoint conflicts with the committed tuple', 'TEAM_ATTEMPT_STALE')
        }
        result = { member, attempt, dispatch: existing }
        return
      }
      if (member.phase !== 'starting' || member.startingAttemptId !== attemptId
        || task.status !== 'in_progress' || task.currentAttemptId !== attemptId
        || task.ownerSessionId !== memberSessionId || attempt.memberSessionId !== memberSessionId
        || attempt.phase !== 'reserved' || attempt.assignmentPhase !== 'reserved'
        || attempt.dispatchEpochs.length !== 0 || member.initialPromptDigest !== checkpoint.initialPromptDigest) {
        throw new TeamDomainError('initial assignment tuple is stale', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const dispatch: ModelDispatchEpoch = {
        dispatchId: DispatchId(requireText(checkpoint.dispatchId, 'dispatch id', 256)),
        kind: 'initial',
        ordinal: 1,
        effectId: TeamEffectId(requireText(checkpoint.effectId, 'dispatch effect id', 256)),
        targetSessionId: memberSessionId,
        turn: checkpoint.turn,
        step: checkpoint.step,
        messageSeq: checkpoint.messageSeq,
        witnessCapabilityDigest: requireDigest(checkpoint.witnessCapabilityDigest, 'witness capability digest'),
        phase: 'dispatch-pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const { startingAttemptId: _startingAttemptId, ...withoutStarting } = member
      void _startingAttemptId
      const active: TeamMemberV2 = {
        ...withoutStarting,
        phase: 'active',
        initialMessageSeq: checkpoint.messageSeq,
        activatedAt: timestamp,
      }
      const delivered: TaskAttemptV2 = {
        ...attempt,
        assignmentPhase: 'delivered',
        assignmentDeliveredAt: timestamp,
        dispatchEpochs: [dispatch],
        updatedAt: timestamp,
      }
      replaceMember(team, active)
      replaceAttempt(team, delivered)
      result = { member: active, attempt: delivered, dispatch }
    })
    return structuredClone(result)
  }

  async failInitialAssignment(
    scope: TeamScope,
    teamId: TeamId,
    memberSessionId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    diagnostic: string,
  ): Promise<{ member: TeamMemberV2; task: TeamTask; attempt: TaskAttemptV2 }> {
    let result!: { member: TeamMemberV2; task: TeamTask; attempt: TaskAttemptV2 }
    await this.store.transact(scope, teamId, team => {
      const member = memberOf(team, memberSessionId)
      const task = taskOf(team, taskId)
      const attempt = attemptOf(team, attemptId)
      const reason = requireText(diagnostic, 'initial assignment diagnostic', 8_192)
      if (member.phase === 'failed' && attempt.phase === 'cancelled' && task.status === 'pending') {
        result = { member, task, attempt }
        return
      }
      if (member.phase !== 'starting' || member.startingAttemptId !== attemptId
        || task.status !== 'in_progress' || task.currentAttemptId !== attemptId
        || task.ownerSessionId !== memberSessionId || attempt.memberSessionId !== memberSessionId
        || attempt.phase !== 'reserved') {
        throw new TeamDomainError('initial assignment tuple is stale', 'TEAM_ATTEMPT_STALE')
      }
      const timestamp = this.now()
      const { startingAttemptId: _startingAttemptId, ...withoutStarting } = member
      const failed: TeamMemberV2 = { ...withoutStarting, phase: 'failed', error: reason }
      const cancelled: TaskAttemptV2 = { ...attempt, phase: 'cancelled', diagnostic: reason, updatedAt: timestamp }
      const { ownerSessionId: _owner, currentAttemptId: _attempt, targetMemberSessionId: _target, ...released } = task
      void _startingAttemptId; void _owner; void _attempt; void _target
      const pending: TeamTask = { ...released, revision: task.revision + 1, status: 'pending', updatedAt: timestamp }
      replaceMember(team, failed)
      replaceAttempt(team, cancelled)
      replaceTask(team, pending)
      result = { member: failed, task: pending, attempt: cancelled }
    })
    return structuredClone(result)
  }
}
