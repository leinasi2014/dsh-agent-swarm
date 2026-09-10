/** Cold recovery consumes persisted goals, never local invocation state. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { Recording, setup, createTeam, captureRestartSnapshot } from './helpers/public-chat-real-composition.js'
import { restartTool } from './helpers/restart-real-composition.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'

async function noRecoveryQueued(f: Awaited<ReturnType<typeof setup>>, captainId: Parameters<typeof readPersistedSession>[1]) {
  const events = f.ctx.agents.get(captainId)?.session.snapshotEvents()
    ?? (await readPersistedSession(f.ctx.sessionPersistence, captainId, new AbortController().signal)).events
  const recovery = events.filter(event => JSON.stringify(event.data).includes('The Host restarted while this managed Team')
    || JSON.stringify(event.data).includes('Goal recovery after Host restart.')).map(event => ({ type: event.type, seq: event.seq }))
  expect(recovery).toEqual([])
}

function recoveryRequests(adapter: Recording) {
  return adapter.requests.filter(request => request.messages.filter(message => message.role === 'user').some(message => message.content.some(block =>
    block.type === 'text' && (block.text.startsWith('The Host restarted') || block.text.startsWith('Goal recovery after Host restart.')))))
}
async function checkpoint(budgetSpent: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-goal-recovery-')), source = join(directory, 'source'), saved = join(directory, 'checkpoint')
  const f = await setup(source, new Recording())
  try {
    const identity = await createTeam(f, source), { root, captain, scope, teamId } = identity
    const result = await restartTool(f.ctx, root, 'save-cold', 'agent_swarm_save_goal', { team_id: teamId,
      requestId: 'cold-goal', expectedLifecycleRevision: 0, start: true, tokenBudget: { expectedTokenLimit: null, tokenLimit: 100 },
      goal: { text: 'Finish after restart.', acceptanceCriteria: 'Explicit confirmation.', constraints: '', mode: 'finite' } })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.messages.find(message => message.kind === 'goal-coordination-notice')?.phase).toBe('delivered')
      expect(f.ctx.agents.get(captain.id)?.status ?? 'idle').toBe('idle')
    })
    if (budgetSpent) await f.ctx.agentSwarm.domain.consumeTokens(scope, teamId, 100)
    const before = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    await captureRestartSnapshot(f, source, saved)
    return { directory, saved, scope, teamId, captainId: captain.id, rootId: root.id, before }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  finally { await f.close() }
}

it('does not wake a cold consumed goal trigger after its token budget is exhausted', async () => {
  const cut = await checkpoint(true), adapter = new Recording()
  let resumed: Awaited<ReturnType<typeof setup>> | undefined
  try {
    resumed = await setup(cut.saved, adapter)
    await noRecoveryQueued(resumed, cut.captainId)
    expect(recoveryRequests(adapter)).toHaveLength(0)
    const goal = await resumed.ctx.agentSwarm.goals.snapshot(cut.scope, cut.teamId)
    expect(goal).toMatchObject({ waitingReason: 'budget', budget: { usedTokens: 100, tokenLimit: 100 }, lifecycle: { phase: 'running' } })
  } finally { await resumed?.close(); await rm(cut.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it.each(['pause', 'owner'] as const)('rechecks %s after cold Main attachment before waking a consumed goal trigger', async change => {
  const cut = await checkpoint(false), adapter = new Recording()
  let resumed: Awaited<ReturnType<typeof setup>> | undefined, context!: Context, entered = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let restore = () => {}
  const pending = setup(cut.saved, adapter, false, async ctx => {
    context = ctx
    const resume = ctx.agents.resume.bind(ctx.agents)
    const spy = vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => {
      if (options.resumeSessionId === cut.rootId) { entered = true; await gate }
      return await resume(options)
    })
    restore = () => spy.mockRestore()
  })
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    if (change === 'pause') await context.agentSwarm.goals.controlOperator(cut.scope, cut.teamId,
      { requestId: 'pause-during-attach', expectedLifecycleRevision: cut.before.goalLifecycle!.revision, action: 'pause' })
    else context.agentSwarm.orchestration.acquire(cut.scope, cut.teamId, 'new-workflow-owner')
    release(); resumed = await pending
    await noRecoveryQueued(resumed, cut.captainId)
    expect(recoveryRequests(adapter)).toHaveLength(0)
  } finally {
    release(); restore(); resumed ??= await pending
    await resumed.close(); await rm(cut.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
