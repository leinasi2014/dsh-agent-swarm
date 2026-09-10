import { z } from 'zod'
import type { DirectoryRequest, DirectoryResponse } from '../rpc/directory-contract.js'
import type { PublicChatV2AppendRequest, PublicChatV2AppendResponse, PublicChatV2HistoryRequest, PublicChatV2HistoryResponse, PublicChatV2RequestResultRequest, PublicChatV2RequestResultResponse } from '../rpc/public-rpc-contract.js'
import { decodeDirectory, publicV2Common, publicV2MessageSchema, publicV2HistorySchema } from './public-v2-schema.js'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { PUBLIC_RPC_CHANNEL, PUBLIC_RPC_ENDPOINTS, PUBLIC_RPC_V2_ENDPOINTS } from '../rpc/public-rpc-contract.js'
import type { PublicChatAppendRequest, PublicChatAppendResponse, PublicChatHistoryRequest, PublicChatHistoryResponse, PublicChatRequestResultRequest, PublicChatRequestResultResponse } from '../rpc/public-rpc-contract.js'

const id = z.string().min(1)
const integer = z.number().int().nonnegative()
const target = z.object({ rootSessionId: id, teamId: id })
const message = z.object({
  id, sequence: integer, createdAt: integer, text: z.string(), replyTo: id.optional(),
  author: z.discriminatedUnion('kind', [z.object({ kind: z.literal('local-operator') }), z.object({ kind: z.literal('agent'), sessionId: id, role: z.enum(['captain', 'member']), name: id, displayName: z.string().optional() })]),
  delivery: z.discriminatedUnion('state', [z.object({ state: z.literal('not-requested') }), z.object({ state: z.literal('queued'), recipientSessionId: id }), z.object({ state: z.literal('claimed'), recipientSessionId: id, claimedAt: integer })]),
})
const common = { schemaVersion: z.literal(1), binding: target, teamRevision: integer, observedAt: integer }
const history = z.object({ ...common, entries: z.array(message), appendEligibility: z.discriminatedUnion('state', [z.object({ state: z.literal('available') }), z.object({ state: z.literal('unavailable'), reason: z.enum(['not-managed', 'not-active', 'lineage-unavailable']) })]), totalCount: integer, returnedCount: integer, limit: z.number().int().min(1).max(100), hasEarlier: z.boolean(), hasMore: z.boolean(), firstSequence: integer.optional(), lastSequence: integer.optional(), limits: z.object({ maxTextBytes: integer, maxMessages: integer, maxBytes: integer }) })
const append = z.object({ ...common, message, replayed: z.boolean() })
const result = z.discriminatedUnion('state', [z.object({ ...common, state: z.literal('not-found') }), z.object({ ...common, state: z.literal('committed'), message })])

/** A decoded endpoint rejection, distinguished from an unknown transport outcome. */
export class PublicChatRpcError extends Error {
  constructor(readonly code: string, detail: string) { super(detail) }
}

/** Only the official Connection RPC carrier is used; all returned values are decoded. */
export class PublicChatClient {
  constructor(private readonly rpc: Pick<ClientConnectionRpc, 'call'>) {}
  private async call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.rpc.call(PUBLIC_RPC_CHANNEL, endpoint, payload, signal)
    if (!response.ok) throw new PublicChatRpcError(response.error.code, response.error.message)
    return response.value
  }
  async history(request: PublicChatHistoryRequest, signal?: AbortSignal): Promise<PublicChatHistoryResponse> {
    const value = history.parse(await this.call(PUBLIC_RPC_ENDPOINTS.history, request, signal))
    if (value.entries.length !== value.returnedCount || value.entries.length > value.limit
      || value.entries.some((entry, index) => index > 0 && entry.sequence <= value.entries[index - 1]!.sequence)
      || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length
      || value.firstSequence !== value.entries[0]?.sequence || value.lastSequence !== value.entries.at(-1)?.sequence) throw new Error('Invalid public history page')
    return value as PublicChatHistoryResponse
  }
  async append(request: PublicChatAppendRequest, signal?: AbortSignal): Promise<PublicChatAppendResponse> {
    return append.parse(await this.call(PUBLIC_RPC_ENDPOINTS.append, request, signal)) as PublicChatAppendResponse
  }
  async requestResult(request: PublicChatRequestResultRequest, signal?: AbortSignal): Promise<PublicChatRequestResultResponse> {
    return result.parse(await this.call(PUBLIC_RPC_ENDPOINTS.requestResult, request, signal)) as PublicChatRequestResultResponse
  }
  async historyV2(request: PublicChatV2HistoryRequest, signal?: AbortSignal): Promise<PublicChatV2HistoryResponse> {
    const value = publicV2HistorySchema.parse(await this.call(PUBLIC_RPC_V2_ENDPOINTS.history, request, signal))
    if (value.entries.length !== value.returnedCount || value.entries.length > value.limit
      || value.entries.some((entry, index) => index > 0 && entry.sequence <= value.entries[index - 1]!.sequence)
      || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length
      || value.firstSequence !== value.entries[0]?.sequence || value.lastSequence !== value.entries.at(-1)?.sequence) throw new Error('Invalid public history page')
    return value as PublicChatV2HistoryResponse
  }
  async appendV2(request: PublicChatV2AppendRequest, signal?: AbortSignal): Promise<PublicChatV2AppendResponse> {
    return z.object({ ...publicV2Common, message: publicV2MessageSchema, replayed: z.boolean() }).parse(await this.call(PUBLIC_RPC_V2_ENDPOINTS.append, request, signal)) as PublicChatV2AppendResponse
  }
  async requestResultV2(request: PublicChatV2RequestResultRequest, signal?: AbortSignal): Promise<PublicChatV2RequestResultResponse> {
    return z.discriminatedUnion('state', [z.object({ ...publicV2Common, state: z.literal('not-found') }), z.object({ ...publicV2Common, state: z.literal('committed'), message: publicV2MessageSchema })]).parse(await this.call(PUBLIC_RPC_V2_ENDPOINTS.requestResult, request, signal)) as PublicChatV2RequestResultResponse
  }
  async directory(request: DirectoryRequest, signal?: AbortSignal): Promise<DirectoryResponse> {
    return decodeDirectory(await this.call(PUBLIC_RPC_V2_ENDPOINTS.directory, request, signal))
  }

}
