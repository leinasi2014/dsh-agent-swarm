/**
 * Fault-first tests: the browser R2 client reading nested composition from a
 * captainMembers response.
 *
 * On a success body the client validates the value via
 * `assertSwarmReadRpcValue('captainMembers', ...)`, so any row whose
 * composition deviates from composition.v1 (a ninth field, a missing required
 * field, a fail-closed row leaking a capability field, ...) must REJECT the
 * whole response. `deniedTools` is surfaced only as the *tool restriction*
 * list.
 */
import { describe, expect, it } from 'vitest'
import { SwarmReadClient } from '../src/client/index.js'

const growth = { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' }
const avatar = { state: 'not_generated', reason: 'avatar_backend_not_implemented' }
const identityCard = { state: 'not_generated', reason: 'identity_backend_not_implemented' }

const membersValue = (members: unknown[]) => ({
  schemaVersion: 1, binding: { rootSessionId: 'root', teamId: 'team' }, members, observedAt: 1_700_000_000_000,
})

const row = (name: string, composition: unknown) =>
  ({ name, role: 'r', phase: 'active', createdAt: 1, avatar, identityCard, growth, composition })

function clientReturning(members: unknown[]): SwarmReadClient {
  return new SwarmReadClient(async () => new Response(JSON.stringify({
    schemaVersion: 1, ok: true, value: membersValue(members),
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

const request = { schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: 'root', teamId: 'team' } } as const

describe('R2 client nested composition read (fault-first)', () => {
  it('delivers healthy + fail-closed rows preserving order/names and their nested composition', async () => {
    const client = clientReturning([
      row('worker', {
        state: 'available', reason: 'available', runtimeProvider: 'spawn',
        llmProvider: 'mock', model: 'worker-model', presetId: 'standard', personaConfigured: true,
        deniedTools: ['agent_swarm_create_managed'],
      }),
      row('damaged', { state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'spawn' }),
    ])
    const envelope = await client.request(request)
    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    const value = envelope.value as unknown as { members: Array<{ name: string; composition: unknown }> }
    expect(value.members.map(member => member.name)).toEqual(['worker', 'damaged'])
    expect(value.members[0]!.composition).toEqual({
      state: 'available', reason: 'available', runtimeProvider: 'spawn',
      llmProvider: 'mock', model: 'worker-model', presetId: 'standard', personaConfigured: true,
      deniedTools: ['agent_swarm_create_managed'],
    })
    expect(value.members[1]!.composition).toEqual({ state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'spawn' })
  })

  it('rejects the whole response when any row violates the composition field set', async () => {
    const variants: Array<[string, unknown[]]> = [
      // ninth field on an available composition
      ['ninth-field', [row('m', { state: 'available', reason: 'available', runtimeProvider: 'spawn', personaConfigured: true, mode: 'continuable' })]],
      // missing required runtimeProvider
      ['missing-runtime', [row('m', { state: 'available', reason: 'available', personaConfigured: true })]],
      // available composition must disclose personaConfigured
      ['no-persona', [row('m', { state: 'available', reason: 'available', runtimeProvider: 'spawn' })]],
      // fail-closed row leaking a capability field
      ['leak-model', [row('m', { state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'spawn', model: 'm' })]],
      // empty tool-restriction entry
      ['empty-tool', [row('m', { state: 'available', reason: 'available', runtimeProvider: 'spawn', personaConfigured: true, deniedTools: [''] })]],
      // composition projection entirely missing
      ['no-composition', [{ name: 'm', role: 'r', phase: 'active', createdAt: 1, avatar, identityCard, growth }]],
    ]
    for (const [label, members] of variants) {
      const client = clientReturning(members)
      await expect(client.request(request), label).rejects.toThrow()
    }
  })
})
