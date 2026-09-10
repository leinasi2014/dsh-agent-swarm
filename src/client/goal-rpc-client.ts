import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { z } from 'zod'
import { PUBLIC_RPC_CHANNEL } from '../rpc/public-rpc-contract.js'
import { GOAL_RPC_ENDPOINTS, goalReadRequestSchema, goalReadResponseSchema, goalSaveRequestSchema, goalControlRequestSchema,
  goalOperationResponseSchema, goalRequestResultRequestSchema, goalRequestResultResponseSchema,
  type GoalReadRequest, type GoalReadResponse, type GoalSaveRequest, type GoalControlRequest, type GoalOperationResponse,
  type GoalRequestResultRequest, type GoalRequestResultResponse } from '../rpc/goal-rpc-contract.js'

export class GoalRpcError extends Error { constructor(readonly code: string, message: string) { super(message) } }

/** The existing Connection authenticates the operator; payloads contain target hints, never actors. */
export class GoalClient {
  constructor(private readonly transport: Pick<ClientConnectionRpc, 'call'>) {}
  private async exchange<T extends GoalReadResponse>(endpoint: string, input: GoalReadRequest & { expectedLifecycleRevision?: number }, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const envelope = await this.transport.call(PUBLIC_RPC_CHANNEL, endpoint, input, signal)
    if (!envelope.ok) throw new GoalRpcError(envelope.error.code, envelope.error.message)
    const value = schema.parse(envelope.value)
    if (value.binding.teamId !== input.target.teamId || value.binding.rootSessionId !== input.target.rootSessionId) throw new Error('Goal response binding changed')
    if ('operationRevision' in value && (value.operationRevision !== (input.expectedLifecycleRevision ?? -1) + 1
      || typeof value.operationRevision !== 'number' || value.operationRevision > (value.snapshot.lifecycle?.revision ?? 0))) throw new Error('Goal operation revision changed')
    return value
  }
  async read(input: GoalReadRequest, signal?: AbortSignal): Promise<GoalReadResponse> {
    return await this.exchange(GOAL_RPC_ENDPOINTS.read, goalReadRequestSchema.parse(input), goalReadResponseSchema, signal)
  }
  async save(input: GoalSaveRequest, signal?: AbortSignal): Promise<GoalOperationResponse> {
    return await this.exchange(GOAL_RPC_ENDPOINTS.save, goalSaveRequestSchema.parse(input), goalOperationResponseSchema, signal)
  }
  async control(input: GoalControlRequest, signal?: AbortSignal): Promise<GoalOperationResponse> {
    return await this.exchange(GOAL_RPC_ENDPOINTS.control, goalControlRequestSchema.parse(input), goalOperationResponseSchema, signal)
  }
  async requestResult(input: GoalRequestResultRequest, signal?: AbortSignal): Promise<GoalRequestResultResponse> {
    return await this.exchange(GOAL_RPC_ENDPOINTS.requestResult, goalRequestResultRequestSchema.parse(input), goalRequestResultResponseSchema, signal)
  }
}
