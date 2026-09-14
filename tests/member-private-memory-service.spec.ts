/**
 * Unit tests for the owning-member oracle in `MemberPrivateMemoryService`
 * (2026-08-26): independent of the Team/storage stack, proves the live-Agent
 * identity check is fail-closed — a forged or stale handle that merely carries a
 * valid member id must be rejected before any membership resolution or storage write.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  MemberPrivateMemoryService,
  type MemberPrivateMemoryServiceDeps,
} from '../src/runtime/member-private-memory-service.js'
import type { ToolExecutionAuthority } from '../src/runtime/orchestrator-runtime.js'
import { MemberPrivateMemoryStore, privateMemoryDomainSpec } from '../src/storage/member-private-memory.js'
import { FaultableBackend, openFaultableStack } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

function fakeAgent(id: string): Agent {
  return { id } as unknown as Agent
}

function service(opts: {
  liveAgentMap: Map<string, Agent>
  requireMembershipRole?: 'captain' | 'member'
  store: MemberPrivateMemoryStore
}) {
  const liveAgent = vi.fn((id: string) => opts.liveAgentMap.get(id))
  const requireMembership = vi.fn(async () => ({ team: { id: 'team-x' }, role: opts.requireMembershipRole ?? 'member', name: 'member' }))
  const deps = {
    domain: () => ({ requireMembership }),
    scopeOf: () => 'scope',
    store: () => opts.store,
    liveAgent,
  } as unknown as MemberPrivateMemoryServiceDeps
  const serviceInstance = new MemberPrivateMemoryService(deps)
  return { serviceInstance, liveAgent, requireMembership }
}

function fakeStore(): MemberPrivateMemoryStore {
  const calls: unknown[][] = []
  return {
    append: vi.fn(async (...args: unknown[]) => {
      calls.push(args)
      return { schemaVersion: 1, scope: 'scope', teamId: 'team-x', memberSessionId: 'member-1', seq: 1, memoryId: 'private-memory-1', content: String(args[3]), evidenceRefs: [], createdAt: 1 }
    }),
    listPage: vi.fn(() => ({ rows: [], nextCursor: undefined })),
    close: () => {},
  } as unknown as MemberPrivateMemoryStore
}

describe('MemberPrivateMemoryService owning-member oracle', () => {
  it('rejects a stale or forged handle that reuses the live member id, before membership or storage', async () => {
    const live = fakeAgent('member-1')
    const forged = fakeAgent('member-1') // same id, NOT the registered object
    const { serviceInstance, requireMembership } = service({ liveAgentMap: new Map([['member-1', live]]), store: fakeStore() })
    const exec: ToolExecutionAuthority = { agent: forged, signal: SIGNAL }
    await expect(serviceInstance.add(exec, 'x', [])).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    await expect(serviceInstance.list(exec, { cursor: 0, limit: 10 })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    expect(requireMembership).not.toHaveBeenCalled()
  })

  it('rejects when no live agent is registered for the given id', async () => {
    const { serviceInstance, requireMembership } = service({ liveAgentMap: new Map(), store: fakeStore() })
    await expect(serviceInstance.add({ agent: fakeAgent('ghost'), signal: SIGNAL }, 'x', []))
      .rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    expect(requireMembership).not.toHaveBeenCalled()
  })

  it('accepts the exact live registered member handle and appends', async () => {
    const live = fakeAgent('member-1')
    const store = fakeStore()
    const { serviceInstance } = service({ liveAgentMap: new Map([['member-1', live]]), store })
    const record = await serviceInstance.add({ agent: live, signal: SIGNAL }, 'note', ['ev-1'])
    expect(record).toMatchObject({ memoryId: 'private-memory-1', memberSessionId: 'member-1' })
    expect(store.append).toHaveBeenCalledTimes(1)
  })

  it('still rejects the exact live handle when it is not an active owning member (captain)', async () => {
    const live = fakeAgent('captain-1')
    const { serviceInstance } = service({ liveAgentMap: new Map([['captain-1', live]]), requireMembershipRole: 'captain', store: fakeStore() })
    await expect(serviceInstance.add({ agent: live, signal: SIGNAL }, 'x', []))
      .rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
  })
})

async function memoryFixture() {
  const stack = await openFaultableStack(new FaultableBackend())
  const memoryDomain = await stack.ctx.storageDomain.open(privateMemoryDomainSpec)
  const store = new MemberPrivateMemoryStore(stack.ctx, memoryDomain)
  const scope = 'private-memory-admission'
  const team = await stack.port.createTeam(scope, 'captain', 'Memory', 'Queued admission')
  await stack.port.provisionMember(scope, team.id, 'captain', { name: 'member', role: 'Notes', sessionId: 'member', provider: 'test' })
  await stack.port.settleMember(scope, team.id, 'member', { active: true })
  const agent = fakeAgent('member'), live = new Map([['member', agent]])
  const service = new MemberPrivateMemoryService({ domain: () => stack.port, store: () => store, scopeOf: () => scope, liveAgent: id => live.get(id) })
  return { stack, memoryDomain, store, scope, team, agent, live, service, async close() {
    store.close(); await memoryDomain.close(); await stack.close()
  } }
}

describe('private memory queued admission over the real Team and storage locks', () => {
  it.each(['removed', 'archived', 'cancelled', 'replaced-agent'] as const)('rejects a queued write after %s before its durable side effect', async reason => {
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, live, service } = fixture
    const cancellation = new AbortController()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; return put(key, value) })
    // An earlier storage operation owns the existing memory queue. The second
    // request resolves real membership while active, then waits behind it.
    const first = store.append(scope, team.id, agent.id, 'committed predecessor', [])
    await started
    const appendSpy = vi.spyOn(store, 'append')
    const waiting = service.add({ agent, signal: cancellation.signal }, 'must not persist', []).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error: error as unknown }))
    try {
      await vi.waitFor(() => { expect(appendSpy).toHaveBeenCalledTimes(1) })
      // Real domain transitions take the SAME aggregate lock as memory admission.
      // They must finish while the waiting write has not acquired that lock.
      if (reason === 'removed') await stack.port.removeMember(scope, team.id, 'captain', 'member', 'revoke queued memory')
      if (reason === 'archived') await stack.port.archiveTeam(scope, team.id, 'captain', 'close queued memory')
      if (reason === 'cancelled') cancellation.abort(new Error('cancel queued memory'))
      if (reason === 'replaced-agent') live.set(agent.id, fakeAgent(agent.id))
      release()
      await first
      const result = await waiting
      expect(result.error).toBeDefined()
      expect(result.value).toBeUndefined()
      expect(putSpy).toHaveBeenCalledTimes(1)
      expect(store.listPage(scope, team.id, agent.id, 0, 10).rows.map(row => [row.seq, row.content]))
        .toEqual([[1, 'committed predecessor']])
      if (reason === 'cancelled' || reason === 'replaced-agent') {
        const accepted = await service.add({ agent: live.get(agent.id)!, signal: SIGNAL }, 'next authorized note', [])
        expect(accepted).toMatchObject({ seq: 2, memoryId: 'private-memory-2' })
      }
    } finally {
      release()
      await Promise.allSettled([first, waiting])
      putSpy.mockRestore()
      await fixture.close()
    }
  })

  it.each(['cancelled', 'closed'] as const)('rechecks %s after the memory queue has entered and the Team lock is released', async reason => {
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, service } = fixture
    const cancellation = new AbortController(), cancelled = new Error('cancel while waiting for Team')
    let entered!: () => void, release!: () => void, teamEntered!: () => void, releaseTeam!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const teamStarted = new Promise<void>(resolve => { teamEntered = resolve }), teamHeld = new Promise<void>(resolve => { releaseTeam = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; return put(key, value) })
    const first = store.append(scope, team.id, agent.id, 'first', [])
    await started
    const appendSpy = vi.spyOn(store, 'append'), transactSpy = vi.spyOn(stack.store, 'transact')
    const waiting = service.add({ agent, signal: cancellation.signal }, 'blocked by Team lock', []).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error: error as unknown }))
    let holding: Promise<void> | undefined
    try {
      await vi.waitFor(() => { expect(appendSpy).toHaveBeenCalledTimes(1) })
      holding = stack.store.transact(scope, team.id, async () => { teamEntered(); await teamHeld })
      await teamStarted
      release(); await first
      await vi.waitFor(() => { expect(transactSpy).toHaveBeenCalledTimes(2) })
      if (reason === 'cancelled') cancellation.abort(cancelled)
      else store.close()
      releaseTeam(); await holding
      const result = await waiting
      if (reason === 'cancelled') expect(result.error).toBe(cancelled)
      else expect(result.error).toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_STORE_CLOSED' })
      expect(result.value).toBeUndefined()
      expect(putSpy).toHaveBeenCalledTimes(1)
      expect([...table.entries()].map(([, row]) => row.content)).toEqual(['first'])
    } finally {
      release(); releaseTeam()
      await Promise.allSettled([first, waiting, holding])
      putSpy.mockRestore(); transactSpy.mockRestore()
      await fixture.close()
    }
  })

  it('holds membership until an admitted put settles and does not claim late abort rolled it back', async () => {
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, service } = fixture
    const cancellation = new AbortController()
    const order: string[] = []
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; await put(key, value); order.push('memory committed') })
    const before = await stack.store.read(scope, team.id)
    const writing = service.add({ agent, signal: cancellation.signal }, 'admitted before abort', [])
    await started
    let removed = false
    const removal = stack.port.removeMember(scope, team.id, 'captain', 'member', 'remove after write').then(() => { removed = true; order.push('member removed') })
    try {
      cancellation.abort(new Error('too late to retract the started put'))
      expect(removed).toBe(false)
      release()
      expect(await writing).toMatchObject({ seq: 1, content: 'admitted before abort' })
      await removal
      expect(order).toEqual(['memory committed', 'member removed'])
      expect(store.listPage(scope, team.id, agent.id, 0, 10).rows).toHaveLength(1)
      const after = await stack.store.read(scope, team.id)
      expect(after!.revision).toBe(before!.revision + 1) // Only removal advances the Team.
      expect(after!.memory).toEqual(before!.memory)
    } finally {
      release(); await Promise.allSettled([writing, removal]); putSpy.mockRestore()
      await fixture.close()
    }
  })

  // The maintenance entry (task-4) queues the same way: eligibility resolves
  // BEFORE queue entry, then the durable write waits on the memory queue and
  // the Team fence. These cases prove the FINAL pre-IO checks of an ALREADY
  // ELIGIBLE queued maintenance — removed member, archived Team, aborted
  // signal, and a swapped live Agent each reject with ZERO extra rows. They
  // are not covered by the legacy `add` cases above, and prove nothing about
  // the first-eligibility wait (that is the writes-spec abort case).
  it.each(['removed', 'archived', 'cancelled', 'replaced-agent'] as const)('rejects a queued MAINTENANCE after %s before its durable side effect', async reason => {
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, live, service } = fixture
    const cancellation = new AbortController()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; return put(key, value) })
    // An earlier storage operation owns the memory queue; the maintenance is
    // admitted (membership active) and then waits behind it.
    const first = store.append(scope, team.id, agent.id, 'committed predecessor', [])
    await started
    const maintenanceSpy = vi.spyOn(store, 'appendMaintenance')
    const waiting = service.maintain({ agent, signal: cancellation.signal }, {
      operation: 'add', operationId: 'op-queued-fence', content: 'must not persist', evidenceRefs: [], tags: [], applicability: '',
    }).then(value => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined as unknown, error }))
    try {
      await vi.waitFor(() => { expect(maintenanceSpy).toHaveBeenCalledTimes(1) })
      if (reason === 'removed') await stack.port.removeMember(scope, team.id, 'captain', 'member', 'revoke queued maintenance')
      if (reason === 'archived') await stack.port.archiveTeam(scope, team.id, 'captain', 'close queued maintenance')
      if (reason === 'cancelled') cancellation.abort(new Error('cancel queued maintenance'))
      if (reason === 'replaced-agent') live.set(agent.id, fakeAgent(agent.id))
      release()
      await first
      const result = await waiting
      expect(result.error).toBeDefined()
      expect(result.value).toBeUndefined()
      expect(putSpy).toHaveBeenCalledTimes(1) // only the predecessor persisted
      expect(store.listPage(scope, team.id, agent.id, 0, 10).rows.map(row => [row.seq, row.content]))
        .toEqual([[1, 'committed predecessor']])
    } finally {
      release(); await Promise.allSettled([first, waiting]); putSpy.mockRestore(); maintenanceSpy.mockRestore()
      await fixture.close()
    }
  })

  it.each(['cancelled', 'closed'] as const)('rechecks %s for a QUEUED MAINTENANCE after the memory queue entered and the Team lock releases', async reason => {
    // Maintenance-specific (mirrors the legacy `add` case): the eligible
    // maintenance has entered the memory queue, THEN the Team lock is held by
    // someone else; abort/Store-close while waiting on that lock rejects before
    // any maintenance put, with the predecessor as the only row.
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, service } = fixture
    const cancellation = new AbortController(), cancelled = new Error('cancel maintenance while waiting for Team')
    let entered!: () => void, release!: () => void, teamEntered!: () => void, releaseTeam!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const teamStarted = new Promise<void>(resolve => { teamEntered = resolve }), teamHeld = new Promise<void>(resolve => { releaseTeam = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; return put(key, value) })
    const first = store.append(scope, team.id, agent.id, 'first', [])
    await started
    const maintenanceSpy = vi.spyOn(store, 'appendMaintenance')
    const transactSpy = vi.spyOn(stack.store, 'transact')
    const waiting = service.maintain({ agent, signal: cancellation.signal }, {
      operation: 'add', operationId: 'op-team-lock', content: 'blocked by Team lock', evidenceRefs: [], tags: [], applicability: '',
    }).then(value => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined as unknown, error }))
    let holding: Promise<void> | undefined
    try {
      await vi.waitFor(() => { expect(maintenanceSpy).toHaveBeenCalledTimes(1) })
      holding = stack.store.transact(scope, team.id, async () => { teamEntered(); await teamHeld })
      await teamStarted
      release(); await first
      await vi.waitFor(() => { expect(transactSpy).toHaveBeenCalledTimes(2) })
      if (reason === 'cancelled') cancellation.abort(cancelled)
      else store.close()
      releaseTeam(); await holding
      const result = await waiting
      if (reason === 'cancelled') expect(result.error).toBe(cancelled)
      else expect(result.error).toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_STORE_CLOSED' })
      expect(result.value).toBeUndefined()
      expect(putSpy).toHaveBeenCalledTimes(1)
      expect([...table.entries()].map(([, row]) => row.content)).toEqual(['first'])
    } finally {
      release(); releaseTeam()
      await Promise.allSettled([first, waiting, holding])
      putSpy.mockRestore(); transactSpy.mockRestore(); maintenanceSpy.mockRestore()
      await fixture.close()
    }
  })

  it('rejects a queued maintenance whose scope moved away while it waited', async () => {
    // scopeOf is consulted per attempt: a maintenance admitted under one scope
    // re-resolves the Team under the CURRENT scope inside the fence. A scope
    // change while queued rejects with zero durable effect — the write never
    // lands in another scope's partition.
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, live } = fixture
    let currentScope = scope
    const service = new MemberPrivateMemoryService({
      domain: () => stack.port, store: () => store, scopeOf: () => currentScope, liveAgent: id => live.get(id),
    })
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; return put(key, value) })
    const first = store.append(scope, team.id, agent.id, 'committed predecessor', [])
    await started
    const maintenanceSpy = vi.spyOn(store, 'appendMaintenance')
    const waiting = service.maintain({ agent, signal: SIGNAL }, {
      operation: 'add', operationId: 'op-scope-moved', content: 'must not land elsewhere', evidenceRefs: [], tags: [], applicability: '',
    }).then(value => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined as unknown, error }))
    try {
      await vi.waitFor(() => { expect(maintenanceSpy).toHaveBeenCalledTimes(1) })
      currentScope = 'scope-moved-while-queued'
      release()
      await first
      const result = await waiting
      expect(result.error).toBeDefined()
      expect(result.value).toBeUndefined()
      expect(putSpy).toHaveBeenCalledTimes(1)
      expect(store.listPage(scope, team.id, agent.id, 0, 10).rows.map(row => [row.seq, row.content]))
        .toEqual([[1, 'committed predecessor']])
      // The other scope gained NOTHING either (its partition does not exist).
      expect(store.listPage('scope-moved-while-queued' as typeof scope, team.id, agent.id, 0, 10).rows).toHaveLength(0)
    } finally {
      release(); await Promise.allSettled([first, waiting]); putSpy.mockRestore(); maintenanceSpy.mockRestore()
      await fixture.close()
    }
  })

  it('holds an admitted maintenance put: a late abort does not roll it back and removal waits for the commit', async () => {
    // Maintenance-specific mirror of the legacy settled-put case: once the
    // durable maintenance put is admitted, a late abort cannot retract it, the
    // real removeMember waits behind it, and only the removal moves the Team.
    const fixture = await memoryFixture()
    const { stack, memoryDomain, store, scope, team, agent, service } = fixture
    const cancellation = new AbortController()
    const order: string[] = []
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const table = memoryDomain.table('memories'), put = table.put.bind(table)
    const putSpy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { entered(); await held; await put(key, value); order.push('memory committed') })
    const before = await stack.store.read(scope, team.id)
    const writing = service.maintain({ agent, signal: cancellation.signal }, {
      operation: 'add', operationId: 'op-late-abort', content: 'admitted before abort', evidenceRefs: [], tags: [], applicability: '',
    })
    await started
    let removed = false
    const removal = stack.port.removeMember(scope, team.id, 'captain', 'member', 'remove after maintenance write').then(() => { removed = true; order.push('member removed') })
    try {
      cancellation.abort(new Error('too late to retract the admitted maintenance put'))
      expect(removed).toBe(false)
      release()
      expect(await writing).toMatchObject({ replayed: false, receipt: { operationId: 'op-late-abort', operationSeq: 1, headSeq: 1, status: 'active' } })
      await removal
      expect(order).toEqual(['memory committed', 'member removed'])
      const rows = store.listPage(scope, team.id, agent.id, 0, 10).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ seq: 1, content: 'admitted before abort' })
      const after = await stack.store.read(scope, team.id)
      expect(after!.revision).toBe(before!.revision + 1) // Only removal advances the Team.
      expect(after!.memory).toEqual(before!.memory)
    } finally {
      release(); await Promise.allSettled([writing, removal]); putSpy.mockRestore()
      await fixture.close()
    }
  })
})

/**
 * Host provenance observation for maintenance writes (task-4): attribution
 * requires EXACTLY ONE `in_progress` task owned by this member whose current
 * attempt durably belongs to that task AND to this member AND is `running`.
 * Everything else — no candidate, several candidates, a non-running phase, or
 * an attempt whose taskId/memberSessionId disagree with the task — must yield
 * the explicit unattributed branch, never a near-miss attribution.
 */
describe('MemberPrivateMemoryService maintenance provenance observation', () => {
  const probeLive = fakeAgent('member-1')

  function provenanceProbe(facts: { tasks: Record<string, unknown>[]; attempts: Record<string, unknown>[] }): { serviceInstance: MemberPrivateMemoryService; observed(): unknown } {
    let observed: unknown
    const store = {
      appendMaintenance: vi.fn(async (_scope: unknown, _team: unknown, _member: unknown, input: { operationId: string; operation: 'add' | 'revise' | 'invalidate' | 'replace' }, provenance: unknown,
        admit: (write: () => Promise<unknown>) => Promise<unknown>) => {
        observed = provenance
        return admit(() => Promise.resolve({
          receipt: { operationId: input.operationId, operation: input.operation, operationSeq: 1, resultMemoryId: 'private-memory-1', headSeq: 1, status: 'active' },
          replayed: false,
        }))
      }),
    } as unknown as MemberPrivateMemoryStore
    const domain = {
      requireMembership: async () => ({ team: { id: 'team-x', revision: 7, tasks: facts.tasks, attempts: facts.attempts }, role: 'member', name: 'member' }),
      withActiveMember: (_scope: unknown, _team: unknown, _member: unknown, operation: () => Promise<unknown>) => operation(),
    }
    const serviceInstance = new MemberPrivateMemoryService({
      domain: () => domain,
      scopeOf: () => 'scope',
      store: () => store,
      liveAgent: (id: string) => (id === probeLive.id ? probeLive : undefined),
      now: () => 1234,
    } as unknown as MemberPrivateMemoryServiceDeps)
    return { serviceInstance, observed: () => observed }
  }

  const addInput = { operation: 'add', operationId: 'op-probe', content: 'note', evidenceRefs: [], tags: [], applicability: '' } as const

  /** One member-owned in-progress task with a running current attempt, freely mutable. */
  function runningFacts(): { tasks: Record<string, unknown>[]; attempts: Record<string, unknown>[] } {
    return {
      tasks: [{ id: 'task-1', revision: 1, status: 'in_progress', ownerSessionId: 'member-1', currentAttemptId: 'attempt-1' }],
      attempts: [{ id: 'attempt-1', taskId: 'task-1', memberSessionId: 'member-1', phase: 'running', generation: 1, assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1 }],
    }
  }

  it('attributes exactly one in-progress task whose current running attempt is durably owned by this member and task', async () => {
    const probe = provenanceProbe(runningFacts())
    await probe.serviceInstance.maintain({ agent: probeLive, signal: SIGNAL }, addInput as never)
    expect(probe.observed()).toEqual({ kind: 'task', taskId: 'task-1', attemptId: 'attempt-1', teamRevision: 7, observedAt: 1234 })
  })

  it('is unattributed when the current attempt is no longer running', async () => {
    const facts = runningFacts()
    facts.attempts[0]!.phase = 'submitted'
    const probe = provenanceProbe(facts)
    await probe.serviceInstance.maintain({ agent: probeLive, signal: SIGNAL }, addInput as never)
    expect(probe.observed()).toEqual({ kind: 'unattributed' })
  })

  it('is unattributed when the current attempt does not durably belong to the task', async () => {
    const facts = runningFacts()
    facts.attempts[0]!.taskId = 'task-other'
    const probe = provenanceProbe(facts)
    await probe.serviceInstance.maintain({ agent: probeLive, signal: SIGNAL }, addInput as never)
    expect(probe.observed()).toEqual({ kind: 'unattributed' })
  })

  it('is unattributed when the current attempt belongs to a different member', async () => {
    const facts = runningFacts()
    facts.attempts[0]!.memberSessionId = 'member-other'
    const probe = provenanceProbe(facts)
    await probe.serviceInstance.maintain({ agent: probeLive, signal: SIGNAL }, addInput as never)
    expect(probe.observed()).toEqual({ kind: 'unattributed' })
  })

  it('is unattributed when more than one task could attribute the write', async () => {
    const facts = runningFacts()
    facts.tasks.push({ id: 'task-2', revision: 1, status: 'in_progress', ownerSessionId: 'member-1', currentAttemptId: 'attempt-2' })
    facts.attempts.push({ id: 'attempt-2', taskId: 'task-2', memberSessionId: 'member-1', phase: 'running', generation: 1, assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1 })
    const probe = provenanceProbe(facts)
    await probe.serviceInstance.maintain({ agent: probeLive, signal: SIGNAL }, addInput as never)
    expect(probe.observed()).toEqual({ kind: 'unattributed' })
  })
})
