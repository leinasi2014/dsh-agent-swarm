/** Client-safe public conversation vocabulary; no execution identity is writable. */
export const PUBLIC_RPC_CHANNEL = '/swarm-public'
export const PUBLIC_RPC_ENDPOINTS = { history: 'v1/history', append: 'v1/append', requestResult: 'v1/requestResult' } as const

interface PublicChatTarget { readonly rootSessionId: string; readonly teamId: string }
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
