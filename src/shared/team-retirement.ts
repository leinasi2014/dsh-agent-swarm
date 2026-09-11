/** Local operator lifecycle wire contract. Session paths and deletion lists stay on Host. */
import { z } from 'zod'

const id = z.string().min(1).max(256)
const counter = z.number().int().safe().nonnegative()
const retirementTargetSchema = z.object({ rootSessionId: id, teamId: id }).strict()
export const retirementCountsSchema = z.object({ sessions: counter, memories: counter, humanInteractions: counter,
  workflowRuns: counter, protectedSessions: counter, unfinishedTasks: counter, activeAttempts: counter }).strict()
const base = { schemaVersion: z.literal(1), target: retirementTargetSchema }
export const retirementPreviewRequestSchema = z.object(base).strict()
export const retirementExecuteRequestSchema = z.object({ ...base, action: z.enum(['archive', 'delete']),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u), expectedTeamRevision: counter,
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().refine(input => input.action !== 'delete' || input.previewDigest !== undefined, 'Deletion requires the Host preview')
export const retirementResultRequestSchema = z.object({ ...base, requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u) }).strict()
export const retirementPreviewSchema = z.object({ ...base, teamName: id, teamRevision: counter, phase: z.enum(['staged', 'active', 'archived']),
  counts: retirementCountsSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  deletion: z.union([z.object({ available: z.literal(true) }).strict(), z.object({ available: z.literal(false), reason: z.string() }).strict()]),
}).strict()
export const retirementResultSchema = z.object({ ...base, requestId: id, action: z.enum(['archive', 'delete']),
  state: z.enum(['pending', 'confirmation-required', 'completed']), counts: retirementCountsSchema, replayed: z.boolean(), teamRevision: counter,
}).strict()
export const retirementHistoryRequestSchema = z.object({ ...base, sessionId: id.optional(), cursor: counter.default(0) }).strict()
export const retirementHistorySchema = z.object({ ...base, teamName: id, readonly: z.literal(true),
  sessions: z.array(z.object({ id, label: z.string(), role: z.enum(['captain', 'member', 'descendant']), available: z.boolean() }).strict()).max(8192),
  sessionId: id.optional(), cursor: counter, nextCursor: counter.optional(),
  entries: z.array(z.object({ sequence: counter, role: z.enum(['user', 'assistant', 'tool', 'context']), content: z.string().max(32768), truncated: z.boolean() }).strict()).max(50),
}).strict()
export type RetirementTarget = z.infer<typeof retirementTargetSchema>
export type RetirementCounts = z.infer<typeof retirementCountsSchema>
export type RetirementPreview = z.infer<typeof retirementPreviewSchema>
export type RetirementRequest = z.infer<typeof retirementExecuteRequestSchema>
export type RetirementResult = z.infer<typeof retirementResultSchema>
export type RetirementHistoryRequest = z.infer<typeof retirementHistoryRequestSchema>
export type RetirementHistory = z.infer<typeof retirementHistorySchema>
