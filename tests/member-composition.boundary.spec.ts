/**
 * Boundary tests: the P1-1 provider cap (exactly 128 vs over-bound producer
 * fields) and the P1-2 strict composition state/reason matrix.
 *
 *  1. A `runtimeProvider` of EXACTLY 128 code points passes the producer output
 *     AND the browser contract validation — the row stays `available`.
 *  2. A producer output whose llmProvider/model/presetId (or a deniedTools
 *     entry) exceeds 128 code points degrades ONLY that single row to
 *     `{ state:'invalid', reason:'descriptor_invalid', runtimeProvider }` while
 *     the rest of the read still succeeds and sibling rows stay untouched.
 *  3. `assertMemberComposition` enforces the exact state→reason matrix: every
 *     allowed pair passes (fail-closed rows disclose nothing beyond
 *     runtimeProvider) and EVERY pair outside the matrix throws.
 *
 * Only public contract types are referenced; no private implementation detail.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import type { TeamState } from '../src/domain/types.js'
import type { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import type { SwarmReadCaptainMembersV1 } from '../src/rpc/read-rpc-contract.js'
import {
  assertSwarmReadRpcValue,
} from '../src/rpc/read-rpc-artifact.js'
import {
  AgentSwarmReadRpcService,
  type SwarmWebServer,
} from '../src/rpc/read-rpc-service.js'

const ROOT = { id: 'root-session', session: { header: { cwd: 'D:\\workspace' } } } as unknown as Agent

/** Build a string of exactly `n` code points from `char`. */
const cp = (char: string, n: number): string => char.repeat(n)
const AT_128 = cp('P', 128)
const OVER_128 = cp('q', 129)

function rpcHarness(options: {
  teamState?: TeamState;
  memberInspect?: (sessionId: string) => unknown;
} = {}) {
  const team = {
    id: 'team-r2', name: 'Team R2', captainSessionId: ROOT.id, phase: 'active', revision: 6,
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
    withTargetRead: async <T>(operation: () => Promise<T>) => await operation(),
    read: vi.fn(), listTeams: vi.fn(async () => ({ schemaVersion: 1, binding: { rootSessionId: ROOT.id, rootKind: 'main-brain' }, teams: [], observedAt: 0, complete: true })),
  } as unknown as AgentSwarmHostReadService
  const webServer = { host: '127.0.0.1', port: 8279, register: vi.fn() } satisfies SwarmWebServer
  return new AgentSwarmReadRpcService({ ctx, runtime, hostRead, webServer })
}

/** Build a stored Session inspection result for one verified child. */
function stored(meta: Record<string, unknown>, events: unknown[]): unknown {
  return {
    meta: { id: meta.id, origin: 'subagent', parentSession: ROOT.id, seedLength: 0, agentPreset: 'standard', ...meta },
    events,
  }
}

/** Build a well-formed continuable descriptor, optionally overriding fields. */
function descriptor(memberName: string, over: Record<string, unknown> = {}) {
  return {
    type: 'subagent/descriptor',
    data: {
      version: 2, mode: 'continuable', provider: 'mock',
      label: `Team R2 · ${memberName}`,
      ...over,
    },
  }
}

const target = { rootSessionId: ROOT.id, teamId: 'team-r2' }
const callMembers = async (service: AgentSwarmReadRpcService) =>
  await service.invoke({ schemaVersion: 1, method: 'captainMembers', target }) as SwarmReadCaptainMembersV1

/** The browser-side contract validator must accept the value as a whole. */
const assertContractAccepts = (value: SwarmReadCaptainMembersV1): void => {
  expect(() => assertSwarmReadRpcValue('captainMembers', value as never)).not.toThrow()
}

describe('P1-1 boundary: provider cap 128 and over-bound producer fields', () => {
  it('accepts a runtimeProvider of EXACTLY 128 code points (available, producer + contract)', async () => {
    const prov = AT_128
    const members = [
      { name: 'alpha', role: 'writer', sessionId: 'alpha-session', provider: prov, phase: 'active', createdAt: 1 },
    ]
    const service = rpcHarness({
      teamState: { id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 6, members, tasks: [], attempts: [] } as never as TeamState,
      memberInspect: (sessionId: string) =>
        stored({ id: sessionId }, [descriptor('alpha', { provider: prov, agentProvider: 'llm', agentModel: 'm' })]),
    })
    const result = await callMembers(service)
    const composition = result.members[0]!.composition
    expect(composition.state).toBe('available')
    expect(composition.runtimeProvider).toBe(prov)
    expect(composition).toMatchObject({ llmProvider: 'llm', model: 'm' })
    // Browser contract validation accepts the 128-provider row too.
    assertContractAccepts(result)
  })

  it('degrades ONLY the over-bound row to descriptor_invalid and leaves siblings untouched', async () => {
    // Each variant over-bounds exactly one producer field beyond 128 code points.
    const variants: Array<[string, (sessionId: string, name: string) => unknown]> = [
      ['llmProvider', (id, name) => stored({ id }, [descriptor(name, { agentProvider: OVER_128, agentModel: 'm' })])],
      ['model', (id, name) => stored({ id }, [descriptor(name, { agentProvider: 'llm', agentModel: OVER_128 })])],
      ['presetId', (id, name) => stored({ id, agentPreset: OVER_128 }, [descriptor(name, { agentProvider: 'llm', agentModel: 'm' })])],
      ['deniedTools-entry', (id, name) => stored({ id }, [descriptor(name, { agentProvider: 'llm', agentModel: 'm', toolFilter: { deny: [OVER_128] } })])],
    ]
    for (const [label, build] of variants) {
      const healthy = { name: 'healthy', role: 'writer', sessionId: 'healthy-session', provider: 'mock', phase: 'active', createdAt: 0 }
      const bad = { name: 'bad', role: 'writer', sessionId: 'bad-session', provider: 'mock', phase: 'active', createdAt: 1 }
      const service = rpcHarness({
        teamState: { id: 'team-r2', captainSessionId: ROOT.id, phase: 'active', revision: 6, members: [healthy, bad], tasks: [], attempts: [] } as never as TeamState,
        memberInspect: (sessionId: string) => {
          if (sessionId === 'healthy-session') {
            return stored({ id: sessionId }, [descriptor('healthy', { agentProvider: 'llm-healthy', agentModel: 'm-healthy' })])
          }
          return build(sessionId, 'bad')
        },
      })
      const result = await callMembers(service)
      expect(result.members.map(member => member.name), label).toEqual(['healthy', 'bad'])
      // Only the over-bound row degrades to descriptor_invalid.
      expect(result.members[1]!.composition, label).toEqual({ state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'mock' })
      // No capability field leaks from the invalid row.
      for (const field of ['llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools'] as const) {
        expect(result.members[1]!.composition, `${label}/${field}`).not.toHaveProperty(field)
      }
      // The healthy sibling row is fully available and untouched.
      expect(result.members[0]!.composition.state, label).toBe('available')
      expect(result.members[0]!.composition, label).toMatchObject({ llmProvider: 'llm-healthy', model: 'm-healthy' })
      // The whole response still passes browser contract validation.
      assertContractAccepts(result)
    }
  })
})

describe('P1-2 strict composition state/reason matrix', () => {
  const STATES = ['available', 'pending', 'unavailable', 'invalid'] as const
  const REASONS = [
    'available', 'provisioning', 'startup_failed', 'removed',
    'inspection_failed', 'active_session_missing', 'binding_invalid',
    'descriptor_invalid', 'not_continuable', 'tool_filter_invalid',
  ] as const
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    available: ['available'],
    pending: ['provisioning'],
    unavailable: ['startup_failed', 'removed', 'inspection_failed'],
    invalid: ['inspection_failed', 'active_session_missing', 'binding_invalid', 'descriptor_invalid', 'not_continuable', 'tool_filter_invalid'],
  }

  const growth = { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' }
  const avatar = { state: 'not_generated', reason: 'avatar_backend_not_implemented' }
  const identityCard = { state: 'not_generated', reason: 'identity_backend_not_implemented' }
  const row = (composition: unknown) =>
    ({ name: 'm', role: 'r', phase: 'active', createdAt: 1, avatar, identityCard, growth, composition })
  const valueFor = (composition: Record<string, unknown>) => ({
    schemaVersion: 1, binding: { rootSessionId: 'root', teamId: 'team' }, observedAt: 1_700_000_000_000,
    members: [row(composition)],
  })

  it('passes every allowed pair and throws on every pair outside the matrix', () => {
    for (const state of STATES) {
      for (const reason of REASONS) {
        const composition: Record<string, unknown> = { state, reason, runtimeProvider: 'spawn' }
        if (state === 'available') composition.personaConfigured = true
        const label = `${state}/${reason}`
        const allowed = ALLOWED[state]?.includes(reason) === true
        if (allowed) {
          expect(() => assertSwarmReadRpcValue('captainMembers', valueFor(composition)), label).not.toThrow()
        } else {
          expect(() => assertSwarmReadRpcValue('captainMembers', valueFor(composition)), label).toThrow()
        }
      }
    }
  })

  it('keeps allowed fail-closed rows free of every capability field', () => {
    // pending→provisioning, unavailable→startup_failed/removed/inspection_failed
    // and every invalid reason are legal fail-closed states; they must disclose
    // NOTHING beyond the recovery-fence runtimeProvider.
    const legalFailClosed: Record<string, readonly string[]> = {
      pending: ['provisioning'],
      unavailable: ['startup_failed', 'removed', 'inspection_failed'],
      invalid: ['inspection_failed', 'active_session_missing', 'binding_invalid', 'descriptor_invalid', 'not_continuable', 'tool_filter_invalid'],
    }
    for (const [state, reasons] of Object.entries(legalFailClosed)) {
      for (const reason of reasons) {
        const composition = { state, reason, runtimeProvider: 'spawn' }
        expect(() => assertSwarmReadRpcValue('captainMembers', valueFor(composition)), `${state}/${reason}`).not.toThrow()
        for (const field of ['llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools'] as const) {
          expect(composition, `${state}/${reason}/${field}`).not.toHaveProperty(field)
        }
      }
    }
  })

  it('directly accepts the unavailable/inspection_failed composition via the validation path', () => {
    // A distinct positive parser check for the pair the follow-up correction
    // (task-6) made legal — explicit, not folded into the cross-product loops.
    const composition = { state: 'unavailable', reason: 'inspection_failed', runtimeProvider: 'spawn' }
    expect(() => assertSwarmReadRpcValue('captainMembers', valueFor(composition))).not.toThrow()
    // The fail-closed row discloses only the recovery-fence runtimeProvider.
    expect(composition).not.toHaveProperty('llmProvider')
    expect(composition).not.toHaveProperty('model')
    expect(composition).not.toHaveProperty('presetId')
    expect(composition).not.toHaveProperty('personaConfigured')
    expect(composition).not.toHaveProperty('deniedTools')
  })
})
