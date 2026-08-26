import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { disposeRestartComposition, mountRestartComposition, RESTART_SIGNAL, restartSnapshot, restartTool, type RestartMounted } from './helpers/restart-real-composition.js'

const CAPTAIN = SessionId('restart-state-matrix-captain')

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message'
    ? event.data.content.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text').map(block => block.text)
    : [])
}

class CountMemberTurns extends LlmAdapter {
  memberId: string | undefined
  memberRequests = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === this.memberId) this.memberRequests += 1
    for (const chunk of textResponse('Restart state-matrix checkpoint.')) yield chunk
  }
}

async function createTeamAndMember(mounted: RestartMounted, sandbox: string, label: string): Promise<{ lead: Agent; teamId: string; memberId: string }> {
  const lead = mounted.ctx.agentLoop.create(CAPTAIN, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
  const created = await restartTool(mounted.ctx, lead, `${label}-create`, 'agent_swarm_create', { name: `Restart ${label}`, description: 'Exercise one durable restart state.' })
  if (created.isError) throw new Error(`Team creation failed: ${JSON.stringify(created.error)}`)
  const added = await restartTool(mounted.ctx, lead, `${label}-member`, 'agent_swarm_add_member', { name: 'worker', role: 'Own one fenced restart attempt.' })
  if (added.isError) throw new Error(`Member creation failed: ${JSON.stringify(added.error)}`)
  return { lead, teamId: (created.value as { team_id: string }).team_id, memberId: (added.value as { session_id: string }).session_id }
}

describe('restart continuation state matrix over one Team authority', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

  it('reopens one reserved assignment debt exactly once without reseating its attempt', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-restart-reserved-'))
    roots.push(sandbox)
    let first: RestartMounted | undefined
    let second: RestartMounted | undefined
    try {
      first = await mountRestartComposition(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new CountMemberTurns())
      const { lead: leadA, teamId, memberId } = await createTeamAndMember(first, sandbox, 'reserved')
      const scope = first.ctx.agentSwarm.scopeOf(leadA)
      const task = await first.ctx.agentSwarm.domain.createTask(scope, AgentSwarm.TeamId(teamId), leadA.id, {
        subject: 'Reserved delivery survives restart', description: 'No successor attempt may be seated.', targetMemberSessionId: memberId,
      })
      const claim = await first.ctx.agentSwarm.domain.claimTask(scope, AgentSwarm.TeamId(teamId), leadA.id, task.id, task.revision, SessionId(memberId))
      expect(claim.attempt).toMatchObject({ phase: 'running', assignmentPhase: 'reserved', generation: 1, memberSessionId: memberId })
      const frozen = { taskId: task.id, revision: claim.task.revision, attemptId: claim.attempt.id, generation: claim.attempt.generation }
      await disposeRestartComposition(first)
      first = undefined

      second = await mountRestartComposition(sandbox, 50)
      const adapter = new CountMemberTurns(); adapter.memberId = memberId
      second.ctx.llm.registerAdapter(['mock'], adapter)
      const resumed = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      const rawFollowup = second.ctx.subagents.followup.bind(second.ctx.subagents)
      const follows: string[] = []
      const followup = vi.spyOn(second.ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        if (String(childId) === memberId) follows.push(content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
        return await rawFollowup(parent, childId, content, options)
      })
      try {
        await second.ctx.agentSwarm.recoverAgent(resumed.agent)
        await vi.waitFor(async () => {
          const reopened = await restartSnapshot(second!.ctx, resumed.agent, teamId)
          expect(reopened.team.tasks.find(candidate => candidate.id === frozen.taskId)).toMatchObject({ status: 'in_progress', revision: frozen.revision, currentAttemptId: frozen.attemptId, ownerSessionId: memberId })
          expect(reopened.team.attempts.find(candidate => candidate.id === frozen.attemptId)).toMatchObject({ phase: 'running', assignmentPhase: 'delivered', generation: frozen.generation, memberSessionId: memberId })
          expect(reopened.team.attempts).toHaveLength(1)
          expect(adapter.memberRequests).toBe(1)
        }, { timeout: 15_000 })
        await second.ctx.agentSwarm.recoverAgent(resumed.agent)
        await new Promise(resolve => setTimeout(resolve, 150))
        expect(follows.filter(text => text.includes('Team assignment from captain.'))).toHaveLength(1)
        expect(adapter.memberRequests).toBe(1)
        const persisted = await second.ctx.sessionPersistence.inspect(SessionId(memberId), RESTART_SIGNAL)
        expect(userTexts(persisted.events).filter(text => text.includes('Team assignment from captain.'))).toHaveLength(1)
      } finally {
        followup.mockRestore()
        await resumed.dispose()
      }
    } finally {
      if (first !== undefined) await disposeRestartComposition(first)
      if (second !== undefined) await disposeRestartComposition(second)
    }
  }, 60_000)

  it('keeps a submitted attempt cold and settles it only through a post-restart Captain review', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-restart-submitted-'))
    roots.push(sandbox)
    let first: RestartMounted | undefined
    let second: RestartMounted | undefined
    try {
      first = await mountRestartComposition(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new CountMemberTurns())
      const { lead: leadA, teamId, memberId } = await createTeamAndMember(first, sandbox, 'submitted')
      const scope = first.ctx.agentSwarm.scopeOf(leadA)
      const created = await first.ctx.agentSwarm.domain.createTask(scope, AgentSwarm.TeamId(teamId), leadA.id, {
        subject: 'Submitted review survives restart', description: 'Captain alone may settle the frozen attempt.', targetMemberSessionId: memberId,
      })
      const claim = await first.ctx.agentSwarm.domain.claimTask(scope, AgentSwarm.TeamId(teamId), leadA.id, created.id, created.revision, SessionId(memberId))
      await first.ctx.agentSwarm.domain.acknowledgeAssignment(scope, AgentSwarm.TeamId(teamId), created.id, claim.attempt.id)
      const submitted = await first.ctx.agentSwarm.domain.submitTask(scope, AgentSwarm.TeamId(teamId), SessionId(memberId), created.id, claim.task.revision, claim.attempt.id, 'Durable submission before restart.', ['restart-state-matrix'])
      const frozen = { taskId: submitted.id, revision: submitted.revision, attemptId: claim.attempt.id, generation: claim.attempt.generation }
      await disposeRestartComposition(first)
      first = undefined

      second = await mountRestartComposition(sandbox, 50)
      const adapter = new CountMemberTurns(); adapter.memberId = memberId
      second.ctx.llm.registerAdapter(['mock'], adapter)
      const resumed = await second.ctx.agents.resume({ resumeSessionId: CAPTAIN })
      const followup = vi.spyOn(second.ctx.subagents, 'followup')
      try {
        await second.ctx.agentSwarm.recoverAgent(resumed.agent)
        await new Promise(resolve => setTimeout(resolve, 150))
        await second.ctx.agentSwarm.recoverAgent(resumed.agent)
        const cold = await restartSnapshot(second.ctx, resumed.agent, teamId)
        expect(cold.team.tasks.find(task => task.id === frozen.taskId)).toMatchObject({ status: 'submitted', revision: frozen.revision, currentAttemptId: frozen.attemptId, ownerSessionId: memberId })
        expect(cold.team.attempts.find(attempt => attempt.id === frozen.attemptId)).toMatchObject({ phase: 'submitted', generation: frozen.generation })
        expect(cold.team.attempts).toHaveLength(1)
        expect(second.ctx.agents.get(SessionId(memberId))).toBeUndefined()
        expect(adapter.memberRequests).toBe(0)
        expect(followup).not.toHaveBeenCalled()
        const review = await restartTool(second.ctx, resumed.agent, 'submitted-review', 'agent_swarm_review_task', {
          task_id: frozen.taskId, expected_revision: frozen.revision, attempt_id: frozen.attemptId, decision: 'accept',
        })
        expect(review).toMatchObject({ isError: false, value: { status: 'completed', decision: 'accept' } })
        const settled = await restartSnapshot(second.ctx, resumed.agent, teamId)
        expect(settled.team.tasks.find(task => task.id === frozen.taskId)).toMatchObject({ status: 'completed', currentAttemptId: frozen.attemptId })
        expect(settled.team.attempts).toEqual([expect.objectContaining({ id: frozen.attemptId, generation: frozen.generation, phase: 'accepted' })])
      } finally {
        followup.mockRestore()
        await resumed.dispose()
      }
    } finally {
      if (first !== undefined) await disposeRestartComposition(first)
      if (second !== undefined) await disposeRestartComposition(second)
    }
  }, 60_000)
})
