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

  it('keeps the main Session outside the Team and binds a continuable Captain child on the configured route', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const result = await mounted.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('managed-create'),
      name: 'agent_swarm_create_managed',
      arguments: {
        name: 'Managed Team',
        description: 'Captain recruits the implementation roster.',
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
    // The Captain's LLM route comes from the plugin configuration only, never
    // from model-supplied arguments.
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

  it('rejects model-steered Captain routing and never leaves a duplicate active Team from one call', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-misroute-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })

    // The public tool no longer exposes captain_llm_provider / captain_model,
    // so a model that tries to steer the Captain's LLM route is rejected before
    // any routing can occur (the display/parameter name can no longer be
    // misused to smuggle a provider).
    const misrouted = await mounted.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('managed-misroute'),
      name: 'agent_swarm_create_managed',
      arguments: {
        name: 'Managed Team',
        description: 'Must not route via model-supplied provider.',
        captain_llm_provider: 'other-provider',
        captain_model: 'other-model',
      },
      agent: mounted.lead,
    })
    // Either schema rejection (isError) or, if tolerated, the call must never
    // surface a captain that carries the smuggled route.
    if (!misrouted.isError) {
      const smug = misrouted.value as { captain_session_id: string }
      const smuggledCaptain = mounted.ctx.agents.get(SessionId(smug.captain_session_id))
      expect(smuggledCaptain?.options).toMatchObject({ provider: 'mock', model: 'mock' })
    }

    // Whatever the outcome of the mis-routed call, exactly one real managed
    // Team may exist afterwards — a single failing/steered create must not have
    // left a duplicate active aggregate in the scope.
    const teams = await mounted.ctx.agentSwarm.listTeamAggregates(mounted.scope)
    const active = teams.filter(team => team.phase === 'active')
    expect(active.length).toBeLessThanOrEqual(1)
  })

  it('does not expose model-steered Captain routing in the public tool schema', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-schema-'))
    mounted = await mountNodeComposition(sandbox)

    // The dedicated Captain's LLM route is plugin-configured only. The public
    // `agent_swarm_create_managed` parameter surface must therefore not offer
    // `captain_llm_provider` / `captain_model`, so a model can never override
    // provider/model at the call site (and the tool cannot forward model
    // options into `createWithDedicatedCaptain`).
    const tool = mounted.ctx.tools.get('agent_swarm_create_managed')
    expect(tool).toBeDefined()
    const properties = (tool?.parameters as { properties?: Record<string, unknown> })?.properties ?? {}
    expect(Object.hasOwn(properties, 'name')).toBe(true)
    expect(Object.hasOwn(properties, 'description')).toBe(true)
    expect(Object.hasOwn(properties, 'captain_llm_provider')).toBe(false)
    expect(Object.hasOwn(properties, 'captain_model')).toBe(false)
  })

  it('is idempotent: the same root never creates a duplicate Captain or Team', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-idem-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const create = async () => (await mounted!.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId(`managed-create-${Date.now()}`),
      name: 'agent_swarm_create_managed',
      arguments: { name: 'Idem Team', description: 'One Captain only.' },
      agent: mounted!.lead,
    })).value as { team_id: string; captain_session_id: string }

    const first = await create()
    expect(first.captain_session_id).not.toBe(mounted.lead.id)
    // A second create_managed for the same root reuses the existing Captain/Team.
    const second = await create()
    expect(second.team_id).toBe(first.team_id)
    expect(second.captain_session_id).toBe(first.captain_session_id)
  })
})
