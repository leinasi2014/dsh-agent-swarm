import { z } from 'zod'

const id = z.string().min(1).max(256)
const time = z.number().int().nonnegative()
export const workRequestOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-operator') }).strict(),
  z.object({ kind: z.literal('main'), sessionId: id }).strict(),
])
export type WorkRequestOrigin = z.infer<typeof workRequestOriginSchema>
export const submitWorkRequestInputSchema = z.object({
  requestId: id,
  description: z.string().min(1).max(8192).refine(value => value.trim().length > 0),
  acceptanceCriteria: z.string().max(4096).optional(),
  sourceMessageId: id.optional(),
}).strict()
export type SubmitWorkRequestInput = z.infer<typeof submitWorkRequestInputSchema>
const workRequestResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept'), actorSessionId: id, occurredAt: time,
    taskIdsByItemKey: z.record(z.string(), id) }).strict(),
  z.object({ kind: z.literal('reject'), actorSessionId: id, occurredAt: time,
    publicReason: z.string().min(1).max(4096) }).strict(),
])
export const workRequestSchema = z.object({
  id, requestId: id, origin: workRequestOriginSchema,
  description: z.string().min(1).max(8192), acceptanceCriteria: z.string().max(4096).optional(),
  sourceMessageId: id.optional(), revision: z.number().int().positive(), createdAt: time,
  resolution: workRequestResolutionSchema.optional(),
}).strict()
export type WorkRequest = z.infer<typeof workRequestSchema>
const workActivityKindSchema = z.enum([
  'request-proposed', 'request-accepted', 'request-rejected',
  'task-created', 'task-claimed', 'task-submitted', 'task-reviewed', 'task-reassigned',
])
export const workActivitySchema = z.object({
  id, sequence: z.number().int().positive(), kind: workActivityKindSchema, occurredAt: time,
  actor: z.union([workRequestOriginSchema, z.object({ kind: z.literal('session'), sessionId: id }).strict()]),
  workRequestId: id.optional(), taskId: id.optional(), attemptId: id.optional(),
  status: z.enum(['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled']).optional(),
  decision: z.enum(['accept', 'reject']).optional(),
  reviewProvider: z.string().min(1).max(128).optional(),
  assigneeSessionId: id.optional(),
}).strict().superRefine((entry, context) => {
  const requestAction = entry.kind.startsWith('request-')
  const invalid = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, message })
  if (requestAction && entry.workRequestId === undefined) invalid('request activity requires workRequestId')
  if (!requestAction && entry.taskId === undefined) invalid('task activity requires taskId')
  if (entry.kind === 'request-proposed' ? entry.actor.kind === 'session' : entry.actor.kind !== 'session') invalid('activity actor does not match action')
  if (['task-claimed', 'task-submitted', 'task-reviewed'].includes(entry.kind) && entry.attemptId === undefined) invalid('execution activity requires attemptId')
  if (entry.kind === 'task-reviewed' && entry.decision === undefined) invalid('review activity requires decision')
})
export type WorkActivity = z.infer<typeof workActivitySchema>
export const workActivityPageSchema = z.object({
  referencedRequests: z.array(workRequestSchema).max(100),
  teamRevision: z.number().int().positive(),
  teamId: id, afterSequence: z.number().int().nonnegative(),
  retainedFromSequence: z.number().int().positive(), throughSequence: z.number().int().nonnegative(),
  entries: z.array(workActivitySchema).max(100), hasMore: z.boolean(),
}).strict()
export type WorkActivityPage = z.infer<typeof workActivityPageSchema>
