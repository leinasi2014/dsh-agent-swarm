/** Public communication records inside the one Team aggregate. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TeamDomainError } from './error.js'

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
const publicMessageSchema = z.object({
  id: z.string().regex(/^public-[a-f0-9-]{36}$/u),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: timestamp, author: publicAuthorSchema, text: z.string().min(1), replyTo: z.string().min(1).optional(),
  requestId: z.string().regex(PUBLIC_REQUEST_ID_PATTERN), bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  delivery: publicDeliverySchema,
}).strict()

/** Optional on old Teams; no migration, second store or pruning authority. */
export const publicChatSchema = z.object({ schemaVersion: z.literal(1), messages: z.array(publicMessageSchema) }).strict()
export type TeamPublicMessage = z.infer<typeof publicMessageSchema>
export type TeamPublicChat = z.infer<typeof publicChatSchema>
export type TeamPublicAuthor = TeamPublicMessage['author']

export interface AppendPublicMessageInput {
  readonly author: PublicMessageAuthorInput
  readonly requestId: string
  readonly text: string
  readonly replyTo?: string
  /** Host-resolved target witnesses, never accepted from the wire. */
  readonly expectedCaptainSessionId?: string
  readonly expectedTeamRevision?: number
}
export interface AppendPublicMessageResult {
  readonly message: TeamPublicMessage
  readonly replayed: boolean
  readonly teamRevision: number
}

export function publicAuthorKey(author: PublicMessageAuthorInput): string {
  return author.kind === 'local-operator' ? 'local-operator' : `agent:${author.sessionId}`
}

/** Frozen display names are deliberately not part of retry identity. */
export function publicBindingDigest(teamId: string, input: Pick<TeamPublicMessage, 'author' | 'requestId' | 'text' | 'replyTo'> | Pick<AppendPublicMessageInput, 'author' | 'requestId' | 'text' | 'replyTo'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    1, teamId, publicAuthorKey(input.author), input.requestId, input.text, input.replyTo ?? null,
  ])).digest('hex')}`
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

/** Include request evidence and wrappers, reserving claim bytes before admission. */
export function publicChatReservedBytes(chat: TeamPublicChat): number {
  return Buffer.byteLength(JSON.stringify({ ...chat, messages: chat.messages.map(message => ({ ...message,
    delivery: message.delivery.state === 'queued'
      ? { ...message.delivery, state: 'claimed', claimedAt: Number.MAX_SAFE_INTEGER } : message.delivery,
  })) }), 'utf8')
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
