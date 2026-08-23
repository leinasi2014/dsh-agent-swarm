/** Pre-I2/I3 producer contract, projection and lifecycle evidence. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const SIGNAL = new AbortController().signal
const NOW = 1_700_000_000_100
const ROOT = { id: 'root-session' } as unknown as Agent
const CHILD = { id: 'child-session' } as unknown as Agent
const OTHER_ROOT = { id: 'other-root-session' } as unknown as Agent

type ContractSchema = Readonly<Record<string, unknown>>

/** Executable conformance for the JSON Schema vocabulary used by this contract. */
function assertConforms(value: unknown, schema: ContractSchema, path = '$'): void {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(candidate => {
      try {
        assertConforms(value, candidate as ContractSchema, path)
        return true
      } catch {
        return false
      }
    })
    if (matches.length !== 1) throw new Error(`${path} must match exactly one schema`)
    return
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    throw new Error(`${path} must equal ${String(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} is outside its enum`)
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string`)
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) throw new Error(`${path} is too short`)
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) throw new Error(`${path} is too long`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      throw new Error(`${path} does not match its pattern`)
    }
  }
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`)
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) throw new Error(`${path} is too small`)
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) throw new Error(`${path} is too large`)
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} must be boolean`)
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`${path} has too few items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path} has too many items`)
    const prefixItems = (schema.prefixItems ?? []) as ContractSchema[]
    prefixItems.forEach((childSchema, index) => assertConforms(value[index], childSchema, `${path}[${index}]`))
    if (schema.items === false && value.length > prefixItems.length) throw new Error(`${path} has unexpected items`)
    if (schema.items !== undefined && schema.items !== false) {
      value.forEach((item, index) => assertConforms(item, schema.items as ContractSchema, `${path}[${index}]`))
    }
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
    const record = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, ContractSchema>
    for (const required of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(record, required)) throw new Error(`${path}.${required} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) throw new Error(`${path}.${key} is unknown`)
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(record, key)) assertConforms(record[key], childSchema, `${path}.${key}`)
    }
  }
}

function teamState(): AgentSwarm.TeamState {
  return {
    schemaVersion: 1,
    id: AgentSwarm.TeamId('team-floor'),
    revision: 7,
    name: 'Producer floor',
    description: 'Not projected',
    captainSessionId: 'root-session',
    phase: 'active',
    members: [
      { name: 'worker', role: 'developer', sessionId: 'child-session', provider: 'test', phase: 'active', createdAt: NOW - 100 },
      { name: 'retired', role: 'reviewer', sessionId: 'old-session', provider: 'test', phase: 'removed', createdAt: NOW - 90 },
    ],
    tasks: [
      {
        id: AgentSwarm.TaskId('task-1'), revision: 2, subject: 'Pending', description: 'secret task body',
        acceptanceCriteria: [], status: 'pending', blockedBy: [], writeScopes: [], priority: 0,
        createdAt: NOW - 80, updatedAt: NOW - 70,
      },
      {
        id: AgentSwarm.TaskId('task-2'), revision: 3, subject: 'Running', description: 'secret task body',
        acceptanceCriteria: [], status: 'in_progress', blockedBy: [], writeScopes: [], priority: 0,
        ownerSessionId: 'child-session', currentAttemptId: AgentSwarm.AttemptId('attempt-1'),
        createdAt: NOW - 60, updatedAt: NOW - 50,
      },
      {
        id: AgentSwarm.TaskId('task-3'), revision: 4, subject: 'Done', description: 'secret task body',
        acceptanceCriteria: [], status: 'completed', blockedBy: [], writeScopes: [], priority: 0,
        createdAt: NOW - 40, updatedAt: NOW - 30,
      },
    ],
    attempts: [], messages: [],
    budget: { usedTokens: 120, usedRequests: 4, usedRetries: 1, tokenLimit: 2_000 },
    usageCursors: {}, memory: [], nextTaskNumber: 4, nextMemoryNumber: 1,
    createdAt: NOW - 200, updatedAt: NOW - 20,
  }
}

function interactionRecord(): AgentSwarm.HumanInteractionRecord {
  return {
    schemaVersion: 1,
    scope: 'C:\\secret\\workspace',
    request: {
      schemaVersion: 1,
      requestId: 'human-floor-00000001',
      teamId: AgentSwarm.TeamId('team-floor'),
      source: {
        kind: 'authenticated-human', captainSessionId: 'root-session',
        principalRef: 'principal-secret', hostSurface: 'secret-surface',
      },
      target: { kind: 'member', memberName: 'worker' },
      intent: 'wake-member', body: 'secret body', expectedTeamRevision: 7,
      createdAt: NOW - 10,
    },
    receipt: {
      requestId: 'human-floor-00000001', teamId: AgentSwarm.TeamId('team-floor'),
      status: 'pending', routedMessageId: 'message-secret', diagnostic: 'diagnostic-secret',
      updatedAt: NOW - 5,
    },
    createdAt: NOW - 10,
    updatedAt: NOW - 5,
  }
}

function harness(overrides: {
  snapshot?: () => Promise<AgentSwarm.TeamStatusSnapshot>
  disposalTimeoutMs?: number
} = {}) {
  const team = teamState()
  const records = [interactionRecord()]
  const domainReads = vi.fn(async () => overrides.snapshot?.() ?? {
    team,
    readyTaskIds: [AgentSwarm.TaskId('task-1')],
    pendingMessageIds: [],
  })
  const overlayReads = vi.fn(() => structuredClone(records))
  const service = new AgentSwarm.AgentSwarmProducerFloorService({
    domain: () => ({ snapshot: domainReads }) as unknown as AgentSwarm.TeamDomainPort,
    overlay: { list: overlayReads },
    scopeOf: () => 'scope-floor',
    isExactLiveRoot: agent => agent === ROOT || agent === OTHER_ROOT,
    now: () => NOW,
    disposalTimeoutMs: overrides.disposalTimeoutMs ?? 1_000,
  })
  return { service, records, domainReads, overlayReads }
}

describe('pre-I2/I3 canonical producer contract', () => {
  it('freezes the versioned schema, fixtures and stable candidate digest', () => {
    expect(AgentSwarm.SWARM_PRODUCER_PROTOCOL).toBe('dsh-agent-swarm/producer')
    expect(AgentSwarm.SWARM_PRODUCER_CONTRACT_VERSION).toBe(1)
    expect(AgentSwarm.SWARM_PRODUCER_NAMESPACE).toBe('/swarm')
    expect(AgentSwarm.SWARM_PRODUCER_SCHEMA_DIALECT).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(AgentSwarm.SWARM_PRODUCER_CONTRACT_V1.schemaDialect).toBe(AgentSwarm.SWARM_PRODUCER_SCHEMA_DIALECT)
    expect(AgentSwarm.SWARM_PRODUCER_CAPABILITIES_V1).toEqual([
      { capability: 'snapshot.read', state: 'available' },
      { capability: 'receipt.read', state: 'available' },
      { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
      { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
      { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
    ])
    expect(Object.isFrozen(AgentSwarm.SWARM_PRODUCER_CONTRACT_V1)).toBe(true)
    expect(Object.isFrozen(AgentSwarm.SWARM_PRODUCER_FIXTURES_V1.snapshot.team)).toBe(true)
    expect(AgentSwarm.SWARM_PRODUCER_CONTRACT_V1.schemas.snapshotRequest.required).toEqual(['teamId'])
    expect(AgentSwarm.SWARM_PRODUCER_CONTRACT_V1.schemas.receiptRequest.properties.limit)
      .toEqual({ type: 'integer', minimum: 1, maximum: 100 })
    expect(AgentSwarm.canonicalJson({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}')
    expect(AgentSwarm.SWARM_PRODUCER_CONTRACT_DIGEST_V1)
      .toBe('1ab536b488ac0f1444cac7c50e66de4835933212c64389937587c680446294ff')
  })

  it('keeps every canonical fixture executable against its strict result or request schema', () => {
    const { schemas } = AgentSwarm.SWARM_PRODUCER_CONTRACT_V1
    const fixtures = AgentSwarm.SWARM_PRODUCER_FIXTURES_V1
    const pairs = [
      [fixtures.description, schemas.description],
      [fixtures.requests.snapshot, schemas.snapshotRequest],
      [fixtures.requests.receipts, schemas.receiptRequest],
      [fixtures.snapshot, schemas.snapshot],
      [fixtures.receiptPage, schemas.receiptPage],
      [fixtures.unavailable.message, schemas.unavailableError],
      [fixtures.unavailable.control, schemas.unavailableError],
      [fixtures.unavailable.cancel, schemas.unavailableError],
    ] as const
    for (const [fixture, schema] of pairs) expect(() => assertConforms(fixture, schema)).not.toThrow()

    expect(() => assertConforms({ teamId: '   ' }, schemas.snapshotRequest)).toThrow()
    expect(() => assertConforms({ teamId: 'team', extra: true }, schemas.snapshotRequest)).toThrow()
    expect(() => assertConforms({ teamId: '汉'.repeat(129) }, schemas.snapshotRequest)).toThrow()
  })

  it('requires the exact live root and returns bounded frozen redacted projections', async () => {
    const { service } = harness()
    expect(service.describe()).toEqual(AgentSwarm.SWARM_PRODUCER_FIXTURES_V1.description)
    await expect(service.readSnapshot({ teamId: '汉'.repeat(128) }, { agent: ROOT, signal: SIGNAL })).resolves.toBeDefined()
    await expect(service.readSnapshot({ teamId: '汉'.repeat(129) }, { agent: ROOT, signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'SWARM_HOST_INVALID_REQUEST' })
    await expect(service.readSnapshot({ teamId: '   ' }, { agent: ROOT, signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'SWARM_HOST_INVALID_REQUEST' })
    await expect(service.readSnapshot({ teamId: 'team-floor', extra: true } as never, { agent: ROOT, signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'SWARM_HOST_INVALID_REQUEST' })
    await expect(service.readSnapshot({ teamId: 'team-floor' }, { agent: CHILD, signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'SWARM_HOST_CAPTAIN_REQUIRED' })
    await expect(service.readSnapshot({ teamId: 'team-floor' }, { agent: OTHER_ROOT, signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'SWARM_HOST_CAPTAIN_REQUIRED' })

    const snapshot = await service.readSnapshot({ teamId: 'team-floor' }, { agent: ROOT, signal: SIGNAL })
    expect(snapshot).toMatchObject({
      team: { id: 'team-floor', revision: 7 },
      counts: {
        members: 2, activeMembers: 1, tasks: 3, pendingTasks: 1,
        inProgressTasks: 1, submittedTasks: 0, terminalTasks: 1, pendingReceipts: 1,
      },
      budget: { usedTokens: 120, tokenLimit: 2_000 },
      observedAt: NOW,
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.counts)).toBe(true)

    const receipts = await service.readReceipts({ teamId: 'team-floor', limit: 1 }, { agent: ROOT, signal: SIGNAL })
    expect(receipts.entries).toEqual([{
      requestId: 'human-floor-00000001', teamId: 'team-floor', intent: 'wake-member',
      targetKind: 'member', status: 'pending', updatedAt: NOW - 5,
    }])
    expect(Object.isFrozen(receipts.entries)).toBe(true)
    const serialized = JSON.stringify({ snapshot, receipts })
    for (const secret of ['secret body', 'secret task body', 'principal-secret', 'message-secret', 'diagnostic-secret', 'secret\\workspace']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('fails Message, Control and cancel closed without inspecting payloads or touching authority', async () => {
    const { service, records, domainReads, overlayReads } = harness()
    const traps = { ownKeys: 0, get: 0 }
    const hostile = new Proxy({}, {
      ownKeys: () => { traps.ownKeys += 1; throw new Error('must not inspect') },
      get: () => { traps.get += 1; throw new Error('must not inspect') },
    })
    const messageError = await service.submitMessage(hostile).catch(error => error as Error & Record<string, unknown>)
    const controlError = await service.submitControl(hostile).catch(error => error as Error & Record<string, unknown>)
    const cancelError = await service.cancelEffect(hostile).catch(error => error as Error & Record<string, unknown>)
    expect(messageError).toMatchObject({
      code: 'SWARM_CAPABILITY_UNAVAILABLE', capability: 'message.write', blocker: 'i1b-effect-correlation',
      result: AgentSwarm.SWARM_PRODUCER_FIXTURES_V1.unavailable.message,
    })
    expect(controlError).toMatchObject({
      code: 'SWARM_CAPABILITY_UNAVAILABLE', capability: 'control.write', blocker: 'i1b-effect-correlation',
      result: AgentSwarm.SWARM_PRODUCER_FIXTURES_V1.unavailable.control,
    })
    expect(cancelError).toMatchObject({
      code: 'SWARM_CAPABILITY_UNAVAILABLE', capability: 'effect.cancel', blocker: 'i1b-effect-correlation',
      result: AgentSwarm.SWARM_PRODUCER_FIXTURES_V1.unavailable.cancel,
    })
    expect(traps).toEqual({ ownKeys: 0, get: 0 })
    expect(domainReads).not.toHaveBeenCalled()
    expect(overlayReads).not.toHaveBeenCalled()
    expect(records).toHaveLength(1)
  })

  it('uses the official provide lifecycle and drains admitted reads before closing', async () => {
    let release!: (snapshot: AgentSwarm.TeamStatusSnapshot) => void
    const blocked = new Promise<AgentSwarm.TeamStatusSnapshot>(resolve => { release = resolve })
    const { service } = harness({ snapshot: () => blocked })
    const ctx = new Context()
    const unprovide = AgentSwarm.provideAgentSwarmProducerFloor(ctx, service)
    expect(ctx.agentSwarmProducerFloor).toBe(service)

    const read = service.readSnapshot({ teamId: 'team-floor' }, { agent: ROOT, signal: SIGNAL })
    const disposal = unprovide()
    expect((ctx as Context & { agentSwarmProducerFloor?: unknown }).agentSwarmProducerFloor).toBeUndefined()
    await expect(service.readSnapshot({ teamId: 'team-floor' }, { agent: ROOT, signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'SWARM_HOST_CLOSED' })

    release({ team: teamState(), readyTaskIds: [], pendingMessageIds: [] })
    await expect(read).resolves.toMatchObject({ team: { id: 'team-floor' } })
    await expect(disposal).resolves.toBeUndefined()
    expect(() => service.describe()).toThrow(expect.objectContaining({ code: 'SWARM_HOST_CLOSED' }))
    await expect(service.submitMessage({})).rejects.toMatchObject({ code: 'SWARM_HOST_CLOSED' })
  })
})
