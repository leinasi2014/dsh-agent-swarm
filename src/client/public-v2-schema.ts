import { z } from 'zod'
import { publicSegmentSchema } from '../shared/public-content.js'
import type { DirectoryResponse } from '../rpc/directory-contract.js'
import type { PublicChatV2Message, PublicChatRecipient } from '../rpc/public-rpc-contract.js'

const id = z.string().min(1), integer = z.number().int().nonnegative()
const publicTargetSchema = z.object({ rootSessionId: id, teamId: id })
export const publicV2Common = { schemaVersion: z.literal(2), binding: publicTargetSchema, teamRevision: integer, observedAt: integer }
export const publicV2MessageSchema = z.object({
  id, sequence: integer, createdAt: integer, text: z.string(), replyTo: id.optional(), formatVersion: z.union([z.literal(1), z.literal(2)]),
  content: z.array(publicSegmentSchema), mentionLabels: z.array(z.object({ memberId: id, label: z.string() })),
  author: z.discriminatedUnion('kind', [z.object({ kind: z.literal('local-operator') }), z.object({ kind: z.literal('agent'), sessionId: id, role: z.enum(['captain', 'member']), name: id, displayName: z.string().optional() })]),
  delivery: z.discriminatedUnion('kind', [z.object({ kind: z.literal('not-requested') }), z.object({ kind: z.literal('requested'), recipients: z.array(z.discriminatedUnion('state', [
    z.object({ recipientSessionId: id, state: z.literal('queued') }),
    z.object({ recipientSessionId: id, state: z.literal('claimed'), claimedAt: integer }),
    z.object({ recipientSessionId: id, state: z.literal('not-delivered'), settledAt: integer, reason: z.enum(['recipient-removed', 'team-archived']) }),
  ])).min(1) })]),
}).superRefine((row, ctx) => {
  if (row.delivery.kind === 'requested' && new Set(row.delivery.recipients.map(value => value.recipientSessionId)).size !== row.delivery.recipients.length) ctx.addIssue({ code: 'custom', message: 'Duplicate public recipients' })
  if (new Set(row.mentionLabels.map(value => value.memberId)).size !== row.mentionLabels.length || row.content.some(value => value.type === 'mention' && !row.mentionLabels.some(label => label.memberId === value.memberId))) ctx.addIssue({ code: 'custom', message: 'Invalid frozen mention labels' })
})
export const publicV2HistorySchema = z.object({ ...publicV2Common, entries: z.array(publicV2MessageSchema),
  appendEligibility: z.discriminatedUnion('state', [z.object({ state: z.literal('available') }), z.object({ state: z.literal('unavailable'), reason: z.enum(['not-managed', 'not-active', 'lineage-unavailable']) })]),
  totalCount: integer, returnedCount: integer, limit: z.number().int().min(1).max(100), hasEarlier: z.boolean(), hasMore: z.boolean(), firstSequence: integer.optional(), lastSequence: integer.optional(),
  limits: z.object({ maxTextBytes: integer, maxMessages: integer, maxBytes: integer, maxSegments: integer }),
})
const source = z.object({ state: z.enum(['available', 'unknown', 'unavailable', 'stale']), source: z.string(), version: z.string().optional(), observedAt: integer, updatedAt: integer.optional(), reason: z.string().optional() })
const skills = source.extend({ entries: z.array(z.object({ name: z.string(), description: z.string().optional(), descriptionTruncated: z.boolean().optional() })) })
const directorySchema = z.object({ schemaVersion: z.literal(2), binding: publicTargetSchema, directoryRevision: id, observedAt: integer,
  entries: z.array(z.object({ memberId: id, role: z.enum(['captain', 'member']), name: id, label: z.string(), responsibility: z.string(), profession: z.string().optional(), personality: z.string().optional(), biography: z.string().optional(),
    phase: z.enum(['staged', 'active', 'archived', 'provisioning', 'failed', 'removed']), profile: source,
    avatar: z.object({ state: z.enum(['generated', 'not_generated', 'unavailable']), reason: z.enum(['avatar_backend_not_implemented', 'identity_backend_not_implemented', 'notice_board_not_implemented']).optional(), svg: z.string().optional() }),
    currentTasks: z.array(z.object({ id, subject: z.string(), status: z.string() })), skills: z.object({ assigned: skills, sessionVisible: skills, catalog: skills }),
    tools: source.extend({ complete: z.boolean(), entries: z.array(z.object({ name: z.string(), state: z.enum(['available', 'approval-required', 'disabled', 'unknown']), teamPolicy: z.enum(['allow', 'ask', 'deny', 'unknown']) })) }),
    model: source.extend({ provider: z.string().optional(), model: z.string().optional(), imageInput: z.enum(['supported', 'unsupported', 'unknown']) }),
  })),
  page: z.object({ offset: integer, limit: z.number().int().min(1).max(50), totalCount: integer, returnedCount: integer, hasMore: z.boolean(), nextCursor: id.optional(), unreadRanges: z.array(z.object({ offset: integer, count: integer })) }),
})
export function decodeDirectory(value: unknown): DirectoryResponse {
  const row = directorySchema.parse(value)
  if (row.entries.length !== row.page.returnedCount || row.entries.length > row.page.limit || row.page.offset + row.entries.length > row.page.totalCount || row.page.hasMore !== (row.page.offset + row.entries.length < row.page.totalCount) || row.page.hasMore !== (row.page.nextCursor !== undefined) || new Set(row.entries.map(entry => entry.memberId)).size !== row.entries.length) throw new Error('Invalid directory page')
  return row as DirectoryResponse
}
/** Merge each recipient independently: a delayed queued projection cannot undo settlement. */
export function mergePublicMessages(old: readonly PublicChatV2Message[], incoming: readonly PublicChatV2Message[]): readonly PublicChatV2Message[] {
  const result = new Map(old.map(row => [row.id, row]))
  for (const row of incoming) {
    const previous = result.get(row.id)
    if (previous?.delivery.kind === 'requested' && row.delivery.kind === 'requested') {
      const recipients = new Map<string, PublicChatRecipient>(previous.delivery.recipients.map(value => [value.recipientSessionId, value]))
      for (const value of row.delivery.recipients) {
        const prior = recipients.get(value.recipientSessionId)
        if (prior === undefined || prior.state === 'queued') recipients.set(value.recipientSessionId, value)
      }
      result.set(row.id, { ...row, delivery: { kind: 'requested', recipients: [...recipients.values()] } })
    } else result.set(row.id, previous?.delivery.kind === 'requested' ? previous : row)
  }
  return [...result.values()].toSorted((a, b) => a.sequence - b.sequence)
}
