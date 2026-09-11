/** Actual loop admission and durable surface replacement, without a synthetic prompt assembler. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { GuardAdapter, doneChunks, mountGuard, prompt, toolChunks } from './helpers/execution-guard.js'

function snapshots(session: Session): SessionEvent<'user/message'>[] {
  return session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === 'plugin' && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')
}

function directoryOf(event: SessionEvent<'user/message'>) {
  const source = event.data.source
  if (source.kind !== 'plugin' || source.form !== 'snapshot') throw new Error('Expected official context snapshot')
  const text = source.sections.find(section => section.name === 'agent-swarm:directory')!.text
  return JSON.parse(text.slice(text.indexOf('```') + 3, text.lastIndexOf('```')))
}

it('keeps real requests lightweight and stable, reflects core changes and restores a replaced snapshot', async () => {
  let now = Date.now(), imageInput = true, toolSteps = 0
  const adapter = new GuardAdapter(async function* (_options, index) {
    now += 1000
    if (toolSteps-- > 0) yield* toolChunks(index, 'agent_swarm_status', {})
    else yield* doneChunks()
  })
  vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => ({ provider, id: model, name: model,
    inputModalities: imageInput ? ['text', 'image'] : ['text'] }))
  const stack = await mountGuard(adapter)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const richReads = vi.spyOn(stack.ctx.agentSwarm.directory, 'read')
  try {
    const { agent, ctx } = stack, scope = ctx.agentSwarm.scopeOf(agent)
    const membership = await ctx.agentSwarm.domain.requireMembership(scope, agent.id), teamId = membership.team.id
    const read = () => ctx.agentSwarm.directory.read(scope, teamId, {}, new AbortController().signal)
    const nextTurn = async () => { agent.followup(prompt('Continue the same task.')); await agent.whenIdle() }
    await nextTurn()
    const baseline = snapshots(agent.session).length, firstRequestCount = adapter.requests.length
    expect(baseline).toBe(1)
    for (const name of ['agent_swarm_claim_task', 'agent_swarm_submit_task', 'agent_swarm_reassign_task', 'agent_swarm_review_task']) {
      const tool = adapter.requests[0]!.tools!.find(candidate => candidate.name === name)!
      expect(tool.parameters).toMatchObject({ properties: { expected_revision: { description: expect.stringContaining('revision of this task') } } })
    }
    expect(adapter.requests[0]!.tools!.find(tool => tool.name === 'agent_swarm_claim_task')!.description).toContain('ready true')
    expect(adapter.requests[0]!.tools!.find(tool => tool.name === 'agent_swarm_claim_task')!.description).toContain('any target must identify you')
    expect(adapter.requests[0]!.tools!.find(tool => tool.name === 'agent_swarm_claim_task')!.description).toContain('Ready does not approve budget or permissions')
    const firstRead = await read()
    richReads.mockClear()
    toolSteps = 2
    await nextTurn()
    expect(adapter.requests).toHaveLength(firstRequestCount + 3)
    expect(richReads).not.toHaveBeenCalled()
    expect(snapshots(agent.session)).toHaveLength(baseline)
    for (const request of adapter.requests.slice(firstRequestCount)) expect(request.messages.filter(message => message.role === 'user'
      && message.content.some(part => part.type === 'text' && part.text.includes('Current public Team overview')))).toHaveLength(baseline)
    const stable = directoryOf(snapshots(agent.session).at(-1)!)
    expect(JSON.stringify(stable)).not.toContain('observedAt')
    const secondRead = await read()
    expect(secondRead.observedAt).toBeGreaterThan(firstRead.observedAt)
    expect(secondRead.entries[0]!.profile.observedAt).toBeGreaterThan(firstRead.entries[0]!.profile.observedAt)
    expect(stable).toMatchObject({ teamId, phase: 'active', members: { entries: [{ memberId: agent.id, name: 'captain' }] }, openTasks: { entries: [] } })
    expect(stable.members.entries[0]).not.toHaveProperty('model')
    expect(stable.members.entries[0]).not.toHaveProperty('tools')
    expect(stable.members.entries[0]).not.toHaveProperty('skills')
    const beforeGoal = await ctx.agentSwarm.domain.requireMembership(scope, agent.id)
    await ctx.agentSwarm.domain.setPublicGoal(scope, teamId, agent.id, beforeGoal.team.revision, 'Unrelated goal metadata changed.')
    imageInput = false
    richReads.mockClear()
    await nextTurn()
    expect(richReads).not.toHaveBeenCalled()
    expect(snapshots(agent.session)).toHaveLength(baseline)
    const explicit = await stack.execute('agent_swarm_directory')
    expect(explicit.isError).toBe(false)
    expect(explicit.value).toMatchObject({ entries: [{ memberId: agent.id, model: { imageInput: 'unsupported' } }] })
    richReads.mockClear()

    const current = await ctx.agentSwarm.domain.requireMembership(scope, agent.id)
    await ctx.agentSwarm.domain.setCaptainProfile(scope, teamId, agent.id, current.team.revision, { displayName: 'Updated captain' })
    await nextTurn()
    expect(snapshots(agent.session)).toHaveLength(baseline + 1)
    expect(directoryOf(snapshots(agent.session).at(-1)!)).toMatchObject({ members: { entries: [{ memberId: agent.id, label: 'Updated captain' }] } })
    // Direct canonical writes keep scheduling out of this projection test.
    const ready = await ctx.agentSwarm.domain.createTask(scope, teamId, agent.id, { subject: 'Inspect dialogue', description: 'Open task summary.', assignmentMode: 'open-claim' })
    const blocked = await ctx.agentSwarm.domain.createTask(scope, teamId, agent.id, { subject: 'Publish dialogue', description: 'Wait for inspection.', blockedBy: [ready.id], assignmentMode: 'open-claim' })
    await nextTurn()
    expect(snapshots(agent.session)).toHaveLength(baseline + 2)
    const latest = snapshots(agent.session).at(-1)!, changed = directoryOf(latest)
    expect(changed.openTasks.entries).toEqual([
      expect.objectContaining({ taskId: ready.id, revision: ready.revision, status: 'pending', ready: true, assignmentMode: 'open-claim' }),
      expect.objectContaining({ taskId: blocked.id, revision: blocked.revision, status: 'pending', ready: false, assignmentMode: 'open-claim' }),
    ])
    await nextTurn()
    expect(snapshots(agent.session)).toHaveLength(baseline + 2)

    // Exercise the same official replacement operation compaction commits. This
    // tests snapshot recovery, not a model's ability to produce a useful summary.
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Earlier context condensed.' }],
      source: { kind: 'plugin', plugin: 'identity-context-proof' } }), {
      surfaceOp: { op: 'replace', startSeq: latest.seq, endSeq: latest.seq }, sourceEventSeqs: [latest.seq],
    })
    expect(agent.session.surface.nodes).not.toContain(latest.seq)
    await nextTurn()
    expect(snapshots(agent.session)).toHaveLength(baseline + 3)
    expect(directoryOf(snapshots(agent.session).at(-1)!)).toEqual(changed)
    const lastRequest = adapter.requests.at(-1)!
    expect(lastRequest.messages.some(message => message.role === 'user' && message.content.some(part => part.type === 'text'
      && part.text.includes('Current public Team overview') && part.text.includes('Updated captain') && part.text.includes(ready.id)))).toBe(true)
    expect(richReads).not.toHaveBeenCalled()
  } finally { richReads.mockRestore(); clock.mockRestore(); await stack.dispose() }
})

it('withdraws the old Team contribution from an actual request and reconstructs a new Team identity', async () => {
  const adapter = new GuardAdapter(async function* () { yield* doneChunks() })
  const stack = await mountGuard(adapter)
  try {
    const { agent, ctx } = stack, scope = ctx.agentSwarm.scopeOf(agent), domain = ctx.agentSwarm.domain
    const nextTurn = async () => { agent.followup(prompt('Read the current context.')); await agent.whenIdle() }
    await nextTurn()
    const oldTeam = (await domain.requireMembership(scope, agent.id)).team
    await domain.archiveTeam(scope, oldTeam.id, agent.id, 'The owner revoked this Team.')
    const before = adapter.requests.length
    await nextTurn()
    expect(adapter.requests).toHaveLength(before + 1)
    const cleared = snapshots(agent.session).at(-1)!, source = cleared.data.source
    expect(source.kind === 'plugin' && source.form === 'snapshot' && source.sections.some(section => section.name.startsWith('agent-swarm:'))).toBe(false)
    expect(adapter.requests.at(-1)!.messages.some(message => message.role === 'user' && JSON.stringify(message.content) === JSON.stringify(cleared.data.content))).toBe(true)
    expect(adapter.requests.at(-1)!.messages.filter(message => message.role === 'system').flatMap(message => message.content)
      .some(part => part.type === 'text' && part.text.includes('Current Team profile and peer-collaboration rules'))).toBe(false)
    const newTeam = await domain.createTeam(scope, agent.id, 'New Team', 'A fresh canonical membership.')
    await nextTurn()
    const latest = snapshots(agent.session).at(-1)!
    expect(directoryOf(latest)).toMatchObject({ teamId: newTeam.id, members: { entries: [{ memberId: agent.id }] } })
    expect(JSON.stringify(latest.data.content)).not.toContain(oldTeam.id)
    expect(adapter.requests.at(-1)!.messages.some(message => message.role === 'user' && JSON.stringify(message.content) === JSON.stringify(latest.data.content))).toBe(true)
  } finally { await stack.dispose() }
})
