import { z } from 'zod'
import { workRequestSchema, workRequestOriginSchema, workActivitySchema } from '../shared/work-request.js'
import { expectDomain } from './error.js'
import type { TeamState } from './types.js'

export const taskSourceSchema = z.object({ workRequestId: z.string().min(1), itemKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), origin: workRequestOriginSchema }).strict()
export const openClaimNoticeSchema = z.object({ revision: z.number().int().positive(), recipientSessionIds: z.array(z.string().min(1)).max(256) }).strict()
export const teamWorkRequestsSchema = z.object({ schemaVersion: z.literal(1), requests: z.array(workRequestSchema.extend({
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/), notificationMessageId: z.string().min(1), decisionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()).max(256) }).strict()
export const teamWorkActivitySchema = z.object({ schemaVersion: z.literal(1), nextSequence: z.number().int().positive(), entries: z.array(workActivitySchema).max(1024) }).strict()
export const workRequestNoticeSchema = z.object({
  id: z.string().min(1), kind: z.literal('work-request-notice'), workRequestId: z.string().min(1), origin: workRequestOriginSchema,
  targetSessionId: z.string().min(1), targetName: z.literal('captain'), content: z.string().min(1), delivery: z.literal('wakeup'),
  phase: z.enum(['queued', 'delivered', 'cancelled', 'obsolete']), createdAt: z.number().int().nonnegative(),
  deliveredAt: z.number().int().nonnegative().optional(), obsoletedAt: z.number().int().nonnegative().optional(), obsoletedReason: z.string().min(1).optional(),
}).strict()

const valid = (condition: unknown, message: string): void => expectDomain(Boolean(condition), message, 'TEAM_STATE_CORRUPT')

export function assertWorkState(team: TeamState): void {
  const requests = team.workRequests === undefined ? [] : teamWorkRequestsSchema.parse(team.workRequests).requests
  valid(new Set(requests.map(request => request.id)).size === requests.length, 'duplicate work request id')
  valid(new Set(requests.map(request => JSON.stringify([request.origin, request.requestId]))).size === requests.length, 'duplicate work request identity')
  for (const request of requests) {
    valid((request.resolution === undefined) === (request.decisionDigest === undefined), 'work request resolution digest mismatch')
    valid(request.revision === (request.resolution === undefined ? 1 : 2), 'invalid work request revision')
    if (request.resolution?.kind === 'accept') for (const [key, id] of Object.entries(request.resolution.taskIdsByItemKey)) {
      const task = team.tasks.find(item => item.id === id)
      valid(task?.source?.workRequestId === request.id && task.source.itemKey === key, 'work request task mapping mismatch')
    }
  }
  if (team.workActivity !== undefined) {
    const state = teamWorkActivitySchema.parse(team.workActivity)
    valid(new Set(state.entries.map(entry => entry.id)).size === state.entries.length, 'duplicate activity id')
    valid(state.entries.every((entry, index) => entry.sequence === state.nextSequence - state.entries.length + index), 'activity sequence boundary mismatch')
    for (const entry of state.entries) {
      valid(entry.workRequestId === undefined || requests.some(request => request.id === entry.workRequestId), 'activity request is missing')
      valid(entry.taskId === undefined || team.tasks.some(task => task.id === entry.taskId), 'activity task is missing')
    }
  }
  for (const task of team.tasks) {
    if (task.createdBySessionId !== undefined) valid(typeof task.createdBySessionId === 'string' && task.createdBySessionId.length > 0, 'invalid creator Session')
    valid(task.assignmentMode === undefined || task.assignmentMode === 'automatic' || task.assignmentMode === 'open-claim', 'invalid assignment mode')
    valid(task.assignmentMode !== 'open-claim' || task.targetMemberSessionId === undefined, 'open task has a fixed target')
    if (task.source !== undefined) {
      taskSourceSchema.parse(task.source)
      const request = requests.find(item => item.id === task.source?.workRequestId)
      valid(request?.resolution?.kind === 'accept' && request.resolution.taskIdsByItemKey[task.source.itemKey] === task.id, 'task source request mapping is missing')
      valid(request?.origin.kind === task.source.origin.kind && (task.source.origin.kind !== 'main' || (request?.origin.kind === 'main' && request.origin.sessionId === task.source.origin.sessionId)), 'task source origin differs from request')
    }
    if (task.openClaimNotice !== undefined) {
      const notice = openClaimNoticeSchema.parse(task.openClaimNotice)
      valid(notice.revision === task.revision && new Set(notice.recipientSessionIds).size === notice.recipientSessionIds.length, 'invalid open notice revision or recipients')
    }
  }
  for (const record of [...team.tasks, ...team.attempts]) {
    for (const [time, actor] of [[record.submittedAt, record.submittedBySessionId], [record.reviewedAt, record.reviewedBySessionId]]) {
      valid((time === undefined) === (actor === undefined), 'task fact requires both actor and time')
      if (time !== undefined) valid(Number.isSafeInteger(time) && Number(time) >= 0 && typeof actor === 'string' && actor.length > 0, 'invalid task fact actor or time')
    }
  }
  for (const message of team.messages) {
    if (message.kind === 'work-request-notice') {
      workRequestNoticeSchema.parse(message)
      const request = requests.find(item => item.id === message.workRequestId)
      valid(request?.notificationMessageId === message.id && request.origin.kind === message.origin.kind
        && (message.origin.kind !== 'main' || (request.origin.kind === 'main' && request.origin.sessionId === message.origin.sessionId)), 'request notice binding mismatch')
    }
    if (message.kind === 'open-claim-notice') valid(message.senderSessionId === team.captainSessionId && message.causal?.taskId !== undefined
      && message.causal.revision !== undefined && message.causal.attemptId === undefined, 'invalid internal open claim notice')
  }
}
