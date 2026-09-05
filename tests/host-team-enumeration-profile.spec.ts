/**
 * Issue #188/#175 — Host single-authority Team enumeration must carry the
 * complete safe Captain identity profile (displayName, profession,
 * personality, pixelAvatarSvg) so the RPC layer can pass all four fields to
 * the client via teamDescriptorOf. Regression: only displayName was projected,
 * so the live panel showed the name but never profession/personality/avatar.
 *
 * Drives the REAL AgentSwarmHostReadService (Host read authority) and the REAL
 * AgentSwarmReadRpcService dispatcher — no copied projection logic and no
 * controller mock. RED (pre-fix): profession/personality/avatar are missing.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import { AgentSwarmReadRpcService, type SwarmWebServer } from '../src/rpc/read-rpc-service.js'
import type { SwarmReadTeamsV1 } from '../src/rpc/read-rpc-contract.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import type { HumanInteractionOverlayStore } from '../src/human/human-interaction-store.js'

const baselineRpc = process.env.SWARM_READ_BASELINE
const RpcService = baselineRpc === undefined ? AgentSwarmReadRpcService
  : (await import(/* @vite-ignore */ baselineRpc) as { AgentSwarmReadRpcService: typeof AgentSwarmReadRpcService }).AgentSwarmReadRpcService

const NOW = 1_700_000_000_500
const ROOT: Agent = { id: 'root-session', session: { header: { cwd: 'C:\\workspace' } } } as unknown as Agent
const SAFE_AVATAR = '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>'

function teamState(): AgentSwarm.TeamState {
  return {
    schemaVersion: 1,
    id: AgentSwarm.TeamId('team-1'),
    revision: 9,
    name: 'Alpha',
    description: 'desc',
    captainSessionId: ROOT.id,
    phase: 'active',
    captainProfile: {
      displayName: '验收指挥官',
      profession: '团队队长',
      personality: '冷静',
      pixelAvatarSvg: SAFE_AVATAR,
    },
    members: [],
    tasks: [],
    attempts: [],
    messages: [],
    budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: {},
    memory: [],
    nextTaskNumber: 1,
    nextMemoryNumber: 1,
    createdAt: NOW - 100,
    updatedAt: NOW - 10,
  }
}

function buildRealService(options: { cold?: boolean; teams?: AgentSwarm.TeamState[]; parented?: boolean; invalidSession?: 'missing' | 'replaced'; liveCaptain?: boolean } = {}) {
  const team = options.teams?.[0] ?? { ...teamState(), ...(options.liveCaptain ? { captainSessionId: 'captain-live' } : {}) }
  const teams = options.teams ?? [team]
  const roots = new Map<string, Agent>([[ROOT.id, ROOT]])
  if (options.liveCaptain) roots.set('captain-live', { id: 'captain-live', session: { header: { cwd: ROOT.session.header.cwd, parentSession: ROOT.id } } } as Agent)
  const parents = options.parented ? Object.fromEntries(teams.map(entry => [entry.captainSessionId, ROOT.id])) : {}
  let currentInitiator: Agent | undefined = ROOT
  const ctx = {
    agents: {
      get: (id: string) => options.cold ? undefined : roots.get(id),
      roots: () => options.cold ? [] : [ROOT],
      currentInitiator: () => currentInitiator,
      withInitiator: async <T>(agent: Agent, callback: () => Promise<T>) => {
        const prev = currentInitiator
        currentInitiator = agent
        try { return await callback() } finally { currentInitiator = prev }
      },
    },
    sessions: { get: (id: string) => {
      if (options.cold) return undefined
      if (options.invalidSession !== undefined && id === team.captainSessionId) {
        return options.invalidSession === 'missing' ? undefined : { header: { cwd: ROOT.session.header.cwd } }
      }
      return roots.get(id)?.session
    } },
    sessionPersistence: { inspect: async (id: string) => id === ROOT.id
      ? { meta: { cwd: 'C:\\workspace' } } : parents[id] === undefined ? undefined
      : { meta: { cwd: 'C:\\workspace', parentSession: parents[id] } } },
  } as unknown as Context
  const runtime = {
    scopeOf: () => 'C:\\workspace',
    listTeamAggregates: vi.fn(async () => teams),
    managedCaptainSessionsOf: () => [],
    domain: { snapshot: async () => ({ team }) },
  } as unknown as AgentSwarmRuntime
  const overlay = { list: () => [] } as unknown as HumanInteractionOverlayStore
  const hostRead = new AgentSwarmHostReadService({
    currentInitiator: () => ctx.agents.currentInitiator(),
    isExactLiveRoot: agent => ctx.agents.get(agent.id) === agent && ctx.sessions.get(agent.id) === agent.session,
    scopeOf: () => 'C:\\workspace',
    teams: scope => runtime.listTeamAggregates(scope),
    domain: () => runtime.domain,
    managedCaptainSessionsOf: () => [],
    parentOfSession: () => undefined,
    overlay,
    now: () => NOW,
    disposalTimeoutMs: 1_000,
  })
  const webServer = { host: '127.0.0.1', port: 8279, register: () => {} } as unknown as SwarmWebServer
  const service = new RpcService({ ctx, runtime, hostRead, webServer })
  return { hostRead, service, team, runtime, roots }
}

it('one real Host/RPC teams refresh scans the backing aggregate list once (#188)', async () => {
  const { service, runtime } = buildRealService()
  const directory = await service.invoke({ schemaVersion: 1, method: 'teams', target: { rootSessionId: ROOT.id } }) as SwarmReadTeamsV1
  expect(directory.teams[0]).toMatchObject({ displayName: '验收指挥官', profession: '团队队长', personality: '冷静', avatar: { state: 'generated', svg: SAFE_AVATAR } })
  expect(runtime.listTeamAggregates).toHaveBeenCalledTimes(1)
})

it.each([false, true])('real Host/RPC retains explicit, implicit, archived and multi-Team reads with cold=%s', async cold => {
  const single = buildRealService({ cold })
  await expect(single.service.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id } }))
    .resolves.toMatchObject({ binding: { teamId: 'team-1', rootSessionId: ROOT.id } })
  const archived = { ...teamState(), phase: 'archived' as const }
  const historical = buildRealService({ cold, teams: [archived] })
  await expect(historical.service.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id, teamId: archived.id } }))
    .resolves.toMatchObject({ team: { phase: 'archived' } })
  const teams = ['captain-a', 'captain-b'].map((id, index) => ({ ...teamState(), id: AgentSwarm.TeamId(`team-${index}`), captainSessionId: id }))
  const multi = buildRealService({ cold, teams, parented: true })
  await expect(multi.service.invoke({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: ROOT.id } }))
    .rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_AMBIGUOUS' })
  const directory = await multi.service.invoke({ schemaVersion: 1, method: 'teams', target: { rootSessionId: ROOT.id } }) as SwarmReadTeamsV1
  expect(directory.teams.map(team => team.teamId)).toEqual(['team-0', 'team-1'])
  await expect(multi.service.invoke({ schemaVersion: 1, method: 'captainDiagnostics', target: { rootSessionId: ROOT.id, teamId: 'team-1' } }))
    .resolves.toMatchObject({ binding: { rootSessionId: 'captain-b', teamId: 'team-1' } })
})

it('Host disposal closes the target port as well as legacy projections', async () => {
  const { hostRead, service } = buildRealService()
  await hostRead.dispose()
  await expect(service.invoke({ schemaVersion: 1, method: 'teams', target: { rootSessionId: ROOT.id } }))
    .rejects.toMatchObject({ code: 'SWARM_HOST_READ_CLOSED' })
})

it.each([
  [false, 'missing'], [false, 'replaced'], [true, 'missing'], [true, 'replaced'],
] as const)('denies live Captain without exact current Session: parent=%s mapping=%s', async (liveCaptain, invalidSession) => {
  const { service, team } = buildRealService({ liveCaptain, invalidSession })
  for (const method of ['snapshot', 'captainDiagnostics'] as const) {
    await expect(service.invoke({ schemaVersion: 1, method, target: { rootSessionId: ROOT.id, teamId: team.id } }))
      .rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
  }
})
