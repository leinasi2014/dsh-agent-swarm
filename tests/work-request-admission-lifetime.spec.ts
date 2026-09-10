/** Keep the real continuable Captain alive across a deliberately delayed admission pass. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { Recording, addPublicMembers, createTeam, setup } from './helpers/public-chat-real-composition.js'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { frameVisibility } from '../src/runtime/frame-visibility.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

class AcceptOnce extends Recording {
  captainId = ''; requestId = ''; called = false; returned = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const work = options.messages.some(message => message.role === 'user' && message.content.some(block =>
      block.type === 'text' && block.text.startsWith('A work request awaits the Captain.')))
    if (options.sessionId === this.captainId && work) {
      if (this.called) { this.returned = true; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      this.called = true
      const id = ToolCallId('delayed-work-accept'), name = 'agent_swarm_resolve_work_request'
      const args = JSON.stringify({ work_request_id: this.requestId, expected_request_revision: 1, decision: 'accept',
        items: [{ item_key: 'only', subject: 'Delayed open work', description: 'Keep Captain authority until notification admission.', assignment_mode: 'open-claim' }] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('does not return the committed decision while its notification admission is still parked', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'work-captain-admission-')), adapter = new AcceptOnce()
  const f = await setup(sandbox, adapter)
  const run = SchedulingPass.prototype.run
  let injected = false
  let observation: { returned: boolean; exactCaptain: boolean } | undefined
  const delayed = vi.spyOn(SchedulingPass.prototype, 'run').mockImplementation(async function (this: SchedulingPass, ...args) {
    const team = (await f.ctx.agentSwarm.domain.snapshot(args[0], args[1], args[2].id)).team
    if (!injected && team.tasks.some(task => task.subject === 'Delayed open work')) {
      injected = true
      // Controlled slow scheduler/IO window, not a longer eventual-success timeout.
      // An unawaited tool return lets the official loop settle/dispose the Captain here.
      await new Promise(resolve => setTimeout(resolve, 100))
      observation = { returned: adapter.returned, exactCaptain: f.ctx.agents.get(args[2].id) === args[2] }
    }
    return await run.apply(this, args)
  })
  try {
    const { root, captain, scope, teamId } = await createTeam(f, sandbox)
    const [worker] = await addPublicMembers(f, root, captain.id)
    adapter.captainId = captain.id
    const request = await f.ctx.agentSwarm.domain.submitWorkRequest(scope, teamId, { kind: 'local-operator' },
      { requestId: 'delayed-captain-admission', description: 'An acceptance must retain its Captain through notification admission.' })
    adapter.requestId = request.request.id
    f.ctx.agentSwarm.kickWorkRequests(scope, teamId)
    await vi.waitFor(() => expect(observation).toBeDefined(), { timeout: 5_000 })
    expect(observation).toEqual({ returned: false, exactCaptain: true })
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.messages.some(notice => notice.kind === 'open-claim-notice' && notice.targetSessionId === worker && notice.phase === 'delivered')).toBe(true)
    }, { timeout: 10_000 })
    await vi.waitFor(() => expect(adapter.returned).toBe(true))
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const notice = team.messages.find(message => message.kind === 'open-claim-notice' && message.targetSessionId === worker)!
    expect(await frameVisibility(f.ctx, worker!, messageFrame(notice), SIGNAL, 'delayed work admission', true)).toBe('claimed')
    expect(team.tasks).toHaveLength(1)
    expect(team.tasks[0]?.status).toBe('pending')
    expect(team.attempts).toHaveLength(0) // Admission completion never waits for member task completion.
  } finally {
    delayed.mockRestore()
    await f.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 20_000)
