/** Actual persisted maintenance rounds; only the due clock callback is controlled. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { Recording, setup, createTeam, captureRestartSnapshot } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL, restartTool } from './helpers/restart-real-composition.js'

class MaintenanceLoop extends Recording {
  rounds = 0
  private readonly steps = new Map<string, number>()
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const frame = options.messages.filter(message => message.role === 'user').toReversed().flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.startsWith('The Team goal needs Captain coordination.'))
    const id = frame?.type === 'text' ? /Goal coordination notice "([^"]+)":/.exec(frame.text)?.[1] : undefined
    if (id === undefined || this.steps.get(id) === 2) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const step = this.steps.get(id) ?? 0
    let name = 'agent_swarm_get_goal', args: object = {}
    if (step === 1) {
      const snapshots = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'tool-result'
        ? block.content.flatMap(part => { if (part.type !== 'text') return []; try { return [JSON.parse(part.text)] } catch { return [] } }) : [])
      const trigger = snapshots.toReversed().find(value => value.lifecycle?.currentTrigger?.notificationMessageId === id)?.lifecycle.currentTrigger
      if (trigger === undefined) throw new Error('Official goal read did not return the current maintenance trigger')
      name = 'agent_swarm_coordinate_goal'; args = { triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
        summary: 'The maintenance check is complete; no new work is required.', taskIds: [], outcome: 'round-finished', nextAction: 'Recheck at the next due time.' }
      this.rounds++
    }
    this.steps.set(id, step + 1)
    const call = ToolCallId(`maintenance-${id}-${step}`), argumentsText = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: call, name, arguments: argumentsText } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('rebuilds a future maintenance deadline after checkpoint, continues the same Team once due, and stops at token exhaustion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-maintenance-loop-')), source = join(directory, 'source'), checkpoint = join(directory, 'checkpoint')
  const firstAdapter = new MaintenanceLoop()
  let first: Awaited<ReturnType<typeof setup>> | undefined = await setup(source, firstAdapter)
  let second: Awaited<ReturnType<typeof setup>> | undefined
  let restoreTimer = () => {}, restoreWake = () => {}
  try {
    const { root, captain, teamId, scope } = await createTeam(first, source)
    // The official lease prevents natural Captain retirement from waking
    // Main after the driver became idle but while the checkpoint is copied.
    const { before, firstDue } = await first.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async live => {
      const result = await restartTool(first!.ctx, root, 'start-maintenance', 'agent_swarm_save_goal', { team_id: teamId,
        requestId: 'maintenance-start', expectedLifecycleRevision: 0, start: true, tokenBudget: { expectedTokenLimit: null, tokenLimit: 1000 },
        goal: { text: 'Keep checking the same Team.', acceptanceCriteria: 'Record a checked round.', constraints: 'No replacement Team.', mode: 'maintenance', intervalMs: 60_000 } })
      expect(result.isError, JSON.stringify(result)).toBe(false)
      await vi.waitFor(async () => expect((await first!.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle?.phase).toBe('waiting'), { timeout: 15_000 })
      await live.whenIdle()
      await root.whenIdle()
      expect(first!.ctx.agents.get(captain.id)).toBe(live)
      expect(live.status).toBe('idle')
      expect(root.status).toBe('idle')
      const savedTeam = (await first!.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(firstAdapter.rounds).toBe(1)
      await captureRestartSnapshot(first!, source, checkpoint)
      return { before: savedTeam, firstDue: savedTeam.goalLifecycle!.nextDueAt! }
    })
    await first.close(); first = undefined

    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(firstDue - 50_000)
    const timers: { timer: ReturnType<typeof setTimeout>; at: number; fire(): void }[] = [], nativeTimeout = globalThis.setTimeout
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
      const timer = nativeTimeout(handler, delay, ...args)
      if (typeof delay === 'number' && delay >= 30_000 && delay <= 60_000) timers.push({ timer, at: Date.now() + delay, fire: () => handler(...args) })
      return timer
    })
    restoreTimer = () => timerSpy.mockRestore()
    const adapter = new MaintenanceLoop()
    second = await setup(checkpoint, adapter)
    expect(adapter.requests).toHaveLength(0)
    expect(timers).toHaveLength(1); expect(timers[0]!.at).toBe(firstDue)
    const restored = await second.ctx.agentSwarm.goals.snapshot(scope, teamId)
    expect(restored.lifecycle?.nextDueAt).toBe(firstDue)
    const firstTimer = timers.shift()!
    clearTimeout(firstTimer.timer); vi.setSystemTime(firstDue + 5); firstTimer.fire()
    await vi.waitFor(async () => {
      expect(adapter.rounds).toBe(1)
      expect((await second!.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle?.phase).toBe('waiting')
    }, { timeout: 15_000 })
    await second.ctx.agents.get(captain.id)?.whenIdle()
    const after = (await second.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(after).toMatchObject({ id: before.id, captainSessionId: before.captainSessionId, managedOrigin: before.managedOrigin, phase: 'active' })
    expect(after.goalLifecycle!.lastCoordination!.at).toBeGreaterThanOrEqual(firstDue + 5)
    expect(after.goalLifecycle?.nextDueAt).toBe(after.goalLifecycle!.lastCoordination!.at + 60_000)
    expect(after.goalLifecycle?.lastCoordination?.triggerId).not.toBe(before.goalLifecycle?.lastCoordination?.triggerId)
    expect(after.tasks).toHaveLength(0)
    expect(timers).toHaveLength(1)
    await second.ctx.agentSwarm.domain.consumeTokens(scope, teamId, Math.max(0, 1000 - after.budget.usedTokens))
    const dueTimer = timers.shift()!, wake = vi.spyOn(second.ctx.agentSwarm.goals, 'wake')
    restoreWake = () => wake.mockRestore()
    clearTimeout(dueTimer.timer); vi.setSystemTime(dueTimer.at); dueTimer.fire()
    expect(wake).toHaveBeenCalledOnce(); await wake.mock.results[0]!.value
    expect(adapter.rounds).toBe(1)
    expect(await second.ctx.agentSwarm.goals.snapshot(scope, teamId)).toMatchObject({ waitingReason: 'budget', lifecycle: { phase: 'waiting', nextDueAt: dueTimer.at } })
    expect(timers).toHaveLength(0)
  } finally {
    restoreWake(); restoreTimer(); vi.useRealTimers(); await first?.close(); await second?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)
