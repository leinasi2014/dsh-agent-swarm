import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { PUBLIC_RPC_CHANNEL } from '../rpc/public-rpc-contract.js'
import { WORK_RPC_ENDPOINTS, workSubmitRequestSchema, workSubmitResponseSchema, workRequestResultRequestSchema, workRequestResultResponseSchema,
  workActivityRequestSchema, workActivityResponseSchema, type WorkSubmitRequest, type WorkSubmitResponse,
  type WorkRequestResultRequest, type WorkRequestResultResponse, type WorkActivityRequest, type WorkActivityResponse } from '../rpc/work-rpc-contract.js'

/** A decoded Host rejection. Transport and malformed responses keep the outcome unknown. */
export class WorkRpcError extends Error { constructor(readonly code: string, message: string) { super(message) } }

/** Work facts use the existing authenticated Connection; no Session prompt impersonation. */
export class WorkRequestClient {
  constructor(private readonly rpc: Pick<ClientConnectionRpc, 'call'>) {}
  private async call(endpoint: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.rpc.call(PUBLIC_RPC_CHANNEL, endpoint, request, signal)
    if (!response.ok) throw new WorkRpcError(response.error.code, response.error.message)
    return response.value
  }
  async submit(request: WorkSubmitRequest, signal?: AbortSignal): Promise<WorkSubmitResponse> {
    const value = workSubmitResponseSchema.parse(await this.call(WORK_RPC_ENDPOINTS.submit, workSubmitRequestSchema.parse(request), signal))
    assertBinding(value, request.target)
    if (value.request.requestId !== request.requestId || value.request.origin.kind !== 'local-operator'
      || value.request.description !== request.description.trim() || (value.request.acceptanceCriteria ?? '') !== (request.acceptanceCriteria ?? '').trim()) throw new Error('Work receipt payload changed')
    return value
  }
  async requestResult(request: WorkRequestResultRequest, signal?: AbortSignal): Promise<WorkRequestResultResponse> {
    const value = workRequestResultResponseSchema.parse(await this.call(WORK_RPC_ENDPOINTS.requestResult, workRequestResultRequestSchema.parse(request), signal))
    assertBinding(value, request.target)
    if (value.state === 'committed' && (value.request.requestId !== request.requestId || value.request.origin.kind !== 'local-operator')) throw new Error('Work result identity changed')
    return value
  }
  async activity(request: WorkActivityRequest, signal?: AbortSignal): Promise<WorkActivityResponse> {
    const value = workActivityResponseSchema.parse(await this.call(WORK_RPC_ENDPOINTS.activity, workActivityRequestSchema.parse(request), signal))
    assertBinding(value, request.target)
    if (value.teamId !== request.target.teamId || value.afterSequence !== (request.afterSequence ?? 0) || value.entries.length > (request.limit ?? 100)
      || value.retainedFromSequence > value.throughSequence + 1 || new Set(value.entries.map(row => row.id)).size !== value.entries.length
      || new Set(value.referencedRequests.map(row => row.id)).size !== value.referencedRequests.length
      || value.referencedRequests.some(row => !value.entries.some(entry => entry.workRequestId === row.id))
      || value.entries.some((row, index) => row.sequence !== Math.max(value.afterSequence + 1, value.retainedFromSequence) + index || row.sequence > value.throughSequence)
      || (value.hasMore && (value.entries.length === 0 || value.entries.at(-1)!.sequence >= value.throughSequence))) throw new Error('Invalid work activity page')
    return value
  }
}

function assertBinding(value: { binding: WorkSubmitRequest['target'] }, target: WorkSubmitRequest['target']): void {
  if (value.binding.rootSessionId !== target.rootSessionId || value.binding.teamId !== target.teamId) throw new Error('Work response binding changed')
}
