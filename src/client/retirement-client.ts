import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { z } from 'zod'
import { PUBLIC_RPC_CHANNEL } from '../rpc/public-rpc-contract.js'
import { retirementExecuteRequestSchema, retirementHistorySchema, retirementPreviewSchema, retirementResultSchema,
  type RetirementHistoryRequest, type RetirementRequest, type RetirementTarget } from '../shared/team-retirement.js'

export class RetirementRpcError extends Error { constructor(readonly code: string, message: string) { super(message) } }
export class RetirementClient {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly rpc: Pick<ClientConnectionRpc, 'call'>, private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>) {}
  private key(target: RetirementTarget): string { return `swarm.retirement.v1:${JSON.stringify([target.rootSessionId, target.teamId])}` }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) listener() }
  private clear(target: RetirementTarget): void { this.storage?.removeItem(this.key(target)); this.changed() }
  savedRequests(): { requests: RetirementRequest[]; invalid: number } {
    const requests: RetirementRequest[] = []; let invalid = 0
    for (let index = 0; index < (this.storage?.length ?? 0); index++) {
      const key = this.storage!.key(index)
      if (!key?.startsWith('swarm.retirement.v1:')) continue
      try {
        const request = retirementExecuteRequestSchema.parse(JSON.parse(this.storage!.getItem(key)!))
        if (key !== this.key(request.target)) throw new Error('Saved request binding changed')
        requests.push(request)
      } catch { invalid++ }
    }
    return { requests, invalid }
  }
  pending(target: RetirementTarget): RetirementRequest | undefined {
    const text = this.storage?.getItem(this.key(target))
    if (!text) return undefined
    const parsed = retirementExecuteRequestSchema.safeParse(JSON.parse(text))
    if (!parsed.success || JSON.stringify(parsed.data.target) !== JSON.stringify(target)) throw new Error('Saved retirement request is invalid')
    return parsed.data
  }
  private async call<T extends { target: RetirementTarget }>(endpoint: string, input: { target: RetirementTarget }, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.rpc.call(PUBLIC_RPC_CHANNEL, `team/v1/${endpoint}`, input, signal)
    if (!response.ok) throw new RetirementRpcError(response.error.code, response.error.message)
    const value = schema.parse(response.value)
    if (value.target.rootSessionId !== input.target.rootSessionId || value.target.teamId !== input.target.teamId) throw new Error('Retirement response binding changed')
    return value
  }
  preview(target: RetirementTarget, signal?: AbortSignal) { return this.call('preview', { schemaVersion: 1, target } as { target: RetirementTarget }, retirementPreviewSchema, signal) }
  history(input: RetirementHistoryRequest, signal?: AbortSignal) { return this.call('history', input, retirementHistorySchema, signal) }
  async execute(request: RetirementRequest, signal?: AbortSignal) {
    const input = retirementExecuteRequestSchema.parse(request)
    const saved = this.pending(input.target)
    if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(input)) throw new Error('Check the saved retirement request before starting another operation')
    this.storage?.setItem(this.key(input.target), JSON.stringify(input))
    this.changed()
    try {
      const result = await this.call('execute', input, retirementResultSchema, signal)
      if (result.requestId !== input.requestId || result.action !== input.action) throw new Error('Retirement operation binding changed')
      if (result.state !== 'pending') this.clear(input.target)
      return result
    } catch (error) {
      if (error instanceof RetirementRpcError && ['TEAM_RETIREMENT_PREVIEW_CHANGED', 'TEAM_REVISION_CONFLICT', 'SWARM_RPC_INVALID_REQUEST'].includes(error.code)) this.clear(input.target)
      throw error
    }
  }
  async result(input: RetirementRequest, signal?: AbortSignal) {
    const schema = z.union([retirementResultSchema, z.object({ state: z.literal('not-found') }).strict()])
    const response = await this.rpc.call(PUBLIC_RPC_CHANNEL, 'team/v1/requestResult', { schemaVersion: 1, target: input.target, requestId: input.requestId }, signal)
    if (!response.ok) throw new RetirementRpcError(response.error.code, response.error.message)
    const value = schema.parse(response.value)
    if (value.state !== 'not-found' && (value.target.rootSessionId !== input.target.rootSessionId || value.target.teamId !== input.target.teamId
      || value.requestId !== input.requestId || value.action !== input.action)) throw new Error('Retirement result binding changed')
    if (value.state !== 'pending' && value.state !== 'not-found') this.clear(input.target)
    return value
  }
}
