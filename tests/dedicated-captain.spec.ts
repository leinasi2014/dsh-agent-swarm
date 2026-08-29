import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { mountNodeComposition, SIGNAL, type NodeComposition } from './helpers/node-composition.js'

describe('dedicated Captain topology', () => {
  let sandbox: string | undefined
  let mounted: NodeComposition | undefined

  afterEach(async () => {
    mounted?.adapter.open()
    if (mounted !== undefined) {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    }
    if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
  })

  it('keeps the main Session outside the Team and binds a continuable Captain child', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-'))
    mounted = await mountNodeComposition(sandbox)
    const result = await mounted.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('managed-create'),
      name: 'agent_swarm_create_managed',
      arguments: {
        name: 'Managed Team',
        description: 'Captain recruits the implementation roster.',
        captain_llm_provider: 'mock',
        captain_model: 'mock',
      },
      agent: mounted.lead,
    })
    expect(result.isError).toBe(false)
    const value = result.value as { team_id: string; captain_session_id: string }
    expect(value.captain_session_id).not.toBe(mounted.lead.id)
    expect(await mounted.domain.findMembership(mounted.scope, mounted.lead.id)).toBeUndefined()
    const captainMembership = await mounted.domain.requireMembership(mounted.scope, value.captain_session_id)
    expect(captainMembership.role).toBe('captain')
    expect(captainMembership.team.id).toBe(value.team_id)
    const captain = mounted.ctx.agents.get(SessionId(value.captain_session_id))
    expect(captain).toBeDefined()
    if (captain === undefined) throw new Error('dedicated Captain was not registered')
    expect(captain?.session.header.parentSession).toBe(mounted.lead.id)
    expect(captain?.options).toMatchObject({ provider: 'mock', model: 'mock' })

    // The dedicated Captain can recruit the first worker at absolute depth 2.
    const add = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('captain-add-member'), name: 'agent_swarm_add_member',
      arguments: { name: 'worker', role: 'Implement the first slice.', llm_provider: 'mock', model: 'mock' },
      agent: captain,
    })
    expect(add.isError).toBe(false)
    const refreshed = await mounted.domain.requireMembership(mounted.scope, captain.id)
    const workerId = refreshed.team.members.find(member => member.name === 'worker')?.sessionId
    expect(workerId).toBeDefined()
    const worker = workerId === undefined ? undefined : mounted.ctx.agents.get(SessionId(workerId))
    expect(worker?.session.header.parentSession).toBe(captain.id)

    // Only the top-level main Chat can create another managed Team. The
    // Captain receives both a tool-filter deny and this runtime authority gate.
    const nested = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('captain-nested-managed'), name: 'agent_swarm_create_managed',
      arguments: { name: 'Nested', description: 'Must not be created.' }, agent: captain,
    })
    expect(nested.isError).toBe(true)
    expect(await mounted.domain.findMembership(mounted.scope, value.captain_session_id)).toMatchObject({ role: 'captain' })
  })
})
