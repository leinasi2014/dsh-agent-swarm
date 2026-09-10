/** In-transaction goal mutations shared by control, review, cancellation and recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { GoalDefinition, GoalLifecycle, GoalTrigger } from '../shared/goal-lifecycle.js'
import type { TeamGoalLifecycle, GoalOrigin, GoalAdmissionGuards } from './goal-lifecycle.js'
import { expectDomain } from './error.js'
import { publicManagedParent } from './public-message.js'
import { pruneRetainedMessages } from './team-domain-mailbox.js'
import { budgetExhaustion } from './team-domain-budget.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import { TeamMessageId, type TeamState, type TeamMessage } from './types.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, item]) => item !== undefined).toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}
export const goalDigest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export const sameGoalOrigin = (left: GoalOrigin, right: GoalOrigin): boolean => canonical(left) === canonical(right)
export function assertGoalOrigin(team: TeamState, origin: GoalOrigin, guards?: GoalAdmissionGuards): void {
  expectDomain(team.phase === 'active' && team.captainSessionId !== '', 'Goal control requires an active Team', 'TEAM_ARCHIVED')
  assertGoalResultOrigin(team, origin)
  if (guards?.expectedCaptainSessionId !== undefined) expectDomain(team.captainSessionId === guards.expectedCaptainSessionId, 'Goal Captain binding changed', 'TEAM_GOAL_ORIGIN_INVALID')
  if (guards?.expectedManagedOrigin !== undefined) expectDomain(team.managedOrigin === guards.expectedManagedOrigin, 'Goal Main binding changed', 'TEAM_GOAL_ORIGIN_INVALID')
  guards?.assertExecution?.()
  guards?.assertTeam?.(team)
}
/** Read recovery preserves current origin authority after Team archival. */
export function assertGoalResultOrigin(team: TeamState, origin: GoalOrigin): void {
  expectDomain(origin.kind === 'local-operator' || origin.kind === 'main' || origin.kind === 'captain', 'Invalid goal authority', 'TEAM_GOAL_ORIGIN_INVALID')
  if (origin.kind === 'main') expectDomain(publicManagedParent(team.managedOrigin) === origin.sessionId, 'This Main does not own the Team', 'TEAM_MAIN_REQUIRED')
  if (origin.kind === 'captain') expectDomain(team.captainSessionId === origin.sessionId, 'Only the current Captain controls this goal', 'TEAM_CAPTAIN_REQUIRED')
}
function initialGoal(definition: GoalDefinition): TeamGoalLifecycle {
  return { schemaVersion: 1, revision: 0, goalRevision: 1, acceptanceCriteria: definition.acceptanceCriteria,
    constraints: definition.constraints, mode: definition.mode, phase: 'draft',
    ...(definition.intervalMs === undefined ? {} : { intervalMs: definition.intervalMs }),
    resultSequence: 0, coordinatedResultSequence: 0, coordinatedGoalRevision: 0, operations: [], operationFloorRevision: 0 }
}
function goalDefinitionOf(team: TeamState): GoalDefinition | undefined {
  const goal = team.goalLifecycle
  return goal === undefined ? undefined : { text: team.publicGoal ?? '', acceptanceCriteria: goal.acceptanceCriteria,
    constraints: goal.constraints, mode: goal.mode, ...(goal.intervalMs === undefined ? {} : { intervalMs: goal.intervalMs }) }
}
/** Unclaimed old input cannot keep a new goal revision pending; claimed input remains in the official log. */
export function retireGoalTrigger(team: TeamState, timestamp: number, reason: string): void {
  const current = team.goalLifecycle?.currentTrigger
  if (current !== undefined) {
    const index = team.messages.findIndex(message => message.id === current.notificationMessageId && message.phase === 'queued')
    if (index >= 0) team.messages[index] = { ...team.messages[index]!, phase: 'obsolete', obsoletedAt: timestamp, obsoletedReason: reason }
  }
  if (team.goalLifecycle !== undefined) delete team.goalLifecycle.currentTrigger
}
function goalNotice(team: TeamState, trigger: GoalTrigger): TeamMessage {
  const definition = goalDefinitionOf(team)!
  return { id: TeamMessageId(trigger.notificationMessageId), kind: 'goal-coordination-notice',
    triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
    targetSessionId: team.captainSessionId, targetName: 'captain', delivery: 'wakeup', phase: 'queued', createdAt: trigger.createdAt,
    content: 'Goal coordination ' + trigger.id + '\n' + JSON.stringify({ goalRevision: trigger.goalRevision,
      resultSequence: trigger.resultSequence, reason: trigger.reason, goal: definition })
      + '\nRead the goal and task board. Adjust actual tasks using the existing tools. Confirm this trigger with agent_swarm_coordinate_goal; use an explicit achieved or round-finished outcome only after all Team work is closed.' }
}
/** The message identity and complete input reconstruct unchanged after bounded mailbox receipt pruning. */
export function ensureGoalNotice(deps: TeamDomainDeps, team: TeamState): boolean {
  const trigger = team.goalLifecycle?.currentTrigger
  if (trigger === undefined || team.messages.some(message => message.id === trigger.notificationMessageId)) return false
  const notice = goalNotice(team, trigger)
  expectDomain(team.messages.filter(message => message.phase === 'queued' && message.targetSessionId === team.captainSessionId).length < deps.limits.maxPendingMessagesPerMember,
    'Captain mailbox is full', 'TEAM_MAILBOX_FULL')
  expectDomain(Buffer.byteLength(JSON.stringify(notice), 'utf8') <= deps.limits.maxMessageBytes, 'Goal notification is too large', 'TEAM_INPUT_LIMIT')
  team.messages.push(notice)
  pruneRetainedMessages(team, deps.limits.maxRetainedMessages, deps.now())
  return true
}
export function createGoalTrigger(deps: TeamDomainDeps, team: TeamState, reason: GoalTrigger['reason']): void {
  const goal = team.goalLifecycle!
  if (goal.currentTrigger !== undefined) return
  goal.currentTrigger = { id: 'goal-trigger-' + randomUUID(), goalRevision: goal.goalRevision,
    resultSequence: goal.resultSequence, reason, createdAt: deps.now(), notificationMessageId: 'message-' + randomUUID() }
  goal.phase = 'running'
  delete goal.nextDueAt
  ensureGoalNotice(deps, team)
}
export function reviseGoalInDraft(deps: TeamDomainDeps, team: TeamState, definition: GoalDefinition): boolean {
  const current = team.goalLifecycle
  const changed = current === undefined || goalDigest(goalDefinitionOf(team)) !== goalDigest(definition)
  if (!changed) return false
  if (current === undefined) Object.assign(team, { goalLifecycle: initialGoal(definition) })
  else {
    retireGoalTrigger(team, deps.now(), 'Goal revision changed')
    const { intervalMs: _interval, nextDueAt: _due, completion: _completion, ...stable } = current
    Object.assign(team, { goalLifecycle: { ...stable, goalRevision: current.goalRevision + 1,
      acceptanceCriteria: definition.acceptanceCriteria, constraints: definition.constraints, mode: definition.mode,
      ...(definition.intervalMs === undefined ? {} : { intervalMs: definition.intervalMs }),
      phase: current.phase === 'achieved' ? 'draft' : current.phase === 'waiting' ? 'running' : current.phase } })
  }
  Object.assign(team, { publicGoal: definition.text })
  if (team.goalLifecycle!.phase === 'running') createGoalTrigger(deps, team, 'goal-updated')
  return true
}
/** Review/cancel facts only move this watermark. A single scheduling transaction consumes accumulated debt. */
export function recordGoalTaskResult(team: TeamState): void {
  const goal = team.goalLifecycle
  if (goal === undefined) return
  Object.assign(goal, { resultSequence: goal.resultSequence + 1, revision: goal.revision + 1 })
}
export function assertGoalAllowsNewAttempt(team: TeamState): void {
  expectDomain(team.goalLifecycle?.phase !== 'paused', 'The Team has paused new work', 'TEAM_GOAL_PAUSED')
}
export function goalBudgetHeld(team: TeamState, now: number): boolean {
  return budgetExhaustion(team.budget, now) !== undefined
    || (team.goalLifecycle?.mode === 'maintenance' && team.budget.tokenLimit === undefined)
}
export function projectGoalLifecycle(goal: TeamGoalLifecycle): GoalLifecycle {
  const { operations: _operations, operationFloorRevision: _floor, lastCoordinationDigest: _digest, ...publicGoal } = goal
  return structuredClone(publicGoal)
}
