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
      .toBe('d32b4a9968b1083383e21f8abb9b3487846bf078b8cb632d43f4955d46a20ea5')
  })

  it('requires the exact live root and returns bounded frozen redacted projections', async () => {
    const { service } = harness()
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
    await expect(service.submitMessage(hostile)).rejects.toMatchObject({ code: 'SWARM_CAPABILITY_UNAVAILABLE' })
    await expect(service.submitControl(hostile)).rejects.toMatchObject({ code: 'SWARM_CAPABILITY_UNAVAILABLE' })
    await expect(service.cancelEffect(hostile)).rejects.toMatchObject({ code: 'SWARM_CAPABILITY_UNAVAILABLE' })
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
