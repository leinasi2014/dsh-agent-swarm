/** Exact running execution proof over real official child Sessions and tools. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { expect, it, vi } from 'vitest'
import { captureTaskInterruption, type TaskInterruptionResult } from '../src/runtime/goal-task-interruption.js'
import { Recording, setup, createTeam, addPublicMembers } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL, restartTool } from './helpers/restart-real-composition.js'

/** Bounded test program, actual SDK Code Mode binding/dispatch and real tool. */
class ClaimCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'; readonly isolation = 'test'
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const match = /^return await tools\.(agent_swarm_list_tasks|agent_swarm_claim_task)\((.*)\);$/.exec(request.program)
    if (match === null) throw new Error('Unexpected cancellation proof program')
    const value = await request.bindings[0]!.functions[match[1]!]!(JSON.parse(match[2]!))
    return { logs: [], value }
  }
}

class CancelLoop extends Recording {
  worker = ''; step = 0; entered = false; stop = false; release = () => {}
  constructor(readonly kind: 'assignment' | 'native claim' | 'Code Mode claim') { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.worker) { yield* super.stream(options); return }
    const texts = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
    if (!texts.some(text => text.startsWith('Team assignment from captain.') || text.startsWith('An open Team task may be available.'))) {
      yield* super.stream(options); return
    }
    this.requests.push(options)
    let name: string | undefined, args: object = {}
    if (this.kind !== 'assignment' && this.step === 0) { name = 'agent_swarm_list_tasks'; this.step++ }
    else if (this.kind !== 'assignment' && this.step === 1) {
      const values = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'tool-result'
        ? block.content.flatMap(part => { if (part.type !== 'text') return []; try { return [JSON.parse(part.text)] } catch { return [] } }) : [])
      const task = values.toReversed().map(value => value.value ?? value).find(value => Array.isArray(value.tasks))?.tasks.find((candidate: any) => candidate.subject === 'Cancel exact old work' && candidate.ready)
      if (task !== undefined) { name = 'agent_swarm_claim_task'; args = { task_id: task.task_id, expected_revision: task.revision }; this.step++ }
    }
    if (name !== undefined) {
      if (this.kind === 'Code Mode claim') {
        args = { code: `return await tools.${name}(${JSON.stringify(args)});`, description: 'Claim proof through the official dispatch bridge.' }
        name = 'run_code'
      }
      const id = ToolCallId(`cancel-claim-${this.step}`), argumentsText = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    if (this.stop) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    this.entered = true
    await new Promise<void>((resolve, reject) => {
      const signal = options.signal, abort = () => reject(signal?.reason ?? new Error('cancelled'))
      this.release = () => { signal?.removeEventListener('abort', abort); resolve() }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each(['assignment', 'native claim', 'Code Mode claim'] as const)('cancels only the actual running %s turn and never repeats interruption', async kind => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-cancel-')), adapter = new CancelLoop(kind), f = await setup(sandbox, adapter)
  try {
    const { root, captain, scope, teamId } = await createTeam(f, sandbox)
    const [worker] = await addPublicMembers(f, root, captain.id)
    if (kind === 'Code Mode claim') {
      f.fibers.push(await f.ctx.plugin(ClaimCodeRuntime))
      const presented = new WeakSet<object>()
      f.ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (agent.id === worker && !presented.has(agent)) { agent.ctx.tools.presentAs('ptc'); presented.add(agent) }
        return await next()
      }, { prepend: true })
    }
    adapter.worker = worker!
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async live => {
      const created = await restartTool(f.ctx, live, 'cancel-create', 'agent_swarm_create_task', { subject: 'Cancel exact old work', description: 'Hold until cancelled.',
        ...(kind === 'assignment' ? { target_member: 'alpha' } : { assignment_mode: 'open-claim' }) })
      expect(created.isError, JSON.stringify(created)).toBe(false)
      await vi.waitFor(() => expect(adapter.entered).toBe(true), { timeout: 15_000 })
      const before = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, live.id)).team
      const task = before.tasks[0]!, attempt = before.attempts.find(item => item.id === task.currentAttemptId)!
      expect(task.ownerSessionId).toBe(worker)
      const held = f.ctx.agents.get(SessionId(worker!))!
      expect(held.status).toBe('running')
      // Keep the official child lease so the successor is the same Agent
      // and Session object; only its actual turn identity will differ.
      await f.ctx.subagents.withContinuableChild(live, held.id, SIGNAL, async owned => {
      expect(owned).toBe(held)
      const late: TaskInterruptionResult = { state: 'not-needed' }
      const captured = captureTaskInterruption(f.ctx, live, before, task, attempt, late)
      expect(captured, JSON.stringify(held.session.snapshotEvents().filter(event => ['turn/start', 'user/message', 'tool/call', 'tool/result'].includes(event.type)))).toBeTypeOf('function')
      if (kind === 'Code Mode claim') {
        const events = held.session.snapshotEvents()
        const start = events.find(event => event.type === 'tool/ptc-dispatch-start' && event.data.name === 'agent_swarm_claim_task')!
        expect(start).toBeDefined()
        if (start.type !== 'tool/ptc-dispatch-start') throw new Error('Wrong dispatch fact')
        const result = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.subCallId === start.data.subCallId)
        expect(result).toMatchObject({ data: { rootCallId: start.data.rootCallId, parentCallId: start.data.parentCallId, isError: false } })
      }
      const interrupt = vi.spyOn(f.ctx.subagents, 'interrupt')
      try {
        const stale = await restartTool(f.ctx, live, 'cancel-stale', 'agent_swarm_cancel_task', { request_id: 'bad-cas', task_id: task.id, expected_revision: task.revision - 1, reason: 'Bad CAS must do nothing.' })
        expect(stale.isError).toBe(true); expect(interrupt).not.toHaveBeenCalled()
        const input = { request_id: 'cancel-once', task_id: task.id, expected_revision: task.revision, reason: 'Requirement replaced.' }
        const result = await restartTool(f.ctx, live, 'cancel-actual', 'agent_swarm_cancel_task', input)
        expect(result.isError, JSON.stringify(result)).toBe(false)
        expect(result.value).toMatchObject({ status: 'cancelled', replayed: false, interruption: { state: 'requested' } })
        expect(interrupt).toHaveBeenCalledTimes(1)
        const replay = await restartTool(f.ctx, live, 'cancel-replay', 'agent_swarm_cancel_task', input)
        expect(replay.value).toMatchObject({ replayed: true, interruption: { state: 'not-repeated' } })
        expect(interrupt).toHaveBeenCalledTimes(1)
        await held.whenIdle()
        const oldTurn = held.session.snapshotEvents().findLast(event => event.type === 'turn/start')!.seq
        adapter.entered = false
        held.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An unrelated successor turn must survive an old cancellation.' }] }))
        await vi.waitFor(() => expect(adapter.entered).toBe(true))
        expect(held.status).toBe('running')
        expect(held.session.snapshotEvents().findLast(event => event.type === 'turn/start')!.seq).toBeGreaterThan(oldTurn)
        captured!()
        expect(late).toMatchObject({ state: 'skipped', reason: 'execution-changed' })
        expect(interrupt).toHaveBeenCalledTimes(1)
        const after = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, live.id)).team
        expect(after.tasks[0]).toMatchObject({ status: 'cancelled' })
        expect(after.attempts.find(item => item.id === attempt.id)).toMatchObject({ phase: 'stale' })
        expect(after.budget.usedTokens).toBeGreaterThanOrEqual(before.budget.usedTokens)
        adapter.stop = true; adapter.release(); await held.whenIdle()
      } finally { interrupt.mockRestore() }
      })
    })
  } finally { adapter.release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)
