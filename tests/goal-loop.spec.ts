/** Deterministic model adapter, actual official loops/tools and durable Team. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { Recording, setup, createTeam, addPublicMembers } from './helpers/public-chat-real-composition.js'
import { restartTool } from './helpers/restart-real-composition.js'

function results(options: GenerateOptions): Record<string, any>[] {
  return options.messages.flatMap(message => message.content).flatMap(block => block.type === 'tool-result'
    ? block.content.flatMap(part => { if (part.type !== 'text') return []; try { return [JSON.parse(part.text)] } catch { return [] } }) : [])
}
class GoalLoop extends Recording {
  captain = ''; worker = ''; captainStep = 0; workerStep = 0
  calls: { name: string; id: string; session: string }[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const json = results(options), session = options.sessionId ?? ''
    const texts = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
    const tasks = json.toReversed().find(value => Array.isArray(value.tasks))?.tasks ?? []
    const snapshot = json.toReversed().find(value => value.lifecycle?.currentTrigger !== undefined)
    let name: string | undefined, args: object = {}
    if (session === this.captain && texts.some(text => text.startsWith('The Team goal needs Captain coordination.'))) {
      if (this.captainStep === 0) { name = 'agent_swarm_get_goal'; this.captainStep++ }
      else if (this.captainStep === 1) { name = 'agent_swarm_create_task'; args = { subject: 'Goal proof', description: 'Complete the finite goal proof.', assignment_mode: 'open-claim' }; this.captainStep++ }
      else if (this.captainStep === 2) { name = 'agent_swarm_list_tasks'; this.captainStep++ }
      else if (this.captainStep === 3 && snapshot !== undefined) {
        const trigger = snapshot.lifecycle.currentTrigger
        name = 'agent_swarm_coordinate_goal'; args = { triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
          taskIds: tasks.map((task: any) => task.task_id), summary: 'One existing task covers the acceptance criterion.', outcome: 'coordinated' }; this.captainStep++
      } else if (this.captainStep === 4 && texts.some(text => text.includes('goal-loop-review'))) { name = 'agent_swarm_list_tasks'; this.captainStep++ }
      else if (this.captainStep === 5) {
        const task = tasks.find((task: any) => task.subject === 'Goal proof' && task.status === 'submitted')
        if (task !== undefined) { name = 'agent_swarm_review_task'; args = { task_id: task.task_id, expected_revision: task.revision, attempt_id: task.attempt_id,
          decision: 'accept', diagnostic: 'Deterministic artifact evidence checked.' }; this.captainStep++ }
      } else if (this.captainStep === 6) { name = 'agent_swarm_get_goal'; this.captainStep++ }
      else if (this.captainStep === 7 && snapshot !== undefined) {
        const trigger = snapshot.lifecycle.currentTrigger
        name = 'agent_swarm_coordinate_goal'; args = { triggerId: trigger.id, goalRevision: trigger.goalRevision, resultSequence: trigger.resultSequence,
          taskIds: tasks.map((task: any) => task.task_id), summary: 'Accepted task satisfies the finite goal.', outcome: 'achieved' }; this.captainStep++
      }
    } else if (session === this.worker && texts.some(text => text.startsWith('An open Team task may be available.'))) {
      if (this.workerStep === 0 || this.workerStep === 2) { name = 'agent_swarm_list_tasks'; this.workerStep++ }
      else if (this.workerStep === 1) {
        const task = tasks.find((task: any) => task.subject === 'Goal proof' && task.ready)
        if (task !== undefined) { name = 'agent_swarm_claim_task'; args = { task_id: task.task_id, expected_revision: task.revision }; this.workerStep++ }
      } else if (this.workerStep === 3) {
        const task = tasks.find((task: any) => task.subject === 'Goal proof' && task.attempt_id !== undefined)
        if (task !== undefined) { name = 'agent_swarm_submit_task'; args = { task_id: task.task_id, expected_revision: task.revision, attempt_id: task.attempt_id,
          output: 'Finite goal artifact.', evidence: ['recording://goal-proof'] }; this.workerStep++ }
      } else if (this.workerStep === 4) { name = 'agent_swarm_send_message'; args = { target: 'captain', content: 'goal-loop-review: inspect submitted work.', delivery: 'wakeup' }; this.workerStep++ }
    }
    if (name === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const id = ToolCallId(`goal-loop-${this.calls.length}`), argumentsText = JSON.stringify(args)
    this.calls.push({ name, id, session })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('runs a finite goal through actual planning, self-claim, review and explicit achievement', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-loop-')), adapter = new GoalLoop(), f = await setup(sandbox, adapter)
  try {
    const { root, captain, scope, teamId } = await createTeam(f, sandbox)
    const [worker] = await addPublicMembers(f, root, captain.id)
    adapter.captain = captain.id; adapter.worker = worker!
    const saved = await restartTool(f.ctx, root, 'goal-start', 'agent_swarm_save_goal', { team_id: teamId,
      requestId: 'finite-goal', expectedLifecycleRevision: 0, start: true,
      goal: { text: 'Produce one verified artifact.', acceptanceCriteria: 'The task is accepted with evidence.', constraints: 'Use existing members.', mode: 'finite' } })
    expect(saved.isError, JSON.stringify(saved)).toBe(false)
    expect(JSON.stringify(saved.value)).not.toMatch(/operations|contentDigest|operationFloorRevision/)
    await vi.waitFor(async () => {
      const snapshot = await f.ctx.agentSwarm.goals.snapshot(scope, teamId)
      expect(snapshot.lifecycle?.phase, JSON.stringify(adapter.calls)).toBe('achieved')
    }, { timeout: 20_000 })
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(team.tasks).toHaveLength(1)
    expect(team.tasks[0]).toMatchObject({ status: 'completed', submittedBySessionId: worker, reviewedBySessionId: captain.id })
    expect(team.goalLifecycle).toMatchObject({ phase: 'achieved', resultSequence: 1, coordinatedResultSequence: 1 })
    expect(team.goalLifecycle?.completion?.taskIds).toEqual([team.tasks[0]!.id])
    expect(team.messages.filter(message => message.kind === 'goal-coordination-notice')).toHaveLength(2)
    expect(adapter.calls.filter(call => call.name === 'agent_swarm_coordinate_goal')).toHaveLength(2)
    expect(team.phase).toBe('active')
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)
