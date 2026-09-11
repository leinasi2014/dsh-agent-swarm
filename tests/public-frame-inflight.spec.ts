/** Real official dequeue/assembly boundary: no synthetic Session events. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as AgentSwarm from '../src/index.js'
import { publicDeliveries } from '../src/domain/public-message.js'
import { framePredicate, frameVisibility } from '../src/runtime/frame-visibility.js'
import { messageClaimed, messageInFlight, messagePending } from '../src/runtime/session-acceptance.js'
import { MessageDelivery } from '../src/runtime/message-delivery.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { captureRestartSnapshot, createTeam, HeldRecording, publicClient, Recording, setup } from './helpers/public-chat-real-composition.js'

it('does not readmit a public frame dequeued by a busy real driver awaiting prompt assembly', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-inflight-'))
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'swarm-public-inflight-cold-'))
  const adapter = new HeldRecording()
  const f = await setup(sandbox, adapter, true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let off: (() => void) | undefined
  let cold: Awaited<ReturnType<typeof setup>> | undefined
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    adapter.hold = true
    await f.ctx.subagents.prompt({ requestId: 'busy-before-public' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Hold existing work.' }] }, SIGNAL)
    await vi.waitFor(() => expect(adapter.entered).toBe(true))
    const prompts = vi.spyOn(f.ctx.subagents, 'prompt')
    const drains = vi.spyOn(MessageDelivery.prototype, 'deliverPublicMessages')
    const call = await publicClient(f, teamId)
    const request = { requestId: 'public-during-busy-turn', content: [{ type: 'text', text: 'Public input during existing work.' }] }
    const sent = await call('append', request)
    const original = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!
    const frame = publicDeliveries(original)[0]!.frame
    const active = f.ctx.agents.get(captain.id)!
    await vi.waitFor(() => expect(active.inbox.nextStep.some(framePredicate(frame))).toBe(true))
    // A brand-new message still steers into a busy target before its next step.
    expect(prompts.mock.calls.filter(([args]) => args.requestId === sent.message.id)).toHaveLength(1)
    let entered = false
    off = f.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent?.id === captain.id) { entered = true; await gate }
      return await next()
    }, { prepend: true })
    adapter.release()
    await vi.waitFor(() => expect(entered).toBe(true))
    expect(messagePending(active.session.snapshotEvents(), framePredicate(frame))).toBe(false)
    expect(messageClaimed(active.session.snapshotEvents(), framePredicate(frame))).toBe(false)
    expect(await f.ctx.sessions.flush(active.session)).toBe(true)
    // Wait for the original owner's bounded claim wait, then re-enter through
    // the real HTTP retry + same public delivery owner while assembly is held.
    await drains.mock.results[0]!.value
    expect(await frameVisibility(f.ctx, captain.id, frame, SIGNAL, 'live proposal', true)).toBe('unknown')
    expect(messageInFlight(active.session.snapshotEvents(), framePredicate(frame))).toBe(true)
    await captureRestartSnapshot(f, sandbox, snapshotRoot)
    cold = await setup(snapshotRoot, new Recording(), true, async ctx => {
      expect(ctx.agents.get(captain.id)).toBeUndefined()
      expect(await frameVisibility(ctx, captain.id, frame, SIGNAL, 'interrupted cold proposal', true)).toBe('absent')
    })
    const coldCall = await publicClient(cold, teamId)
    await coldCall('append', request)
    await vi.waitFor(async () => expect(publicDeliveries((await cold!.ctx.agentSwarm.listTeamAggregates(scope))[0]!.publicChat!.messages[0]!)[0]?.state).toBe('claimed'), { timeout: 10_000 })
    // A claimed frame is live evidence, not a persistence checkpoint. Keep
    // the official activation leased through its idle flush and stored read.
    await cold.ctx.subagents.withContinuableChild(cold.ctx.agents.get(root.id)!, captain.id, SIGNAL, async recovered => {
      await recovered.whenIdle()
      expect(messageClaimed(recovered.session.snapshotEvents(), framePredicate(frame))).toBe(true)
      expect(await recovered.ctx.sessions.flush(recovered.session)).toBe(true)
      const coldStored = await readPersistedSession(cold!.ctx.sessionPersistence, captain.id, SIGNAL)
      expect(coldStored.events.filter(event => event.type === 'user/message' && framePredicate(frame)(event.data))).toHaveLength(1)
    })
    await cold.close(); cold = undefined
    await call('append', request)
    await drains.mock.results.at(-1)!.value
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async live => {
      expect(live).toBe(active)
      release()
      await live.whenIdle()
      expect(messageClaimed(live.session.snapshotEvents(), framePredicate(frame))).toBe(true)
      expect(await live.ctx.sessions.flush(live.session)).toBe(true)
      const stored = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
      const insertions = stored.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).filter(framePredicate(frame))
      const claims = stored.events.flatMap(event => event.type === 'user/message' ? [event.data] : []).filter(framePredicate(frame))
      expect({ admissions: prompts.mock.calls.filter(([args]) => args.requestId === sent.message.id).length,
        insertions: insertions.length, claims: claims.length }).toEqual({ admissions: 1, insertions: 1, claims: 1 })
    })
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!)[0]?.state).toBe('claimed'))
  } finally {
    off?.(); release(); adapter.release(); vi.restoreAllMocks(); await cold?.close(); await f.close()
    await Promise.all([sandbox, snapshotRoot].map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  }
}, 25_000)

it.each(['reject', 'abort'] as const)('reconstructs an in-flight proposal after Host reload and releases it on %s turn end', async action => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-inflight-turn-'))
  const f = await setup(sandbox, new Recording())
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let off: (() => void) | undefined
  try {
    const { root } = await createTeam(f, sandbox)
    const frame = `Fixture public proposal ${action}.`
    const matches = framePredicate(frame)
    let entered = false
    off = root.ctx.on('agent/pre-step', async (proposal, next) => {
      const decision = await next()
      if (!proposal.messages.some(matches)) return decision
      entered = true; await gate
      return action === 'reject' ? { kind: 'reject' } : decision
    })
    // Real other work must finish without entering this frame's barrier.
    const other = 'Unrelated legitimate input before the proposal.'
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: other }] }))
    await root.whenIdle()
    expect(entered).toBe(false)
    expect(await frameVisibility(f.ctx, root.id, other, SIGNAL, 'unrelated input completed', true)).toBe('claimed')
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] }))
    await vi.waitFor(() => expect(entered).toBe(true))
    expect([...root.inbox.nextStep, ...root.inbox.nextTurn].filter(matches)).toHaveLength(0)
    expect(messageInFlight(root.session.snapshotEvents(), matches)).toBe(true)
    expect(await frameVisibility(f.ctx, root.id, frame, SIGNAL, 'before reload', true)).toBe('unknown')
    const previous = f.ctx.agentSwarm
    await f.fibers.pop()!.dispose()
    f.fibers.push(await f.ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs: 0,
      captainLlmProvider: 'public-fixture', captainModel: 'public-model' }))
    expect(f.ctx.agentSwarm).not.toBe(previous)
    expect(f.ctx.agents.get(root.id)).toBe(root)
    expect(await frameVisibility(f.ctx, root.id, frame, SIGNAL, 'fresh Host same real driver', true)).toBe('unknown')
    if (action === 'abort') root.cancel({ kind: 'user' }, { keepInbox: true })
    release(); await root.whenIdle()
    expect(root.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe(action === 'reject' ? 'blocked' : 'aborted')
    expect(messageInFlight(root.session.snapshotEvents(), framePredicate(frame))).toBe(false)
    expect(await frameVisibility(f.ctx, root.id, frame, SIGNAL, 'settled discarded proposal', true)).toBe('absent')
    off()
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] }))
    await root.whenIdle()
    expect(await frameVisibility(f.ctx, root.id, frame, SIGNAL, 'subsequent valid claim', true)).toBe('claimed')
  } finally { off?.(); release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it('treats explicit inbox removal as cancellation while the real driver remains busy', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-inflight-cancel-'))
  const adapter = new HeldRecording()
  const f = await setup(sandbox, adapter)
  try {
    const { root, captain } = await createTeam(f, sandbox)
    adapter.hold = true
    await f.ctx.subagents.prompt({ requestId: 'busy-for-cancel' as never, parentSessionId: root.id, childSessionId: captain.id,
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Remain busy while pending input is canceled.' }] }, SIGNAL)
    await vi.waitFor(() => expect(adapter.entered).toBe(true))
    const active = f.ctx.agents.get(captain.id)!
    const frame = 'Canceled pending fixture input.'
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] })
    active.steer(message)
    expect(await frameVisibility(f.ctx, captain.id, frame, SIGNAL, 'pending before explicit removal', true)).toBe('pending')
    expect(active.inbox.remove(message.id)).toBe(true)
    expect(active.status).toBe('running')
    expect(messageInFlight(active.session.snapshotEvents(), framePredicate(frame))).toBe(false)
    expect(await frameVisibility(f.ctx, captain.id, frame, SIGNAL, 'explicit canceled removal', true)).toBe('absent')
    active.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: frame }] }))
    adapter.release(); await active.whenIdle()
    expect(await frameVisibility(f.ctx, captain.id, frame, SIGNAL, 'replacement input claimed', true)).toBe('claimed')
  } finally { adapter.release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)
