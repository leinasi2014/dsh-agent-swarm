/** Browser-safe R2/I3-R wire vocabulary. This module imports no Host or storage code. */
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'

export const SWARM_READ_RPC_PROTOCOL = 'dsh-agent-swarm/read-rpc' as const
export const SWARM_READ_RPC_VERSION = 1 as const
export const SWARM_READ_RPC_NAMESPACE = '/swarm' as const
export const SWARM_READ_RPC_ENDPOINT = '/swarm/v1' as const

export type SwarmReadRpcMethod = 'capabilities' | 'binding' | 'status' | 'snapshot' | 'page'
export type SwarmReadPageKind = 'tasks' | 'attempts' | 'pendingInteractions'
export type SwarmReadCapability =
  | 'binding.read'
  | 'status.read'
  | 'snapshot.read'
  | 'page.read'
  | 'message.write'
  | 'control.write'
  | 'effect.cancel'

export interface SwarmReadCapabilityState {
  readonly capability: SwarmReadCapability
  readonly state: 'available' | 'unavailable'
  readonly blocker?: 'listener-not-loopback' | 'i1b-effect-correlation'
}

export interface SwarmReadTargetHint {
  /** Target selector only. R2 never treats it as caller identity or a principal. */
  readonly rootSessionId: string
  /** Optional lookup selector; Host authority resolves and revalidates it. */
  readonly teamId?: string
}

export interface SwarmReadCapabilitiesRequest {
  readonly schemaVersion: 1
  readonly method: 'capabilities'
}

export interface SwarmReadTargetRequest {
  readonly schemaVersion: 1
  readonly method: 'binding' | 'status' | 'snapshot'
  readonly target: SwarmReadTargetHint
  readonly afterCursor?: string
}

export interface SwarmReadPageRequest {
  readonly schemaVersion: 1
  readonly method: 'page'
  readonly target: SwarmReadTargetHint
  readonly afterCursor?: string
  readonly page: {
    readonly kind: SwarmReadPageKind
    readonly offset?: number
    readonly limit?: number
  }
}

export type SwarmReadRpcRequest = SwarmReadCapabilitiesRequest | SwarmReadTargetRequest | SwarmReadPageRequest

export interface SwarmReadCapabilitiesV1 {
  readonly protocol: typeof SWARM_READ_RPC_PROTOCOL
  readonly version: typeof SWARM_READ_RPC_VERSION
  readonly namespace: typeof SWARM_READ_RPC_NAMESPACE
  readonly trust: {
    readonly mode: 'local-single-user-target-bound'
    readonly principalBound: false
    readonly listener: 'loopback' | 'non-loopback'
  }
  readonly capabilities: readonly SwarmReadCapabilityState[]
}

export interface SwarmReadBindingV1 {
  readonly binding: SwarmHostReadProjectionV1['binding']
  readonly team: Pick<SwarmHostReadProjectionV1['team'], 'id' | 'name' | 'phase' | 'revision' | 'updatedAt'>
  readonly cursor: string
  readonly changed: boolean
  readonly resyncRequired: boolean
}

export interface SwarmReadStatusV1 extends SwarmReadBindingV1 {
  readonly budget: SwarmHostReadProjectionV1['budget']
  readonly totals: SwarmHostReadProjectionV1['totals']
  readonly truncated: SwarmHostReadProjectionV1['truncated']
  readonly capabilities: SwarmHostReadProjectionV1['capabilities']
  readonly observedAt: number
}

export interface SwarmReadPageV1 {
  readonly kind: SwarmReadPageKind
  readonly entries: readonly unknown[]
  readonly offset: number
  readonly limit: number
  readonly visibleTotal: number
  readonly authoritativeTotal: number
  readonly nextOffset?: number
  readonly projectionTruncated: boolean
  readonly cursor: string
  readonly changed: boolean
  readonly resyncRequired: boolean
  readonly observedAt: number
}

export type SwarmReadRpcValue =
  | SwarmReadCapabilitiesV1
  | SwarmReadBindingV1
  | SwarmReadStatusV1
  | SwarmHostReadProjectionV1
  | SwarmReadPageV1

export interface SwarmReadRpcSuccess {
  readonly schemaVersion: 1
  readonly ok: true
  readonly value: SwarmReadRpcValue
}

export interface SwarmReadRpcFailure {
  readonly schemaVersion: 1
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type SwarmReadRpcEnvelope = SwarmReadRpcSuccess | SwarmReadRpcFailure

/** Conservative browser-side envelope check; method values remain typed by the caller. */
export function parseSwarmReadRpcEnvelope(value: unknown): SwarmReadRpcEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Swarm RPC response is not an object')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.ok !== 'boolean') throw new Error('Swarm RPC response has no versioned outcome')
  if (record.ok) {
    if (typeof record.value !== 'object' || record.value === null) throw new Error('Swarm RPC success has no value')
    return value as SwarmReadRpcSuccess
  }
  if (typeof record.error !== 'object' || record.error === null) throw new Error('Swarm RPC failure has no error')
  const error = record.error as Record<string, unknown>
  if (typeof error.code !== 'string' || typeof error.message !== 'string') throw new Error('Swarm RPC failure is malformed')
  return value as SwarmReadRpcFailure
}
