/**
 * Task board transitions of the Team protocol core.
 *
 * Owns task creation with dependency-graph admission, claiming under
 * revision CAS with a fresh fenced attempt, assignment-delivery
 * checkpoints, worker submission, the captain review gate and
 * reassignment/cancellation of open attempts. Task metadata CAS
 * (`revision`) and execution generation (`attemptId`) stay distinct
 * mechanisms, as in the port contract.
 */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { assertTaskGraph, isTaskReady } from './graph.js'
import { budgetAvailable } from './team-domain-budget.js'
import {
  actorMembership,
  attemptOf,
  clearTaskExecution,
  nonEmpty,
  replaceAttempt,
  replaceTask,
  type TeamDomainDeps,
} from './team-domain-shared.js'
import { AttemptId, TaskId, type TaskAttempt, type TeamId, type TeamState, type TeamTask } from './types.js'
import type { CreateTaskInput, TeamScope } from './team-domain-port.js'

function taskOf(team: TeamState, id: TaskId): TeamTask {
  const task = team.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new TeamDomainError(`task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
  return task
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

export async function createTask(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  actorSessionId: string,
  input: CreateTaskInput,
): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    actorMembership(team, actorSessionId)
    expectDomain(team.tasks.length < deps.limits.maxTasks, 'team task limit reached', 'TEAM_TASK_LIMIT')
    const blockedBy = [...(input.blockedBy ?? [])]
    expectDomain(blockedBy.length <= deps.limits.maxDependencies, 'task dependency limit reached', 'TEAM_TASK_DEPENDENCY_LIMIT')
    expectDomain(Number.isSafeInteger(input.priority ?? 0), 'task priority must be a safe integer', 'TEAM_INPUT_INVALID')
    const timestamp = deps.now()
    committed = {
      id: TaskId(`task-${team.nextTaskNumber}`),
      revision: 1,
      subject: nonEmpty(input.subject, 'task subject', 512),
      description: nonEmpty(input.description, 'task description', deps.limits.maxTaskBytes),
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

export async function claimTask(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  actorSessionId: string,
  taskId: TaskId,
  expectedRevision: number,
  assigneeSessionId: string,
): Promise<{ task: TeamTask; attempt: TaskAttempt }> {
  let committedTask!: TeamTask
  let committedAttempt!: TaskAttempt
  await deps.store.transact(scope, teamId, team => {
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
    budgetAvailable(team.budget, deps.now())
    const timestamp = deps.now()
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

export async function acknowledgeAssignment(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  taskId: TaskId,
  expectedRevision: number,
  attemptId: AttemptId,
): Promise<TaskAttempt> {
  let committed!: TaskAttempt
  await deps.store.transact(scope, teamId, team => {
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
      assignmentDeliveredAt: deps.now(),
      updatedAt: deps.now(),
    }
    replaceAttempt(team, committed)
  })
  return structuredClone(committed)
}

export async function submitTask(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  actorSessionId: string,
  taskId: TaskId,
  expectedRevision: number,
  attemptId: AttemptId,
  output: string,
  evidence: readonly string[],
): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    actorMembership(team, actorSessionId)
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    assertCurrentAttempt(current, attemptId)
    expectDomain(current.ownerSessionId === actorSessionId, 'only the current owner can submit', 'TEAM_TASK_OWNER_REQUIRED')
    const attempt = attemptOf(team, attemptId)
    expectDomain(attempt.phase === 'running', 'attempt is not running', 'TEAM_ATTEMPT_PHASE_INVALID')
    const timestamp = deps.now()
    const normalizedOutput = nonEmpty(output, 'task output', deps.limits.maxTaskBytes)
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

export async function reviewTask(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  taskId: TaskId,
  expectedRevision: number,
  attemptId: AttemptId,
  decision: 'accept' | 'reject',
  diagnostic: string | undefined,
): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can review', 'TEAM_CAPTAIN_REQUIRED')
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    assertCurrentAttempt(current, attemptId)
    expectDomain(current.status === 'submitted' || current.status === 'verifying', 'task is not submitted for review', 'TEAM_REVIEW_NOT_READY')
    const attempt = attemptOf(team, attemptId)
    const timestamp = deps.now()
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

export async function cancelAttempt(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  taskId: TaskId,
  expectedRevision: number,
  diagnostic: string,
): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can reassign', 'TEAM_CAPTAIN_REQUIRED')
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    expectDomain(
      ['in_progress', 'submitted', 'verifying'].includes(current.status) && current.currentAttemptId !== undefined,
      'only an open execution attempt can be reassigned',
      'TEAM_TASK_NOT_REASSIGNABLE',
    )
    const timestamp = deps.now()
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
