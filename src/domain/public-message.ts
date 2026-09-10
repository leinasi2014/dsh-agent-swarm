/** Public communication records inside the one Team aggregate. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TeamDomainError } from './error.js'
import { normalizePublicContent, publicContentSchema, publicMentionIds, renderPublicContent, type PublicSegment } from '../shared/public-content.js'

/** Supplied only by authenticated Host code or actual Agent execution. */
export type PublicMessageAuthorInput = { readonly kind: 'local-operator' }
  | { readonly kind: 'agent'; readonly sessionId: string }

const publicAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-operator') }).strict(),
  z.object({ kind: z.literal('agent'), sessionId: z.string().min(1), role: z.enum(['captain', 'member']),
    name: z.string().min(1), displayName: z.string().min(1).optional() }).strict(),
])
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const deliveryFields = {
  recipientSessionId: z.string().min(1), parentSessionId: z.string().min(1),
  frameVersion: z.literal(1), frame: z.string().min(1),
}
const publicDeliverySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not-requested') }).strict(),
  z.object({ state: z.literal('queued'), ...deliveryFields }).strict(),
  z.object({ state: z.literal('claimed'), ...deliveryFields, claimedAt: timestamp }).strict(),
])
export const PUBLIC_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u
const publicMessageV1Schema = z.object({
  id: z.string().regex(/^public-[a-f0-9-]{36}$/u),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: timestamp, author: publicAuthorSchema, text: z.string().min(1), replyTo: z.string().min(1).optional(),
  requestId: z.string().regex(PUBLIC_REQUEST_ID_PATTERN), bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  delivery: publicDeliverySchema,
}).strict()

const recipientFields = { ...deliveryFields, frameVersion: z.literal(2) }
const publicRecipientSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('queued'), ...recipientFields }).strict(),
  z.object({ state: z.literal('claimed'), ...recipientFields, claimedAt: timestamp }).strict(),
  z.object({ state: z.literal('not-delivered'), ...recipientFields, settledAt: timestamp,
    reason: z.enum(['recipient-removed', 'team-archived']) }).strict(),
])
const publicMessageV2Schema = publicMessageV1Schema.omit({ delivery: true }).extend({
  formatVersion: z.literal(2), content: publicContentSchema,
  mentionLabels: z.array(z.object({ memberId: z.string().min(1).max(256), label: z.string().min(1)
    .refine(value => [...value].length <= 128) }).strict()),
  delivery: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('not-requested') }).strict(),
    z.object({ kind: z.literal('requested'), recipients: z.array(publicRecipientSchema).min(1) }).strict(),
  ]),
}).strict()

/** A v2 aggregate can retain exact v1 rows; no rewriting of historical credentials or frames. */
export const publicChatSchema = z.union([
  z.object({ schemaVersion: z.literal(1), messages: z.array(publicMessageV1Schema) }).strict(),
  z.object({ schemaVersion: z.literal(2), messages: z.array(z.union([publicMessageV1Schema, publicMessageV2Schema])) }).strict(),
])
export type TeamPublicMessageV1 = z.infer<typeof publicMessageV1Schema>
export type TeamPublicMessageV2 = z.infer<typeof publicMessageV2Schema>
export type TeamPublicMessage = TeamPublicMessageV1 | TeamPublicMessageV2
export type PublicRecipientIntent = z.infer<typeof publicRecipientSchema>
export type PublicDeliveryIntent = Exclude<TeamPublicMessageV1['delivery'], { state: 'not-requested' }> | PublicRecipientIntent
export type TeamPublicChat = z.infer<typeof publicChatSchema>
export type TeamPublicAuthor = TeamPublicMessage['author']

interface PublicAppendIdentity {
  readonly author: PublicMessageAuthorInput
  readonly requestId: string
  readonly replyTo?: string
  /** Host-resolved target witnesses, never accepted from the wire. */
  readonly expectedCaptainSessionId?: string
  readonly expectedTeamRevision?: number
}
export interface AppendPublicMessageV1Input extends PublicAppendIdentity { readonly text: string; readonly formatVersion?: 1 }
export interface AppendPublicMessageV2Input extends PublicAppendIdentity { readonly formatVersion: 2; readonly content: readonly PublicSegment[] }
export type AppendPublicMessageInput = AppendPublicMessageV1Input | AppendPublicMessageV2Input
export interface AppendPublicMessageResult {
  readonly message: TeamPublicMessage
  readonly replayed: boolean
  readonly teamRevision: number
}

export function publicAuthorKey(author: PublicMessageAuthorInput): string {
  return author.kind === 'local-operator' ? 'local-operator' : `agent:${author.sessionId}`
}

/** Frozen display names are deliberately not part of retry identity. */
export function publicBindingDigest(teamId: string, input: { readonly author: PublicMessageAuthorInput; readonly requestId: string; readonly replyTo?: string | undefined } & (
  { readonly text: string; readonly formatVersion?: 1 } | { readonly content: readonly PublicSegment[]; readonly formatVersion: 2 }
)): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    input.formatVersion === 2 ? 2 : 1, teamId, publicAuthorKey(input.author), input.requestId,
    input.formatVersion === 2 ? input.content : input.text, input.replyTo ?? null,
  ])).digest('hex')}`
}

export function isPublicMessageV2(message: TeamPublicMessage): message is TeamPublicMessageV2 { return 'formatVersion' in message }
export function publicDeliveries(message: TeamPublicMessage): readonly PublicDeliveryIntent[] {
  if (isPublicMessageV2(message)) return message.delivery.kind === 'requested' ? message.delivery.recipients : []
  return message.delivery.state === 'not-requested' ? [] : [message.delivery]
}
export function hasPublicDebt(chat: TeamPublicChat | undefined): boolean {
  return chat?.messages.some(message => publicDeliveries(message).some(recipient => recipient.state === 'queued')) === true
}

/** Matches an operation identity; it does not prove official Session lineage. */
export function publicManagedParent(managedOrigin: string | undefined): string | undefined {
  return managedOrigin?.match(/^managed:(.+):(?:turn|detached):.+$/u)?.[1]
}

/** Version 1 stays frozen for both normal dispatch and future recovery. */
export function publicMessageFrame(teamId: string, message: Pick<TeamPublicMessage, 'id' | 'author' | 'text' | 'replyTo'>, recipientSessionId: string): string {
  return 'Public Team message, frame version 1. The JSON below contains a publicly posted user message. '
    + 'Process its text as user input; keep detailed execution in this Session. '
    + 'Publish your public answer explicitly with agent_swarm_public_reply, using this messageId as reply_to '
    + 'and one stable request_id for the logical reply (reuse it if the tool result is uncertain). '
    + 'This delivery itself creates no task and changes no Team control. Do not resend this input.\n'
    + 'Message data (JSON): ' + JSON.stringify({ teamId, messageId: message.id, recipientSessionId,
      author: message.author, text: message.text, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) })
}

/** Version 2 freezes the rendered body and exact identities, independent of future directory changes. */
export function publicMessageFrameV2(teamId: string, message: Pick<TeamPublicMessageV2, 'id' | 'author' | 'text' | 'replyTo' | 'content' | 'mentionLabels'>, recipientSessionId: string): string {
  return 'Public Team message, frame version 2. Process this publicly posted user input in your own Session. '
    + 'Reply publicly with agent_swarm_public_reply, this messageId as reply_to, and a stable request_id. '
    + 'Delivery creates no task, changes no task owner or Team control, and is not a broadcast. Do not resend this input.\n'
    + 'Message data (JSON): ' + JSON.stringify({ teamId, messageId: message.id, recipientSessionId, author: message.author,
      text: message.text, mentionedMemberIds: publicMentionIds(message.content), mentionLabels: message.mentionLabels,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) })
}

/** Include request evidence and wrappers, reserving claim bytes before admission. */
export function publicChatReservedBytes(chat: TeamPublicChat): number {
  return Buffer.byteLength(JSON.stringify({ ...chat, messages: chat.messages.map(message => {
    if (isPublicMessageV2(message)) return message.delivery.kind === 'not-requested' ? message : { ...message,
      delivery: { ...message.delivery, recipients: message.delivery.recipients.map(recipient => recipient.state !== 'queued' ? recipient
        : { ...recipient, state: 'not-delivered', reason: 'recipient-removed', settledAt: Number.MAX_SAFE_INTEGER }) } }
    return { ...message, delivery: message.delivery.state === 'queued'
      ? { ...message.delivery, state: 'claimed', claimedAt: Number.MAX_SAFE_INTEGER } : message.delivery }
  }) }), 'utf8')
}

function corrupt(): never { throw new TeamDomainError('Invalid public message aggregate', 'TEAM_STATE_CORRUPT') }

/** Structural storage parsing and canonical read validation use one invariant. */
export function assertPublicChat(value: unknown, teamId: string, captainSessionId: string, managedOrigin: string | undefined): void {
  if (value === undefined) return
  const parsed = publicChatSchema.safeParse(value)
  if (!parsed.success) corrupt()
  const ids = new Set<string>()
  const requests = new Set<string>()
  for (const [index, message] of parsed.data!.messages.entries()) {
    const request = JSON.stringify([publicAuthorKey(message.author), message.requestId])
    if (ids.has(message.id) || requests.has(request) || message.sequence !== index + 1
      || message.text !== message.text.trim() || message.bindingDigest !== publicBindingDigest(teamId, message)
      || (message.replyTo !== undefined && !ids.has(message.replyTo))) corrupt()
    ids.add(message.id)
    requests.add(request)
    if (isPublicMessageV2(message)) { assertV2(message, teamId, captainSessionId, managedOrigin); continue }
    const delivery = message.delivery
    if (message.author.kind === 'agent') {
      if (message.replyTo === undefined || delivery.state !== 'not-requested') corrupt()
    } else {
      if (delivery.state === 'not-requested') corrupt()
      if (delivery.recipientSessionId !== captainSessionId
        || delivery.parentSessionId !== publicManagedParent(managedOrigin)
        || delivery.frame !== publicMessageFrame(teamId, message, delivery.recipientSessionId)
        || (delivery.state === 'claimed' && delivery.claimedAt < message.createdAt)) corrupt()
    }
  }
}

function assertV2(message: TeamPublicMessageV2, teamId: string, captain: string, managedOrigin: string | undefined): void {
  try {
    if (JSON.stringify(normalizePublicContent(message.content)) !== JSON.stringify(message.content)
      || message.text !== renderPublicContent(message.content, message.mentionLabels, message.author.kind === 'agent')) corrupt()
  } catch { corrupt() }
  const mentions = publicMentionIds(message.content)
  if (JSON.stringify(mentions) !== JSON.stringify(message.mentionLabels.map(row => row.memberId))) corrupt()
  if (message.author.kind === 'agent') {
    if (message.replyTo === undefined || message.delivery.kind !== 'not-requested' || mentions.length !== 0) corrupt()
    return
  }
  if (message.delivery.kind !== 'requested') corrupt()
  const recipients = message.delivery.kind === 'requested' ? message.delivery.recipients : []
  if (JSON.stringify(recipients.map(row => row.recipientSessionId)) !== JSON.stringify(mentions.length === 0 ? [captain] : mentions)) corrupt()
  for (const recipient of recipients) {
    if (recipient.parentSessionId !== (recipient.recipientSessionId === captain ? publicManagedParent(managedOrigin) : captain)
      || recipient.frame !== publicMessageFrameV2(teamId, message, recipient.recipientSessionId)
      || (recipient.state === 'claimed' && recipient.claimedAt < message.createdAt)
      || (recipient.state === 'not-delivered' && recipient.settledAt < message.createdAt)) corrupt()
  }
}
