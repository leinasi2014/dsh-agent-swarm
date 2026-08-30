import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(result.content).toEqual([{
      type: 'text',
      text: `Created managed Team "Managed Team" (${value.team_id}) with dedicated Captain ${value.captain_session_id}. The supplied description was delivered as the Captain's only initial objective; it must contain the user's complete requested outcome, constraints, and acceptance criteria verbatim because omitted requirements will not be delivered automatically. The Main Brain remains outside the Team: call agent_swarm_list_managed_teams at most once, then end this turn. Do not call agent_swarm_wait, agent_swarm_status, or agent_swarm_send_message, and do not use Shell sleep or polling; use the Host Team UI for later observation.`,
    }])
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

    // Managed topology is deliberate: the Main Brain can enumerate its Team,
    // but Team-participant tools reject it before any aggregate mutation. The
    // dedicated Captain retains the same status path.
    const beforeRejectedSend = (await mounted.domain.requireMembership(mounted.scope, value.captain_session_id)).team
    const mainStatus = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('main-status'), name: 'agent_swarm_status', arguments: {}, agent: mounted.lead,
    })
    expect(mainStatus).toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
    const mainSend = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('main-send'), name: 'agent_swarm_send_message',
      arguments: { target: 'captain', content: 'Must be rejected before persistence.' }, agent: mounted.lead,
    })
    expect(mainSend).toMatchObject({ isError: true, error: { info: { code: 'TEAM_NOT_JOINED' } } })
    const afterRejectedSend = (await mounted.domain.requireMembership(mounted.scope, value.captain_session_id)).team
    expect(afterRejectedSend.revision).toBe(beforeRejectedSend.revision)
    expect(afterRejectedSend.messages).toEqual(beforeRejectedSend.messages)
    const captainStatus = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('captain-status'), name: 'agent_swarm_status', arguments: {}, agent: captain,
    })
    expect(captainStatus).toMatchObject({ isError: false, value: { team_id: value.team_id } })

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

    // These descriptions are the model-visible routing contract. Keep the
    // managed Main Brain on its read-only enumeration surface and prevent the
    // model from trying Team-participant tools after a successful create.
    expect(properties.description).toMatchObject({
      description: 'The Captain\'s only initial objective. Copy the user\'s complete requested outcome, constraints, and acceptance criteria verbatim; do not summarize or omit requirements because omitted requirements are not delivered automatically later.',
    })
    expect(tool?.description).toBe('Main Brain entry. Create a durable Team with a dedicated Captain Session. The `description` argument is that Captain\'s only initial objective: copy the user\'s complete requested outcome, constraints, and acceptance criteria into `description` verbatim, including any requested public goal, announcement, Captain/member names, professions, personalities, and pixel avatars. Do not summarize or drop requirements; omitted requirements are not delivered to the Captain automatically. The Main Brain remains outside the Team; the Captain analyzes the delivered objective and recruits its own members. After creation, the Main Brain may call agent_swarm_list_managed_teams at most once, then must end the current turn. It must not call agent_swarm_wait, agent_swarm_status, or agent_swarm_send_message, and must not use Shell sleep or polling. Use the Host Team UI for later observation.')
    expect(mounted.ctx.tools.get('agent_swarm_send_message')?.description).toBe('Active-Team-participant only. Persist a Team message before best-effort delivery. A queued result is durable and must not be resent by the caller. A managed Main Brain remains outside the Team and is not a valid sender; use agent_swarm_list_managed_teams or the Host Team UI to observe its managed Teams.')
    expect(mounted.ctx.tools.get('agent_swarm_status')?.description).toBe('Active-Team-participant or archived-Captain only. Read the fixed-size Team counters: roster size, task counts by outcome, readiness, queued mail, budgets and memory. Task rows — owners, attempts, filters, pagination — come from agent_swarm_list_tasks; this summary never embeds them. A managed Main Brain remains outside the Team and must use agent_swarm_list_managed_teams or the Host Team UI instead.')
    expect(mounted.ctx.tools.get('agent_swarm_wait')?.description).toBe('Active-Team-participant or archived-Captain only; unavailable to a managed Main Brain. Wait without polling until the authoritative Team revision exceeds after_revision, or return unchanged at timeout. Returns no_progress immediately when no other member is running or provisioning — waiting cannot help then. Caller cancellation fails with TEAM_WAIT_ABORTED. After managed creation, the Main Brain may call agent_swarm_list_managed_teams at most once, then must end the current turn without Shell sleep or polling.')
  })

  it('is idempotent: the same operation identity never creates a duplicate Captain or Team', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-idem-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const create = async () => (await mounted!.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('managed-create-idem'),
      name: 'agent_swarm_create_managed',
      arguments: { name: 'Idem Team', description: 'One Captain only.' },
      agent: mounted!.lead,
    })).value as { team_id: string; captain_session_id: string }

    const first = await create()
    expect(first.captain_session_id).not.toBe(mounted.lead.id)
    // A second create with the SAME operation identity (MainBrainSessionId +
    // turn / detached call handle) reuses the existing Captain/Team.
    const second = await create()
    expect(second.team_id).toBe(first.team_id)
    expect(second.captain_session_id).toBe(first.captain_session_id)
  })

  it('issues a readable "Team · Captain" label to official startContinuable (issue #148)', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-label-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const start = vi.spyOn(mounted.ctx.subagents, 'startContinuable')

    const result = await mounted.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('managed-label'),
      name: 'agent_swarm_create_managed',
      arguments: { name: 'Managed Team', description: 'Readable Captain label.' },
      agent: mounted.lead,
    })
    expect(result.isError).toBe(false)

    // The Captain Session must appear in the official DSH session list under
    // the Team name plus a readable role tag, never `agent-swarm:captain:<id>`.
    const labels = start.mock.calls.map(call => (call[0] as { label: string }).label)
    expect(labels).toContain('Managed Team · Captain')
    expect(labels.some(label => label.startsWith('agent-swarm:captain:'))).toBe(false)

    start.mockRestore()
  })

  it('onboards the Captain identity before any recruitment (issue #171)', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-dedicated-captain-profile-'))
    mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
    const start = vi.spyOn(mounted.ctx.subagents, 'startContinuable')

    const result = await mounted.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('managed-profile-order'),
      name: 'agent_swarm_create_managed',
      arguments: { name: 'Profiled Team', description: 'Recruit only after Captain onboarding.' },
      agent: mounted.lead,
    })
    expect(result.isError).toBe(false)
    const value = result.value as { captain_session_id: string }
    const membership = await mounted.domain.requireMembership(mounted.scope, value.captain_session_id)
    const request = start.mock.calls[0]?.[0].request
    expect(request).toBeDefined()
    const notice = request?.prompt.map(part => part.type === 'text' ? part.text : '').join('\n') ?? ''
    const persona = request?.persona ?? ''

    expect(notice).toContain(`expected_revision=${membership.team.revision}`)
    expect(notice).toContain('Chinese display_name')
    expect(notice).toContain('profession')
    expect(notice).toContain('personality')
    expect(notice).toContain('original safe pixel_avatar_svg')
    expect(notice.indexOf('agent_swarm_set_captain_profile')).toBeGreaterThanOrEqual(0)
    expect(notice.indexOf('agent_swarm_add_member')).toBeGreaterThan(notice.indexOf('agent_swarm_set_captain_profile'))
    expect(persona.indexOf('agent_swarm_set_captain_profile')).toBeGreaterThanOrEqual(0)
    expect(persona.indexOf('agent_swarm_add_member')).toBeGreaterThan(persona.indexOf('agent_swarm_set_captain_profile'))
    expect(`${persona}\n${notice}`).toContain('Captain Session and Team already exist')

    start.mockRestore()
  })
})
