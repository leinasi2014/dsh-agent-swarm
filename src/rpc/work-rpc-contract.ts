/** Browser-safe work requests and activity. Public chat sequence and authors are separate. */
import { z } from 'zod'
import { submitWorkRequestInputSchema, workActivityPageSchema, workRequestSchema } from '../shared/work-request.js'

export const WORK_RPC_ENDPOINTS = { submit: 'work/v1/submit', requestResult: 'work/v1/requestResult', activity: 'work/v1/activity' } as const
const id = z.string().min(1).max(256)
const integer = z.number().int().nonnegative()
const target = z.object({ rootSessionId: id, teamId: id }).strict()
const base = { schemaVersion: z.literal(1), target }
export const workSubmitRequestSchema = submitWorkRequestInputSchema.omit({ sourceMessageId: true }).extend(base).strict()
export const workRequestResultRequestSchema = z.object({ ...base, requestId: id }).strict()
export const workActivityRequestSchema = z.object({ ...base, afterSequence: integer.optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
const response = { schemaVersion: z.literal(1), binding: target, teamRevision: integer, observedAt: integer }
export const workSubmitResponseSchema = z.object({ ...response, request: workRequestSchema, replayed: z.boolean() }).strict()
export const workRequestResultResponseSchema = z.discriminatedUnion('state', [
  z.object({ ...response, state: z.literal('not-found') }).strict(),
  z.object({ ...response, state: z.literal('committed'), request: workRequestSchema }).strict(),
])
export const workActivityResponseSchema = workActivityPageSchema.extend({
  ...response,
  limits: z.object({ maxDescriptionChars: integer, maxAcceptanceCriteriaChars: integer, maxRequests: integer, maxActivityEntries: integer }).strict(),
  submitEligibility: z.discriminatedUnion('state', [z.object({ state: z.literal('available') }).strict(),
    z.object({ state: z.literal('unavailable'), reason: z.enum(['not-managed', 'not-active', 'lineage-unavailable', 'request-limit', 'mailbox-full']) }).strict()]),
}).strict()
export type WorkSubmitRequest = z.infer<typeof workSubmitRequestSchema>
export type WorkSubmitResponse = z.infer<typeof workSubmitResponseSchema>
export type WorkRequestResultRequest = z.infer<typeof workRequestResultRequestSchema>
export type WorkRequestResultResponse = z.infer<typeof workRequestResultResponseSchema>
export type WorkActivityRequest = z.infer<typeof workActivityRequestSchema>
export type WorkActivityResponse = z.infer<typeof workActivityResponseSchema>
export interface WorkResponse { readonly schemaVersion: 1; readonly binding: { readonly rootSessionId: string; readonly teamId: string }; readonly teamRevision: number; readonly observedAt: number }
