import { z } from 'zod'
import { goalLifecycleSchema } from '../shared/goal-lifecycle.js'
import { expectDomain } from './error.js'
import { goalDigest } from './goal-transitions.js'
import type { TeamState } from './types.js'

const id = z.string().min(1).max(256)
const integer = z.number().int().safe().nonnegative()
const positive = z.number().int().safe().positive()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const bounded = z.string().refine(value => value.trim().length > 0 && [...value].length <= 4096)
export const goalOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-operator') }).strict(),
  z.object({ kind: z.literal('main'), sessionId: id }).strict(),
  z.object({ kind: z.literal('captain'), sessionId: id }).strict(),
])
export const teamGoalLifecycleSchema = goalLifecycleSchema.extend({
  operations: z.array(z.object({ origin: goalOriginSchema, requestId: id, expectedLifecycleRevision: integer,
    contentDigest: digest, operationRevision: positive, at: integer }).strict()).max(256),
  operationFloorRevision: integer, lastCoordinationDigest: digest.optional(),
}).strict()
export const taskCancellationSchema = z.object({
  requestId: id, expectedTaskRevision: positive, taskRevision: positive, reason: bounded,
  actorSessionId: id, at: integer, attemptId: id.optional(),
}).strict()
export const cancelTaskInputSchema = taskCancellationSchema.pick({ requestId: true, expectedTaskRevision: true, reason: true })
  .extend({ taskId: id }).strict()
export const goalCoordinationInputSchema = z.object({
  triggerId: id, goalRevision: positive, resultSequence: integer, summary: bounded,
  taskIds: z.array(id).max(256).refine(values => new Set(values).size === values.length),
  outcome: z.enum(['coordinated', 'achieved', 'round-finished']), nextAction: bounded.optional(),
}).strict()
export const goalNoticeSchema = z.object({
  id, kind: z.literal('goal-coordination-notice'), triggerId: id, goalRevision: positive, resultSequence: integer,
  targetSessionId: id, targetName: z.literal('captain'), content: z.string().min(1), delivery: z.literal('wakeup'),
  phase: z.enum(['queued', 'delivered', 'cancelled', 'obsolete']), createdAt: integer,
  deliveredAt: integer.optional(), obsoletedAt: integer.optional(), obsoletedReason: z.string().min(1).optional(),
}).strict()
const valid = (condition: unknown, message: string): void => expectDomain(condition, message, 'TEAM_STATE_CORRUPT')
export function assertGoalState(team: TeamState): void {
  const goal = team.goalLifecycle
  if (goal !== undefined) {
    valid(teamGoalLifecycleSchema.safeParse(goal).success, 'Invalid goal lifecycle')
    valid(team.publicGoal !== undefined && team.publicGoal.trim() !== '', 'Lifecycle requires the canonical public goal')
    valid((goal.mode === 'maintenance') === (goal.intervalMs !== undefined), 'Goal interval/mode mismatch')
    valid(goal.coordinatedGoalRevision <= goal.goalRevision && goal.coordinatedResultSequence <= goal.resultSequence, 'Goal coordination exceeds the current goal')
    valid((goal.phase === 'waiting') === (goal.nextDueAt !== undefined), 'Goal waiting deadline mismatch')
    valid(goal.phase !== 'waiting' || goal.mode === 'maintenance', 'Only maintenance can wait')
    valid(goal.phase !== 'achieved' || (goal.mode === 'finite' && goal.completion?.goalRevision === goal.goalRevision), 'Goal achievement is not evidenced')
    valid(goal.operationFloorRevision <= goal.revision, 'Goal operation recovery floor is invalid')
    valid(new Set(goal.operations.map(receipt => goalDigest([receipt.origin, receipt.requestId]))).size === goal.operations.length, 'Duplicate goal operation identity')
    for (const [index, receipt] of goal.operations.entries()) {
      valid(receipt.expectedLifecycleRevision < receipt.operationRevision && receipt.operationRevision <= goal.revision, 'Goal receipt revision is invalid')
      valid(index === 0 || receipt.operationRevision > goal.operations[index - 1]!.operationRevision, 'Goal operation receipts are out of order')
      valid(receipt.expectedLifecycleRevision >= goal.operationFloorRevision, 'Goal receipt predates the recovery floor')
    }
    if (goal.currentTrigger !== undefined) {
      valid(goal.currentTrigger.goalRevision === goal.goalRevision && goal.currentTrigger.resultSequence <= goal.resultSequence, 'Current goal trigger is stale')
      valid(goal.phase === 'running' || goal.phase === 'paused', 'Goal trigger exists outside an active or paused round')
      const notice = team.messages.find(message => message.id === goal.currentTrigger!.notificationMessageId)
      if (notice !== undefined) valid(notice.kind === 'goal-coordination-notice' && notice.triggerId === goal.currentTrigger.id
        && notice.goalRevision === goal.currentTrigger.goalRevision && notice.resultSequence === goal.currentTrigger.resultSequence, 'Goal trigger notification differs')
    }
    valid((goal.lastCoordination === undefined) === (goal.lastCoordinationDigest === undefined), 'Goal coordination digest mismatch')
    if (goal.lastCoordination !== undefined) {
      valid(goal.lastCoordination.goalRevision <= goal.goalRevision && goal.lastCoordination.resultSequence <= goal.resultSequence, 'Goal coordination refers to future state')
      valid(goal.lastCoordination.taskIds.every(taskId => team.tasks.some(task => task.id === taskId)), 'Goal coordination refers to missing tasks')
    }
    if (goal.completion !== undefined) valid(goal.completion.taskIds.every(taskId => team.tasks.some(task => task.id === taskId)), 'Goal completion refers to missing tasks')
  }
  for (const task of team.tasks) if (task.cancellation !== undefined) {
    const cancellation = task.cancellation
    valid(taskCancellationSchema.safeParse(cancellation).success, 'Invalid task cancellation')
    valid(task.status === 'cancelled' && task.ownerSessionId === undefined && task.currentAttemptId === undefined, 'Cancelled task retains execution ownership')
    valid(cancellation.taskRevision === task.revision && cancellation.expectedTaskRevision + 1 === cancellation.taskRevision, 'Cancellation revision mismatch')
    if (cancellation.attemptId !== undefined) {
      const attempt = team.attempts.find(item => item.id === cancellation.attemptId)
      valid(attempt === undefined || (attempt.taskId === task.id && attempt.phase === 'stale'), 'Cancelled execution was not fenced stale')
    }
  }
  for (const message of team.messages) if (message.kind === 'goal-coordination-notice') {
    valid(goalNoticeSchema.safeParse(message).success, 'Invalid goal notice')
    valid(goal !== undefined && message.goalRevision <= goal.goalRevision, 'Goal notice has no corresponding goal revision')
    valid(message.targetName === 'captain' && message.targetSessionId === team.captainSessionId, 'Goal notice target mismatch')
  }
}
