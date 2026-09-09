import { persistenceReadFixture } from './helpers/persistence-read-fixture.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'
import type { SwarmReadTeamsV1 } from '../src/rpc/read-rpc-contract.js'
import { SwarmReadClient } from '../src/client/index.js'
import { openStorageStack } from './helpers/storage-stack.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).toReversed()) await close() })

async function setup(cold = false) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-main-read-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const storage = await openStorageStack(join(directory, 'storage'))
  cleanups.push(() => storage.close())
  const scope = join(directory, 'workspace')
  const sessions = new Map<string, Session>()
  function session(id: string, parentSession?: string, cwd = scope) {
    const value = Session.create(SessionId(id), [], { version: SESSION_FORMAT_VERSION, id: SessionId(id),
      createdAt: 1, isSeeded: false, cwd, ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }) })
    sessions.set(id, value)
    return value
  }
  const main = session('main'), captain = session('captain', 'main'), sibling = session('sibling', 'main')
  session('member', 'captain'); session('ordinary-child', 'captain'); session('foreign-main'); session('foreign-captain', 'foreign-main')
  main.append('session/title', { title: '公开主会话标题', messageSeqs: [], source: { kind: 'user' } })
  const live = new Map<string, Agent>(cold ? [] : [...sessions].map(([id, value]) => [id, { id, session: value } as Agent]))
  const team = await storage.port.createTeam(scope, captain.id, 'First', 'First team')
  const other = await storage.port.createTeam(scope, sibling.id, 'Second', 'Second team')
  await storage.port.createTeam(scope, 'foreign-captain', 'Foreign', 'Other main')
  await storage.port.provisionMember(scope, team.id, captain.id, { name: 'worker', role: 'Writer', provider: 'spawn', sessionId: 'member' })
  await storage.port.settleMember(scope, team.id, 'member', { active: true })
  await storage.port.createTask(scope, other.id, sibling.id, { subject: 'Pending', description: 'Pending work' })
  const task = await storage.port.createTask(scope, other.id, sibling.id, { subject: 'Completed', description: 'Complete work' })
  const claimed = await storage.port.claimTask(scope, other.id, sibling.id, task.id, task.revision)
  const submitted = await storage.port.submitTask(scope, other.id, sibling.id, task.id, claimed.task.revision, claimed.attempt.id, 'done')
  await storage.port.reviewTask(scope, other.id, sibling.id, task.id, submitted.revision, claimed.attempt.id, 'accept')
  const inspect = vi.fn(async (id: string) => {
    const value = sessions.get(id)
    if (value === undefined) throw new Error('not found')
    return { meta: value.header, events: value.snapshotEvents(), inheritedEventCount: value.inheritedEventCount }
  })
  const ctx = { agents: { get: (id: string) => live.get(id), roots: () => [...live.values()].filter(agent => agent.session.header.parentSession === undefined) },
    sessions: { get: (id: string) => cold ? undefined : sessions.get(id) }, sessionPersistence: persistenceReadFixture(inspect) } as unknown as Context
  const list = vi.fn(() => storage.store.list(scope))
  const runtime = { scopeOf: (agent: Agent) => agent.session.header.cwd!, listTeamAggregates: list,
    managedCaptainSessionsOf: () => [], domain: storage.port } as unknown as AgentSwarmRuntime
  const hostRead = new AgentSwarmHostReadService({ currentInitiator: () => live.get('main'), isExactLiveRoot: () => true,
    scopeOf: runtime.scopeOf, teams: list, domain: () => storage.port, overlay: { list: () => [] } })
  cleanups.push(() => hostRead.dispose())
  const rpc = new AgentSwarmReadRpcService({ ctx, runtime, hostRead, webServer: { host: '127.0.0.1', port: 8279, register: vi.fn() } })
  const teams = (id: string) => rpc.invoke({ schemaVersion: 1, method: 'teams', target: { rootSessionId: id } }) as Promise<SwarmReadTeamsV1>
  const read = (id: string, teamId = other.id, method = 'snapshot') => rpc.invoke({ schemaVersion: 1, method, target: { rootSessionId: id, teamId } })
  return { storage, scope, sessions, session, live, inspect, list, rpc, teams, read, team, other }
}

describe('local UI main Session association (#225)', () => {
  for (const cold of [false, true]) it(`retains main, Captain and exact member association with sibling reads (${cold ? 'cold' : 'live'})`, async () => {
    const h = await setup(cold)
    for (const id of ['main', 'captain', 'member']) {
      const result = await h.teams(id)
      const client = new SwarmReadClient(async () => new Response(JSON.stringify({ schemaVersion: 1, ok: true, value: result })))
      await expect(client.request({ schemaVersion: 1, method: 'teams', target: { rootSessionId: id } })).resolves.toMatchObject({ ok: true, value: result })
      expect(result.binding).toEqual({ rootSessionId: id, mainSessionId: 'main', mainSessionTitle: '公开主会话标题',
        ...(id === 'main' ? {} : { currentTeamId: h.team.id }), ...(id === 'member' ? { currentMemberName: 'worker' } : {}) })
      expect(result.teams.map(team => team.teamId).toSorted()).toEqual([h.team.id, h.other.id].toSorted())
      expect(result.teams.find(team => team.teamId === h.team.id)?.summary).toEqual({ memberCount: 1, taskCount: 0, completedTaskCount: 0 })
      const sibling = result.teams.find(team => team.teamId === h.other.id)
      expect(sibling?.summary).toEqual({ memberCount: 0, taskCount: 2, completedTaskCount: 1 })
      expect(sibling?.endpoints.members.target).toEqual({ rootSessionId: id, teamId: h.other.id })
      for (const method of ['snapshot', 'captainMembers', 'captainAnnouncements', 'captainDiagnostics']) {
        expect(await h.read(id, h.other.id, method)).toMatchObject({ binding: { rootSessionId: 'sibling', teamId: h.other.id } })
      }
    }
    expect(await h.rpc.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: 'member' } }))
      .toMatchObject({ binding: { teamId: h.team.id } })
  })

  it('does not manufacture a missing public title', async () => {
    const h = await setup(true)
    h.session('main')
    expect((await h.teams('member')).binding).toEqual({ rootSessionId: 'member', mainSessionId: 'main', currentTeamId: h.team.id, currentMemberName: 'worker' })
  })

  it('keeps the exact member public name while reading a sibling and refreshes it from the owning aggregate', async () => {
    const h = await setup(true)
    const before = await h.storage.port.snapshot(h.scope, h.team.id, 'captain')
    await h.storage.port.setMemberProfile(h.scope, h.team.id, 'captain', before.team.revision, 'worker', { displayName: '公开成员名' })
    await h.read('member', h.other.id, 'captainMembers')
    expect((await h.teams('member')).binding).toMatchObject({ currentTeamId: h.team.id, currentMemberName: '公开成员名' })
    expect((await h.teams('captain')).binding).not.toHaveProperty('currentMemberName')
    const current = await h.storage.port.snapshot(h.scope, h.team.id, 'captain')
    await h.storage.port.setMemberProfile(h.scope, h.team.id, 'captain', current.team.revision, 'worker', { displayName: '更新后的公开名' })
    expect((await h.teams('member')).binding).toMatchObject({ currentMemberName: '更新后的公开名' })
  })

  it('does not promote ordinary, removed or previous member identities', async () => {
    const h = await setup(true)
    expect((await h.teams('ordinary-child')).teams).toEqual([])
    await expect(h.read('ordinary-child')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
    await h.storage.port.removeMember(h.scope, h.team.id, 'captain', 'worker', 'removed')
    expect((await h.teams('member')).teams).toEqual([])
    await expect(h.read('member')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  for (const fault of ['captain-cwd', 'main-cwd', 'nested-main', 'foreign-sibling', 'sibling-cwd', 'missing-captain'] as const) {
    it(`does not inherit siblings through ${fault}`, async () => {
      const h = await setup(true)
      if (fault === 'captain-cwd') h.session('captain', 'main', join(h.scope, 'foreign'))
      if (fault === 'main-cwd') h.session('main', undefined, join(h.scope, 'foreign'))
      if (fault === 'nested-main') h.session('main', 'foreign-main')
      if (fault === 'foreign-sibling') h.session('sibling', 'foreign-main')
      if (fault === 'sibling-cwd') h.session('sibling', 'main', join(h.scope, 'foreign'))
      if (fault === 'missing-captain') h.sessions.delete('captain')
      const result = await h.teams('member')
      expect(result.teams.map(team => team.teamId)).not.toContain(h.other.id)
      await expect(h.read('member')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
    })
  }

  it('rechecks exact membership after awaited Session inspection', async () => {
    const h = await setup(true)
    const original = h.inspect.getMockImplementation()!
    let removed = false
    h.inspect.mockImplementation(async id => {
      const value = await original(id)
      if (id === 'sibling' && !removed) {
        removed = true
        await h.storage.port.removeMember(h.scope, h.team.id, 'captain', 'worker', 'concurrent removal')
      }
      return value
    })
    await expect(h.read('member')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
    expect(removed).toBe(true)
  })

  it('denies a previous failed Session after an actual retry commit', async () => {
    const h = await setup(true)
    await h.storage.port.settleMember(h.scope, h.team.id, 'member', { active: false, error: 'startup failed' })
    h.session('replacement', 'captain')
    await h.storage.port.provisionMember(h.scope, h.team.id, 'captain', { name: 'worker', role: 'Writer', provider: 'spawn', sessionId: 'replacement', retryOf: 'member' })
    await h.storage.port.settleMember(h.scope, h.team.id, 'replacement', { active: true })
    expect((await h.teams('member')).teams).toEqual([])
    expect((await h.teams('replacement')).teams).toHaveLength(2)
    await expect(h.read('member')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  for (const fault of ['root-reparented', 'captain-reparented', 'sibling-reparented', 'cold-resumed'] as const) {
    it(`rejects an in-flight ${fault} binding change`, async () => {
      const h = await setup(true)
      const original = h.inspect.getMockImplementation()!
      let changed = false
      h.inspect.mockImplementation(async id => {
        const value = await original(id)
        if (id === 'sibling' && !changed) {
          changed = true
          if (fault === 'root-reparented') h.session('main', 'foreign-main')
          if (fault === 'captain-reparented') h.session('captain', 'foreign-main')
          if (fault === 'sibling-reparented') h.session('sibling', 'foreign-main')
          if (fault === 'cold-resumed') h.live.set('member', { id: SessionId('member'), session: h.sessions.get('member')! } as Agent)
        }
        return value
      })
      await expect(h.read('member')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
      expect(changed).toBe(true)
    })
  }

  it('rechecks member authorization after the awaited sibling section composition', async () => {
    const h = await setup(true)
    h.session('sibling-member', 'sibling')
    await h.storage.port.provisionMember(h.scope, h.other.id, 'sibling', { name: 'second-worker', role: 'Writer', provider: 'spawn', sessionId: 'sibling-member' })
    await h.storage.port.settleMember(h.scope, h.other.id, 'sibling-member', { active: true })
    const original = h.inspect.getMockImplementation()!
    let removed = false
    h.inspect.mockImplementation(async id => {
      if (id === 'sibling-member' && !removed) {
        removed = true
        await h.storage.port.removeMember(h.scope, h.team.id, 'captain', 'worker', 'during section')
      }
      return original(id)
    })
    await expect(h.read('member', h.other.id, 'captainMembers')).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
    expect(removed).toBe(true)
  })
})
