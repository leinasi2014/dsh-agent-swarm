/**
 * Pre-I2/I3 canonical producer contract floor.
 *
 * This module freezes the transport-neutral read vocabulary and the explicit
 * negative write capability. It mounts no transport and grants no authority.
 */
import { createHash } from 'node:crypto'
import { deepFreezeJson } from './frozen-json.js'

export const SWARM_PRODUCER_PROTOCOL = 'dsh-agent-swarm/producer' as const
export const SWARM_PRODUCER_CONTRACT_VERSION = 1 as const
export const SWARM_PRODUCER_NAMESPACE = '/swarm' as const
export const SWARM_PRODUCER_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const
export const SWARM_PRODUCER_EFFECT_BLOCKER = 'i1b-effect-correlation' as const

export type SwarmProducerCapability =
  | 'snapshot.read'
  | 'receipt.read'
  | 'message.write'
  | 'control.write'
  | 'effect.cancel'

export interface SwarmProducerCapabilityState {
  readonly capability: SwarmProducerCapability
  readonly state: 'available' | 'unavailable'
  readonly blocker?: typeof SWARM_PRODUCER_EFFECT_BLOCKER
}

export interface SwarmProducerDescriptionV1 {
  readonly schemaVersion: 1
  readonly protocol: typeof SWARM_PRODUCER_PROTOCOL
  readonly contractVersion: typeof SWARM_PRODUCER_CONTRACT_VERSION
  readonly namespace: typeof SWARM_PRODUCER_NAMESPACE
  readonly schemaDialect: typeof SWARM_PRODUCER_SCHEMA_DIALECT
  readonly contractDigest: string
  readonly capabilities: readonly SwarmProducerCapabilityState[]
}

export interface SwarmProducerSnapshotV1 {
  readonly schemaVersion: 1
  readonly team: {
    readonly id: string
    readonly name: string
    readonly phase: 'staged' | 'active' | 'archived'
    readonly revision: number
    readonly updatedAt: number
  }
  readonly counts: {
    readonly members: number
    readonly activeMembers: number
    readonly tasks: number
    readonly pendingTasks: number
    readonly inProgressTasks: number
    readonly submittedTasks: number
    readonly terminalTasks: number
    readonly pendingReceipts: number
  }
  readonly budget: {
    readonly usedTokens: number
    readonly usedRequests: number
    readonly usedRetries: number
    readonly tokenLimit?: number
    readonly requestLimit?: number
    readonly retryLimit?: number
    readonly deadlineAt?: number
  }
  readonly observedAt: number
}

export interface SwarmProducerReceiptRowV1 {
  readonly requestId: string
  readonly teamId: string
  readonly intent: SwarmProducerReceiptIntent
  readonly targetKind: 'captain' | 'team' | 'member' | 'task'
  readonly status: SwarmProducerReceiptStatus
  readonly code?: string
  readonly updatedAt: number
}

export type SwarmProducerReceiptIntent =
  | 'message'
  | 'member-question'
  | 'correct-task'
  | 'interrupt-member'
  | 'wake-member'
  | 'reassign-task'
  | 'review-task'

export type SwarmProducerReceiptStatus =
  | 'pending'
  | 'acknowledged'
  | 'executed'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface SwarmProducerReceiptPageV1 {
  readonly schemaVersion: 1
  readonly teamId: string
  readonly entries: readonly SwarmProducerReceiptRowV1[]
  readonly total: number
  readonly truncated: boolean
  readonly observedAt: number
}

export interface SwarmProducerUnavailableErrorV1 {
  readonly schemaVersion: 1
  readonly error: {
    readonly code: 'SWARM_CAPABILITY_UNAVAILABLE'
    readonly capability: 'message.write' | 'control.write' | 'effect.cancel'
    readonly blocker: typeof SWARM_PRODUCER_EFFECT_BLOCKER
  }
}

/** Stable capability ordering is part of the digest. */
export const SWARM_PRODUCER_CAPABILITIES_V1: readonly SwarmProducerCapabilityState[] = deepFreezeJson([
  { capability: 'snapshot.read', state: 'available' },
  { capability: 'receipt.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: SWARM_PRODUCER_EFFECT_BLOCKER },
  { capability: 'control.write', state: 'unavailable', blocker: SWARM_PRODUCER_EFFECT_BLOCKER },
  { capability: 'effect.cancel', state: 'unavailable', blocker: SWARM_PRODUCER_EFFECT_BLOCKER },
])

const nonNegativeInteger = { type: 'integer', minimum: 0 } as const
const positiveInteger = { type: 'integer', minimum: 1 } as const
const boundedString = (maxLength: number) => ({
  type: 'string', minLength: 1, maxLength, pattern: '\\S',
}) as const

/**
 * Transport-neutral JSON Schema bundle. It is intentionally hand-authored:
 * generated schema ordering must not silently move the contract digest.
 */
export const SWARM_PRODUCER_CONTRACT_V1 = deepFreezeJson({
  protocol: SWARM_PRODUCER_PROTOCOL,
  contractVersion: SWARM_PRODUCER_CONTRACT_VERSION,
  namespace: SWARM_PRODUCER_NAMESPACE,
  schemaDialect: SWARM_PRODUCER_SCHEMA_DIALECT,
  capabilities: SWARM_PRODUCER_CAPABILITIES_V1,
  schemas: {
    description: {
      type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'protocol', 'contractVersion', 'namespace', 'schemaDialect', 'contractDigest', 'capabilities'],
      properties: {
        schemaVersion: { const: 1 },
        protocol: { const: SWARM_PRODUCER_PROTOCOL },
        contractVersion: { const: SWARM_PRODUCER_CONTRACT_VERSION },
        namespace: { const: SWARM_PRODUCER_NAMESPACE },
        schemaDialect: { const: SWARM_PRODUCER_SCHEMA_DIALECT },
        contractDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        capabilities: {
          type: 'array', minItems: 5, maxItems: 5,
          prefixItems: [
            capabilitySchema('snapshot.read', 'available'),
            capabilitySchema('receipt.read', 'available'),
            capabilitySchema('message.write', 'unavailable'),
            capabilitySchema('control.write', 'unavailable'),
            capabilitySchema('effect.cancel', 'unavailable'),
          ],
          items: false,
        },
      },
    },
    snapshotRequest: {
      type: 'object', additionalProperties: false,
      required: ['teamId'],
      properties: { teamId: boundedString(128) },
    },
    receiptRequest: {
      type: 'object', additionalProperties: false,
      required: ['teamId'],
      properties: { teamId: boundedString(128), limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    snapshot: {
      type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'team', 'counts', 'budget', 'observedAt'],
      properties: {
        schemaVersion: { const: 1 },
        team: {
          type: 'object', additionalProperties: false,
          required: ['id', 'name', 'phase', 'revision', 'updatedAt'],
          properties: {
            id: boundedString(128), name: boundedString(128),
            phase: { enum: ['active', 'archived'] }, revision: nonNegativeInteger,
            updatedAt: nonNegativeInteger,
          },
        },
        counts: {
          type: 'object', additionalProperties: false,
          required: ['members', 'activeMembers', 'tasks', 'pendingTasks', 'inProgressTasks', 'submittedTasks', 'terminalTasks', 'pendingReceipts'],
          properties: {
            members: nonNegativeInteger, activeMembers: nonNegativeInteger,
            tasks: nonNegativeInteger, pendingTasks: nonNegativeInteger,
            inProgressTasks: nonNegativeInteger, submittedTasks: nonNegativeInteger,
            terminalTasks: nonNegativeInteger, pendingReceipts: nonNegativeInteger,
          },
        },
        budget: {
          type: 'object', additionalProperties: false,
          required: ['usedTokens', 'usedRequests', 'usedRetries'],
          properties: {
            usedTokens: nonNegativeInteger, usedRequests: nonNegativeInteger,
            usedRetries: nonNegativeInteger, tokenLimit: positiveInteger,
            requestLimit: positiveInteger, retryLimit: positiveInteger,
            deadlineAt: nonNegativeInteger,
          },
        },
        observedAt: nonNegativeInteger,
      },
    },
    receiptPage: {
      type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'teamId', 'entries', 'total', 'truncated', 'observedAt'],
      properties: {
        schemaVersion: { const: 1 }, teamId: boundedString(128),
        entries: {
          type: 'array', maxItems: 100,
          items: {
            type: 'object', additionalProperties: false,
            required: ['requestId', 'teamId', 'intent', 'targetKind', 'status', 'updatedAt'],
            properties: {
              requestId: boundedString(96), teamId: boundedString(128),
              intent: { enum: ['message', 'member-question', 'correct-task', 'interrupt-member', 'wake-member', 'reassign-task', 'review-task'] },
              targetKind: { enum: ['captain', 'team', 'member', 'task'] },
              status: { enum: ['pending', 'acknowledged', 'executed', 'rejected', 'failed', 'expired', 'cancelled'] },
              code: boundedString(128), updatedAt: nonNegativeInteger,
            },
          },
        },
        total: nonNegativeInteger, truncated: { type: 'boolean' }, observedAt: nonNegativeInteger,
      },
    },
    unavailableError: {
      type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'error'],
      properties: {
        schemaVersion: { const: 1 },
        error: {
          type: 'object', additionalProperties: false,
          required: ['code', 'capability', 'blocker'],
          properties: {
            code: { const: 'SWARM_CAPABILITY_UNAVAILABLE' },
            capability: { enum: ['message.write', 'control.write', 'effect.cancel'] },
            blocker: { const: SWARM_PRODUCER_EFFECT_BLOCKER },
          },
        },
      },
    },
  },
})

/**
 * A fixed marker breaks the description digest's otherwise recursive input.
 * The final fixture replaces only this marker with the derived digest.
 */
const CONTRACT_DIGEST_PREIMAGE = 'sha256:self' as const

/** Canonical digest preimage; no fixture carries secrets or mutable host identity. */
const SWARM_PRODUCER_FIXTURE_PREIMAGE_V1 = deepFreezeJson({
  description: {
    schemaVersion: 1,
    protocol: SWARM_PRODUCER_PROTOCOL,
    contractVersion: SWARM_PRODUCER_CONTRACT_VERSION,
    namespace: SWARM_PRODUCER_NAMESPACE,
    schemaDialect: SWARM_PRODUCER_SCHEMA_DIALECT,
    contractDigest: CONTRACT_DIGEST_PREIMAGE,
    capabilities: SWARM_PRODUCER_CAPABILITIES_V1,
  } satisfies SwarmProducerDescriptionV1,
  requests: {
    snapshot: { teamId: 'team-fixture' },
    receipts: { teamId: 'team-fixture', limit: 50 },
  },
  snapshot: {
    schemaVersion: 1,
    team: { id: 'team-fixture', name: 'Fixture Team', phase: 'active', revision: 7, updatedAt: 1_700_000_000_000 },
    counts: {
      members: 2, activeMembers: 1, tasks: 3, pendingTasks: 1,
      inProgressTasks: 1, submittedTasks: 0, terminalTasks: 1, pendingReceipts: 1,
    },
    budget: { usedTokens: 120, usedRequests: 4, usedRetries: 1, tokenLimit: 2_000 },
    observedAt: 1_700_000_000_100,
  } satisfies SwarmProducerSnapshotV1,
  receiptPage: {
    schemaVersion: 1,
    teamId: 'team-fixture',
    entries: [{
      requestId: 'human-fixture-00000001', teamId: 'team-fixture', intent: 'message',
      targetKind: 'captain', status: 'acknowledged', updatedAt: 1_700_000_000_050,
    }],
    total: 1, truncated: false, observedAt: 1_700_000_000_100,
  } satisfies SwarmProducerReceiptPageV1,
  unavailable: {
    message: unavailableFixture('message.write'),
    control: unavailableFixture('control.write'),
    cancel: unavailableFixture('effect.cancel'),
  },
})

export const SWARM_PRODUCER_CONTRACT_DIGEST_V1 = createHash('sha256')
  .update(canonicalJson({ contract: SWARM_PRODUCER_CONTRACT_V1, fixtures: SWARM_PRODUCER_FIXTURE_PREIMAGE_V1 }))
  .digest('hex')

/** Canonical examples; description is the exact result returned by describe(). */
export const SWARM_PRODUCER_FIXTURES_V1 = deepFreezeJson({
  ...SWARM_PRODUCER_FIXTURE_PREIMAGE_V1,
  description: {
    ...SWARM_PRODUCER_FIXTURE_PREIMAGE_V1.description,
    contractDigest: SWARM_PRODUCER_CONTRACT_DIGEST_V1,
  } satisfies SwarmProducerDescriptionV1,
})

/** Stable canonical JSON used by the digest and by contract conformance tests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function unavailableFixture(
  capability: 'message.write' | 'control.write' | 'effect.cancel',
): SwarmProducerUnavailableErrorV1 {
  return {
    schemaVersion: 1,
    error: { code: 'SWARM_CAPABILITY_UNAVAILABLE', capability, blocker: SWARM_PRODUCER_EFFECT_BLOCKER },
  }
}

function capabilitySchema(
  capability: SwarmProducerCapability,
  state: 'available' | 'unavailable',
): object {
  return state === 'available'
    ? {
        type: 'object', additionalProperties: false,
        required: ['capability', 'state'],
        properties: { capability: { const: capability }, state: { const: state } },
      }
    : {
        type: 'object', additionalProperties: false,
        required: ['capability', 'state', 'blocker'],
        properties: {
          capability: { const: capability }, state: { const: state },
          blocker: { const: SWARM_PRODUCER_EFFECT_BLOCKER },
        },
      }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    // Canonical ordering is Unicode code-unit order, never host locale.
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, sortJson(child)] as const)
  return Object.fromEntries(entries)
}

