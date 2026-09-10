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

it('deduplicates clock-only directory updates across real steps, retains semantic changes and restores a replaced snapshot', async () => {
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
  try {
    const { agent, ctx } = stack, scope = ctx.agentSwarm.scopeOf(agent)
    const membership = await ctx.agentSwarm.domain.requireMembership(scope, agent.id), teamId = membership.team.id
    const read = () => ctx.agentSwarm.directory.read(scope, teamId, {}, new AbortController().signal)
    const nextTurn = async () => { agent.followup(prompt('Continue the same task.')); await agent.whenIdle() }
    // The first routed request/catalog changes the real directory. Stabilize
    // those semantic facts before isolating observation-clock-only updates.
    await nextTurn()
    await nextTurn()
    const baseline = snapshots(agent.session).length, firstRequestCount = adapter.requests.length
    const firstRead = await read()
    toolSteps = 2
    await nextTurn()
    expect(adapter.requests).toHaveLength(firstRequestCount + 3)
    expect(snapshots(agent.session)).toHaveLength(baseline)
    for (const request of adapter.requests.slice(firstRequestCount)) expect(request.messages.filter(message => message.role === 'user'
      && message.content.some(part => part.type === 'text' && part.text.includes('Current public Team directory')))).toHaveLength(baseline)
    const stable = directoryOf(snapshots(agent.session).at(-1)!)
    expect(JSON.stringify(stable)).not.toContain('observedAt')
    const secondRead = await read()
    expect(secondRead.observedAt).toBeGreaterThan(firstRead.observedAt)
    expect(secondRead.entries[0]!.profile.observedAt).toBeGreaterThan(firstRead.entries[0]!.profile.observedAt)
    expect(secondRead.directoryRevision).toBe(firstRead.directoryRevision)
    expect(stable).toMatchObject({ directoryRevision: secondRead.directoryRevision, binding: secondRead.binding, page: secondRead.page,
      entries: [{ memberId: agent.id, model: { imageInput: 'supported' } }] })

    const current = await ctx.agentSwarm.domain.requireMembership(scope, agent.id)
    await ctx.agentSwarm.domain.setCaptainProfile(scope, teamId, agent.id, current.team.revision, { displayName: 'Updated captain' })
    await nextTurn()
    expect(snapshots(agent.session)).toHaveLength(baseline + 1)
    expect(directoryOf(snapshots(agent.session).at(-1)!)).toMatchObject({ entries: [{ memberId: agent.id, label: 'Updated captain' }] })
    imageInput = false
    await nextTurn()
    expect(snapshots(agent.session)).toHaveLength(baseline + 2)
    const latest = snapshots(agent.session).at(-1)!, changed = directoryOf(latest)
    expect(changed.directoryRevision).not.toBe(stable.directoryRevision)
    expect(changed).toMatchObject({ entries: [{ memberId: agent.id, model: { imageInput: 'unsupported' } }] })
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
      && part.text.includes('Current public Team directory') && part.text.includes('Updated captain') && part.text.includes('unsupported')))).toBe(true)
  } finally { clock.mockRestore(); await stack.dispose() }
})
