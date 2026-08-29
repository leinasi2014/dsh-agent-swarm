/**
 * Real-shape multi-Team enumeration / selection consistency and cross-user
 * 403 (targets 3's read path: team-dashboard-controller + read RPC).
 *
 * Backed by the REAL full official composition (mountNodeComposition: real
 * AgentLoop, real durable storage, real Team domain, real host-read service)
 * and the REAL AgentSwarmReadRpcService. Only the socket transport (fetch →
 * service.invoke) is stubbed, exactly as the official read-RPC surface does;
 * resolution, authorization, authorization status mapping and projections are
 * the real service + real store. No Team store/domain mock.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamDomainError } from '../src/domain/error.js'
import { TeamDashboardController, type TeamDashboardSchedule, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient, type SwarmFetch } from '../src/client/read-client.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'
import type { SwarmReadBindingV1, SwarmReadCaptainMembersV1, SwarmReadRpcRequest, SwarmReadTeamsV1 } from '../src/rpc/read-rpc-contract.js'
import type { SwarmHostReadProjectionV1 } from '../src/host/host-read-types.js'
import { mountNodeComposition, SIGNAL, type NodeComposition } from './helpers/node-composition.js'

/** Wire status for the error codes this suite exercises (RPC contract §publicFailure). */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  SWARM_HOST_BINDING_AMBIGUOUS: 409,
  SWARM_HOST_BINDING_MISMATCH: 403,
  TEAM_UNAUTHORIZED: 403,
  SWARM_HOST_BINDING_NOT_FOUND: 404,
  SWARM_RPC_INTERNAL: 500,
}

/** Adapter: POST → real AgentSwarmReadRpcService.invoke, mapping failures to the
 *  wire envelope + HTTP status exactly like the official handler does. */
function rpcFetch(service: AgentSwarmReadRpcService): { fetch: SwarmFetch; statuses: number[] } {
  const statuses: number[] = []
  const fetch: SwarmFetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as SwarmReadRpcRequest
    try {
      const value = await service.invoke(request)
      return Response.json({ schemaVersion: 1, ok: true, value })
    } catch (error) {
      const code = error instanceof TeamDomainError ? error.code : 'SWARM_RPC_INTERNAL'
      const status = ERROR_STATUS[code] ?? 500
      statuses.push(status)
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ schemaVersion: 1, ok: false, error: { code, message } }, { status })
    }
  }
  return { fetch, statuses }
}

class ManualSchedule implements TeamDashboardSchedule {
  readonly pending = new Map<object, () => void>()
  set(_delayMs: number, callback: () => void): object {
    const handle = {}
    this.pending.set(handle, callback)
    return handle
  }
  clear(handle: unknown): void { this.pending.delete(handle as object) }
  fire(): void {
    const callback = this.pending.values().next().value as (() => void) | undefined
    if (callback === undefined) throw new Error('no scheduled callback')
    this.pending.clear()
    callback()
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition did not settle')
}

/** Narrow a success envelope to its value, failing loud on an RPC error. */
function okValue<T>(envelope: { ok: boolean; value?: unknown; error?: { code: string } }): T {
  if (!envelope.ok) throw new Error(`expected a successful read, got code ${envelope.error?.code}`)
  return envelope.value as T
}

/** Narrow a failure envelope, failing loud on a success. */
function failError<T extends { ok: boolean; error?: { code: string } }>(envelope: T): { code: string } {
  if (envelope.ok) throw new Error('expected an RPC failure')
  return envelope.error ?? { code: 'SWARM_RPC_INTERNAL' }
}

async function managedCreate(composition: NodeComposition, agent: NonNullable<Parameters<typeof composition.ctx.tools.execute>[0]['agent']>, callId: string, name: string): Promise<{ team_id: string; captain_session_id: string }> {
  const result = await composition.ctx.tools.execute({
    signal: SIGNAL, callId: CallId(callId), name: 'agent_swarm_create_managed',
    arguments: { name, description: 'Multi-team switch/403 seam.' }, agent,
  })
  expect(result.isError).toBe(false)
  return result.value as { team_id: string; captain_session_id: string }
}

async function plainCreate(composition: NodeComposition, agent: NonNullable<Parameters<typeof composition.ctx.tools.execute>[0]['agent']>, callId: string, name: string): Promise<{ team_id: string }> {
  const result = await composition.ctx.tools.execute({
    signal: SIGNAL, callId: CallId(callId), name: 'agent_swarm_create',
    arguments: { name, description: 'Sibling-owned Team in the same workspace scope.' }, agent,
  })
  expect(result.isError).toBe(false)
  return result.value as { team_id: string }
}

describe('real-shape multi-Team read + cross-user 403', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('4: multi-Team enumeration + selected-teamId switch yield consistent binding/snapshot/sections, and the controller never 409s before enumeration', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-multiteam-switch-'))
    roots.push(sandbox)
    const mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    try {
      // Team A: managed dedicated Captain under lead (main brain) → visible to lead.
      const teamA = await managedCreate(mounted, mounted.lead, 'mt-lead-a', 'Team A')
      // Team B: a continuable child of the SAME lead, owning its own Team →
      // persisted parentSession edge makes it visible to lead as well. So the
      // lead now maps to TWO visible Teams in one workspace scope.
      const siblingId = SessionId(`multiteam-sibling-${Math.random().toString(36).slice(2, 8)}`)
      await mounted.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'multiteam-sibling',
        childId: siblingId,
        request: {
          prompt: [{ type: 'text', text: 'Sibling of the Main Brain; owns a Team.' }],
          parent: mounted.lead,
          maxDepth: 1,
        },
        signal: SIGNAL,
      })
      const sibling = await vi.waitFor(() => {
        const agent = mounted.ctx.agents.get(siblingId)
        if (agent === undefined) throw new Error('sibling not live yet')
        return agent
      }, { timeout: 5_000 })
      const teamB = await plainCreate(mounted, sibling, 'mt-sibling-b', 'Team B')

      const service = new AgentSwarmReadRpcService({
        ctx: mounted.ctx,
        runtime: mounted.ctx.agentSwarm,
        hostRead: mounted.ctx.agentSwarmHostRead,
        webServer: { host: '127.0.0.1', port: 8279, register: () => () => undefined },
      })
      const { fetch, statuses } = rpcFetch(service)
      const client = new SwarmReadClient(fetch)

      // (4a) Real enumeration: the Main Brain sees BOTH its visible Teams.
      const teamsValue = okValue<SwarmReadTeamsV1>(await client.request({ schemaVersion: 1, method: 'teams', target: { rootSessionId: mounted.lead.id } }))
      const visibleIds = teamsValue.teams.map(team => team.teamId)
      expect(visibleIds).toEqual(expect.arrayContaining([teamA.team_id, teamB.team_id]))

      // (4b) Selected-teamId switch → binding/snapshot/captain section all
      // resolve to the SAME selected Team (consistent, never mixed).
      for (const [teamId, captainId] of [[teamA.team_id, teamA.captain_session_id], [teamB.team_id, sibling.id]] as const) {
        const binding = okValue<SwarmReadBindingV1>(await client.request({ schemaVersion: 1, method: 'binding', target: { rootSessionId: mounted.lead.id, teamId } }))
        expect(binding.binding.teamId).toBe(teamId)
        expect(binding.binding.rootSessionId).toBe(captainId)

        const snapshot = okValue<SwarmHostReadProjectionV1>(await client.request({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: mounted.lead.id, teamId } }))
        expect(snapshot.binding.teamId).toBe(teamId)
        expect(snapshot.team.id).toBe(teamId)

        const members = okValue<SwarmReadCaptainMembersV1>(await client.request({ schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: mounted.lead.id, teamId } }))
        expect(members.binding.teamId).toBe(teamId)
      }

      // (4c) Controller open on the multi-Team root must READ the directory and
      // resolve a stable selection — it must NOT 409-ambiguous before enumeration.
      // (Target; RED against the current readBinding-before-readTeams order.)
      const controller = new TeamDashboardController(client, new ManualSchedule())
      controller.open(mounted.lead.id)
      let state: TeamDashboardState = controller.getSnapshot()
      await waitFor(() => ['ready', 'error'].includes(controller.getSnapshot().phase))
      state = controller.getSnapshot()
      expect(state.phase).toBe('ready')
      expect(state.error?.code).not.toBe('SWARM_HOST_BINDING_AMBIGUOUS')
      if (state.data !== undefined) {
        expect(visibleIds).toContain(state.data.projection.binding.teamId)
      }
      controller.dispose()
      // The directory-first controller must never have produced a 409 during open.
      expect(statuses).not.toContain(409)
    } finally {
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('5: a Main Brain cannot read another user\'s Team in the same workspace (HTTP 403)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-multiteam-403-'))
    roots.push(sandbox)
    const mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    try {
      // Two independent Main Brains share the SAME workspace cwd (same scope).
      const leadA = mounted.lead
      const leadB = mounted.ctx.agentLoop.create(
        SessionId(`multi403-leadB-${Math.random().toString(36).slice(2, 8)}`),
        { provider: 'mock', model: 'mock' },
        { cwd: join(sandbox, 'workspace') },
      )
      const teamA = await managedCreate(mounted, leadA, 'mt403-a', 'Team A')
      const teamB = await managedCreate(mounted, leadB, 'mt403-b', 'Team B')

      const service = new AgentSwarmReadRpcService({
        ctx: mounted.ctx,
        runtime: mounted.ctx.agentSwarm,
        hostRead: mounted.ctx.agentSwarmHostRead,
        webServer: { host: '127.0.0.1', port: 8279, register: () => () => undefined },
      })
      const { fetch, statuses } = rpcFetch(service)
      const client = new SwarmReadClient(fetch)

      // Each root enumerates ONLY its own visible Teams (isolation).
      const teamsA = okValue<SwarmReadTeamsV1>(await client.request({ schemaVersion: 1, method: 'teams', target: { rootSessionId: leadA.id } }))
      const teamsB = okValue<SwarmReadTeamsV1>(await client.request({ schemaVersion: 1, method: 'teams', target: { rootSessionId: leadB.id } }))
      expect(teamsA.teams.map(t => t.teamId)).toContain(teamA.team_id)
      expect(teamsA.teams.map(t => t.teamId)).not.toContain(teamB.team_id)
      expect(teamsB.teams.map(t => t.teamId)).toContain(teamB.team_id)
      expect(teamsB.teams.map(t => t.teamId)).not.toContain(teamA.team_id)

      // Cross-user read attempts resolve the foreign Team but fail authorization as 403.
      const invade = await client.request({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: leadA.id, teamId: teamB.team_id } })
      expect(failError(invade).code).toBe('SWARM_HOST_BINDING_MISMATCH')
      expect(statuses).toContain(403)

      const reverse = await client.request({ schemaVersion: 1, method: 'snapshot', target: { rootSessionId: leadB.id, teamId: teamA.team_id } })
      expect(failError(reverse).code).toBe('SWARM_HOST_BINDING_MISMATCH')
      expect(statuses.filter(status => status === 403).length).toBeGreaterThanOrEqual(2)
    } finally {
      mounted.adapter.open()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
  })
})
