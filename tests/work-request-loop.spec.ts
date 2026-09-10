/** Recording adapter drives actual tools through the official loop; it is not real-model evidence. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { Recording, addPublicMembers, createTeam, setup } from './helpers/public-chat-real-composition.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

function jsonResults(options: GenerateOptions): Record<string, any>[] {
  return options.messages.flatMap(message => message.content).flatMap(block => block.type === 'tool-result'
    ? block.content.flatMap(part => { if (part.type !== 'text') return []; try { return [JSON.parse(part.text)] } catch { return [] } }) : [])
}
class WorkLoop extends Recording {
  captainId = ''; workerId = ''
  readonly calls: { id: ToolCallId; name: string; sessionId: string }[] = []
  private proposalStep = 0; private workerStep = 0; private reviewStep = 0
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const sessionId = options.sessionId ?? ''
    const texts = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    const results = jsonResults(options)
    const tasks = results.toReversed().find(value => Array.isArray(value.tasks) && value.tasks.some((task: any) => 'status' in task))?.tasks ?? []
    let name: string | undefined, args: object = {}
    if (sessionId === this.captainId && texts.some(text => text.includes('review-work-loop'))) {
      if (this.reviewStep === 0) { name = 'agent_swarm_list_tasks'; this.reviewStep++ }
      else if (this.reviewStep === 1) {
        const submitted = tasks.find((task: any) => task.subject === 'First work item' && task.status === 'submitted')
        if (submitted !== undefined) { name = 'agent_swarm_review_task'; args = { task_id: submitted.task_id,
          expected_revision: submitted.revision, attempt_id: submitted.attempt_id, decision: 'accept', diagnostic: 'Recorded deterministic check passed.' }; this.reviewStep++ }
      }
    } else if (sessionId === this.captainId && texts.some(text => text.startsWith('A work request awaits the Captain.'))) {
      if (this.proposalStep === 0) { name = 'agent_swarm_list_work_requests'; this.proposalStep++ }
      else if (this.proposalStep === 1) {
        const request = results.toReversed().find(value => Array.isArray(value.requests) && value.requests.length > 0)?.requests[0]
        if (request !== undefined) {
          name = 'agent_swarm_resolve_work_request'; args = { work_request_id: request.work_request_id,
            expected_request_revision: request.revision, decision: 'accept', items: [
              { item_key: 'first', subject: 'First work item', description: 'Read the real task, self-claim, then submit.', assignment_mode: 'open-claim' },
              { item_key: 'second', subject: 'Follow-on work item', description: 'Wait for the first item to be accepted.', assignment_mode: 'open-claim', blocked_by_items: ['first'] },
            ] }; this.proposalStep++
        }
      }
    } else if (sessionId === this.workerId && texts.some(text => text.startsWith('An open Team task may be available.'))) {
      if (this.workerStep === 0 || this.workerStep === 2) { name = 'agent_swarm_list_tasks'; this.workerStep++ }
      else if (this.workerStep === 1) {
        const ready = tasks.find((task: any) => task.subject === 'First work item' && task.ready && task.assignment_mode === 'open-claim')
        if (ready !== undefined) { name = 'agent_swarm_claim_task'; args = { task_id: ready.task_id, expected_revision: ready.revision }; this.workerStep++ }
      } else if (this.workerStep === 3) {
        const owned = tasks.find((task: any) => task.subject === 'First work item' && task.owner === 'alpha' && task.attempt_id !== undefined)
        if (owned !== undefined) { name = 'agent_swarm_submit_task'; args = { task_id: owned.task_id, expected_revision: owned.revision,
          attempt_id: owned.attempt_id, output: 'Private result from the official tool chain.', evidence: ['recording://work-loop-check'] }; this.workerStep++ }
      } else if (this.workerStep === 4) {
        name = 'agent_swarm_send_message'; args = { target: 'captain', content: 'review-work-loop: please inspect and review the submitted First work item.', delivery: 'wakeup' }; this.workerStep++
      }
    }
    if (name === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const id = ToolCallId(`work-loop-${this.calls.length + 1}`), text = JSON.stringify(args)
    this.calls.push({ id, name, sessionId })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('keeps the real operator source across atomic planning, worker self-claim, submission and Captain review', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-work-loop-')), adapter = new WorkLoop()
  const f = await setup(sandbox, adapter)
  try {
    const { root, captain, scope, teamId } = await createTeam(f, sandbox)
    const [worker] = await addPublicMembers(f, root, captain.id)
    adapter.captainId = captain.id; adapter.workerId = worker!
    const request = await f.ctx.agentSwarm.domain.submitWorkRequest(scope, teamId, { kind: 'local-operator' },
      { requestId: 'whole-work-loop', description: 'Complete first work, and keep follow-on work dependent on review.' })
    f.ctx.agentSwarm.kickWorkRequests(scope, teamId)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.tasks.find(task => task.subject === 'First work item')?.status, JSON.stringify(adapter.calls)).toBe('completed')
    }, { timeout: 20_000 })
    await Promise.all([f.ctx.agents.get(captain.id)?.whenIdle(), f.ctx.agents.get(worker!)?.whenIdle()])
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(team.tasks).toHaveLength(2)
    const first = team.tasks.find(task => task.subject === 'First work item')!, second = team.tasks.find(task => task.subject === 'Follow-on work item')!
    expect(first).toMatchObject({ ownerSessionId: worker, createdBySessionId: captain.id,
      source: { workRequestId: request.request.id, itemKey: 'first', origin: { kind: 'local-operator' } },
      submittedBySessionId: worker, reviewedBySessionId: captain.id })
    expect(second).toMatchObject({ status: 'pending', blockedBy: [first.id], source: { workRequestId: request.request.id, itemKey: 'second' } })
    expect(team.attempts).toHaveLength(1)
    expect(team.attempts[0]).toMatchObject({ memberSessionId: worker, phase: 'accepted', reviewProvider: 'manual' })
    expect(team.publicChat?.messages ?? []).toHaveLength(0)
    expect(team.workActivity?.entries.filter(entry => entry.taskId === first.id).map(entry => entry.kind))
      .toEqual(['task-created', 'task-claimed', 'task-submitted', 'task-reviewed'])
    expect(JSON.stringify(team.workActivity)).not.toContain('Private result')
    for (const call of adapter.calls) {
      const persisted = await readPersistedSession(f.ctx.sessionPersistence, call.sessionId as typeof captain.id, SIGNAL)
      const called = persisted.events.find(event => event.type === 'tool/call' && event.data.callId === call.id)
      expect(called, call.name).toBeDefined()
      const finished = persisted.events.find(event => event.type === 'tool/result' && event.sourceEventSeqs?.includes(called!.seq))
      expect(finished, call.name).toMatchObject({ data: { message: { content: [{ type: 'tool-result', toolCallId: call.id, isError: false }] } } })
    }
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)
