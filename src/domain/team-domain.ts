import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { expectDomain, TeamDomainError } from './error.js'
import { assertTaskGraph, isTaskReady } from './graph.js'
import {
  AttemptId,
  TaskId,
  TeamId,
  TeamMessageId,
  type TaskAttempt,
  type TeamBudget,
  type TeamLimits,
  type TeamMember,
  type TeamMembership,
  type TeamMemoryCategory,
  type TeamMessageDelivery,
  type TeamState,
  type TeamStatusSnapshot,
  type TeamTask,
} from './types.js'
import type { CreateTaskInput, TeamAggregateStore, TeamDomainPort, TeamScope } from './team-domain-port.js'

export const DEFAULT_TEAM_LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessages: 1_024,
  maxMessageBytes: 65_536,
  maxTaskBytes: 65_536,
  maxDependencies: 64,
  maxMemories: 512,
}

function nonEmpty(value: string, label: string, max = 512): string {
  const normalized = value.trim()
  expectDomain(normalized !== '', `${label} must not be empty`, 'TEAM_INPUT_INVALID')
  expectDomain(Buffer.byteLength(normalized, 'utf8') <= max, `${label} is too large`, 'TEAM_INPUT_LIMIT')
  return normalized
}

function memberName(value: string): string {
  const normalized = value.trim().toLowerCase()
  expectDomain(/^[a-z][a-z0-9-]{0,63}$/.test(normalized), 'member name must be lowercase kebab-case', 'TEAM_MEMBER_NAME_INVALID')
  expectDomain(normalized !== 'captain', 'member name "captain" is reserved', 'TEAM_MEMBER_NAME_RESERVED')
  return normalized
}

function taskOf(team: TeamState, id: TaskId): TeamTask {
  const task = team.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new TeamDomainError(`task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
  return task
}

function attemptOf(team: TeamState, id: AttemptId): TaskAttempt {
  const attempt = team.attempts.find(candidate => candidate.id === id)
  if (attempt === undefined) throw new TeamDomainError(`attempt "${id}" not found`, 'TEAM_ATTEMPT_NOT_FOUND')
  return attempt
}

function replaceTask(team: TeamState, next: TeamTask): void {
  const index = team.tasks.findIndex(candidate => candidate.id === next.id)
  team.tasks[index] = next
}

function replaceAttempt(team: TeamState, next: TaskAttempt): void {
  const index = team.attempts.findIndex(candidate => candidate.id === next.id)
  team.attempts[index] = next
}

function clearTaskExecution(task: TeamTask, next: Pick<TeamTask, 'revision' | 'status' | 'updatedAt'>): TeamTask {
  const { ownerSessionId: _owner, currentAttemptId: _attempt, output: _output, ...stable } = task
  return { ...stable, ...next }
}

function taskRevision(task: TeamTask, expected: number): void {
  if (task.revision !== expected) {
    throw new TeamDomainError(
      `stale task revision ${expected}; current revision is ${task.revision}`,
      'TEAM_TASK_STALE_REVISION',
    )
  }
}

function assertCurrentAttempt(task: TeamTask, attemptId: AttemptId): void {
  if (task.currentAttemptId !== attemptId) {
    throw new TeamDomainError(`attempt "${attemptId}" is stale`, 'TEAM_ATTEMPT_STALE')
  }
}

function actorMembership(team: TeamState, sessionId: string): TeamMembership {
  if (team.phase !== 'active') throw new TeamDomainError('Team is archived', 'TEAM_ARCHIVED')
  if (team.captainSessionId === sessionId) return { team, role: 'captain', name: 'captain' }
  const member = team.members.find(candidate => candidate.sessionId === sessionId && candidate.phase === 'active')
  if (member === undefined) throw new TeamDomainError('caller is not an active Team participant', 'TEAM_UNAUTHORIZED')
  return { team, role: 'member', name: member.name }
}

function budgetAvailable(budget: TeamBudget, now: number): void {
  if (budget.deadlineAt !== undefined && now >= budget.deadlineAt) {
    throw new TeamDomainError('team deadline has expired', 'TEAM_BUDGET_DEADLINE')
  }
  if (budget.requestLimit !== undefined && budget.usedRequests >= budget.requestLimit) {
    throw new TeamDomainError('team request budget exhausted', 'TEAM_BUDGET_REQUESTS')
  }
  if (budget.tokenLimit !== undefined && budget.usedTokens >= budget.tokenLimit) {
    throw new TeamDomainError('team token budget exhausted', 'TEAM_BUDGET_TOKENS')
  }
  if (budget.retryLimit !== undefined && budget.usedRetries >= budget.retryLimit) {
    throw new TeamDomainError('team retry budget exhausted', 'TEAM_BUDGET_RETRIES')
  }
}

/** Framework-neutral Team protocol used by the DSH tool and scheduler consumers. */
export class TeamDomain implements TeamDomainPort {
  constructor(
    private readonly store: TeamAggregateStore,
    private readonly limits: TeamLimits = DEFAULT_TEAM_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      expectDomain(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
    }
  }

  async createTeam(
    scope: TeamScope,
    captainSessionId: string,
    name: string,
    description: string,
    captainUsageSeq = -1,
  ): Promise<TeamState> {
    expectDomain(Number.isSafeInteger(captainUsageSeq) && captainUsageSeq >= -1, 'captain usage seq is invalid', 'TEAM_INPUT_INVALID')
    const timestamp = this.now()
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
    await this.store.createUniqueForCaptain(scope, team)
    return structuredClone(team)
  }

  async findMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
    for (const team of await this.store.list(scope)) {
      if (team.phase !== 'active') continue
      if (team.captainSessionId === sessionId) return { team, role: 'captain', name: 'captain' }
      const member = team.members.find(candidate => candidate.sessionId === sessionId && candidate.phase === 'active')
      if (member !== undefined) return { team, role: 'member', name: member.name }
    }
    return undefined
  }

  async requireMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership> {
    const membership = await this.findMembership(scope, sessionId)
    if (membership === undefined) throw new TeamDomainError('caller does not belong to an active team', 'TEAM_NOT_JOINED')
    return membership
  }

  async provisionMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: { name: string; role: string; sessionId: string; provider: string },
  ): Promise<TeamMember> {
    let committed!: TeamMember
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, captainSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can add members', 'TEAM_CAPTAIN_REQUIRED')
      const occupiedMembers = team.members.filter(candidate => candidate.phase === 'active' || candidate.phase === 'provisioning')
      expectDomain(occupiedMembers.length < this.limits.maxMembers, 'team member limit reached', 'TEAM_MEMBER_LIMIT')
      const name = memberName(input.name)
      expectDomain(!occupiedMembers.some(candidate => candidate.name === name), `active member name "${name}" is already in use`, 'TEAM_MEMBER_NAME_REUSED')
      const timestamp = this.now()
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

  async settleMember(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    outcome: { active: true } | { active: false; error: string },
  ): Promise<TeamMember> {
    let committed!: TeamMember
    await this.store.transact(scope, teamId, team => {
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

  async recoverProvisioningMembers(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    diagnostic: string,
  ): Promise<TeamMember[]> {
    const recovered: TeamMember[] = []
    await this.store.transact(scope, teamId, team => {
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

  async removeMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    name: string,
    diagnostic: string,
  ): Promise<{ member: TeamMember; requeuedTaskIds: TaskId[] }> {
    let committedMember!: TeamMember
    const requeuedTaskIds: TaskId[] = []
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, captainSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can remove members', 'TEAM_CAPTAIN_REQUIRED')
      const normalizedName = memberName(name)
      const index = team.members.findIndex(member => member.name === normalizedName && member.phase === 'active')
      expectDomain(index >= 0, `active member "${normalizedName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
      const current = team.members[index]!
      const timestamp = this.now()
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

  async archiveTeam(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    diagnostic: string,
  ): Promise<TeamState> {
    let committed!: TeamState
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, captainSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can archive the Team', 'TEAM_CAPTAIN_REQUIRED')
      const timestamp = this.now()
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

  async createTask(scope: TeamScope, teamId: TeamId, actorSessionId: string, input: CreateTaskInput): Promise<TeamTask> {
    let committed!: TeamTask
    await this.store.transact(scope, teamId, team => {
      actorMembership(team, actorSessionId)
      expectDomain(team.tasks.length < this.limits.maxTasks, 'team task limit reached', 'TEAM_TASK_LIMIT')
      const blockedBy = [...(input.blockedBy ?? [])]
      expectDomain(blockedBy.length <= this.limits.maxDependencies, 'task dependency limit reached', 'TEAM_TASK_DEPENDENCY_LIMIT')
      expectDomain(Number.isSafeInteger(input.priority ?? 0), 'task priority must be a safe integer', 'TEAM_INPUT_INVALID')
      const timestamp = this.now()
      committed = {
        id: TaskId(`task-${team.nextTaskNumber}`),
        revision: 1,
        subject: nonEmpty(input.subject, 'task subject', 512),
        description: nonEmpty(input.description, 'task description', this.limits.maxTaskBytes),
        acceptanceCriteria: [...(input.acceptanceCriteria ?? [])].map(value => nonEmpty(value, 'acceptance criterion', 2_048)),
        status: 'pending',
        blockedBy,
        writeScopes: [...(input.writeScopes ?? [])].map(value => nonEmpty(value, 'write scope', 1_024)),
        priority: input.priority ?? 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      assertTaskGraph([...team.tasks, committed])
      team.tasks.push(committed)
      Object.assign(team, { nextTaskNumber: team.nextTaskNumber + 1 })
    })
    return structuredClone(committed)
  }

  async claimTask(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    assigneeSessionId = actorSessionId,
  ): Promise<{ task: TeamTask; attempt: TaskAttempt }> {
    let committedTask!: TeamTask
    let committedAttempt!: TaskAttempt
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, actorSessionId)
      const assignee = actorMembership(team, assigneeSessionId)
      if (actorSessionId !== assigneeSessionId) {
        expectDomain(authority.role === 'captain', 'only the captain can assign another member', 'TEAM_CAPTAIN_REQUIRED')
        expectDomain(assignee.role === 'member', 'captain cannot be a scheduler target', 'TEAM_ASSIGNEE_INVALID')
      }
      const current = taskOf(team, taskId)
      taskRevision(current, expectedRevision)
      expectDomain(isTaskReady(team.tasks, current), `task "${taskId}" is not ready`, 'TEAM_TASK_NOT_READY')
      expectDomain(!team.tasks.some(task => task.ownerSessionId === assigneeSessionId && ['in_progress', 'submitted', 'verifying'].includes(task.status)), 'assignee already owns open work', 'TEAM_MEMBER_BUSY')
      budgetAvailable(team.budget, this.now())
      const timestamp = this.now()
      const generation = team.attempts.filter(attempt => attempt.taskId === taskId).length + 1
      committedAttempt = {
        id: AttemptId(`attempt-${randomUUID()}`),
        taskId,
        generation,
        memberSessionId: assigneeSessionId,
        phase: 'running',
        assignmentPhase: 'reserved',
        evidence: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      committedTask = {
        ...current,
        revision: current.revision + 1,
        status: 'in_progress',
        ownerSessionId: assigneeSessionId,
        currentAttemptId: committedAttempt.id,
        updatedAt: timestamp,
      }
      replaceTask(team, committedTask)
      team.attempts.push(committedAttempt)
      Object.assign(team, { budget: { ...team.budget, usedRequests: team.budget.usedRequests + 1 } })
    })
    return { task: structuredClone(committedTask), attempt: structuredClone(committedAttempt) }
  }

  async acknowledgeAssignment(
    scope: TeamScope,
    teamId: TeamId,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
  ): Promise<TaskAttempt> {
    let committed!: TaskAttempt
    await this.store.transact(scope, teamId, team => {
      const current = taskOf(team, taskId)
      taskRevision(current, expectedRevision)
      assertCurrentAttempt(current, attemptId)
      const attempt = attemptOf(team, attemptId)
      expectDomain(attempt.phase === 'running', 'attempt is not running', 'TEAM_ATTEMPT_PHASE_INVALID')
      if (attempt.assignmentPhase === 'delivered') {
        committed = attempt
        return
      }
      committed = {
        ...attempt,
        assignmentPhase: 'delivered',
        assignmentDeliveredAt: this.now(),
        updatedAt: this.now(),
      }
      replaceAttempt(team, committed)
    })
    return structuredClone(committed)
  }

  async submitTask(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
    output: string,
    evidence: readonly string[] = [],
  ): Promise<TeamTask> {
    let committed!: TeamTask
    await this.store.transact(scope, teamId, team => {
      actorMembership(team, actorSessionId)
      const current = taskOf(team, taskId)
      taskRevision(current, expectedRevision)
      assertCurrentAttempt(current, attemptId)
      expectDomain(current.ownerSessionId === actorSessionId, 'only the current owner can submit', 'TEAM_TASK_OWNER_REQUIRED')
      const attempt = attemptOf(team, attemptId)
      expectDomain(attempt.phase === 'running', 'attempt is not running', 'TEAM_ATTEMPT_PHASE_INVALID')
      const timestamp = this.now()
      const normalizedOutput = nonEmpty(output, 'task output', this.limits.maxTaskBytes)
      replaceAttempt(team, {
        ...attempt,
        phase: 'submitted',
        output: normalizedOutput,
        evidence: [...evidence].map(value => nonEmpty(value, 'evidence reference', 2_048)),
        updatedAt: timestamp,
      })
      committed = {
        ...current,
        revision: current.revision + 1,
        status: 'submitted',
        output: normalizedOutput,
        updatedAt: timestamp,
      }
      replaceTask(team, committed)
    })
    return structuredClone(committed)
  }

  async reviewTask(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
    decision: 'accept' | 'reject',
    diagnostic?: string,
  ): Promise<TeamTask> {
    let committed!: TeamTask
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, captainSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can review', 'TEAM_CAPTAIN_REQUIRED')
      const current = taskOf(team, taskId)
      taskRevision(current, expectedRevision)
      assertCurrentAttempt(current, attemptId)
      expectDomain(current.status === 'submitted' || current.status === 'verifying', 'task is not submitted for review', 'TEAM_REVIEW_NOT_READY')
      const attempt = attemptOf(team, attemptId)
      const timestamp = this.now()
      const normalizedDiagnostic = diagnostic === undefined ? undefined : nonEmpty(diagnostic, 'review diagnostic', 8_192)
      replaceAttempt(team, {
        ...attempt,
        phase: decision === 'accept' ? 'accepted' : 'rejected',
        ...(normalizedDiagnostic === undefined ? {} : { diagnostic: normalizedDiagnostic }),
        updatedAt: timestamp,
      })
      committed = decision === 'accept'
        ? { ...current, revision: current.revision + 1, status: 'completed', updatedAt: timestamp }
        : clearTaskExecution(current, {
            revision: current.revision + 1,
            status: 'pending',
            updatedAt: timestamp,
          })
      replaceTask(team, committed)
      if (decision === 'reject') {
        Object.assign(team, { budget: { ...team.budget, usedRetries: team.budget.usedRetries + 1 } })
      }
    })
    return structuredClone(committed)
  }

  async cancelAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    diagnostic: string,
  ): Promise<TeamTask> {
    let committed!: TeamTask
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, captainSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can reassign', 'TEAM_CAPTAIN_REQUIRED')
      const current = taskOf(team, taskId)
      taskRevision(current, expectedRevision)
      expectDomain(
        ['in_progress', 'submitted', 'verifying'].includes(current.status) && current.currentAttemptId !== undefined,
        'only an open execution attempt can be reassigned',
        'TEAM_TASK_NOT_REASSIGNABLE',
      )
      const timestamp = this.now()
      if (current.currentAttemptId !== undefined) {
        const attempt = attemptOf(team, current.currentAttemptId)
        replaceAttempt(team, {
          ...attempt,
          phase: 'stale',
          diagnostic: nonEmpty(diagnostic, 'reassignment diagnostic', 8_192),
          updatedAt: timestamp,
        })
      }
      committed = clearTaskExecution(current, {
        revision: current.revision + 1,
        status: 'pending',
        updatedAt: timestamp,
      })
      replaceTask(team, committed)
    })
    return structuredClone(committed)
  }

  async queueMessage(
    scope: TeamScope,
    teamId: TeamId,
    senderSessionId: string,
    targetName: string,
    content: string,
    delivery: TeamMessageDelivery,
  ): Promise<TeamState['messages'][number]> {
    let committed!: TeamState['messages'][number]
    await this.store.transact(scope, teamId, team => {
      const sender = actorMembership(team, senderSessionId)
      expectDomain(team.messages.length < this.limits.maxMessages, 'team message limit reached', 'TEAM_MESSAGE_LIMIT')
      const normalizedTarget = targetName.trim().toLowerCase()
      const targetSessionId = normalizedTarget === 'captain'
        ? team.captainSessionId
        : team.members.find(member => member.name === normalizedTarget && member.phase === 'active')?.sessionId
      expectDomain(targetSessionId !== undefined, `target "${targetName}" is not active`, 'TEAM_MESSAGE_TARGET_INVALID')
      const normalizedContent = nonEmpty(content, 'message', this.limits.maxMessageBytes)
      const timestamp = this.now()
      committed = {
        id: TeamMessageId(`message-${randomUUID()}`),
        senderSessionId,
        senderName: sender.name,
        targetSessionId,
        targetName: normalizedTarget,
        content: normalizedContent,
        delivery,
        phase: 'queued',
        createdAt: timestamp,
      }
      expectDomain(
        Buffer.byteLength(JSON.stringify(committed), 'utf8') <= this.limits.maxMessageBytes,
        'complete message frame is too large',
        'TEAM_INPUT_LIMIT',
      )
      team.messages.push(committed)
    })
    return structuredClone(committed)
  }

  async acknowledgeMessage(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId): Promise<TeamState['messages'][number]> {
    let committed!: TeamState['messages'][number]
    await this.store.transact(scope, teamId, team => {
      const index = team.messages.findIndex(message => message.id === messageId)
      expectDomain(index >= 0, `message "${messageId}" not found`, 'TEAM_MESSAGE_NOT_FOUND')
      const current = team.messages[index]!
      if (current.phase === 'delivered') {
        committed = current
        return
      }
      expectDomain(current.phase === 'queued', 'only queued mail can be acknowledged', 'TEAM_MESSAGE_PHASE_INVALID')
      committed = { ...current, phase: 'delivered', deliveredAt: this.now() }
      team.messages[index] = committed
    })
    return structuredClone(committed)
  }

  async setBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    limits: Pick<TeamBudget, 'tokenLimit' | 'requestLimit' | 'retryLimit' | 'deadlineAt'>,
  ): Promise<TeamBudget> {
    let committed!: TeamBudget
    await this.store.transact(scope, teamId, team => {
      const authority = actorMembership(team, captainSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can configure budget', 'TEAM_CAPTAIN_REQUIRED')
      for (const [name, value] of Object.entries(limits)) {
        if (value !== undefined) expectDomain(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`, 'TEAM_BUDGET_INVALID')
      }
      if (limits.tokenLimit !== undefined) expectDomain(limits.tokenLimit >= team.budget.usedTokens, 'tokenLimit is below current usage', 'TEAM_BUDGET_INVALID')
      if (limits.requestLimit !== undefined) expectDomain(limits.requestLimit >= team.budget.usedRequests, 'requestLimit is below current usage', 'TEAM_BUDGET_INVALID')
      if (limits.retryLimit !== undefined) expectDomain(limits.retryLimit >= team.budget.usedRetries, 'retryLimit is below current usage', 'TEAM_BUDGET_INVALID')
      committed = { ...team.budget, ...limits }
      Object.assign(team, { budget: committed })
    })
    return structuredClone(committed)
  }

  async consumeTokens(scope: TeamScope, teamId: TeamId, tokens: number): Promise<TeamBudget> {
    let committed!: TeamBudget
    await this.store.transact(scope, teamId, team => {
      expectDomain(Number.isSafeInteger(tokens) && tokens >= 0, 'tokens must be a non-negative safe integer', 'TEAM_BUDGET_INVALID')
      const next = team.budget.usedTokens + tokens
      expectDomain(team.budget.tokenLimit === undefined || next <= team.budget.tokenLimit, 'team token budget exceeded', 'TEAM_BUDGET_TOKENS')
      committed = { ...team.budget, usedTokens: next }
      Object.assign(team, { budget: committed })
    })
    return structuredClone(committed)
  }

  async recordSessionUsage(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    eventSeq: number,
    tokens: number,
  ): Promise<TeamBudget> {
    let committed!: TeamBudget
    await this.store.transact(scope, teamId, team => {
      expectDomain(Number.isSafeInteger(eventSeq) && eventSeq >= 0, 'event seq must be a non-negative safe integer', 'TEAM_BUDGET_INVALID')
      expectDomain(Number.isSafeInteger(tokens) && tokens >= 0, 'tokens must be a non-negative safe integer', 'TEAM_BUDGET_INVALID')
      const known = team.captainSessionId === sessionId || team.members.some(member => member.sessionId === sessionId)
      expectDomain(known, 'usage session is not a Team participant', 'TEAM_UNAUTHORIZED')
      const previous = team.usageCursors[sessionId] ?? -1
      if (eventSeq <= previous) {
        committed = team.budget
        return
      }
      committed = { ...team.budget, usedTokens: team.budget.usedTokens + tokens }
      Object.assign(team, {
        budget: committed,
        usageCursors: { ...team.usageCursors, [sessionId]: eventSeq },
      })
    })
    return structuredClone(committed)
  }

  async addMemory(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    category: TeamMemoryCategory,
    content: string,
    evidenceRefs: readonly string[],
  ): Promise<TeamState['memory'][number]> {
    let committed!: TeamState['memory'][number]
    await this.store.transact(scope, teamId, team => {
      actorMembership(team, actorSessionId)
      expectDomain(team.memory.length < this.limits.maxMemories, 'team memory limit reached', 'TEAM_MEMORY_LIMIT')
      committed = {
        id: `memory-${team.nextMemoryNumber}`,
        category,
        content: nonEmpty(content, 'memory content', 16_384),
        evidenceRefs: [...evidenceRefs].map(value => nonEmpty(value, 'memory evidence reference', 2_048)),
        createdAt: this.now(),
      }
      team.memory.push(committed)
      Object.assign(team, { nextMemoryNumber: team.nextMemoryNumber + 1 })
    })
    return structuredClone(committed)
  }

  /** One authoritative aggregate plus its derived readiness/mailbox projections. */
  private statusOf(team: TeamState): TeamStatusSnapshot {
    return {
      team,
      readyTaskIds: team.tasks.filter(task => isTaskReady(team.tasks, task)).map(task => task.id),
      pendingMessageIds: team.messages.filter(message => message.phase === 'queued').map(message => message.id),
    }
  }

  async snapshot(scope: TeamScope, teamId: TeamId, actorSessionId: string): Promise<TeamStatusSnapshot> {
    const team = await this.store.read(scope, teamId)
    if (team === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
    actorMembership(team, actorSessionId)
    return this.statusOf(team)
  }

  async waitForChange(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    afterRevision: number,
    signal: AbortSignal,
  ): Promise<TeamStatusSnapshot> {
    expectDomain(Number.isSafeInteger(afterRevision) && afterRevision >= 0, 'afterRevision must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
    const before = await this.store.read(scope, teamId)
    if (before === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
    actorMembership(before, actorSessionId)
    const team = await this.store.waitForChange(scope, teamId, afterRevision, signal)
    actorMembership(team, actorSessionId)
    return this.statusOf(team)
  }
}
