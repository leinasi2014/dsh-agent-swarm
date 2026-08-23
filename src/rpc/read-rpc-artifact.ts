/** Immutable R2 schema/fixture artifact shared by DSH and Canvas consumers. */
import { deepFreezeJson } from '../host/frozen-json.js'
import {
  SWARM_READ_RPC_ENDPOINT,
  SWARM_READ_RPC_NAMESPACE,
  SWARM_READ_RPC_PROTOCOL,
  SWARM_READ_RPC_VERSION,
} from './read-rpc-contract.js'

export const SWARM_READ_RPC_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const
export const SWARM_READ_RPC_CONTRACT_DIGEST_V1 = 'c8fd56328319166462c1a1b9fda82e09707221d51af0a5228e9c1112ed3115a6' as const

const boundedString = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' })
const nonNegativeInteger = { type: 'integer', minimum: 0 }
const cursor = { type: 'string', pattern: '^r1:[a-f0-9]{64}$' }
const target = {
  type: 'object', additionalProperties: false, required: ['rootSessionId'],
  properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
}
const requestBase = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'method', 'target'],
  properties: { schemaVersion: { const: 1 }, target, afterCursor: cursor },
}
const binding = {
  type: 'object', additionalProperties: false, required: ['rootSessionId', 'teamId'],
  properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
}
const team = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'phase', 'revision', 'createdAt', 'updatedAt'],
  properties: {
    id: boundedString(128), name: boundedString(128), phase: { enum: ['active', 'archived'] },
    revision: nonNegativeInteger, createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
const budget = {
  type: 'object', additionalProperties: false, required: ['usedTokens', 'usedRequests', 'usedRetries'],
  properties: {
    usedTokens: nonNegativeInteger, usedRequests: nonNegativeInteger, usedRetries: nonNegativeInteger,
    tokenLimit: { type: 'integer', minimum: 1 }, requestLimit: { type: 'integer', minimum: 1 },
    retryLimit: { type: 'integer', minimum: 1 }, deadlineAt: nonNegativeInteger,
  },
}
const totals = {
  type: 'object', additionalProperties: false,
  required: ['roster', 'tasks', 'attempts', 'pendingInteractions'],
  properties: {
    roster: nonNegativeInteger, tasks: nonNegativeInteger,
    attempts: nonNegativeInteger, pendingInteractions: nonNegativeInteger,
  },
}
const truncation = {
  type: 'object', additionalProperties: false,
  required: ['roster', 'tasks', 'attempts', 'pendingInteractions'],
  properties: {
    roster: { type: 'boolean' }, tasks: { type: 'boolean' },
    attempts: { type: 'boolean' }, pendingInteractions: { type: 'boolean' },
  },
}
const capability = {
  type: 'object', additionalProperties: false, required: ['capability', 'state'],
  properties: {
    capability: { enum: ['binding.read', 'status.read', 'snapshot.read', 'page.read', 'message.write', 'control.write', 'effect.cancel'] },
    state: { enum: ['available', 'unavailable'] },
    blocker: { enum: ['listener-not-loopback', 'i1b-effect-correlation'] },
  },
}
const rosterRow = {
  type: 'object', additionalProperties: false, required: ['name', 'role', 'phase', 'createdAt'],
  properties: {
    name: boundedString(64), role: boundedString(256),
    phase: { enum: ['provisioning', 'active', 'failed', 'removed'] }, createdAt: nonNegativeInteger,
  },
}
const taskRow = {
  type: 'object', additionalProperties: false,
  required: ['id', 'revision', 'subject', 'status', 'blockedBy', 'priority', 'createdAt', 'updatedAt'],
  properties: {
    id: boundedString(128), revision: nonNegativeInteger, subject: boundedString(256),
    status: { enum: ['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'] },
    blockedBy: { type: 'array', maxItems: 100, items: boundedString(128) },
    priority: { type: 'integer' }, ownerName: boundedString(64), currentAttemptId: boundedString(128),
    createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
const attemptRow = {
  type: 'object', additionalProperties: false,
  required: ['id', 'taskId', 'generation', 'phase', 'assignmentPhase', 'createdAt', 'updatedAt'],
  properties: {
    id: boundedString(128), taskId: boundedString(128), generation: { type: 'integer', minimum: 1 },
    memberName: boundedString(64),
    phase: { enum: ['running', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale'] },
    assignmentPhase: { enum: ['reserved', 'delivered'] },
    createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
const interactionRow = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'intent', 'targetKind', 'status', 'createdAt', 'updatedAt'],
  properties: {
    requestId: boundedString(96), intent: boundedString(64),
    targetKind: { enum: ['captain', 'team', 'member', 'task'] }, targetRef: boundedString(128),
    status: { enum: ['pending', 'acknowledged'] }, createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
const resultBase = {
  type: 'object', additionalProperties: false,
  required: ['binding', 'team', 'cursor', 'changed', 'resyncRequired'],
  properties: {
    binding, team, cursor, changed: { type: 'boolean' }, resyncRequired: { type: 'boolean' },
  },
}

export const SWARM_READ_RPC_CONTRACT_V1 = deepFreezeJson({
  protocol: SWARM_READ_RPC_PROTOCOL,
  version: SWARM_READ_RPC_VERSION,
  namespace: SWARM_READ_RPC_NAMESPACE,
  endpoint: SWARM_READ_RPC_ENDPOINT,
  schemaDialect: SWARM_READ_RPC_SCHEMA_DIALECT,
  schemas: {
    request: {
      $schema: SWARM_READ_RPC_SCHEMA_DIALECT,
      oneOf: [
        {
          type: 'object', additionalProperties: false, required: ['schemaVersion', 'method'],
          properties: { schemaVersion: { const: 1 }, method: { const: 'capabilities' } },
        },
        ...(['binding', 'status', 'snapshot'] as const).map(method => ({
          ...requestBase, properties: { ...requestBase.properties, method: { const: method } },
        })),
        {
          ...requestBase,
          required: [...requestBase.required, 'page'],
          properties: {
            ...requestBase.properties, method: { const: 'page' },
            page: {
              type: 'object', additionalProperties: false, required: ['kind'],
              properties: {
                kind: { enum: ['tasks', 'attempts', 'pendingInteractions'] },
                offset: nonNegativeInteger, limit: { type: 'integer', minimum: 1, maximum: 50 },
              },
            },
          },
        },
      ],
    },
    values: {
      capabilities: {
        type: 'object', additionalProperties: false,
        required: ['protocol', 'version', 'namespace', 'trust', 'capabilities'],
        properties: {
          protocol: { const: SWARM_READ_RPC_PROTOCOL }, version: { const: 1 }, namespace: { const: SWARM_READ_RPC_NAMESPACE },
          trust: {
            type: 'object', additionalProperties: false, required: ['mode', 'principalBound', 'listener'],
            properties: {
              mode: { const: 'local-single-user-target-bound' }, principalBound: { const: false },
              listener: { enum: ['loopback', 'non-loopback'] },
            },
          },
          capabilities: { type: 'array', minItems: 7, maxItems: 7, items: capability },
        },
      },
      binding: resultBase,
      status: {
        ...resultBase,
        required: [...resultBase.required, 'budget', 'totals', 'truncated', 'capabilities', 'observedAt'],
        properties: {
          ...resultBase.properties, budget, totals, truncated: truncation,
          capabilities: { type: 'array', maxItems: 16, items: { type: 'object' } }, observedAt: nonNegativeInteger,
        },
      },
      snapshot: {
        type: 'object', additionalProperties: false,
        required: [
          'schemaVersion', 'binding', 'team', 'roster', 'tasks', 'attempts', 'budget', 'pendingInteractions',
          'totals', 'truncated', 'capabilities', 'cursor', 'changed', 'resyncRequired', 'observedAt',
        ],
        properties: {
          schemaVersion: { const: 1 }, binding, team,
          roster: { type: 'array', maxItems: 100, items: rosterRow },
          tasks: { type: 'array', maxItems: 100, items: taskRow },
          attempts: { type: 'array', maxItems: 200, items: attemptRow },
          budget,
          pendingInteractions: { type: 'array', maxItems: 100, items: interactionRow },
          totals, truncated: truncation, capabilities: { type: 'array', maxItems: 16, items: { type: 'object' } },
          cursor, changed: { type: 'boolean' }, resyncRequired: { type: 'boolean' }, observedAt: nonNegativeInteger,
        },
      },
      page: {
        type: 'object', additionalProperties: false,
        required: [
          'kind', 'entries', 'offset', 'limit', 'visibleTotal', 'authoritativeTotal', 'projectionTruncated',
          'cursor', 'changed', 'resyncRequired', 'observedAt',
        ],
        properties: {
          kind: { enum: ['tasks', 'attempts', 'pendingInteractions'] },
          entries: { type: 'array', maxItems: 50 }, offset: nonNegativeInteger,
          limit: { type: 'integer', minimum: 1, maximum: 50 }, visibleTotal: nonNegativeInteger,
          authoritativeTotal: nonNegativeInteger, nextOffset: nonNegativeInteger,
          projectionTruncated: { type: 'boolean' }, cursor, changed: { type: 'boolean' },
          resyncRequired: { type: 'boolean' }, observedAt: nonNegativeInteger,
        },
      },
      failure: {
        type: 'object', additionalProperties: false, required: ['schemaVersion', 'ok', 'error'],
        properties: {
          schemaVersion: { const: 1 }, ok: { const: false },
          error: {
            type: 'object', additionalProperties: false, required: ['code', 'message'],
            properties: { code: boundedString(128), message: boundedString(256) },
          },
        },
      },
    },
  },
})

const readCapabilities = [
  { capability: 'binding.read', state: 'available' }, { capability: 'status.read', state: 'available' },
  { capability: 'snapshot.read', state: 'available' }, { capability: 'page.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
]

export const SWARM_READ_RPC_FIXTURES_V1 = deepFreezeJson({
  requests: {
    capabilities: { schemaVersion: 1, method: 'capabilities' },
    snapshot: { schemaVersion: 1, method: 'snapshot', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    page: {
      schemaVersion: 1, method: 'page', target: { rootSessionId: 'session-fixture' },
      afterCursor: `r1:${'a'.repeat(64)}`, page: { kind: 'tasks', offset: 0, limit: 50 },
    },
  },
  values: {
    capabilities: {
      protocol: SWARM_READ_RPC_PROTOCOL, version: 1, namespace: SWARM_READ_RPC_NAMESPACE,
      trust: { mode: 'local-single-user-target-bound', principalBound: false, listener: 'loopback' },
      capabilities: readCapabilities,
    },
    page: {
      kind: 'tasks', entries: [], offset: 0, limit: 50, visibleTotal: 0, authoritativeTotal: 0,
      projectionTruncated: false, cursor: `r1:${'a'.repeat(64)}`, changed: false,
      resyncRequired: false, observedAt: 1_700_000_000_000,
    },
    failure: {
      schemaVersion: 1, ok: false,
      error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'Target root Session is not live' },
    },
  },
})

/** Stable Unicode code-unit key order; consumers can independently verify the digest. */
export function canonicalSwarmReadRpcJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

/** Strict browser-side result validation against the frozen method schema. */
export function assertSwarmReadRpcValue(method: string, value: unknown): void {
  const key = method === 'capabilities' || method === 'binding' || method === 'status'
    || method === 'snapshot' || method === 'page' ? method : undefined
  if (key === undefined) throw new Error('Swarm RPC method is not a read method')
  const schema = SWARM_READ_RPC_CONTRACT_V1.schemas.values[key]
  assertSchema(value, schema, '$', { seen: new WeakSet<object>(), nodes: 0 })
  assertResultSemantics(key, value as Record<string, unknown>)
}

function assertResultSemantics(method: string, value: Record<string, unknown>): void {
  if (method === 'capabilities') {
    const expected = ['binding.read', 'status.read', 'snapshot.read', 'page.read', 'message.write', 'control.write', 'effect.cancel']
    const entries = value.capabilities as Array<Record<string, unknown>>
    entries.forEach((entry, index) => {
      const read = index < 4
      if (entry.capability !== expected[index]
        || entry.state !== (read ? 'available' : 'unavailable')
        || (read ? entry.blocker !== undefined : entry.blocker !== 'i1b-effect-correlation')) {
        throw new Error('Swarm RPC capability state contradicts the R2 contract')
      }
    })
    return
  }
  if (method === 'page') {
    const entries = value.entries as unknown[]
    const offset = value.offset as number
    const limit = value.limit as number
    const visible = value.visibleTotal as number
    const authoritative = value.authoritativeTotal as number
    const next = value.nextOffset as number | undefined
    if (entries.length > limit || visible < offset + entries.length || authoritative < visible
      || (authoritative > visible && value.projectionTruncated !== true)
      || (next !== undefined && (next <= offset || next > visible))) {
      throw new Error('Swarm RPC page totals contradict its entries')
    }
    return
  }
  const selected = value.binding as Record<string, unknown>
  const selectedTeam = value.team as Record<string, unknown>
  if (selected.teamId !== selectedTeam.id) throw new Error('Swarm RPC Team binding contradicts its Team')
  if (method !== 'snapshot') return
  const totalsValue = value.totals as Record<string, number>
  const truncatedValue = value.truncated as Record<string, boolean>
  for (const collection of ['roster', 'tasks', 'attempts', 'pendingInteractions'] as const) {
    const visible = (value[collection] as unknown[]).length
    const total = totalsValue[collection]
    if (total === undefined || total < visible || (total > visible && truncatedValue[collection] !== true)) {
      throw new Error(`Swarm RPC ${collection} total contradicts its projection`)
    }
  }
}

interface SchemaState { readonly seen: WeakSet<object>; nodes: number }
type JsonSchema = Record<string, unknown>

function assertSchema(value: unknown, schema: JsonSchema, path: string, state: SchemaState): void {
  state.nodes += 1
  if (state.nodes > 10_000) throw new Error('Swarm RPC result exceeds the structural bound')
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) throw new Error(`${path} has the wrong constant`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} is outside the enum`)
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} is not a string`)
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) throw new Error(`${path} is too short`)
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) throw new Error(`${path} is too long`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path} has the wrong shape`)
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} is not a safe integer`)
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) throw new Error(`${path} is too small`)
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) throw new Error(`${path} is too large`)
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} is not boolean`)
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} is not an array`)
    remember(value, path, state)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`${path} is too short`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path} is too long`)
    if (isSchema(schema.items)) value.forEach((item, index) => assertSchema(item, schema.items as JsonSchema, `${path}[${index}]`, state))
  } else if (schema.type === 'object') {
    const record = strictRecord(value, path, state)
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === 'string' && !Object.hasOwn(record, required)) throw new Error(`${path}.${required} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!Object.hasOwn(properties, key)) throw new Error(`${path}.${key} is unknown`)
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key]
      if (isSchema(childSchema)) assertSchema(child, childSchema, `${path}.${key}`, state)
    }
  }
}

function strictRecord(value: unknown, path: string, state: SchemaState): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`)
  remember(value, path, state)
  let prototype: object | null
  let keys: PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    throw new Error(`${path} is proxy-like`)
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not plain data`)
  const result = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${path} has a non-string key`)
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw new Error(`${path}.${key} is proxy-like`) }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key} is not a data field`)
    result[key] = descriptor.value
  }
  return result
}

function remember(value: object, path: string, state: SchemaState): void {
  if (state.seen.has(value)) throw new Error(`${path} is cyclic or aliased`)
  state.seen.add(value)
}

function isSchema(value: unknown): value is JsonSchema { return isRecord(value) }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, sortJson(child)]))
}
