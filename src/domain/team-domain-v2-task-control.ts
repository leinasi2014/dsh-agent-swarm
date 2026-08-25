import { TeamDomainError } from './error.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import type { TaskAttemptV2, TeamStateV2 } from './team-state-v2.js'
import { AttemptId, TaskId, type TeamTask, type TeamId } from './types.js'
import type { TeamScope } from './team-domain-port.js'
import { replaceV2Attempt, replaceV2Task, requireV2Text } from './team-domain-v2-shared.js'

const OPEN_DISPATCH_PHASES = new Set([
  'frame-pending', 'frame-claimed', 'dispatch-pending', 'dispatch-entered',
])
const DEFAULT_MAX_TASK_BYTES = 65_536

function taskOf(team: TeamStateV2, taskId: TaskId): TeamTask {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new TeamDomainError(`task "${taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
  return task
}

function attemptOf(team: TeamStateV2, attemptId: AttemptId): TaskAttemptV2 {
  const attempt = team.attempts.find(candidate => candidate.id === attemptId)
  if (attempt === undefined) throw new TeamDomainError(`attempt "${attemptId}" is stale`, 'TEAM_ATTEMPT_STALE')
  return attempt
}

function requireTaskRevision(task: TeamTask, expected: number): void {
  if (task.revision !== expected) {
    throw new TeamDomainError(
      `stale task revision ${expected}; current revision is ${task.revision}`,
      'TEAM_TASK_STALE_REVISION',
    )
  }
}

function closeAttemptControl(
  team: TeamStateV2,
  attempt: TaskAttemptV2,
  status: 'superseded' | 'cancelled',
  timestamp: number,
): Omit<TaskAttemptV2, 'phase'> {
  const closedEffectIds = new Set<string>()
  const dispatchEpochs = attempt.dispatchEpochs.map(epoch => {
    if (!OPEN_DISPATCH_PHASES.has(epoch.phase)) return epoch
    closedEffectIds.add(epoch.effectId)
    return { ...epoch, phase: status, updatedAt: timestamp }
  })
  for (let index = 0; index < team.interactionEffects.length; index += 1) {
    const receipt = team.interactionEffects[index]!
    if (receipt.status === 'applied' && closedEffectIds.has(receipt.effectId)) {
      team.interactionEffects[index] = {
        ...receipt,
        status,
        resultingTeamRevision: team.revision + 1,
      }
    }
  }
  const { parked: _parked, currentContinuationIntent: _intent, phase: _phase, ...base } = attempt
  void _parked; void _intent; void _phase
  return { ...base, dispatchEpochs, updatedAt: timestamp }
}

function submissionAdmissible(attempt: TaskAttemptV2): boolean {
  return attempt.phase === 'running'
}

/** Atomic v2 task submission and captain reassignment fences. */
export class TeamV2TaskControlDomain {
  constructor(
    private readonly store: StorageDomainTeamStoreV2,
    private readonly deps: { readonly now?: () => number; readonly maxTaskBytes?: number } = {},
  ) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  async submitTask(scope: TeamScope, teamId: TeamId, actorSessionId: string, input: {
    readonly taskId: TaskId
    readonly expectedTaskRevision: number
    readonly attemptId: AttemptId
    readonly output: string
    readonly evidence: readonly string[]
  }): Promise<TeamTask> {
    let result!: TeamTask
    await this.store.transact(scope, teamId, team => {
      const member = team.members.find(candidate => candidate.sessionId === actorSessionId)
      if (member?.phase !== 'active') throw new TeamDomainError('only an active Team member may submit', 'TEAM_TASK_OWNER_REQUIRED')
      const task = taskOf(team, input.taskId)
      requireTaskRevision(task, input.expectedTaskRevision)
      if (task.status !== 'in_progress' || task.currentAttemptId !== input.attemptId
        || task.ownerSessionId !== actorSessionId) {
        throw new TeamDomainError('only the exact current owner Attempt may submit', 'TEAM_ATTEMPT_STALE')
      }
      const attempt = attemptOf(team, input.attemptId)
      if (attempt.memberSessionId !== actorSessionId || attempt.assignmentPhase !== 'delivered'
        || !submissionAdmissible(attempt)) {
        throw new TeamDomainError('Attempt is not at an executable submission boundary', 'TEAM_ATTEMPT_PHASE_INVALID')
      }
      const output = requireV2Text(input.output, 'task output', this.deps.maxTaskBytes ?? DEFAULT_MAX_TASK_BYTES)
      const evidence = [...input.evidence].map(value => requireV2Text(value, 'evidence reference', 2_048))
      const timestamp = this.now()
      const controlled = closeAttemptControl(team, attempt, 'superseded', timestamp)
      replaceV2Attempt(team, { ...controlled, phase: 'submitted', output, evidence })
      result = {
        ...task,
        revision: task.revision + 1,
        status: 'submitted',
        output,
        updatedAt: timestamp,
      }
      replaceV2Task(team, result)
    })
    return structuredClone(result)
  }

  async reassignTask(scope: TeamScope, teamId: TeamId, captainSessionId: string, input: {
    readonly taskId: TaskId
    readonly expectedTaskRevision: number
    readonly diagnostic: string
    readonly targetMemberSessionId?: string
  }): Promise<{ task: TeamTask; replacedAttemptId: AttemptId; previousOwnerSessionId: string }> {
    let result!: { task: TeamTask; replacedAttemptId: AttemptId; previousOwnerSessionId: string }
    await this.store.transact(scope, teamId, team => {
      if (team.phase !== 'active' || team.captainSessionId !== captainSessionId) {
        throw new TeamDomainError('only the active Team captain may reassign', 'TEAM_CAPTAIN_REQUIRED')
      }
      const task = taskOf(team, input.taskId)
      requireTaskRevision(task, input.expectedTaskRevision)
      if (!['in_progress', 'submitted', 'verifying'].includes(task.status)
        || task.currentAttemptId === undefined || task.ownerSessionId === undefined) {
        throw new TeamDomainError('only an open execution Attempt may be reassigned', 'TEAM_TASK_NOT_REASSIGNABLE')
      }
      if (input.targetMemberSessionId !== undefined) {
        const target = team.members.find(candidate => candidate.sessionId === input.targetMemberSessionId
          && (candidate.phase === 'declared' || candidate.phase === 'active'))
        if (target === undefined) throw new TeamDomainError('task target is not an available Team member', 'TEAM_ASSIGNEE_INVALID')
      }
      const attempt = attemptOf(team, task.currentAttemptId)
      const diagnostic = requireV2Text(input.diagnostic, 'reassignment diagnostic', 8_192)
      const timestamp = this.now()
      const controlled = closeAttemptControl(team, attempt, 'superseded', timestamp)
      replaceV2Attempt(team, { ...controlled, phase: 'stale', diagnostic })
      const {
        ownerSessionId: previousOwnerSessionId,
        currentAttemptId: replacedAttemptId,
        output: _output,
        targetMemberSessionId: _oldTarget,
        ...taskBase
      } = task
      void _output; void _oldTarget
      const released: TeamTask = {
        ...taskBase,
        revision: task.revision + 1,
        status: 'pending',
        ...(input.targetMemberSessionId === undefined ? {} : { targetMemberSessionId: input.targetMemberSessionId }),
        updatedAt: timestamp,
      }
      replaceV2Task(team, released)
      result = { task: released, replacedAttemptId, previousOwnerSessionId }
    })
    return structuredClone(result)
  }
}
