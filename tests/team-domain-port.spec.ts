import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { TeamDomainError } from '../src/index.js'
import { TaskId, TeamId, type TeamId as TeamIdType, type TeamState } from '../src/domain/types.js'
import {
  FaultableBackend,
  openFaultableStack,
  openStorageStack,
  unitFilePath,
  type StorageStack,
} from './helpers/storage-stack.js'

function baseTeam(id: string, captain = 'captain-session'): TeamState {
  const timestamp = 1
  return {
    schemaVersion: 1,
    id: TeamId(id),
    revision: 1,
    name: 'Port team',
    description: 'Conformance fixture aggregate',
    captainSessionId: captain,
    phase: 'active',
    members: [],
    tasks: [],
    attempts: [],
    messages: [],
    budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: { [captain]: -1 },
    memory: [],
    nextTaskNumber: 1,
    nextMemoryNumber: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

describe('TeamDomainPort provider over the official Storage Domain', () => {
  let sandbox: string
  let tick: number
  let stack: StorageStack

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-port-'))
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true })
  })

  it('round-trips aggregates and isolates workspace scopes', async () => {
    const left = baseTeam('team-port-left-0001')
    const right = baseTeam('team-port-right-0002', 'other-captain')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws-left'), left)
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws-right'), right)

    expect((await stack.store.read(join(sandbox, 'ws-left'), left.id))?.id).toBe(left.id)
    expect(await stack.store.read(join(sandbox, 'ws-right'), left.id)).toBeUndefined()
    expect(await stack.store.read(join(sandbox, 'ws-left'), right.id)).toBeUndefined()
    expect((await stack.store.list(join(sandbox, 'ws-left'))).map(team => team.id)).toEqual([left.id])
    expect((await stack.store.list(join(sandbox, 'ws-right'))).map(team => team.id)).toEqual([right.id])
    expect(await stack.store.list(join(sandbox, 'ws-empty'))).toEqual([])
  })

  it('keeps every committed transaction durable across a full reopen', async () => {
    const team = baseTeam('team-port-durable-0003')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
    await stack.store.transact(join(sandbox, 'ws'), team.id, draft => {
      draft.tasks.push({
        id: TaskId('task-1'),
        revision: 1,
        subject: 'durable',
        description: 'Survive close and reopen',
        acceptanceCriteria: [],
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
        priority: 0,
        createdAt: 2,
        updatedAt: 2,
      })
      Object.assign(draft, { nextTaskNumber: 2 })
    })

    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    const reloaded = await stack.store.read(join(sandbox, 'ws'), team.id)
    expect(reloaded?.revision).toBe(2)
    expect(reloaded?.tasks).toHaveLength(1)
    expect(reloaded?.nextTaskNumber).toBe(2)
    expect(reloaded?.updatedAt).toBeGreaterThan(0)
  })

  it('does not bump revision or persist a no-op transaction', async () => {
    const team = baseTeam('team-port-noop-0000004')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
    await stack.store.transact(join(sandbox, 'ws'), team.id, () => 'no-change')
    const stored = await stack.store.read(join(sandbox, 'ws'), team.id)
    expect(stored?.revision).toBe(team.revision)
  })

  it('enforces one active team per captain per scope and unique ids', async () => {
    const first = baseTeam('team-port-first-000005')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), first)
    await expect(stack.store.createUniqueForCaptain(join(sandbox, 'ws'), baseTeam('team-port-second-0006')))
      .rejects.toMatchObject({ code: 'TEAM_ALREADY_ACTIVE' })
    // The same captain may open a team in another scope.
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws-other'), baseTeam('team-port-third-000007'))
    // Team ids are unique across the whole domain.
    await expect(stack.store.createUniqueForCaptain(join(sandbox, 'ws-other'), baseTeam('team-port-first-000005', 'another')))
      .rejects.toMatchObject({ code: 'TEAM_ALREADY_EXISTS' })
  })

  it('wakes revision waiters from durable commits and honors aborts', async () => {
    const team = baseTeam('team-port-wait-0000008')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
    const controller = new AbortController()
    const waiting = stack.store.waitForChange(join(sandbox, 'ws'), team.id, team.revision, controller.signal)
    await stack.store.transact(join(sandbox, 'ws'), team.id, draft => { Object.assign(draft, { name: 'Renamed' }) })
    await expect(waiting).resolves.toMatchObject({ revision: 2, name: 'Renamed' })

    const aborted = stack.store.waitForChange(join(sandbox, 'ws'), team.id, 2, AbortSignal.abort(new Error('stop')))
    await expect(aborted).rejects.toThrowError('stop')
  })

  it('rejects a version-stamped medium at reopen', async () => {
    const team = baseTeam('team-port-version-00009')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
    await stack.close()

    const path = unitFilePath(join(sandbox, 'storage'))
    const unit = JSON.parse(await readFile(path, 'utf8')) as { unit: { version: number } }
    unit.unit.version = 999
    await writeFile(path, JSON.stringify(unit, null, 2), 'utf8')

    await expect(openStorageStack(join(sandbox, 'storage'), () => tick++))
      .rejects.toMatchObject({ code: 'version-mismatch' })
    // Keep `stack` valid for the afterEach teardown.
    stack = await openStorageStack(join(sandbox, 'storage-fresh'), () => tick++)
  })

  it('rejects schema-corrupt records at reopen with invalid-record', async () => {
    const team = baseTeam('team-port-corrupt-00010')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
    await stack.close()

    const path = unitFilePath(join(sandbox, 'storage'))
    const unit = JSON.parse(await readFile(path, 'utf8')) as { tables: { teams: Record<string, { team: { revision: unknown } }> } }
    unit.tables.teams[team.id]!.team.revision = 'not-an-integer'
    await writeFile(path, JSON.stringify(unit, null, 2), 'utf8')

    const outcome = await openStorageStack(join(sandbox, 'storage'), () => tick++)
      .then(() => undefined, (error: { code?: string }) => error)
    expect(outcome).toMatchObject({ code: 'invalid-record' })
    // Keep `stack` valid for the afterEach teardown.
    stack = await openStorageStack(join(sandbox, 'storage-fresh'), () => tick++)
  })

  it('fails closed on lifecycle: closed store rejects reads, writes and waiters', async () => {
    const team = baseTeam('team-port-close-0000011')
    await stack.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
    const waiting = stack.store.waitForChange(join(sandbox, 'ws'), team.id, team.revision, new AbortController().signal)
    await stack.store.close()

    await expect(stack.store.read(join(sandbox, 'ws'), team.id)).rejects.toMatchObject({ code: 'TEAM_STORE_CLOSED' })
    await expect(stack.store.list(join(sandbox, 'ws'))).rejects.toMatchObject({ code: 'TEAM_STORE_CLOSED' })
    await expect(stack.store.transact(join(sandbox, 'ws'), team.id, () => 'x')).rejects.toMatchObject({ code: 'TEAM_STORE_CLOSED' })
    await expect(waiting).rejects.toMatchObject({ code: 'TEAM_STORE_CLOSED' })
    // Closing the domain itself rejects further writes and frees the name
    // for a later open (official domain semantics).
    await stack.domain.close()
    await expect(stack.domain.table('teams').put(TeamId('team-x'), {} as never)).rejects.toMatchObject({ code: 'closed' })
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    expect(await stack.store.read(join(sandbox, 'ws'), team.id)).toBeDefined()
  })

  it('leaves state untouched when the backend write fails durability', async () => {
    const backend = new FaultableBackend()
    const faulted = await openFaultableStack(backend, () => tick++)
    try {
      const team = baseTeam('team-port-fail-00000012')
      await faulted.store.createUniqueForCaptain(join(sandbox, 'ws'), team)
      backend.failNextWrites = 1
      await expect(faulted.store.transact(join(sandbox, 'ws'), team.id, draft => { Object.assign(draft, { name: 'Must not land' }) }))
        .rejects.toThrowError('injected write failure')
      const stored = await faulted.store.read(join(sandbox, 'ws'), team.id)
      expect(stored?.name).toBe('Port team')
      expect(stored?.revision).toBe(team.revision)
    } finally {
      await faulted.close()
    }
  })

  it('rejects a migration import when the backend write fails durability', async () => {
    const backend = new FaultableBackend()
    const faulted = await openFaultableStack(backend, () => tick++)
    try {
      const team = baseTeam('team-port-verify-000013')
      backend.failNextWrites = 1
      await expect(faulted.store.importAggregate(join(sandbox, 'ws'), team))
        .rejects.toThrowError('injected write failure')
      // The failed import left no record and the id stays importable.
      backend.failNextWrites = 0
      await expect(faulted.store.importAggregate(join(sandbox, 'ws'), team)).resolves.toBeUndefined()
    } finally {
      await faulted.close()
    }
  })

  it('never activates the plugin without session persistence and the storage domain', async () => {
    const sandboxPending = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-pending-'))
    try {
      // No persistence, no storage stack: the plugin must stay pending.
      const bare = new Context()
      const bareFiber = bare.plugin(AgentSwarm, { memberProvider: 'spawn' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(bare.get('agentSwarm')).toBeUndefined()
      await bareFiber.dispose()

      // Persistence present but no storage stack: still pending.
      const noStorage = new Context()
      await mountAgentLoopTestDependencies(noStorage)
      const noStorageFibers = [
        await noStorage.plugin(JsonlSessionPersistence, { root: join(sandboxPending, 'sessions-a') }),
        noStorage.plugin(SubagentService),
        noStorage.plugin(SubagentSpawn, { providerName: 'spawn' }),
        noStorage.plugin(AgentSwarm, { memberProvider: 'spawn' }),
      ]
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(noStorage.get('agentSwarm')).toBeUndefined()
      for (const fiber of noStorageFibers.toReversed()) await fiber.dispose()

      // Storage stack present but no persistence: still pending.
      const noPersistence = new Context()
      await mountAgentLoopTestDependencies(noPersistence)
      const noPersistenceFibers = [
        await noPersistence.plugin(Storage),
        await noPersistence.plugin(StorageJson, { root: join(sandboxPending, 'storage') }),
        await noPersistence.plugin(StorageDomain, { backend: 'json' }),
        noPersistence.plugin(SubagentService),
        noPersistence.plugin(SubagentSpawn, { providerName: 'spawn' }),
        noPersistence.plugin(AgentSwarm, { memberProvider: 'spawn' }),
      ]
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(noPersistence.get('agentSwarm')).toBeUndefined()
      for (const fiber of noPersistenceFibers.toReversed()) await fiber.dispose()
    } finally {
      await rm(sandboxPending, { recursive: true, force: true })
    }
  })

  it('activates and serves tools when persistence and the storage stack are composed', async () => {
    const active = new Context()
    const fibers = [] as import('@deepseek-ai/cordis').Fiber[]
    try {
      await mountAgentLoopTestDependencies(active)
      fibers.push(
        await active.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions') }),
        await active.plugin(AgentLoop, { agents: [] }),
        await active.plugin(Storage),
        await active.plugin(StorageJson, { root: join(sandbox, 'active-storage') }),
        await active.plugin(StorageDomain, { backend: 'json' }),
        await active.plugin(SubagentService),
        await active.plugin(SubagentSpawn, { providerName: 'spawn' }),
        await active.plugin(AgentSwarm, { memberProvider: 'spawn' }),
      )
      expect(active.agentSwarm).toBeDefined()
      const lead = active.agentLoop.create(
        SessionId('port-lead'),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )
      const created = await active.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('port-create'),
        name: 'agent_swarm_create',
        arguments: { name: 'Active team', description: 'Fail-closed positive control.' },
        agent: lead,
      })
      expect(created.isError).toBeFalsy()
      const teamId = (created.value as { team_id: TeamIdType }).team_id
      expect(teamId).toMatch(/^team-/)
      const snapshot = await active.agentSwarm.domain.snapshot(
        active.agentSwarm.scopeOf(lead), teamId, lead.id,
      )
      expect(snapshot.team.name).toBe('Active team')
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  })

  it('keeps a domain-level TeamDomainError distinct from storage pass-through errors', () => {
    const error = new TeamDomainError('message', 'TEAM_STORE_CLOSED')
    expect(error).toBeInstanceOf(TeamDomainError)
    expect(error.code).toBe('TEAM_STORE_CLOSED')
  })
})
