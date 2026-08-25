/**
 * Task board transitions of the Team protocol core.
 *
 * Owns task creation with dependency-graph admission, claiming under
 * revision CAS with a fresh fenced attempt, attempt-fenced
 * assignment-delivery checkpoints, worker submission, the captain
 * review gate and reassignment/cancellation of open attempts. Task
 * metadata CAS (`revision`) and execution generation (`attemptId`)
 * stay distinct mechanisms, as in the port contract.
 *
 * Retained attempt history is bounded per task (M1B/F7): terminal
 * transitions prune the oldest terminal attempts beyond the newest
 * `maxRetainedAttempts` of their task inside the same transaction. The
 * fencing basis never depends on the pruned array: worker updates are
 * validated against the task's `currentAttemptId` (never pruned), and
 * new generations are allocated from a watermark derived from the
 * retained maximum generation, so a pruned id can never become valid
 * again.
 */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { assertTaskGraph, isTaskReady } from './graph.js'
import { budgetAvailable, outstandingReservationTokens, reservationAdmissible } from './team-domain-budget.js'
import {
  actorMembership,
  attemptOf,
  clearTaskExecution,
  nonEmpty,
  replaceAttempt,
  replaceTask,
  type TeamDomainDeps,
} from './team-domain-shared.js'
import { AttemptId, TaskId, type ReviewVerificationCommand, type TaskAttempt, type TeamId, type TeamMember, type TeamState, type TeamTask } from './types.js'
import type { CreateTaskInput, TeamScope } from './team-domain-port.js'

const TERMINAL_ATTEMPT_PHASES = new Set(['accepted', 'rejected', 'cancelled', 'stale'])

/**
 * Normalize one captain-declared verification list (M3-2): bounded count,
 * non-empty bounded command text, per-command timeout within the deployment
 * ceiling. A stored list is always a private deep copy of the caller's.
 */
function normalizeVerification(
  verification: readonly ReviewVerificationCommand[],
  limits: { readonly maxVerificationCommands: number; readonly maxVerificationCommandMs: number },
): ReviewVerificationCommand[] {
  expectDomain(verification.length <= limits.maxVerificationCommands, 'task verification command limit reached', 'TEAM_TASK_VERIFICATION_LIMIT')
  return verification.map(entry => {
    const command = nonEmpty(entry.command, 'verification command', 2_048)
    if (entry.timeoutMs === undefined) return { command }
    expectDomain(
      Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs >= 1 && entry.timeoutMs <= limits.maxVerificationCommandMs,
      'verification command timeout must be a safe integer between 1 and the deployment ceiling',
      'TEAM_INPUT_INVALID',
    )
    return { command, timeoutMs: entry.timeoutMs }
  })
}

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

/**
 * Fence one open attempt stale with the caller's diagnostic inside the
 * running transaction — the one shape `cancelAttempt` and the in-place
 * `retryAttempt` (issue #83) share.
 */
function fenceAttemptStale(team: TeamState, attemptId: AttemptId, diagnostic: string, timestamp: number): void {
  const attempt = attemptOf(team, attemptId)
  replaceAttempt(team, {
    ...attempt,
    phase: 'stale',
    diagnostic: nonEmpty(diagnostic, 'reassignment diagnostic', 8_192),
    updatedAt: timestamp,
  })
}

/**
 * Generation watermark of one task: strictly above every generation that
 * was ever allocated, including generations whose attempts were pruned.
 * Because pruning only ever removes the oldest terminal attempts of a
 * task, the retained maximum is always the historical maximum, so the
 * watermark stays monotonic without a persisted counter.
 */
function nextAttemptGeneration(team: TeamState, taskId: TaskId): number {
  let watermark = 0
  for (const attempt of team.attempts) {
    if (attempt.taskId === taskId && attempt.generation > watermark) watermark = attempt.generation
  }
  return watermark + 1
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
    if (input.reservationTokens !== undefined) {
      expectDomain(
        Number.isSafeInteger(input.reservationTokens) && input.reservationTokens > 0,
        'reservationTokens must be a positive safe integer',
        'TEAM_BUDGET_INVALID',
      )
    }
    if (input.targetMemberSessionId !== undefined) {
      const authority = actorMembership(team, actorSessionId)
      expectDomain(authority.role === 'captain', 'only the captain can target another member', 'TEAM_CAPTAIN_REQUIRED')
      const target = team.members.find(member => member.sessionId === input.targetMemberSessionId
        && (member.phase === 'provisioning' || member.phase === 'active'))
      expectDomain(target !== undefined, 'task assignment target is not an available Team member', 'TEAM_ASSIGNEE_INVALID')
    }
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
      ...(input.verification === undefined ? {} : { verification: normalizeVerification(input.verification, deps.limits) }),
      ...(input.reservationTokens === undefined ? {} : { reservationTokens: input.reservationTokens }),
      ...(input.targetMemberSessionId === undefined ? {} : { targetMemberSessionId: input.targetMemberSessionId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    assertTaskGraph([...team.tasks, committed])
    team.tasks.push(committed)
    Object.assign(team, { nextTaskNumber: team.nextTaskNumber + 1 })
  })
  return structuredClone(committed)
}

/**
 * Seat one fresh reserved attempt as its task's current execution and charge
 * the request against the budget — the shared commit step of `claimTask` and
 * the in-place `retryAttempt` (issue #83).
 */
function seatAttempt(team: TeamState, task: TeamTask, attempt: TaskAttempt): { task: TeamTask; attempt: TaskAttempt } {
  replaceTask(team, task)
  team.attempts.push(attempt)
  Object.assign(team, { budget: { ...team.budget, usedRequests: team.budget.usedRequests + 1 } })
  return { task: structuredClone(task), attempt: structuredClone(attempt) }
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
  let seated!: { task: TeamTask; attempt: TaskAttempt }
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, actorSessionId)
    if (actorSessionId !== assigneeSessionId) {
      expectDomain(authority.role === 'captain', 'only the captain can assign another member', 'TEAM_CAPTAIN_REQUIRED')
      const assignee = team.members.find(candidate =>
        candidate.sessionId === assigneeSessionId
        && (candidate.phase === 'provisioning' || candidate.phase === 'active'))
      expectDomain(assignee !== undefined, 'scheduler target is not an available Team member', 'TEAM_ASSIGNEE_INVALID')
    } else {
      actorMembership(team, assigneeSessionId)
    }
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    expectDomain(
      current.targetMemberSessionId === undefined || current.targetMemberSessionId === assigneeSessionId,
      `task "${taskId}" is assigned to another Team member`,
      'TEAM_TASK_ASSIGNEE_MISMATCH',
    )
    expectDomain(isTaskReady(team.tasks, current), `task "${taskId}" is not ready`, 'TEAM_TASK_NOT_READY')
    expectDomain(!team.tasks.some(task => task.ownerSessionId === assigneeSessionId && ['in_progress', 'submitted', 'verifying'].includes(task.status)), 'assignee already owns open work', 'TEAM_MEMBER_BUSY')
    budgetAvailable(team.budget, deps.now())
    // Reservation admission (M4-3, issue #129): the declared floor of this
    // claim plus the outstanding holds of the in_progress tasks must fit the
    // remaining budget. Deliberately NOT one of the BUDGET_EXHAUSTION_CODES:
    // headroom may free when an in_progress task settles, so this is
    // admission-postpone (the scheduler skips and retries the task next
    // pass), never budget exhaustion (which converges run-owned Teams).
    const floor = current.reservationTokens ?? 0
    if (!reservationAdmissible(team.budget, outstandingReservationTokens(team.tasks), floor)) {
      throw new TeamDomainError(
        `task "${taskId}" reservation of ${floor} tokens exceeds the remaining budget headroom`,
        'TEAM_BUDGET_RESERVATION',
      )
    }
    const timestamp = deps.now()
    const generation = nextAttemptGeneration(team, taskId)
    const attempt: TaskAttempt = {
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
    seated = seatAttempt(team, {
      ...current,
      revision: current.revision + 1,
      status: 'in_progress',
      ownerSessionId: assigneeSessionId,
      currentAttemptId: attempt.id,
      updatedAt: timestamp,
    }, attempt)
  })
  return seated
}

export async function acknowledgeAssignment(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  taskId: TaskId,
  attemptId: AttemptId,
): Promise<TaskAttempt> {
  let committed!: TaskAttempt
  await deps.store.transact(scope, teamId, team => {
    const current = taskOf(team, taskId)
    // Delivery is a property of the fenced attempt, not of the task
    // metadata revision (issue #45): the fencing check below already
    // rejects every acknowledgement whose generation lost a handoff, and
    // the running-phase check rejects every settled attempt. A task
    // revision CAS would additionally reject the checkpoint after any
    // concurrent task write that left this attempt current — stranding it
    // `reserved` and re-driving duplicate delivery — while protecting
    // nothing the two attempt checks do not already prove.
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

/** Atomically activate a declared member with its first claimed assignment. */
export async function activateInitialAssignment(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  memberSessionId: string,
  taskId: TaskId,
  attemptId: AttemptId,
): Promise<{ member: TeamMember; attempt: TaskAttempt }> {
  let committedMember!: TeamMember
  let committedAttempt!: TaskAttempt
  await deps.store.transact(scope, teamId, team => {
    const memberIndex = team.members.findIndex(candidate => candidate.sessionId === memberSessionId)
    expectDomain(memberIndex >= 0, 'declared member not found', 'TEAM_MEMBER_NOT_FOUND')
    const member = team.members[memberIndex]!
    const task = taskOf(team, taskId)
    assertCurrentAttempt(task, attemptId)
    const attempt = attemptOf(team, attemptId)
    expectDomain(
      task.ownerSessionId === memberSessionId && attempt.memberSessionId === memberSessionId,
      'initial assignment does not belong to the declared member',
      'TEAM_TASK_OWNER_REQUIRED',
    )
    expectDomain(attempt.phase === 'running', 'attempt is not running', 'TEAM_ATTEMPT_PHASE_INVALID')
    if (member.phase === 'active' && attempt.assignmentPhase === 'delivered') {
      committedMember = member
      committedAttempt = attempt
      return
    }
    expectDomain(member.phase === 'provisioning', 'member is not awaiting its initial assignment', 'TEAM_MEMBER_PHASE_INVALID')
    const timestamp = deps.now()
    committedMember = { ...member, phase: 'active' }
    committedAttempt = attempt.assignmentPhase === 'delivered'
      ? attempt
      : {
          ...attempt,
          assignmentPhase: 'delivered',
          assignmentDeliveredAt: timestamp,
          updatedAt: timestamp,
        }
    team.members[memberIndex] = committedMember
    replaceAttempt(team, committedAttempt)
  })
  return { member: structuredClone(committedMember), attempt: structuredClone(committedAttempt) }
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
    expectDomain(
      attempt.assignmentPhase === 'delivered',
      'task assignment has not reached the member model',
      'TEAM_ASSIGNMENT_NOT_DELIVERED',
    )
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
    pruneRetainedAttempts(team, deps.limits.maxRetainedAttempts)
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
  targetMemberSessionId?: string,
): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can reassign', 'TEAM_CAPTAIN_REQUIRED')
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    if (targetMemberSessionId !== undefined) {
      const target = team.members.find(member => member.sessionId === targetMemberSessionId
        && (member.phase === 'provisioning' || member.phase === 'active'))
      expectDomain(target !== undefined, 'task assignment target is not an available Team member', 'TEAM_ASSIGNEE_INVALID')
    }
    expectDomain(
      ['in_progress', 'submitted', 'verifying'].includes(current.status) && current.currentAttemptId !== undefined,
      'only an open execution attempt can be reassigned',
      'TEAM_TASK_NOT_REASSIGNABLE',
    )
    const timestamp = deps.now()
    if (current.currentAttemptId !== undefined) {
      fenceAttemptStale(team, current.currentAttemptId, diagnostic, timestamp)
    }
    committed = clearTaskExecution(current, {
      revision: current.revision + 1,
      status: 'pending',
      updatedAt: timestamp,
    })
    const { targetMemberSessionId: _previousTarget, ...released } = committed
    committed = released
    if (targetMemberSessionId !== undefined) {
      committed = { ...committed, targetMemberSessionId }
    }
    replaceTask(team, committed)
    pruneRetainedAttempts(team, deps.limits.maxRetainedAttempts)
  })
  return structuredClone(committed)
}

/**
 * Retry one live owner's open attempt in place (issue #83): stale the fenced
 * attempt and allocate its same-owner successor inside ONE transaction, so
 * the task is never observable as `pending` between the two transitions —
 * not to a reader, and not to a scheduling pass's new-assignment lane, which
 * could otherwise legitimately re-assign the transiently released task
 * without a captain decision. The fresh attempt records the attempt it
 * replaced, which is what lets {@link reinstateAttempt} reverse a misfired
 * retry onto exactly the attempt it fenced.
 */
export async function retryAttempt(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  taskId: TaskId,
  expectedRevision: number,
  assigneeSessionId: string,
  diagnostic: string,
): Promise<{ task: TeamTask; attempt: TaskAttempt }> {
  let seated!: { task: TeamTask; attempt: TaskAttempt }
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can retry an attempt', 'TEAM_CAPTAIN_REQUIRED')
    actorMembership(team, assigneeSessionId)
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    expectDomain(
      current.status === 'in_progress' && current.currentAttemptId !== undefined && current.ownerSessionId === assigneeSessionId,
      'only the current owner\'s open in_progress attempt can be retried in place',
      'TEAM_TASK_NOT_REASSIGNABLE',
    )
    budgetAvailable(team.budget, deps.now())
    const timestamp = deps.now()
    const previous = attemptOf(team, current.currentAttemptId!)
    fenceAttemptStale(team, previous.id, diagnostic, timestamp)
    const attempt: TaskAttempt = {
      id: AttemptId(`attempt-${randomUUID()}`),
      taskId,
      generation: nextAttemptGeneration(team, taskId),
      memberSessionId: assigneeSessionId,
      phase: 'running',
      assignmentPhase: 'reserved',
      replacesAttemptId: previous.id,
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    seated = seatAttempt(team, {
      ...current,
      revision: current.revision + 1,
      currentAttemptId: attempt.id,
      updatedAt: timestamp,
    }, attempt)
    // Cost-aware retryLimit (M4-3, issue #129): an in-place retry is a
    // failure-driven re-execution generation, so it consumes one retry in
    // the same transaction that seats it (alongside the request seat
    // charge). Review rework keeps its own charge (docs/04 §5); captain
    // reassignment and member-removal requeue stay deliberately uncharged —
    // control acts, not failure-driven re-executions. No reservation
    // re-admission: the task stays continuously in_progress, so its hold is
    // already accounted.
    Object.assign(team, { budget: { ...team.budget, usedRetries: team.budget.usedRetries + 1 } })
  })
  return seated
}

/**
 * Reverse one misfired in-place retry (issue #83): the scheduler retried a
 * live-and-idle owner, but the owner stopped being live while the retry
 * committed — the premise of the heal is gone and a not-live owner is
 * evidence-only, never an automatic requeue. The undelivered retry is
 * cancelled and the attempt it fenced is reinstated as the task's current
 * running attempt (its delivery checkpoint is preserved by the retry), all
 * inside one transaction so the task stays continuously `in_progress` under
 * the same owner. A retry whose frame was already acknowledged as delivered
 * is not reversible — the member saw the assignment, so the retry stands.
 */
export async function reinstateAttempt(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  taskId: TaskId,
  expectedRevision: number,
  misfiredAttemptId: AttemptId,
  diagnostic: string,
): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can reinstate an attempt', 'TEAM_CAPTAIN_REQUIRED')
    const current = taskOf(team, taskId)
    taskRevision(current, expectedRevision)
    expectDomain(
      current.status === 'in_progress' && current.currentAttemptId === misfiredAttemptId,
      'only the task\'s current retry can be reversed',
      'TEAM_ATTEMPT_STALE',
    )
    const misfired = attemptOf(team, misfiredAttemptId)
    expectDomain(
      misfired.phase === 'running' && misfired.assignmentPhase === 'reserved',
      'only an undelivered retry can be reversed',
      'TEAM_ATTEMPT_PHASE_INVALID',
    )
    const replacedId = misfired.replacesAttemptId
    expectDomain(replacedId !== undefined, 'the retry records no replaced attempt', 'TEAM_ATTEMPT_STALE')
    const replaced = attemptOf(team, replacedId!)
    expectDomain(
      replaced.taskId === taskId && replaced.memberSessionId === misfired.memberSessionId && replaced.phase === 'stale',
      'the replaced attempt does not match the retry',
      'TEAM_ATTEMPT_STALE',
    )
    const timestamp = deps.now()
    replaceAttempt(team, {
      ...misfired,
      phase: 'cancelled',
      diagnostic: nonEmpty(diagnostic, 'reassignment diagnostic', 8_192),
      updatedAt: timestamp,
    })
    const { diagnostic: replacedDiagnostic, ...replacedWithoutDiagnostic } = replaced
    void replacedDiagnostic
    replaceAttempt(team, {
      ...replacedWithoutDiagnostic,
      phase: 'running',
      updatedAt: timestamp,
    })
    committed = {
      ...current,
      revision: current.revision + 1,
      currentAttemptId: replaced.id,
      updatedAt: timestamp,
    }
    replaceTask(team, committed)
    pruneRetainedAttempts(team, deps.limits.maxRetainedAttempts)
  })
  return structuredClone(committed)
}

/**
 * Bound the retained terminal attempts per task, pruning the oldest
 * first (M1B/F7). Only terminal phases are prunable; the open attempt
 * still owed a settlement and any attempt a task references as its
 * `currentAttemptId` are never removed, so the fencing reference and the
 * deep state validation stay intact. Pruning removes whole entries from
 * the front of the creation-ordered array, so the retained replay order,
 * attempt identities and the store revision sequence stay continuous,
 * and the per-task generation watermark survives (the retained maximum
 * is always the historical maximum). Records persisted before this
 * policy existed load unchanged; their history is pruned lazily by the
 * next terminal transition that runs through here.
 */
export function pruneRetainedAttempts(team: TeamState, maxRetainedAttempts: number): void {
  const currentIds = new Set(
    team.tasks.flatMap(task => task.currentAttemptId === undefined ? [] : [task.currentAttemptId]),
  )
  const retainedTerminal = new Map<TaskId, number>()
  const removable: number[] = []
  for (let index = team.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = team.attempts[index]!
    if (!TERMINAL_ATTEMPT_PHASES.has(attempt.phase) || currentIds.has(attempt.id)) continue
    const seen = (retainedTerminal.get(attempt.taskId) ?? 0) + 1
    retainedTerminal.set(attempt.taskId, seen)
    if (seen > maxRetainedAttempts) removable.push(index)
  }
  // Collected newest-first, so splicing from the tail never shifts a
  // pending lower index.
  for (const index of removable) team.attempts.splice(index, 1)
}
