/**
 * Fault-first tests: read-rpc-service captainMembers nested composition.
 *
 * These encode the composition.v1 contract as executable assertions that FAIL
 * against a naive/buggy implementation:
 *   - roster ORDER and NAME are authoritative: each row's composition is merged
 *     from the member's OWN verified profile (never a cross-row / copied value);
 *   - a single missing/corrupt child fails CLOSED into its own row only, marked
 *     with the precise reason, and never affects sibling rows;
 *   - composition carries EXACTLY the eight public fields
 *     (state/reason/runtimeProvider + llmProvider/model/presetId/personaConfigured/
 *     deniedTools) and nothing else;
 *   - `deniedTools` is only ever surfaced as the declared *tool restriction*
 *     list (an allow-side leak is a contract violation, never an enumeration of
 *     permitted tools).
 *
 * Only public contract types and the shared R2 min harness are referenced; no
 * private memory or internal implementation detail.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import type { TeamState } from '../src/domain/types.js'
import type { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import type { SwarmReadCaptainMembersV1, SwarmReadCaptainMemberRowV1 } from '../src/rpc/read-rpc-contract.js'
import {
  AgentSwarmReadRpcService,
  type SwarmWebServer,
} from '../src/rpc/read-rpc-service.js'

const ROOT = { id: 'root-session', session: { header: { cwd: 'D:\\workspace' } } } as unknown as Agent

/** The full public composition field set (3 required + 5 optional). */
const COMPOSITION_FIELDS = [
  'state', 'reason', 'runtimeProvider',
  'llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools',
] as const

function rpcHarness(options: {
  teamState?: TeamState;
  memberInspect?: (sessionId: string) => unknown;
} = {}) {
  const team = {
    id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 6,
    members: [], tasks: [], attempts: [],
    ...options.teamState,
  } as TeamState
  const teams: TeamState[] = [team]
  const ctx = {
    agents: {
      get: (id: string) => (id === ROOT.id ? ROOT : undefined),
      roots: () => [ROOT],
      withInitiator: async <T>(_agent: Agent, callback: () => Promise<T>) => await callback(),
    },
    sessions: { get: (id: string) => (id === ROOT.id ? ROOT.session : undefined) },
    sessionPersistence: {
      inspect: async (sessionId: string) => {
        if (options.memberInspect !== undefined) return options.memberInspect(sessionId)
        throw new Error(`session "${sessionId}" not found`)
      },
    },
  } as unknown as Context
  const snapshot = vi.fn(async () => ({ team }))
  const runtime = {
    scopeOf: (agent: Agent) => agent.session.header.cwd!,
    listTeamAggregates: vi.fn(async () => teams),
    domain: { snapshot },
    managedCaptainSessionsOf: vi.fn(() => []),
  } as unknown as AgentSwarmRuntime
  const hostRead = {
    read: vi.fn(), listTeams: vi.fn(async () => ({ schemaVersion: 1, binding: { rootSessionId: ROOT.id, rootKind: 'main-brain' }, teams: [], observedAt: 0, complete: true })),
  } as unknown as AgentSwarmHostReadService
  const webServer = { host: '127.0.0.1', port: 8279, register: vi.fn() } satisfies SwarmWebServer
  return new AgentSwarmReadRpcService({ ctx, runtime, hostRead, webServer })
}

/** Build a stored Session inspection result for one verified child. */
function stored(meta: Record<string, unknown>, events: unknown[]): unknown {
  return {
    meta: {
      id: meta.id, origin: 'subagent', parentSession: ROOT.id, seedLength: 0,
      agentPreset: 'standard', ...meta,
    },
    events,
  }
}

/** Build a well-formed continuable descriptor, optionally overriding fields.
 *  Optional composition keys are OMITTED (never set to `undefined`): the
 *  official `@deepseek-ai/dsh-subagent` `parseSubagentDescriptor` rejects a
 *  present-but-undefined field (it calls `optionalString`/`parseToolFilter` on
 *  an own property regardless of value), so a literal `toolFilter: undefined`
 *  would make even a healthy no-tool-filter child fail as `descriptor_invalid`.
 */
function descriptor(memberName: string, over: Record<string, unknown> = {}) {
  return {
    type: 'subagent/descriptor',
    data: {
      version: 2, mode: 'continuable', provider: 'mock',
      label: `agent-swarm:team-r2:${memberName}`,
      ...over,
    },
  }
}

const target = { rootSessionId: ROOT.id, teamId: 'team-r2' }
const callMembers = async (service: AgentSwarmReadRpcService) =>
  await service.invoke({ schemaVersion: 1, method: 'captainMembers', target }) as SwarmReadCaptainMembersV1

/** The composition must expose NO field outside the eight public fields. The 5
 *  capability fields are individually optional — a member who denies no tools
 *  has no `deniedTools` — so this asserts the field set is a subset of the
 *  eight (no ninth/unknown field), while the exact per-row shape is pinned by
 *  the `toEqual` assertions below. */
const expectCompositionOnly = (composition: SwarmReadCaptainMemberRowV1['composition']) => {
  const allowed = new Set<string>([...COMPOSITION_FIELDS])
  expect(Object.keys(composition).every(key => allowed.has(key))).toBe(true)
}

describe('captainMembers nested composition (fault-first)', () => {
  it('merges each verified member profile in authoritative roster order with EXACT 8-field set', async () => {
    const members = [
      // Distinguish profiles per name so a cross-row/copied merge is caught.
      { name: 'alpha', role: 'writer', sessionId: 'alpha-session', provider: 'mock', phase: 'active', createdAt: 1 },
      { name: 'beta', role: 'artist', sessionId: 'beta-session', provider: 'mock', phase: 'active', createdAt: 2 },
      { name: 'gamma', role: 'reviewer', sessionId: 'gamma-session', provider: 'mock', phase: 'active', createdAt: 3 },
    ]
    const service = rpcHarness({
      teamState: { id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 6, members, tasks: [], attempts: [] } as never as TeamState,
      memberInspect: (sessionId: string) => {
        const byName: Record<string, { model: string; presetId: string; tools: string[] }> = {
          'alpha-session': { model: 'model-a', presetId: 'preset-a', tools: ['tool-a1', 'tool-a2'] },
          'beta-session': { model: 'model-b', presetId: 'preset-b', tools: ['tool-b'] },
          'gamma-session': { model: 'model-c', presetId: 'preset-c', tools: [] },
        }
        const name = { 'alpha-session': 'alpha', 'beta-session': 'beta', 'gamma-session': 'gamma' }[sessionId]!
        const conf = byName[sessionId]!
        return stored(
          { id: sessionId, agentPreset: conf.presetId },
          [descriptor(name, {
            agentProvider: `llm-${name}`, agentModel: conf.model, persona: `Persona ${name}`,
            ...(conf.tools.length ? { toolFilter: { deny: conf.tools } } : {}),
          })],
        )
      },
    })
    const result = await callMembers(service)
    // Authoritative roster order and names are preserved exactly.
    expect(result.members.map(member => member.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(result.members.map(member => member.composition)).toEqual([
      {
        state: 'available', reason: 'available', runtimeProvider: 'mock',
        llmProvider: 'llm-alpha', model: 'model-a', presetId: 'preset-a', personaConfigured: true,
        deniedTools: ['tool-a1', 'tool-a2'],
      },
      {
        state: 'available', reason: 'available', runtimeProvider: 'mock',
        llmProvider: 'llm-beta', model: 'model-b', presetId: 'preset-b', personaConfigured: true,
        deniedTools: ['tool-b'],
      },
      {
        state: 'available', reason: 'available', runtimeProvider: 'mock',
        llmProvider: 'llm-gamma', model: 'model-c', presetId: 'preset-c', personaConfigured: true,
      },
    ])
    // Each row's composition exposes EXACTLY the eight public fields — any ninth
    // field (an allow-side, a persona blob, an internal mode, ...) is a violation.
    result.members.forEach(row => expectCompositionOnly(row.composition))
    // The tool-restriction field only ever lists restricted tools, with no allow side.
    expect(result.members[0]?.composition.deniedTools).toEqual(['tool-a1', 'tool-a2'])
  })

  it('fails a single missing child CLOSED with active_session_missing and leaves siblings unaffected', async () => {
    const members = [
      { name: 'worker', role: 'writer', sessionId: 'worker-session', provider: 'mock', phase: 'active', createdAt: 1 },
      { name: 'ghost', role: 'writer', sessionId: 'ghost-session', provider: 'mock', phase: 'active', createdAt: 2 },
      { name: 'tail', role: 'writer', sessionId: 'tail-session', provider: 'mock', phase: 'active', createdAt: 3 },
    ]
    const service = rpcHarness({
      teamState: { id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 7, members, tasks: [], attempts: [] } as never as TeamState,
      memberInspect: (sessionId: string) => {
        if (sessionId === 'ghost-session') throw new Error(`session "${sessionId}" not found`)
        const name = { 'worker-session': 'worker', 'tail-session': 'tail' }[sessionId]!
        return stored({ id: sessionId }, [descriptor(name, { agentProvider: `llm-${name}`, agentModel: `model-${name}` })])
      },
    })
    const result = await callMembers(service)
    expect(result.members.map(member => member.name)).toEqual(['worker', 'ghost', 'tail'])
    const ghost = result.members[1]!
    // The missing row fails CLOSED into its own row only, reason precise.
    expect(ghost.composition).toEqual({ state: 'invalid', reason: 'active_session_missing', runtimeProvider: 'mock' })
    // A fail-closed row discloses NOTHING beyond the recovery-fence runtimeProvider.
    for (const field of ['llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools'] as const) {
      expect(ghost.composition).not.toHaveProperty(field)
    }
    // Both sibling rows remain fully available and unaffected.
    expect(result.members[0]?.composition.state).toBe('available')
    expect(result.members[2]?.composition.state).toBe('available')
    expect(result.members[2]?.composition).toMatchObject({ llmProvider: 'llm-tail', model: 'model-tail' })
  })

  it('fails each corrupt-child mode CLOSED with its precise reason, sibling unaffected', async () => {
    const modeToSession = {
      binding_invalid: 'binding-session',
      descriptor_invalid: 'garbled-session',
      not_continuable: 'manual-session',
      tool_filter_invalid: 'allow-session',
      inspection_failed: 'exploded-session',
    } as const
    const members = [
      { name: 'writer', role: 'writer', sessionId: 'writer-session', provider: 'mock', phase: 'active', createdAt: 0 },
      ...Object.entries(modeToSession).map(([, sessionId], index) =>
        ({ name: `bad-${index}`, role: 'writer', sessionId, provider: 'mock', phase: 'active', createdAt: index + 1 })),
    ]
    const service = rpcHarness({
      teamState: { id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 8, members, tasks: [], attempts: [] } as never as TeamState,
      memberInspect: (sessionId: string) => {
        if (sessionId === 'writer-session') {
          return stored({ id: sessionId }, [descriptor('writer', { agentProvider: 'llm-w', agentModel: 'model-w', persona: 'Writer persona' })])
        }
        switch (sessionId) {
          case 'binding-session': return stored({ id: sessionId, origin: 'main' }, [descriptor('x')])
          case 'garbled-session': return stored({ id: sessionId }, [{ type: 'subagent/descriptor' }])
          case 'manual-session': return stored({ id: sessionId }, [descriptor('x', { mode: 'one-shot' })])
          case 'allow-session': return stored({ id: sessionId }, [descriptor('bad-3', { toolFilter: { allow: ['agent_swarm_list_jobs'] } })])
          case 'exploded-session': throw new Error('boom')
          default: throw new Error(`session "${sessionId}" not found`)
        }
      },
    })
    const result = await callMembers(service)
    expect(result.members[0]?.name).toBe('writer')
    expect(result.members[0]?.composition.state).toBe('available')
    // Every corrupt mode fails CLOSED into its own row with the exact reason.
    const got = new Map(result.members.slice(1).map(row => [row.name, row.composition]))
    const reasons = [...got.values()].map(comp => (comp as { reason?: string }).reason)
    // Test 2 covers the missing-session (`active_session_missing`) failure; this
    // scenario exercises only the present-but-corrupt child modes.
    expect(reasons.sort()).toEqual([
      'binding_invalid', 'descriptor_invalid',
      'inspection_failed', 'not_continuable', 'tool_filter_invalid',
    ].sort())
    // No corrupt row may leak a capability field; only the healthy row carries them.
    for (const composition of got.values()) {
      for (const field of ['llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools'] as const) {
        expect(composition).not.toHaveProperty(field)
      }
    }
    // The healthy sibling is fully available with its 8-field composition intact.
    expect(result.members[0]?.composition).toMatchObject({ llmProvider: 'llm-w', model: 'model-w', personaConfigured: true })
    expectCompositionOnly(result.members[0]!.composition)
  })
})
