/**
 * Fault-first tests: the frozen read-rpc contract/artifact schema field set for
 * captainMembers nested composition.
 *
 * The composition projection (composition.v1) is validated by
 * `assertSwarmReadRpcValue('captainMembers', value)` against the frozen JSON
 * schema plus semantic guards. These tests pin the exact public field set and
 * enforce that a single corrupt/fail-closed row (and any field leak from it)
 * is rejected LOUD — schema/contract deviations must never silently pass.
 * `deniedTools` is treated strictly as the declared *tool restriction* list
 * (bounded entries), never an enumeration of permitted tools.
 */
import { describe, expect, it } from 'vitest'
import {
  assertSwarmReadRpcValue,
  SWARM_READ_RPC_CONTRACT_V1,
  SWARM_READ_RPC_FIXTURES_V1,
} from '../src/rpc/read-rpc-artifact.js'

const COMPOSITION_FIELDS = [
  'state', 'reason', 'runtimeProvider',
  'llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools',
] as const

const growth = { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' }
const avatar = { state: 'not_generated', reason: 'avatar_backend_not_implemented' }
const identityCard = { state: 'not_generated', reason: 'identity_backend_not_implemented' }

describe('composition contract/artifact field set (fault-first)', () => {
  it('pins the schema so composition admits EXACTLY the eight public fields', () => {
    // Walk to the frozen memberComposition schema and read its allowed properties.
    const captainMembers = SWARM_READ_RPC_CONTRACT_V1.schemas.values.captainMembers as {
      properties: { members: { items: { properties: { composition: { properties: Record<string, unknown> } } } } };
    }
    const allowed = Object.keys(captainMembers.properties.members.items.properties.composition.properties).sort()
    expect(allowed).toEqual([...COMPOSITION_FIELDS].sort())
    // additionalProperties:false means any other field is a contract violation.
    const compositionSchema = captainMembers.properties.members.items.properties.composition as unknown as { additionalProperties: boolean }
    expect(compositionSchema.additionalProperties).toBe(false)
  })

  it('admits an available composition with the full eight-field set and a fail-closed row', () => {
    expect(() => assertSwarmReadRpcValue('captainMembers', SWARM_READ_RPC_FIXTURES_V1.values.captainMembers)).not.toThrow()
  })

  it('rejects required-field omissions and any unknown ninth field', () => {
    const base = { ...SWARM_READ_RPC_FIXTURES_V1.values.captainMembers, members: [] as unknown[] }
    const row = (composition: unknown) =>
      ({ name: 'm', role: 'r', phase: 'active', createdAt: 1, avatar, identityCard, growth, composition })
    const full = {
      state: 'available', reason: 'available', runtimeProvider: 'spawn',
      llmProvider: 'mock', model: 'm', presetId: 'standard', personaConfigured: true,
      deniedTools: ['agent_swarm_create_managed'],
    }
    expect(() => assertSwarmReadRpcValue('captainMembers', { ...base, members: [row(full)] })).not.toThrow()
    // Missing a required field must fail.
    expect(() => assertSwarmReadRpcValue('captainMembers', {
      ...base, members: [row({ ...full, state: undefined })],
    })).toThrow()
    expect(() => assertSwarmReadRpcValue('captainMembers', {
      ...base, members: [row({ ...full, runtimeProvider: undefined })],
    })).toThrow()
    // Any ninth / unknown field (an allow-side, an internal mode, a persona blob) fails.
    for (const leak of [
      { allow: [] },
      { mode: 'continuable' },
      { persona: 'blob' },
      { provider: 'spawn' },
      { toolFilter: { deny: ['x'] } },
    ]) {
      expect(() => assertSwarmReadRpcValue('captainMembers', { ...base, members: [row({ ...full, ...leak })] }), JSON.stringify(leak)).toThrow()
    }
  })

  it('rejects a fail-closed row that leaks capability fields or an empty tool-restriction entry', () => {
    const base = { ...SWARM_READ_RPC_FIXTURES_V1.values.captainMembers, members: [] as unknown[] }
    const row = (composition: unknown) =>
      ({ name: 'm', role: 'r', phase: 'active', createdAt: 1, avatar, identityCard, growth, composition })
    const failClosed = { state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'spawn' }
    expect(() => assertSwarmReadRpcValue('captainMembers', { ...base, members: [row(failClosed)] })).not.toThrow()
    // A fail-closed row must never expose the capability fields.
    for (const leak of [
      { llmProvider: 'mock' }, { model: 'm' }, { presetId: 'standard' },
      { personaConfigured: true }, { deniedTools: ['x'] }, { reason: 'available' },
    ]) {
      expect(() => assertSwarmReadRpcValue('captainMembers', { ...base, members: [row({ ...failClosed, ...leak })] }), JSON.stringify(leak)).toThrow()
    }
    // The tool-restriction list stays bounded with non-empty entries.
    expect(() => assertSwarmReadRpcValue('captainMembers', {
      ...base,
      members: [row({ state: 'available', reason: 'available', runtimeProvider: 'spawn', personaConfigured: true, deniedTools: [''] })],
    })).toThrow()
  })

  it('rejects an available composition that fails to disclose personaConfigured', () => {
    const base = { ...SWARM_READ_RPC_FIXTURES_V1.values.captainMembers, members: [] as unknown[] }
    const row = (composition: unknown) =>
      ({ name: 'm', role: 'r', phase: 'active', createdAt: 1, avatar, identityCard, growth, composition })
    expect(() => assertSwarmReadRpcValue('captainMembers', {
      ...base,
      members: [row({ state: 'available', reason: 'available', runtimeProvider: 'spawn' })],
    })).toThrow()
  })
})
