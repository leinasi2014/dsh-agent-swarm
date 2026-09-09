/** Script only the LLM output. Mail transport, tools, continuable Sessions,
 * scheduler, fenced submission and Captain review use the official composition. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamId } from '../src/index.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { mountNodeComposition, SIGNAL, taskOf } from './helpers/node-composition.js'

const QUESTION = 'PEER-QUESTION: what is the approved radius?'
const ANSWER = 'PEER-ANSWER: radius=37'
const BUSY = 'HOLD-BETA-REQUEST'
const ASSIGNMENT = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/
const userText = (options: GenerateOptions): string => options.messages.filter(message => message.role === 'user')
  .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

class PeerAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  busyRequest: GenerateOptions | undefined
  private releaseBusy!: () => void
  private busyGate = new Promise<void>(resolve => { this.releaseBusy = resolve })
  private asked = false
  private answered = false
  private submitted = false
  private reviewed = false
  private readonly joinReleases = new Map<string, () => void>()
  private readonly joined = new Set<string>()
  open(): void { this.releaseBusy(); for (const release of this.joinReleases.values()) release() }
  openJoin(model: string): void { this.joinReleases.get(model)?.() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = userText(options)
    if (['alpha', 'beta'].includes(options.model) && !this.joined.has(options.model)) {
      this.joined.add(options.model)
      await new Promise<void>(resolve => { this.joinReleases.set(options.model, resolve) })
    }
    if (options.model === 'beta' && text.includes(BUSY) && this.busyRequest === undefined) {
      this.busyRequest = options
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new Error('busy beta aborted'))
        if (options.signal?.aborted) { abort(); return }
        options.signal?.addEventListener('abort', abort, { once: true })
        void this.busyGate.then(() => { options.signal?.removeEventListener('abort', abort); resolve() })
      })
    }
    let tool: { name: string; args: Record<string, unknown> } | undefined
    const assignment = ASSIGNMENT.exec(text)
    if (options.model === 'alpha' && assignment !== null && !this.asked) {
      this.asked = true
      tool = { name: 'agent_swarm_send_message', args: { target: 'beta', content: QUESTION, delivery: 'wakeup' } }
    } else if (options.model === 'beta' && text.includes(QUESTION) && !this.answered) {
      this.answered = true
      tool = { name: 'agent_swarm_send_message', args: { target: 'alpha', content: ANSWER, delivery: 'wakeup' } }
    } else if (options.model === 'alpha' && assignment !== null && text.includes(ANSWER) && !this.submitted) {
      this.submitted = true
      // The result is derived from the actual peer answer in this model request.
      const radius = /PEER-ANSWER: radius=(\d+)/.exec(text)?.[1]
      if (radius === undefined) throw new Error('peer answer missing from alpha context')
      tool = { name: 'agent_swarm_submit_task', args: {
        task_id: assignment[1], expected_revision: Number(assignment[2]), attempt_id: assignment[3],
        output: `Applied beta's approved radius=${radius}; diameter=${Number(radius) * 2}.`,
        evidence: [`Consumed beta reply: ${ANSWER}`],
      } }
    } else if (options.model === 'mock' && text.includes('CAPTAIN-REVIEW:') && !this.reviewed) {
      const review = JSON.parse(text.split('CAPTAIN-REVIEW:')[1]!.split('\n')[0]!) as { task_id: string; revision: number; attempt_id: string; output: string }
      if (review.output !== "Applied beta's approved radius=37; diameter=74.") throw new Error('Captain rejected incorrect peer-derived result')
      this.reviewed = true
      tool = { name: 'agent_swarm_review_task', args: {
        task_id: review.task_id, expected_revision: review.revision, attempt_id: review.attempt_id, decision: 'accept',
        diagnostic: 'Checked peer answer radius=37 and derived diameter=74 in the submitted result.',
      } }
    }
    if (tool !== undefined) {
      const id = ToolCallId(crypto.randomUUID()), args = JSON.stringify(tool.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool.name, arguments: args } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Turn finished.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Turn finished.' } }
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: tool === undefined ? 'stop' : 'tool-calls' } }
  }
}

function successfulLoggedTool(events: readonly SessionEvent[], name: string): boolean {
  return events.some(call => call.type === 'tool/call' && call.data.name === name && events.some(result =>
    result.type === 'tool/result' && result.sourceEventSeqs?.includes(call.seq)
    && result.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === call.data.callId && block.isError === false)))
}
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

for (const state of ['idle', 'busy'] as const) {
  it(`completes alpha -> ${state} beta -> alpha submission -> Captain review through actual Session context`, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), `dsh-peer-${state}-`))
    cleanup.push(() => rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const composition = await mountNodeComposition(sandbox)
    const adapter = new PeerAdapter()
    cleanup.push(async () => {
      adapter.open(); composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    })
    composition.ctx.llm.registerAdapter(['peer'], adapter)
    // Captain also uses deterministic output so its notification turns can finish.
    vi.spyOn(composition.adapter, 'stream').mockImplementation(options => adapter.stream(options))
    const call = async (agent: Agent, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = await composition.ctx.tools.execute({ agent, name, arguments: args, signal: SIGNAL, callId: ToolCallId(crypto.randomUUID()) })
      if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    const team = await call(composition.lead, 'agent_swarm_create', { name: 'Peer loop', description: 'Use a colleague answer in a reviewed result.' }) as { team_id: string }
    const members: Record<string, Agent> = {}
    for (const name of ['alpha', 'beta']) {
      const added = await call(composition.lead, 'agent_swarm_add_member', { name, role: name, llm_provider: 'peer', model: name }) as { session_id: string }
      const member = composition.ctx.agents.get(SessionId(added.session_id))
      if (member === undefined) throw new Error(`${name} resident missing`)
      members[name] = member
      adapter.openJoin(name)
      await member.whenIdle()
    }
    const alpha = members.alpha!, beta = members.beta!
    if (state === 'busy') {
      await call(composition.lead, 'agent_swarm_send_message', { target: 'beta', content: BUSY, delivery: 'wakeup' })
      await vi.waitFor(() => expect(adapter.busyRequest).toBeDefined())
    }
    const created = await call(composition.lead, 'agent_swarm_create_task', {
      subject: 'Use a peer measurement', description: 'Ask beta for the approved radius, then submit radius and diameter.', target_member: 'alpha',
    }) as { task_id: string }
    const snapshot = () => composition.domain.snapshot(composition.scope, TeamId(team.team_id), composition.lead.id)
    if (state === 'busy') {
      await vi.waitFor(async () => {
        expect((await snapshot()).team.messages).toContainEqual(expect.objectContaining({ senderSessionId: alpha.id, targetSessionId: beta.id, content: QUESTION }))
      }, { timeout: 15_000 })
      expect(adapter.busyRequest?.signal?.aborted).toBe(false)
      expect(userText(adapter.busyRequest!)).not.toContain(QUESTION)
      expect(adapter.requests.some(request => request.model === 'beta' && userText(request).includes(QUESTION))).toBe(false)
      expect((await taskOf(composition, team.team_id, created.task_id)).status).toBe('in_progress')
      adapter.open()
    }
    await vi.waitFor(async () => {
      const task = await taskOf(composition, team.team_id, created.task_id)
      expect(task.status).toBe('submitted')
      expect(task.output).toBe("Applied beta's approved radius=37; diameter=74.")
    }, { timeout: 20_000 })
    await alpha.whenIdle(); await beta.whenIdle(); await composition.lead.whenIdle()
    const submitted = await taskOf(composition, team.team_id, created.task_id)
    composition.lead.followup(createUserMessage({ content: [{ type: 'text', text: `CAPTAIN-REVIEW:${JSON.stringify({
      task_id: submitted.id, revision: submitted.revision, attempt_id: submitted.currentAttemptId, output: submitted.output,
    })}` }], source: { kind: 'user' } }))
    await composition.lead.whenIdle()
    expect((await taskOf(composition, team.team_id, created.task_id)).status).toBe('completed')
    const final = await snapshot()
    expect(final.team.messages.filter(message => message.senderSessionId === alpha.id && message.targetSessionId === beta.id))
      .toEqual([expect.objectContaining({ content: QUESTION, phase: 'delivered' })])
    expect(final.team.messages.filter(message => message.senderSessionId === beta.id && message.targetSessionId === alpha.id))
      .toEqual([expect.objectContaining({ content: ANSWER, phase: 'delivered' })])
    expect(final.team.attempts.filter(attempt => attempt.taskId === created.task_id))
      .toEqual([expect.objectContaining({ phase: 'accepted', memberSessionId: alpha.id })])
    // Provider-visible contexts, not mocked delivery counters.
    expect(adapter.requests.some(request => request.model === 'beta' && userText(request).includes(QUESTION))).toBe(true)
    expect(adapter.requests.some(request => request.model === 'alpha' && userText(request).includes(ANSWER))).toBe(true)
    await composition.ctx.subagents.drainContinuableChildren(composition.lead, [alpha.id, beta.id])
    for (const agent of [alpha, beta, composition.lead]) {
      const live = composition.ctx.agents.get(agent.id)
      if (live !== undefined) await composition.ctx.sessions.flush(live.session)
    }
    const alphaLog = await readPersistedSession(composition.ctx.sessionPersistence, alpha.id)
    const betaLog = await readPersistedSession(composition.ctx.sessionPersistence, beta.id)
    const captainLog = await readPersistedSession(composition.ctx.sessionPersistence, composition.lead.id)
    expect(betaLog.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes(QUESTION))).toBe(true)
    expect(alphaLog.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes(ANSWER))).toBe(true)
    expect(successfulLoggedTool(alphaLog.events, 'agent_swarm_send_message')).toBe(true)
    expect(successfulLoggedTool(betaLog.events, 'agent_swarm_send_message')).toBe(true)
    expect(successfulLoggedTool(alphaLog.events, 'agent_swarm_submit_task')).toBe(true)
    expect(successfulLoggedTool(captainLog.events, 'agent_swarm_review_task')).toBe(true)
  }, 45_000)
}
