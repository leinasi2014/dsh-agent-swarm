import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { assignmentPrompt } from '../src/runtime/prompts.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { addMember, GatedAdapter, mount, SIGNAL, snapshotOf } from './helpers/gated-composition.js'
import { disposeRestartComposition, mountRestartComposition, type RestartMounted } from './helpers/restart-real-composition.js'

it('revalidates a cold member against persisted task state when restoring a pre-shutdown inbox snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assignment-cold-'))
  const original = join(root, 'original'), restored = join(root, 'restored')
  const first = await mount(original, 0)
  let second: RestartMounted | undefined
  let firstDisposed = false
  const resumedAdapter = new GatedAdapter()
  try {
    const memberId = await addMember(first, 'cold-worker')
    const member = first.ctx.agents.get(SessionId(memberId))!
    await first.adapter.waitForRequests(1)
    const domain = first.ctx.agentSwarm.domain, teamId = TeamId(first.teamId)
    const task = await domain.createTask(first.scope, teamId, first.lead.id, { subject: 'Settled before restart', description: 'Do not replay this task.' })
    const claim = await domain.claimTask(first.scope, teamId, memberId, task.id, task.revision, memberId)
    const stale = createUserMessage({ content: [{ type: 'text', text: assignmentPrompt((await snapshotOf(first)).team, claim.task, claim.attempt.id) }], source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } })
    const submitted = await domain.submitTask(first.scope, teamId, memberId, task.id, claim.task.revision, claim.attempt.id, 'Done before restart')
    await domain.reviewTask(first.scope, teamId, first.lead.id, task.id, submitted.revision, claim.attempt.id, 'accept')
    await vi.waitFor(() => {
      first.adapter.open()
      expect(member.status).toBe('idle')
      expect(first.lead.status).toBe('idle')
    }, { timeout: 5_000 })
    member.send(stale, 'next-turn', false)
    await first.ctx.sessionPersistence.flush()
    const logs = await Promise.all([member.id, first.lead.id].map(id => readPersistedSession(first.ctx.sessionPersistence, id)))
    expect(member.inbox.nextTurn.map(message => message.id)).toContain(stale.id)
    await cp(join(original, 'storage'), join(restored, 'storage'), { recursive: true })
    for (const fiber of first.fibers.toReversed()) await fiber.dispose()
    firstDisposed = true
    // Normal disposal cancels pending work. Restore the exact flushed prefix
    // through official persistence handles to simulate a crash's retained inbox;
    // this is a fresh Context, with no original Agent or in-memory Team objects.
    second = await mountRestartComposition(restored, 0, undefined, undefined, async ctx => {
      ctx.llm.registerAdapter(['mock'], resumedAdapter)
      for (const log of logs) {
        const handle = await ctx.sessionPersistence.create(log.meta, { inheritedEventCount: log.inheritedEventCount })
        try { await handle.append(log.events); await handle.flush() } finally { await handle.close() }
      }
    })
    expect(second.ctx.agents.get(SessionId(memberId))).toBeUndefined()
    const captain = (await second.ctx.agents.resume({ resumeSessionId: first.lead.id, agentOptions: { provider: 'mock', model: 'mock' } })).agent
    const feedback = 'Fresh feedback after cold restoration.'
    await queueHostSubagentPrompt(second.ctx.subagents, captain, SessionId(memberId), [{ type: 'text', text: feedback }], { kind: 'plugin', plugin: 'dsh-agent-swarm' }, SIGNAL)
    const resumed = second.ctx.agents.get(SessionId(memberId))!
    await vi.waitFor(() => {
      resumedAdapter.open()
      expect(resumed.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === feedback))).toBe(true)
    }, { timeout: 5_000 })
    expect(resumed.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === stale.id)).toBe(false)
    const state = await second.ctx.agentSwarm.domain.snapshot(first.scope, teamId, captain.id)
    expect(state.team.tasks.find(candidate => candidate.id === task.id)).toMatchObject({ status: 'completed', currentAttemptId: claim.attempt.id })
  } finally {
    first.adapter.open(); resumedAdapter.open()
    if (!firstDisposed) for (const fiber of first.fibers.toReversed()) await fiber.dispose()
    if (second !== undefined) await disposeRestartComposition(second)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
