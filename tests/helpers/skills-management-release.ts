/** Official Agent and task lifecycle helpers for the S2 release composition. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { expect, vi } from 'vitest'
import { captainSkillsTool, SkillsManagerScriptAdapter, skillsTextChunks, type RestartMounted } from './skills-management-composition.js'
import { failureFields } from './skills-management-support.js'

export const MEMBER_ROUTE = { provider: 's2-member-fixture', model: 's2-member-model' }
export const RELEASE_PROVIDER = 'agent_swarm_skills_release'

export const requestBodies = (requests: readonly GenerateOptions[]): string => JSON.stringify(requests.map(request => request.messages))

/** Compare the exact loaded block with the official scoped registry winner.
 * Provider metadata is not rendered into ordinary skill tool content. */
export async function expectSkillInRequest(mounted: RestartMounted, member: Agent, request: GenerateOptions, expected: { name: string; provider: string; content: string }, toolCallId?: string): Promise<void> {
  const winner = await mounted.ctx.skills.get(expected.name, { scope: member, cwd: member.session.header.cwd })
  expect(winner, 'the exact member-scoped winning definition').toMatchObject(expected)
  const content = [{ type: 'text', text: renderSkillContent(winner!) }]
  if (toolCallId !== undefined) {
    const result = request.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === toolCallId)
    expect(result, 'the exact tool result entered the actual next request').toMatchObject({ type: 'tool-result', toolCallId, isError: false })
    if (result?.type !== 'tool-result') throw new Error('the actual request has no matching skill result')
    if (expected.provider === RELEASE_PROVIDER) {
      expect(result.content, 'the official body block stays exact beside any release attribution').toEqual(expect.arrayContaining(content))
    } else {
      expect(result.content, 'ordinary skill loading keeps the exact official content').toEqual(content)
    }
  } else {
    const invocation = request.messages.find(message => {
      const source = message.source as { kind?: string; name?: string } | undefined
      return source?.kind === 'skill-invocation' && source.name === expected.name
    })
    expect(invocation, 'the exact legal gesture body entered the actual request').toMatchObject({ content })
  }
}


/** Add the member, let its boot turn settle into the natural epoch, then
 *  RESUME it on the scripted route — the real cold-continuation path. */
export async function liveScriptedMember(mounted: RestartMounted, root: Agent, name: string, skills: readonly string[] | undefined, route: { provider: string; model: string } = MEMBER_ROUTE): Promise<{ member: Agent; disposeMember: () => Promise<void> }> {
  const added = await captainSkillsTool(mounted.ctx, root, `s2-add-${name}`, 'agent_swarm_add_member', {
    name, role: 'worker', ...(skills === undefined ? {} : { skills }),
  })
  expect(added.ok, `add_member must succeed, got: ${failureFields(added)}`).toBe(true)
  const sessionId = (added.value as { session_id: string }).session_id
  await vi.waitFor(async () => {
    expect(mounted.ctx.agents.get(SessionId(sessionId)), 'the settled child releases its live instance at the natural epoch').toBeUndefined()
  }, { timeout: 10_000 })
  // Registry removal precedes the old handle's durable writer release. Retry
  // only this exact public ownership refusal while that known owner settles;
  // corruption, missing Sessions and all other resume failures propagate.
  const releaseDeadline = Date.now() + 5_000
  for (;;) {
    try {
      const handle = await mounted.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { ...route } })
      return { member: handle.agent, disposeMember: async () => { await handle.dispose() } }
    } catch (error) {
      if (!(error instanceof SessionAlreadyOwnedError) || Date.now() >= releaseDeadline) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

/** Keep a real continuable Activation at its initial model boundary. Task
 * delivery must use this official owner, not an independently resumed Agent. */
export async function liveTaskMember(mounted: RestartMounted, root: Agent, name: string, skills: readonly string[], adapter: SkillsManagerScriptAdapter) {
  let releaseReady = () => {}
  const ready = new Promise<void>(resolve => { releaseReady = resolve })
  adapter.append([{ gate: ready }, ...skillsTextChunks('Ready for the assigned task.')])
  const added = await captainSkillsTool(mounted.ctx, root, `s2-add-${name}`, 'agent_swarm_add_member', {
    name, role: 'worker', skills, llm_provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model,
  })
  expect(added.ok, `continuable member admission failed: ${failureFields(added)}`).toBe(true)
  const id = SessionId((added.value as { session_id: string }).session_id)
  await vi.waitFor(() => {
    expect(mounted.ctx.agents.get(id)?.status).toBe('running')
    expect(adapter.requests.some(request => request.sessionId === id)).toBe(true)
  }, { timeout: 5_000 })
  return {
    member: mounted.ctx.agents.get(id)!, releaseReady,
    disposeMember: async () => {
      releaseReady()
      mounted.ctx.subagents.interrupt(id, { kind: 'ancestor', agent: root })
      await mounted.ctx.subagents.drainContinuableChildren(root, [id])
    },
  }
}

/** Keep fixture tasks on the official open-claim path until the member claims them. */
export async function createS2Task(ctx: RestartMounted['ctx'], captain: Agent, callId: string, subject: string): Promise<string> {
  const created = await captainSkillsTool(ctx, captain, callId, 'agent_swarm_create_task', {
    subject, description: subject, assignment_mode: 'open-claim',
  })
  expect(created.ok, `create task failed: ${failureFields(created)}`).toBe(true)
  return (created.value as { task_id: string }).task_id
}

/** Claim a real current attempt; submit its evidence only AFTER the loading proof. */
export async function claimCurrentTask(mounted: RestartMounted, member: Agent, scope: string, teamId: string, taskId: string, callId: string, evidenceRef: string): Promise<() => Promise<void>> {
  const preTask = (await mounted.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)?.tasks.find(task => task.id === taskId)
  expect(preTask, 'the official task row is readable').toBeTruthy()
  const claimed = await captainSkillsTool(mounted.ctx, member, `${callId}-claim`, 'agent_swarm_claim_task', { task_id: taskId, expected_revision: preTask!.revision })
  expect(claimed.ok, `member claim must succeed, got: ${failureFields(claimed)}`).toBe(true)
  const afterClaim = (await mounted.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)
  const task = afterClaim?.tasks.find(candidate => candidate.id === taskId)
  const attempt = afterClaim?.attempts.find(candidate => candidate.id === task?.currentAttemptId)
  expect(task).toMatchObject({ status: 'in_progress', ownerSessionId: member.id })
  expect(attempt).toMatchObject({ taskId, memberSessionId: member.id, phase: 'running' })
  return async () => {
    const current = (await mounted.ctx.agentSwarm.listTeamAggregates(scope)).find(candidate => candidate.id === teamId)?.tasks.find(candidate => candidate.id === taskId)
    expect(current, 'the exact loading attempt stays current until evidence submission').toMatchObject({ currentAttemptId: attempt!.id, ownerSessionId: member.id, status: 'in_progress' })
    const submitted = await captainSkillsTool(mounted.ctx, member, `${callId}-submit`, 'agent_swarm_submit_task', {
      task_id: taskId, attempt_id: attempt!.id, expected_revision: current!.revision,
      output: 'S2 adoption grounding delivery.', evidence: [evidenceRef],
    })
    expect(submitted.ok, `member submit must succeed, got: ${failureFields(submitted)}`).toBe(true)
  }
}

let triggerSequence = 0
export const gesture = async (member: Agent, adapter: SkillsManagerScriptAdapter, text: string, waitForIdle = true, releaseReady?: () => void): Promise<void> => {
  const start = adapter.requests.length
  const marker = `S2_REQUEST_TRIGGER_${++triggerSequence}`
  const message = createUserMessage({ content: [{ type: 'text', text: `${text}\n${marker}` }], source: { kind: 'user' } })
  if (releaseReady === undefined) member.followup(message)
  else { member.steer(message); releaseReady() }
  try {
    await vi.waitFor(() => {
      expect(requestBodies(adapter.requests.slice(start)), 'the exact followup must enter a real model request before waiting for idle').toContain(marker)
    }, { timeout: 5_000 })
  } catch (error) {
    console.error('S2 request entry failed', JSON.stringify(member.session.snapshotEvents()
      .filter(event => event.type.includes('error') || event.type === 'turn/end')
      .slice(-4).map(event => ({ type: event.type, data: event.data }))))
    throw error
  }
  if (waitForIdle) await member.whenIdle()
}

