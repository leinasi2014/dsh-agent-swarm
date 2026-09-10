/** Client-safe public conversation vocabulary; no execution identity is writable. */
import { z } from 'zod'
import { publicImageContentSchema } from '../shared/public-image-content.js'
import type { PublicImageAvailability, PublicImageHistoryContentSegment, PublicImageInputSegment,
  PublicImageMetadata } from '../shared/public-image-content.js'
export const PUBLIC_RPC_CHANNEL = '/swarm-public'
export const PUBLIC_RPC_ENDPOINTS = { history: 'v1/history', append: 'v1/append', requestResult: 'v1/requestResult' } as const
export const PUBLIC_RPC_V2_ENDPOINTS = { history: 'v2/history', append: 'v2/append', requestResult: 'v2/requestResult', directory: 'v2/directory' } as const
export const PUBLIC_RPC_V3_ENDPOINTS = { history: 'v3/history', append: 'v3/append', requestResult: 'v3/requestResult', image: 'v3/image' } as const
import type { PublicMentionLabel, PublicSegment } from '../shared/public-content.js'

export interface PublicChatTarget { readonly rootSessionId: string; readonly teamId: string }
interface PublicChatRequest { readonly schemaVersion: 1; readonly target: PublicChatTarget }
export interface PublicChatAppendRequest extends PublicChatRequest {
  readonly requestId: string; readonly text: string; readonly replyTo?: string
}
export interface PublicChatRequestResultRequest extends PublicChatRequest { readonly requestId: string }
export interface PublicChatHistoryRequest extends PublicChatRequest {
  readonly limit?: number; readonly beforeSequence?: number; readonly afterSequence?: number
}
export interface PublicChatMessage {
  readonly id: string; readonly sequence: number; readonly createdAt: number; readonly text: string; readonly replyTo?: string
  readonly author: { readonly kind: 'local-operator' } | {
    readonly kind: 'agent'; readonly sessionId: string; readonly role: 'captain' | 'member'; readonly name: string; readonly displayName?: string
  }
  readonly delivery: { readonly state: 'not-requested' } | { readonly state: 'queued'; readonly recipientSessionId: string }
    | { readonly state: 'claimed'; readonly recipientSessionId: string; readonly claimedAt: number }
}
type PublicChatAppendEligibility = { readonly state: 'available' }
  | { readonly state: 'unavailable'; readonly reason: 'not-managed' | 'not-active' | 'lineage-unavailable' }
export interface PublicChatResponse {
  readonly schemaVersion: 1; readonly binding: PublicChatTarget; readonly teamRevision: number; readonly observedAt: number
}
export interface PublicChatAppendResponse extends PublicChatResponse { readonly message: PublicChatMessage; readonly replayed: boolean }
export type PublicChatRequestResultResponse = PublicChatResponse & ({ readonly state: 'not-found' } | { readonly state: 'committed'; readonly message: PublicChatMessage })
export interface PublicChatHistoryResponse extends PublicChatResponse {
  readonly entries: readonly PublicChatMessage[]; readonly appendEligibility: PublicChatAppendEligibility
  readonly totalCount: number; readonly returnedCount: number; readonly limit: number
  readonly hasEarlier: boolean; readonly hasMore: boolean; readonly firstSequence?: number; readonly lastSequence?: number
  readonly limits: { readonly maxTextBytes: number; readonly maxMessages: number; readonly maxBytes: number }
}

export interface PublicChatV2AppendRequest {
  readonly schemaVersion: 2; readonly target: PublicChatTarget; readonly requestId: string
  readonly content: readonly PublicSegment[]; readonly replyTo?: string
}
export interface PublicChatV2HistoryRequest extends Omit<PublicChatHistoryRequest, 'schemaVersion'> { readonly schemaVersion: 2 }
export interface PublicChatV2RequestResultRequest extends Omit<PublicChatRequestResultRequest, 'schemaVersion'> { readonly schemaVersion: 2 }
export type PublicChatRecipient = { readonly recipientSessionId: string } & (
  { readonly state: 'queued' } | { readonly state: 'claimed'; readonly claimedAt: number }
  | { readonly state: 'not-delivered'; readonly settledAt: number; readonly reason: 'recipient-removed' | 'team-archived' }
)
export interface PublicChatV2Message extends Omit<PublicChatMessage, 'delivery'> {
  readonly formatVersion: 1 | 2; readonly content: readonly PublicSegment[]; readonly mentionLabels: readonly PublicMentionLabel[]
  readonly delivery: { readonly kind: 'not-requested' } | { readonly kind: 'requested'; readonly recipients: readonly PublicChatRecipient[] }
}
export interface PublicChatV2Response extends Omit<PublicChatResponse, 'schemaVersion'> { readonly schemaVersion: 2 }
export interface PublicChatV2AppendResponse extends PublicChatV2Response { readonly message: PublicChatV2Message; readonly replayed: boolean }
export type PublicChatV2RequestResultResponse = PublicChatV2Response & ({ readonly state: 'not-found' } | { readonly state: 'committed'; readonly message: PublicChatV2Message })
export interface PublicChatV2HistoryResponse extends Omit<PublicChatHistoryResponse, 'schemaVersion' | 'entries' | 'limits'> {
  readonly schemaVersion: 2; readonly entries: readonly PublicChatV2Message[]
  readonly limits: PublicChatHistoryResponse['limits'] & { readonly maxSegments: number }
}

const v3Target = z.object({ rootSessionId: z.string().min(1), teamId: z.string().min(1) }).strict()
const v3Common = { schemaVersion: z.literal(3), target: v3Target }
const v3RequestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u)

/** One append owns upload and commit. No receipt, durable reference or author is accepted from a caller. */
export const publicChatV3AppendRequestSchema = z.object({
  ...v3Common, requestId: v3RequestId, content: publicImageContentSchema, replyTo: z.string().min(1).optional(),
}).strict()
export const publicChatV3RequestResultRequestSchema = z.object({ ...v3Common, requestId: v3RequestId }).strict()
export const publicChatV3HistoryRequestSchema = z.object({
  ...v3Common, limit: z.number().int().min(1).max(100).default(50),
  beforeSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(value => value.beforeSequence === undefined || value.afterSequence === undefined, 'Choose one cursor')
export const publicChatV3ImageRequestSchema = z.object({
  ...v3Common, messageId: z.string().min(1), imageId: z.string().min(1).max(256),
}).strict()

export interface PublicChatV3AppendRequest extends Omit<PublicChatV2AppendRequest, 'schemaVersion' | 'content'> {
  readonly schemaVersion: 3; readonly content: readonly PublicImageInputSegment[]
}
export interface PublicChatV3HistoryRequest extends Omit<PublicChatHistoryRequest, 'schemaVersion'> { readonly schemaVersion: 3 }
export interface PublicChatV3RequestResultRequest extends Omit<PublicChatRequestResultRequest, 'schemaVersion'> { readonly schemaVersion: 3 }
export interface PublicChatV3ImageRequest {
  readonly schemaVersion: 3; readonly target: PublicChatTarget; readonly messageId: string; readonly imageId: string
}
/** v3 projects older records without rewriting their formatVersion or historical content. */
export interface PublicChatV3Message extends Omit<PublicChatV2Message, 'formatVersion' | 'content'> {
  readonly formatVersion: 1 | 2 | 3; readonly content: readonly PublicImageHistoryContentSegment[]
}
export interface PublicChatV3Response extends Omit<PublicChatResponse, 'schemaVersion'> { readonly schemaVersion: 3 }
export interface PublicChatV3AppendResponse extends PublicChatV3Response { readonly message: PublicChatV3Message; readonly replayed: boolean }
export type PublicChatV3RequestResultResponse = PublicChatV3Response & (
  { readonly state: 'not-found' } | { readonly state: 'committed'; readonly message: PublicChatV3Message }
)
export interface PublicChatV3HistoryResponse extends Omit<PublicChatV2HistoryResponse, 'schemaVersion' | 'entries'> {
  readonly schemaVersion: 3; readonly entries: readonly PublicChatV3Message[]; readonly imageAvailability: PublicImageAvailability
}
/** Only the authorized image endpoint returns encoded bytes, checked against the stored metadata by Host. */
export interface PublicChatV3ImageResponse extends PublicChatV3Response {
  readonly messageId: string; readonly imageId: string; readonly image: PublicImageMetadata & { readonly data: string }
}
