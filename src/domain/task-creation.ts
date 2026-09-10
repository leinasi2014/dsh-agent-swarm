import { expectDomain } from './error.js'
import { assertTaskGraph } from './graph.js'
import { actorMembership, nonEmpty, boundedBoardItems, type TeamDomainDeps } from './team-domain-shared.js'
import { TaskId, type TeamId, type TeamState, type TeamTask, type ReviewVerificationCommand } from './types.js'
import type { CreateTaskInput, TeamScope } from './team-domain-port.js'
import type { TaskWorkRequestSource } from './work-request.js'
import { appendWorkActivity } from './team-domain-work-activity.js'

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

export function prepareTaskInDraft(deps: TeamDomainDeps, team: TeamState, actorSessionId: string, input: CreateTaskInput, id: TaskId, source?: TaskWorkRequestSource): TeamTask {
    const authority = actorMembership(team, actorSessionId)
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
      expectDomain(authority.role === 'captain', 'only the captain can target another member', 'TEAM_CAPTAIN_REQUIRED')
      expectDomain(team.members.some(member => member.sessionId === input.targetMemberSessionId && (member.phase === 'provisioning' || member.phase === 'active')), 'task assignment target is not an available Team member', 'TEAM_ASSIGNEE_INVALID')
    }
    const timestamp = deps.now()
    expectDomain(input.assignmentMode === undefined || input.assignmentMode === "automatic" || input.assignmentMode === "open-claim", "invalid assignment mode", "TEAM_INPUT_INVALID")
    expectDomain(input.assignmentMode !== "open-claim" || input.targetMemberSessionId === undefined, "open tasks cannot have a fixed target", "TEAM_INPUT_INVALID")
    const committed: TeamTask = {
      id: id,
      revision: 1,
      createdBySessionId: actorSessionId,
      ...(input.assignmentMode === undefined ? {} : { assignmentMode: input.assignmentMode }),
      ...(source === undefined ? {} : { source: structuredClone(source) }),
      subject: nonEmpty(input.subject, 'task subject', 512),
      description: nonEmpty(input.description, 'task description', deps.limits.maxTaskBytes),
      acceptanceCriteria: boundedBoardItems(input.acceptanceCriteria ?? [], 'acceptance criterion', 2_048),
      status: 'pending',
      blockedBy,
      writeScopes: boundedBoardItems(input.writeScopes ?? [], 'write scope', 1_024),
      priority: input.priority ?? 0,
      ...(input.verification === undefined ? {} : { verification: normalizeVerification(input.verification, deps.limits) }),
      ...(input.reservationTokens === undefined ? {} : { reservationTokens: input.reservationTokens }),
      ...(input.targetMemberSessionId === undefined ? {} : { targetMemberSessionId: input.targetMemberSessionId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    return committed
}

export async function createTask(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, actorSessionId: string, input: CreateTaskInput): Promise<TeamTask> {
  let committed!: TeamTask
  await deps.store.transact(scope, teamId, team => {
    committed = prepareTaskInDraft(deps, team, actorSessionId, input, TaskId(`task-${team.nextTaskNumber}`))
    assertTaskGraph([...team.tasks, committed])
    team.tasks.push(committed)
    Object.assign(team, { nextTaskNumber: team.nextTaskNumber + 1 })
    appendWorkActivity(team, { kind: "task-created", actor: { kind: "session", sessionId: actorSessionId }, taskId: committed.id, status: committed.status, occurredAt: committed.createdAt })
  })
  return structuredClone(committed)
}
