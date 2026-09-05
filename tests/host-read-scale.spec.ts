/** Actual StorageDomain reads/clones for one RPC refresh; no timing assertions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import { AgentSwarmReadRpcService, type SwarmWebServer } from '../src/rpc/read-rpc-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { openStorageStack } from './helpers/storage-stack.js'
import { TaskId } from '../src/domain/types.js'

it.each([1, 2, 8])('real store scale matrix: %i members and growing retained task history', async members => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-read-scale-'))
  const stack = await openStorageStack(join(sandbox, 'storage'))
  const scope = join(sandbox, 'workspace')
  const root = { id: 'scale-main', session: { header: { cwd: scope } } } as unknown as Agent
  const captains = ['scale-a', 'scale-b']
  let initiator: Agent | undefined
  const ctx = {
    agents: { get: (id: string) => id === root.id ? root : undefined, roots: () => [root], currentInitiator: () => initiator,
      withInitiator: async <T>(agent: Agent, callback: () => Promise<T>) => { initiator = agent; try { return await callback() } finally { initiator = undefined } } },
    sessions: { get: (id: string) => id === root.id ? root.session : captains.includes(id) ? { header: { cwd: scope, parentSession: root.id } } : undefined },
  } as unknown as Context
  const list = vi.fn((requested: string) => stack.store.list(requested))
  const runtime = { scopeOf: () => scope, listTeamAggregates: list, managedCaptainSessionsOf: () => captains, domain: stack.port } as unknown as AgentSwarmRuntime
  const hostRead = new AgentSwarmHostReadService({ currentInitiator: () => initiator, isExactLiveRoot: agent => agent === root,
    scopeOf: () => scope, teams: list, domain: () => stack.port, overlay: { list: () => [] }, managedCaptainSessionsOf: () => captains })
  // Optional read-only baseline execution imports the accepted checkout's RPC;
  // ordinary regression runs always exercise this candidate and demand one scan.
  const baseline = process.env.SWARM_READ_BASELINE
  const Rpc = baseline === undefined ? AgentSwarmReadRpcService : (await import(/* @vite-ignore */ baseline) as { AgentSwarmReadRpcService: typeof AgentSwarmReadRpcService }).AgentSwarmReadRpcService
  const service = new Rpc({ ctx, runtime, hostRead, webServer: { host: '127.0.0.1', port: 3182, register: () => {} } as unknown as SwarmWebServer })
  try {
    const teams = await Promise.all(captains.map(id => stack.port.createTeam(scope, id, id, 'scale fixture')))
    for (const history of [0, 32, 128]) {
      for (const team of teams) await stack.store.transact(scope, team.id, draft => {
        draft.members.splice(0, draft.members.length, ...Array.from({ length: members }, (_, index) => ({ name: `member-${index}`, role: 'writer', phase: 'active' as const, provider: 'spawn', sessionId: `${team.id}-member-${index}`, createdAt: 1 })))
        draft.tasks.splice(0, draft.tasks.length, ...Array.from({ length: history }, (_, index) => ({ id: TaskId(`task-${index}`), revision: 1, subject: `task ${index}`, description: 'retained task', acceptanceCriteria: [], status: 'pending' as const, blockedBy: [], writeScopes: [], priority: 0, createdAt: 1, updatedAt: 1 })))
      })
      list.mockClear()
      const get = vi.spyOn(stack.domain.table('teams'), 'get')
      const clone = vi.spyOn(globalThis, 'structuredClone')
      try {
        const response = await service.invoke({ schemaVersion: 1, method: 'teams', target: { rootSessionId: root.id } })
        const result = { baseline: baseline !== undefined, members, history, teams: teams.length, lists: list.mock.calls.length, storeReads: get.mock.calls.length, clones: clone.mock.calls.length, responseBytes: Buffer.byteLength(JSON.stringify(response)) }
        console.log('188-SCALE', JSON.stringify(result))
        expect(result.lists).toBe(baseline === undefined ? 1 : 2)
        expect(result.storeReads).toBe(teams.length * result.lists)
        expect(result.clones).toBe(teams.length * result.lists)
      } finally { get.mockRestore(); clone.mockRestore() }
    }
  } finally { await hostRead.dispose(); await stack.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5 }) }
})
