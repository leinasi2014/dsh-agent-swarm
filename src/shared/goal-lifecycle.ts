import { z } from 'zod'

const id = z.string().min(1).max(256)
const counter = z.number().int().safe().nonnegative()
const positive = z.number().int().safe().positive()
const text = z.string().refine(value => [...value].length <= 4096, 'Text exceeds 4096 code points')
export const GOAL_INTERVAL_MIN_MS = 60_000
export const GOAL_INTERVAL_MAX_MS = 7 * 24 * 60 * 60_000
const goalModeSchema = z.enum(['finite', 'maintenance'])
export const goalDefinitionSchema = z.object({
  text: text.refine(value => value.trim().length > 0, 'Goal text is required'),
  acceptanceCriteria: text, constraints: text, mode: goalModeSchema,
  intervalMs: z.number().int().safe().min(GOAL_INTERVAL_MIN_MS).max(GOAL_INTERVAL_MAX_MS).optional(),
}).strict().superRefine((goal, context) => {
  if ((goal.mode === 'maintenance') !== (goal.intervalMs !== undefined)) {
    context.addIssue({ code: 'custom', path: ['intervalMs'], message: 'Only maintenance requires an interval' })
  }
})
export type GoalDefinition = z.infer<typeof goalDefinitionSchema>
export const goalTokenBudgetSchema = z.object({ expectedTokenLimit: positive.nullable(), tokenLimit: positive }).strict()
const operation = { requestId: id, expectedLifecycleRevision: counter, tokenBudget: goalTokenBudgetSchema.optional() }
export const saveGoalInputSchema = z.object({ ...operation, goal: goalDefinitionSchema, start: z.boolean() }).strict()
export const controlGoalInputSchema = z.object({ ...operation, action: z.enum(['start', 'pause', 'resume']) }).strict()
export type SaveGoalInput = z.infer<typeof saveGoalInputSchema>
export type ControlGoalInput = z.infer<typeof controlGoalInputSchema>
const goalTriggerSchema = z.object({
  id, goalRevision: positive, resultSequence: counter,
  reason: z.enum(['start', 'resume', 'goal-updated', 'task-result', 'maintenance-due']),
  createdAt: counter, notificationMessageId: id,
}).strict()
export const goalCoordinationSchema = z.object({
  triggerId: id, goalRevision: positive, resultSequence: counter, actorSessionId: id, at: counter,
  summary: text, taskIds: z.array(id).max(256), outcome: z.enum(['coordinated', 'achieved', 'round-finished']), nextAction: text.optional(),
}).strict()
const goalCompletionSchema = z.object({ goalRevision: positive, at: counter, summary: text, taskIds: z.array(id).max(256) }).strict()
/** Public lifecycle only. The unique goal body remains Team.publicGoal; private receipts never cross this projection. */
export const goalLifecycleSchema = z.object({
  schemaVersion: z.literal(1), revision: positive, goalRevision: positive,
  acceptanceCriteria: text, constraints: text, mode: goalModeSchema,
  phase: z.enum(['draft', 'running', 'paused', 'waiting', 'achieved']),
  intervalMs: z.number().int().safe().min(GOAL_INTERVAL_MIN_MS).max(GOAL_INTERVAL_MAX_MS).optional(),
  resultSequence: counter, coordinatedResultSequence: counter, coordinatedGoalRevision: counter,
  currentTrigger: goalTriggerSchema.optional(), lastCoordination: goalCoordinationSchema.optional(),
  completion: goalCompletionSchema.optional(), nextDueAt: counter.optional(), nextAction: text.optional(),
}).strict()
export type GoalLifecycle = z.infer<typeof goalLifecycleSchema>
export type GoalTrigger = z.infer<typeof goalTriggerSchema>
export const goalSnapshotSchema = z.object({
  text, lifecycle: goalLifecycleSchema.optional(),
  budget: z.object({ tokenLimit: positive.optional(), usedTokens: counter, requestLimit: positive.optional(), usedRequests: counter,
    retryLimit: positive.optional(), usedRetries: counter, deadlineAt: positive.optional() }).strict(),
  remainingActiveTasks: counter, remainingActiveAttempts: counter,
  eligibility: z.discriminatedUnion('state', [z.object({ state: z.literal('available') }).strict(),
    z.object({ state: z.literal('unavailable'), reason: z.string().min(1).max(128).optional() }).strict()]),
  waitingReason: z.enum(['paused', 'budget', 'workflow-owner', 'unsupported']).optional(),
}).strict()
export type GoalSnapshot = z.infer<typeof goalSnapshotSchema>
