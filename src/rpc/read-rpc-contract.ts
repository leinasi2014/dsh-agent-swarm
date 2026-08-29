/** Browser-safe R2/I3-R wire vocabulary. This module imports no Host or storage code. */
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'

export const SWARM_READ_RPC_PROTOCOL = 'dsh-agent-swarm/read-rpc' as const
export const SWARM_READ_RPC_VERSION = 1 as const
export const SWARM_READ_RPC_NAMESPACE = '/swarm' as const
export const SWARM_READ_RPC_ENDPOINT = '/swarm/v1' as const

export type SwarmReadRpcMethod =
  | 'capabilities'
  | 'teams'
  | 'binding'
  | 'status'
  | 'snapshot'
  | 'page'
  | 'captainMembers'
  | 'captainAnnouncements'
  | 'captainDiagnostics'
export type SwarmReadPageKind = 'tasks' | 'attempts' | 'pendingInteractions'
/** A Captain-scoped read section reachable from the `teams` enumeration entry point. */
export type SwarmReadCaptainSectionMethod =
  | 'captainMembers'
  | 'captainAnnouncements'
  | 'captainDiagnostics'
export type SwarmReadCapability =
  | 'teams.read'
  | 'binding.read'
  | 'status.read'
  | 'snapshot.read'
  | 'page.read'
  | 'captainMembers.read'
  | 'captainAnnouncements.read'
  | 'captainDiagnostics.read'
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

/** Read-only enumeration of every Team aggregate visible to the target root (real authorities,
 *  never a copied or second state). Multi-team is a legal result; zero teams is an explicit empty
 *  list — the caller distinguishes them from an error. */
export interface SwarmReadTeamsRequest {
  readonly schemaVersion: 1
  readonly method: 'teams'
  readonly target: SwarmReadTargetHint
}

/** Explicit identity-asset availability of a Captain/team/member. Backend states are honest: a
 *  field the backend has no profile for reports `not_generated` with a stable reason — never a
 *  fabricated avatar/identity card. `unavailable` means the read endpoint exists but carries no
 *  data source. When the backend holds a Captain-declared profile it reports `generated` and
 *  carries the value. */
export type SwarmReadAssetState = 'generated' | 'not_generated' | 'unavailable'
export type SwarmReadAssetReason =
  | 'avatar_backend_not_implemented'
  | 'identity_backend_not_implemented'
  | 'notice_board_not_implemented'

export interface SwarmReadAssetStatusV1 {
  readonly state: SwarmReadAssetState
  readonly reason?: SwarmReadAssetReason
  /** Strictly allowlisted pixel-avatar SVG; present only when `state === 'generated'`. */
  readonly svg?: string
}

export interface SwarmReadCaptainEndpointRefV1 {
  readonly method: SwarmReadCaptainSectionMethod
  readonly target: {
    readonly rootSessionId: string
    readonly teamId: string
  }
}

export interface SwarmReadTeamV1 {
  readonly teamId: string
  readonly name: string
  readonly phase: 'active' | 'archived'
  /** Dedicated Captain Session id of this Team; the caller opens it via the official Session seam. */
  readonly captainSessionId: string
  /** Backend does not generate avatars yet; reports `not_generated`, never a fake asset. */
  readonly avatar: SwarmReadAssetStatusV1
  /** Backend does not generate identity cards yet; reports `not_generated`, never a fake card. */
  readonly identityCard: SwarmReadAssetStatusV1
  /** Captain-scoped read entry points this Team exposes (members / announcements / diagnostics). */
  readonly endpoints: {
    readonly members: SwarmReadCaptainEndpointRefV1
    readonly announcements: SwarmReadCaptainEndpointRefV1
    readonly diagnostics: SwarmReadCaptainEndpointRefV1
  }
}

export interface SwarmReadTeamsV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
  }
  readonly teams: readonly SwarmReadTeamV1[]
  readonly observedAt: number
  /** True when the enumeration is complete within the bounded read ceiling. */
  readonly complete: boolean
}

export interface SwarmReadCaptainSectionRequest {
  readonly schemaVersion: 1
  readonly method: SwarmReadCaptainSectionMethod
  readonly target: SwarmReadTargetHint
}

/** One Captain-scoped member row. The roster identity/phase is authoritative Team data. The
 *  avatar/identity card are honest asset projections: present only when the Captain declared the
 *  corresponding identity profile (`state === 'generated'`), otherwise `not_generated`. */
export interface SwarmReadCaptainMemberRowV1 {
  readonly name: string
  readonly role: string
  readonly phase: 'provisioning' | 'active' | 'failed' | 'removed'
  readonly createdAt: number
  /** Captain-declared display name; present only when the identity card is `generated`. */
  readonly displayName?: string
  /** Captain-declared profession; present only when the identity card is `generated`. */
  readonly profession?: string
  /** Captain-declared personality; present only when the identity card is `generated`. */
  readonly personality?: string
  readonly avatar: SwarmReadAssetStatusV1
  readonly identityCard: SwarmReadAssetStatusV1
}

export interface SwarmReadCaptainMembersV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  readonly members: readonly SwarmReadCaptainMemberRowV1[]
  readonly observedAt: number
}

/** Announcements are not backed by a public notice board yet, so the read returns an explicit
 *  `unavailable` state with a stable reason and an empty entry list — never fabricated posts. */
export interface SwarmReadCaptainAnnouncementsV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  readonly state: 'unavailable'
  readonly reason: 'notice_board_not_implemented'
  readonly entries: readonly []
  readonly observedAt: number
}

export interface SwarmReadCaptainDiagnosticsV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  readonly diagnostics: {
    readonly revision: number
    readonly phase: 'active' | 'archived'
    readonly taskCount: number
    readonly attemptCount: number
    readonly memberCount: number
    readonly backend: string
  }
  readonly observedAt: number
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

export type SwarmReadRpcRequest =
  | SwarmReadCapabilitiesRequest
  | SwarmReadTeamsRequest
  | SwarmReadCaptainSectionRequest
  | SwarmReadTargetRequest
  | SwarmReadPageRequest

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
  readonly team: Pick<SwarmHostReadProjectionV1['team'], 'id' | 'name' | 'phase' | 'revision' | 'createdAt' | 'updatedAt'>
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
  | SwarmReadTeamsV1
  | SwarmReadCaptainMembersV1
  | SwarmReadCaptainAnnouncementsV1
  | SwarmReadCaptainDiagnosticsV1
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
  const record = strictEnvelopeRecord(value, new Set(['schemaVersion', 'ok', 'value', 'error']))
  if (record.schemaVersion !== 1 || typeof record.ok !== 'boolean') throw new Error('Swarm RPC response has no versioned outcome')
  if (record.ok) {
    if (Object.keys(record).length !== 3 || !Object.hasOwn(record, 'value')) throw new Error('Swarm RPC success has unknown fields')
    if (typeof record.value !== 'object' || record.value === null) throw new Error('Swarm RPC success has no value')
    return value as SwarmReadRpcSuccess
  }
  if (Object.keys(record).length !== 3 || !Object.hasOwn(record, 'error')) throw new Error('Swarm RPC failure has unknown fields')
  if (typeof record.error !== 'object' || record.error === null) throw new Error('Swarm RPC failure has no error')
  const error = strictEnvelopeRecord(record.error, new Set(['code', 'message']))
  if (Object.keys(error).length !== 2) throw new Error('Swarm RPC failure has unknown error fields')
  if (typeof error.code !== 'string' || typeof error.message !== 'string') throw new Error('Swarm RPC failure is malformed')
  return value as SwarmReadRpcFailure
}

function strictEnvelopeRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Swarm RPC response is not an object')
  let prototype: object | null
  let keys: PropertyKey[]
  try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value) } catch { throw new Error('Swarm RPC response is proxy-like') }
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Swarm RPC response is not plain data')
  const record = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error('Swarm RPC response has an unknown field')
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw new Error('Swarm RPC response is proxy-like') }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new Error('Swarm RPC response has an accessor field')
    record[key] = descriptor.value
  }
  return record
}
