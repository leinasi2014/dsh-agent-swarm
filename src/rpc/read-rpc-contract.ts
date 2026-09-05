/** Browser-safe R2/I3-R wire vocabulary. This module imports no Host or storage code. */
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'

export const SWARM_READ_RPC_PROTOCOL = 'dsh-agent-swarm/read-rpc' as const
export const SWARM_READ_RPC_VERSION = 1 as const
export const SWARM_READ_RPC_NAMESPACE = '/swarm' as const
export const SWARM_READ_RPC_ENDPOINT = '/swarm/v1' as const

export type SwarmReadRpcMethod =
  | 'capabilities'
  | 'skillCatalog'
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
  | 'skillCatalog.read'
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

/** Model-facing Skill directory for the exact live Session selected in Settings.
 *  This is read-only discovery metadata; it never loads Skill bodies. */
export interface SwarmReadSkillCatalogRequest {
  readonly schemaVersion: 1
  readonly method: 'skillCatalog'
  readonly target: SwarmReadTargetHint
}

export interface SwarmReadSkillCatalogEntryV1 {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: true
}

export interface SwarmReadSkillCatalogV1 {
  readonly schemaVersion: 1
  readonly binding: { readonly rootSessionId: string }
  /** False means provider discovery changed while this observation was collected. */
  readonly complete: boolean
  readonly skills: readonly SwarmReadSkillCatalogEntryV1[]
  readonly observedAt: number
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
  readonly phase: 'staged' | 'active' | 'archived'
  /** Dedicated Captain Session id of this Team; the caller opens it via the official Session seam. */
  readonly captainSessionId: string
  /** Captain-declared display name; present only when the identity card is `generated`. */
  readonly displayName?: string
  /** Captain-declared profession; present only when the identity card is `generated`. */
  readonly profession?: string
  /** Captain-declared personality; present only when the identity card is `generated`. */
  readonly personality?: string
  /** Captain identity asset projection: `generated` with a safe rect-only svg, or honest `not_generated`. */
  readonly avatar: SwarmReadAssetStatusV1
  /** Captain identity card projection: `generated` with the profile fields, or honest `not_generated`. */
  readonly identityCard: SwarmReadAssetStatusV1
  /** Public goal projection: `generated` with the canonical text, or honest `not_generated`. */
  readonly goal: { readonly state: 'generated'; readonly text: string } | { readonly state: 'not_generated'; readonly reason: 'goal_not_set' }
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

/** Fixed row-local composition diagnostics (captainMembers.composition.v1). Every
 *  non-`available` state carries exactly one non-available reason; `available`
 *  carries exactly `available`. Discloses no backend error text, path or persona. */
export type SwarmReadMemberCompositionReasonV1 =
  | 'available'
  | 'provisioning'
  | 'startup_failed'
  | 'removed'
  | 'inspection_failed'
  | 'active_session_missing'
  | 'binding_invalid'
  | 'descriptor_invalid'
  | 'not_continuable'
  | 'tool_filter_invalid'

/** Row-local read-only composition of one member, derived from the member's own durable
 *  Session descriptor by the shared MemberProfileReader. A missing, corrupt or
 *  non-continuable child fails CLOSED into this row's `state`/`reason` only — never other
 *  rows, never a section error, and a non-`available` row discloses nothing beyond
 *  `runtimeProvider`. `deniedTools` is the declared tool-denial restriction list; it is
 *  not an enumeration of permitted tools. */
export interface SwarmReadMemberCompositionV1 {
  readonly state: 'available' | 'pending' | 'unavailable' | 'invalid'
  readonly reason: SwarmReadMemberCompositionReasonV1
  /** Existing Team recovery fence provider the child descriptor is verified against. */
  readonly runtimeProvider: string
  readonly llmProvider?: string
  readonly model?: string
  readonly presetId?: string
  readonly personaConfigured?: boolean
  readonly deniedTools?: readonly string[]
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
  /** Row-local composition projection (captainMembers.composition.v1): derived per member
   *  from the member's own durable Session descriptor; single-row fail-closed. */
  readonly composition: SwarmReadMemberCompositionV1
  /** Non-sensitive capability availability enumeration. Constant literal values —
   *  never content; private memory is exposed only as `private_to_member`. */
  readonly growth: {
    readonly privateMemory: 'private_to_member'
    readonly skills: 'not_implemented'
    readonly capability: 'not_implemented'
  }
  /** Session-visible catalog Skills the member can SEE in the scoped catalog (NOT
   *  owned expertise and NOT the member-assigned subset). A bounded enumeration;
   *  an empty array means none visible. Absent when the read has no authoritative
   *  source (fail-closed), never a fabricated claim. */
  readonly skills?: readonly string[]
  /** Member-assigned Skill subset (issue #184): the recruit-time subset this
   *  member may load, distinct from Session-visible catalog Skills (`skills`).
   *  Absent when the captain declared none; an explicit empty array is a
   *  declared empty subset (narrows the member to no Skill), never an
   *  inheritance of the whole Team allow-list. */
  readonly assignedSkills?: readonly string[]
  /** Tools this member may call within the Team's member-facing model surface,
   *  derived from the member's durable toolFilter denial (deny-excluded). Empty
   *  means none remain in that surface. Absent when the surface is unknown. */
  readonly callableTools?: readonly string[]
  /** Human-readable growth/experience summary derived from the member's real
   *  Team history (bounded free text; empty means no summary is available yet). */
  readonly growthSummary?: string
  /** The member's genuinely in-flight task and its status, when one exists. */
  readonly currentActivity?: {
    readonly taskId: string
    readonly subject: string
    readonly status: 'pending' | 'in_progress' | 'submitted' | 'verifying'
  }
  /** The member's most recent terminal outcome (accepted/rejected), when one exists. */
  readonly recentOutcome?: {
    readonly taskId: string
    readonly phase: 'accepted' | 'rejected'
    readonly at: number
  }
}

export interface SwarmReadCaptainMembersV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  /** Immutable Team eligibility policy (issue #184) — the Team allow-list. Absent
   *  when the Team kept the host default (unrestricted). Distinct from the
   *  Session-visible catalog `skills` and the per-member `assignedSkills`. */
  readonly teamAllowedSkills?: readonly string[]
  readonly members: readonly SwarmReadCaptainMemberRowV1[]
  readonly observedAt: number
}

/** One Captain-published public announcement (real bounded projection). */
export interface SwarmReadAnnouncementEntryV1 {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

/** Real bounded projection of the Team's public announcements — never fabricated. */
export interface SwarmReadCaptainAnnouncementsV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  readonly state: 'available'
  readonly entries: readonly SwarmReadAnnouncementEntryV1[]
  readonly observedAt: number
  /** Retained optional for client compatibility with the pre-feature unavailable state. */
  readonly reason?: string
}

export interface SwarmReadCaptainDiagnosticsV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  readonly diagnostics: {
    readonly revision: number
    readonly phase: 'staged' | 'active' | 'archived'
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
  | SwarmReadSkillCatalogRequest
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
  | SwarmReadSkillCatalogV1
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

