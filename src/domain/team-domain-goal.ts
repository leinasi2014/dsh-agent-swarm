import { saveGoalInputSchema, controlGoalInputSchema, goalDefinitionSchema, type GoalSnapshot } from '../shared/goal-lifecycle.js'
import type { SaveGoalInput, ControlGoalInput, GoalOrigin, GoalAdmissionGuards, GoalOperationResult,
  GoalResultQuery, GoalResultLookup, GoalCoordinationInput, GoalOperationReceipt } from './goal-lifecycle.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId, TeamState } from './types.js'
import { expectDomain } from './error.js'
import { budgetAvailable, setBudgetInDraft } from './team-domain-budget.js'
import { goalOriginSchema, goalCoordinationInputSchema } from './goal-validation.js'
import { assertGoalOrigin, assertGoalResultOrigin, createGoalTrigger, ensureGoalNotice, goalBudgetHeld, goalDigest,
  projectGoalLifecycle, retireGoalTrigger, reviseGoalInDraft, sameGoalOrigin } from './goal-transitions.js'

async function readTeam(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId): Promise<TeamState> {
  const team = await deps.store.read(scope, teamId)
  expectDomain(team !== undefined, 'Team not found', 'TEAM_NOT_FOUND')
  return team
}
function oldReceipt(team: TeamState, origin: GoalOrigin, requestId: string, contentDigest: string): GoalOperationReceipt | undefined {
  const receipt = team.goalLifecycle?.operations.find(item => item.requestId === requestId && sameGoalOrigin(item.origin, origin))
  if (receipt !== undefined) expectDomain(receipt.contentDigest === contentDigest, 'This goal request has a different payload', 'TEAM_GOAL_CONFLICT')
  return receipt
}
function revision(team: TeamState, expected: number): void {
  expectDomain((team.goalLifecycle?.revision ?? 0) === expected, 'Goal revision changed; read the current goal before a new operation', 'TEAM_GOAL_STALE_REVISION')
}
function tokenBudget(team: TeamState, input: SaveGoalInput | ControlGoalInput): void {
  if (input.tokenBudget === undefined) return
  expectDomain((team.budget.tokenLimit ?? null) === input.tokenBudget.expectedTokenLimit, 'Team token limit changed', 'TEAM_GOAL_BUDGET_CONFLICT')
  setBudgetInDraft(team, { tokenLimit: input.tokenBudget.tokenLimit })
}
function start(deps: TeamDomainDeps, team: TeamState, reason: 'start' | 'resume', guards?: GoalAdmissionGuards): void {
  const goal = team.goalLifecycle!
  guards?.assertCanStart?.()
  if (goal.mode === 'maintenance') expectDomain(team.budget.tokenLimit !== undefined && team.budget.tokenLimit > team.budget.usedTokens,
    'Maintenance requires a finite token limit above current usage', 'TEAM_GOAL_BUDGET_REQUIRED')
  budgetAvailable(team.budget, deps.now())
  if (goal.phase === 'running') return
  retireGoalTrigger(team, deps.now(), 'Goal explicitly resumed')
  goal.phase = 'running'
  delete goal.nextDueAt
  delete goal.completion
  createGoalTrigger(deps, team, reason)
}
function commitReceipt(deps: TeamDomainDeps, team: TeamState, origin: GoalOrigin,
  input: SaveGoalInput | ControlGoalInput, contentDigest: string): number {
  const goal = team.goalLifecycle!
  goal.revision++
  const receipt: GoalOperationReceipt = { origin, requestId: input.requestId, expectedLifecycleRevision: input.expectedLifecycleRevision,
    contentDigest, operationRevision: goal.revision, at: deps.now() }
  const operations = [...goal.operations, receipt], evicted = operations.slice(0, Math.max(0, operations.length - 256))
  Object.assign(goal, { operations: operations.slice(-256),
    operationFloorRevision: evicted.length === 0 ? goal.operationFloorRevision : evicted.at(-1)!.expectedLifecycleRevision + 1 })
  return receipt.operationRevision
}
async function operate(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, rawOrigin: GoalOrigin,
  input: SaveGoalInput | ControlGoalInput, kind: 'save' | 'control', guards: GoalAdmissionGuards | undefined,
  apply: (team: TeamState) => void): Promise<GoalOperationResult> {
  const parsedOrigin = goalOriginSchema.safeParse(rawOrigin)
  expectDomain(parsedOrigin.success, 'Invalid goal authority', 'TEAM_INPUT_INVALID')
  const origin = parsedOrigin.data, contentDigest = goalDigest({ kind, input })
  const result = await deps.store.transact(scope, teamId, team => {
    assertGoalOrigin(team, origin, guards)
    const existing = oldReceipt(team, origin, input.requestId, contentDigest)
    if (existing !== undefined) return { operationRevision: existing.operationRevision, replayed: true }
    revision(team, input.expectedLifecycleRevision)
    tokenBudget(team, input)
    apply(team)
    return { operationRevision: commitReceipt(deps, team, origin, input, contentDigest), replayed: false }
  })
  return { ...result, team: await readTeam(deps, scope, teamId) }
}
export async function saveGoal(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, rawOrigin: GoalOrigin,
  raw: SaveGoalInput, guards?: GoalAdmissionGuards): Promise<GoalOperationResult> {
  const parsed = saveGoalInputSchema.safeParse(raw)
  expectDomain(parsed.success, 'Invalid goal save', 'TEAM_INPUT_INVALID')
  const input = parsed.data
  return operate(deps, scope, teamId, rawOrigin, input, 'save', guards, team => {
    const definition = { ...input.goal, text: input.goal.text.trim(),
      acceptanceCriteria: input.goal.acceptanceCriteria.trim(), constraints: input.goal.constraints.trim() }
    expectDomain(goalDefinitionSchema.safeParse(definition).success, 'Invalid goal definition', 'TEAM_INPUT_INVALID')
    reviseGoalInDraft(deps, team, definition)
    if (input.start) start(deps, team, 'start', guards)
  })
}
export async function controlGoal(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, rawOrigin: GoalOrigin,
  raw: ControlGoalInput, guards?: GoalAdmissionGuards): Promise<GoalOperationResult> {
  const parsed = controlGoalInputSchema.safeParse(raw)
  expectDomain(parsed.success, 'Invalid goal control', 'TEAM_INPUT_INVALID')
  const input = parsed.data
  return operate(deps, scope, teamId, rawOrigin, input, 'control', guards, team => {
    expectDomain(team.goalLifecycle !== undefined, 'Save a goal before controlling its lifecycle', 'TEAM_GOAL_NOT_CONFIGURED')
    if (input.action === 'pause') {
      team.goalLifecycle.phase = 'paused'
      delete team.goalLifecycle.nextDueAt
    } else start(deps, team, input.action, guards)
  })
}
export async function goalOperationResult(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId,
  rawOrigin: GoalOrigin, query: GoalResultQuery): Promise<GoalResultLookup> {
  const origin = goalOriginSchema.safeParse(rawOrigin)
  expectDomain(origin.success && typeof query.requestId === 'string' && query.requestId.length > 0
    && Number.isSafeInteger(query.expectedLifecycleRevision) && query.expectedLifecycleRevision >= 0, 'Invalid goal result query', 'TEAM_INPUT_INVALID')
  const team = await readTeam(deps, scope, teamId)
  assertGoalResultOrigin(team, origin.data)
  const receipt = team.goalLifecycle?.operations.find(item => item.requestId === query.requestId && sameGoalOrigin(item.origin, origin.data))
  if (receipt !== undefined) {
    expectDomain(receipt.expectedLifecycleRevision === query.expectedLifecycleRevision, 'Goal result identity changed', 'TEAM_GOAL_CONFLICT')
    return { team, state: 'committed', operationRevision: receipt.operationRevision }
  }
  return { team, state: query.expectedLifecycleRevision < (team.goalLifecycle?.operationFloorRevision ?? 0) ? 'expired' : 'not-found' }
}
export function projectGoalSnapshot(team: TeamState, now: number): GoalSnapshot {
  const goal = team.goalLifecycle
  const waitingReason = goal?.phase === 'paused' ? 'paused' : goalBudgetHeld(team, now) ? 'budget' : undefined
  return { text: team.publicGoal ?? '', ...(goal === undefined ? {} : { lifecycle: projectGoalLifecycle(goal) }),
    budget: structuredClone(team.budget), remainingActiveTasks: team.tasks.filter(task => !['completed', 'failed', 'cancelled'].includes(task.status)).length,
    remainingActiveAttempts: team.attempts.filter(attempt => ['running', 'submitted', 'verifying'].includes(attempt.phase)).length,
    eligibility: team.phase === 'active' ? { state: 'available' } : { state: 'unavailable', reason: 'not-active' },
    ...(waitingReason === undefined ? {} : { waitingReason }) }
}
export async function goalSnapshot(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId): Promise<GoalSnapshot> {
  return projectGoalSnapshot(await readTeam(deps, scope, teamId), deps.now())
}
export async function coordinateGoal(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, captain: string,
  raw: GoalCoordinationInput, guards?: GoalAdmissionGuards): Promise<{ team: TeamState; replayed: boolean }> {
  const parsed = goalCoordinationInputSchema.safeParse(raw)
  expectDomain(parsed.success, 'Invalid goal coordination', 'TEAM_INPUT_INVALID')
  const input = parsed.data, contentDigest = goalDigest(input)
  const replayed = await deps.store.transact(scope, teamId, team => {
    assertGoalOrigin(team, { kind: 'captain', sessionId: captain }, guards)
    const goal = team.goalLifecycle
    expectDomain(goal !== undefined, 'No goal lifecycle exists', 'TEAM_GOAL_NOT_CONFIGURED')
    expectDomain(input.goalRevision === goal.goalRevision, 'Goal revision changed before coordination', 'TEAM_GOAL_STALE_TRIGGER')
    if (goal.lastCoordination?.triggerId === input.triggerId) {
      expectDomain(goal.lastCoordinationDigest === contentDigest, 'This goal trigger has another conclusion', 'TEAM_GOAL_CONFLICT')
      return true
    }
    const trigger = goal.currentTrigger
    expectDomain(goal.phase === 'running' && trigger?.id === input.triggerId, 'Goal trigger is no longer active', 'TEAM_GOAL_STALE_TRIGGER')
    expectDomain(input.resultSequence === trigger.resultSequence && input.resultSequence <= goal.resultSequence,
      'Goal conclusion must cover exactly the observed trigger watermark', 'TEAM_GOAL_STALE_TRIGGER')
    expectDomain(input.taskIds.every(id => team.tasks.some(task => task.id === id)), 'Coordination refers to missing Team tasks', 'TEAM_TASK_NOT_FOUND')
    if (input.outcome !== 'coordinated') {
      expectDomain(input.resultSequence === goal.resultSequence, 'New task results require another coordination before completion', 'TEAM_GOAL_STALE_TRIGGER')
      expectDomain(team.tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status))
        && team.attempts.every(attempt => !['running', 'submitted', 'verifying'].includes(attempt.phase)),
      'Close all Team work before completing a goal or maintenance round', 'TEAM_GOAL_WORK_OPEN')
      expectDomain(input.outcome === (goal.mode === 'finite' ? 'achieved' : 'round-finished'),
        'This conclusion does not match the goal mode', 'TEAM_GOAL_OUTCOME_INVALID')
    }
    const at = deps.now()
    retireGoalTrigger(team, at, 'Captain confirmed goal coordination')
    goal.lastCoordination = { ...input, actorSessionId: captain, at }
    Object.assign(goal, { lastCoordinationDigest: contentDigest, coordinatedGoalRevision: input.goalRevision,
      coordinatedResultSequence: input.resultSequence, revision: goal.revision + 1 })
    if (input.nextAction !== undefined) goal.nextAction = input.nextAction
    else delete goal.nextAction
    if (input.outcome === 'achieved') {
      goal.phase = 'achieved'
      goal.completion = { goalRevision: goal.goalRevision, at, summary: input.summary, taskIds: input.taskIds }
    } else if (input.outcome === 'round-finished') {
      goal.phase = 'waiting'
      goal.nextDueAt = at + goal.intervalMs!
    } else if (goal.resultSequence > input.resultSequence && !goalBudgetHeld(team, at) && guards?.autonomousAllowed?.() !== false
      && team.messages.filter(message => message.phase === 'queued' && message.targetSessionId === team.captainSessionId).length < deps.limits.maxPendingMessagesPerMember) {
      createGoalTrigger(deps, team, 'task-result')
    }
    return false
  })
  return { replayed, team: await readTeam(deps, scope, teamId) }
}
export async function reconcileGoal(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId,
  guards?: GoalAdmissionGuards): Promise<{ team: TeamState }> {
  await deps.store.transact(scope, teamId, team => {
    guards?.assertExecution?.()
    const goal = team.goalLifecycle
    if (team.phase !== 'active' || goal === undefined || !['running', 'waiting'].includes(goal.phase)
      || guards?.autonomousAllowed?.() === false || goalBudgetHeld(team, deps.now())) return
    if (goal.currentTrigger !== undefined) {
      if (ensureGoalNotice(deps, team)) goal.revision++
      return
    }
    const reason = goal.resultSequence > goal.coordinatedResultSequence ? 'task-result'
      : goal.goalRevision > goal.coordinatedGoalRevision ? 'goal-updated'
        : goal.phase === 'waiting' && goal.nextDueAt! <= deps.now() ? 'maintenance-due' : undefined
    if (reason === undefined) return
    createGoalTrigger(deps, team, reason)
    goal.revision++
  })
  return { team: await readTeam(deps, scope, teamId) }
}
