/** Shared real maintenance checkpoint and the actual one-shot clock callbacks. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, vi } from 'vitest'
import { Recording, setup, createTeam, captureRestartSnapshot } from './public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL, restartTool } from './restart-real-composition.js'

export class MaintenanceLoop extends Recording {
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

export async function maintenanceCheckpoint() {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-maintenance-loop-')), source = join(directory, 'source'), checkpoint = join(directory, 'checkpoint')
  const adapter = new MaintenanceLoop(), first = await setup(source, adapter)
  let failed = false
  try {
    const { root, captain, teamId, scope } = await createTeam(first, source)
    return await first.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async live => {
      const result = await restartTool(first.ctx, root, 'start-maintenance', 'agent_swarm_save_goal', { team_id: teamId,
        requestId: 'maintenance-start', expectedLifecycleRevision: 0, start: true, tokenBudget: { expectedTokenLimit: null, tokenLimit: 1000 },
        goal: { text: 'Keep checking the same Team.', acceptanceCriteria: 'Record a checked round.', constraints: 'No replacement Team.', mode: 'maintenance', intervalMs: 60_000 } })
      expect(result.isError, JSON.stringify(result)).toBe(false)
      await vi.waitFor(async () => expect((await first.ctx.agentSwarm.goals.snapshot(scope, teamId)).lifecycle?.phase).toBe('waiting'), { timeout: 15_000 })
      await live.whenIdle(); await root.whenIdle()
      expect(first.ctx.agents.get(captain.id)).toBe(live)
      expect(live.status).toBe('idle'); expect(root.status).toBe('idle')
      const before = (await first.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(adapter.rounds).toBe(1)
      await captureRestartSnapshot(first, source, checkpoint)
      return { directory, source, checkpoint, scope, teamId, rootId: root.id, captainId: captain.id, before, firstDue: before.goalLifecycle!.nextDueAt! }
    })
  } catch (error) { failed = true; throw error }
  finally { await first.close(); if (failed) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

export function maintenanceTimers(now: number) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  type Timer = { timer: ReturnType<typeof setTimeout>; at: number; delay: number; fire(): void }
  const pending: Timer[] = [], history: Timer[] = [], nativeTimeout = globalThis.setTimeout, nativeClear = globalThis.clearTimeout
  const remove = (timer: ReturnType<typeof setTimeout>) => {
    const index = pending.findIndex(entry => entry.timer === timer)
    if (index >= 0) pending.splice(index, 1)
  }
  const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    if (typeof delay !== 'number' || delay < 1000 || delay > 60_000) return nativeTimeout(handler, delay, ...args)
    const entry: Timer = { timer: undefined as unknown as ReturnType<typeof setTimeout>, at: Date.now() + delay, delay,
      fire: () => { remove(entry.timer); nativeClear(entry.timer); vi.setSystemTime(Math.max(Date.now(), entry.at)); handler(...args) } }
    entry.timer = nativeTimeout(() => { remove(entry.timer); handler(...args) }, delay)
    pending.push(entry); history.push(entry)
    return entry.timer
  })
  const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
    const entry = pending.find(item => item.timer === timer)
    if (entry !== undefined) remove(entry.timer)
    nativeClear(timer)
  })
  return { pending, history, restore: () => {
    for (const entry of pending) nativeClear(entry.timer)
    pending.length = 0; set.mockRestore(); clear.mockRestore(); vi.useRealTimers()
  } }
}
