import { z } from 'zod'
import { controlGoalInputSchema, goalSnapshotSchema, saveGoalInputSchema } from '../shared/goal-lifecycle.js'

export const GOAL_RPC_ENDPOINTS = { read: 'goal/v1/read', save: 'goal/v1/save', control: 'goal/v1/control', requestResult: 'goal/v1/requestResult' } as const
const id = z.string().min(1).max(256)
const counter = z.number().int().safe().nonnegative()
const target = z.object({ rootSessionId: id, teamId: id }).strict()
const base = { schemaVersion: z.literal(1), target }
export const goalReadRequestSchema = z.object(base).strict()
export const goalSaveRequestSchema = saveGoalInputSchema.extend(base).strict()
export const goalControlRequestSchema = controlGoalInputSchema.extend(base).strict()
export const goalRequestResultRequestSchema = z.object({ ...base, requestId: id, expectedLifecycleRevision: counter }).strict()
const response = { schemaVersion: z.literal(1), binding: target, teamRevision: counter, observedAt: counter, snapshot: goalSnapshotSchema }
export const goalReadResponseSchema = z.object(response).strict()
export const goalOperationResponseSchema = z.object({ ...response, operationRevision: counter, replayed: z.boolean() }).strict()
export const goalRequestResultResponseSchema = z.discriminatedUnion('state', [
  z.object({ ...response, state: z.literal('committed'), operationRevision: counter }).strict(),
  z.object({ ...response, state: z.literal('not-found') }).strict(),
  z.object({ ...response, state: z.literal('expired') }).strict(),
])
export type GoalReadRequest = z.infer<typeof goalReadRequestSchema>
export type GoalReadResponse = z.infer<typeof goalReadResponseSchema>
export type GoalSaveRequest = z.infer<typeof goalSaveRequestSchema>
export type GoalControlRequest = z.infer<typeof goalControlRequestSchema>
export type GoalOperationResponse = z.infer<typeof goalOperationResponseSchema>
export type GoalRequestResultRequest = z.infer<typeof goalRequestResultRequestSchema>
export type GoalRequestResultResponse = z.infer<typeof goalRequestResultResponseSchema>
