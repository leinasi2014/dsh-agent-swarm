import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { expect, it, vi } from 'vitest'
import {
  disposeRestartComposition as dispose, mountRestartComposition,
  restartSnapshot as snapshot, restartTool as tool, type RestartMounted,
} from './helpers/restart-real-composition.js'

class IdleAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mount(sandbox: string): Promise<RestartMounted> {
  const mounted = await mountRestartComposition(sandbox, 60_000, ['alpha', 'beta'])
  mounted.fibers.push(await mounted.ctx.plugin(SkillRegistry))
  mounted.fibers.push(await mounted.ctx.plugin(ToolSkill))
  for (const name of ['alpha', 'beta']) mounted.ctx.skills.register({ name, description: name, content: name, source: 'runtime' })
  mounted.ctx.llm.registerAdapter(['mock'], new IdleAdapter())
  return mounted
}

it('restores the member subset from disk across two complete Contexts and enforces it on an officially resumed child (#184 A3)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-assigned-skills-restart-'))
  const captainId = SessionId('assigned-skills-restart-captain')
  let first: RestartMounted | undefined
  let second: RestartMounted | undefined
  try {
    first = await mount(sandbox)
    const leadA = first.ctx.agentLoop.create(captainId, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
    const created = await tool(first.ctx, leadA, 'create', 'agent_swarm_create', { name: 'Skill recovery', description: 'Persist the assigned subset.' })
    expect(created.isError).toBe(false)
    const teamId = (created.value as { team_id: string }).team_id
    const added = await tool(first.ctx, leadA, 'add', 'agent_swarm_add_member', { name: 'worker', role: 'worker', skills: ['alpha'] })
    expect(added.isError).toBe(false)
    const childId = SessionId((added.value as { session_id: string }).session_id)
    await vi.waitFor(async () => {
      const stored = await first!.ctx.sessionPersistence.inspect(childId)
      expect(stored.events.some(event => event.type === 'turn/end')).toBe(true)
    })
    await first.ctx.subagents.drainContinuableChildren(leadA, [childId])
    expect(first.ctx.agents.get(childId)).toBeUndefined()
    await dispose(first)
    first = undefined

    // Only durable SQLite / Storage roots cross this boundary. No manual
    // rememberTeam/rememberChild call can hide a broken recovery path.
    second = await mount(sandbox)
    expect(second.ctx.agents.get(childId)).toBeUndefined()
    const captain = await second.ctx.agents.resume({ resumeSessionId: captainId })
    try {
      const restored = await snapshot(second.ctx, captain.agent, teamId)
      expect(restored.team.allowedSkills).toEqual(['alpha', 'beta'])
      expect(restored.team.members.find(member => member.sessionId === childId)?.assignedSkills).toEqual(['alpha'])
      let child: Agent | undefined
      const stop = second.ctx.on('agent/created', ({ agent }) => { if (agent.id === childId) child = agent })
      try {
        const woke = await tool(second.ctx, captain.agent, 'wake', 'agent_swarm_send_message', { target: 'worker', content: 'Resume with your persisted Skill policy.', delivery: 'wakeup' })
        expect(woke.isError).toBe(false)
        await vi.waitFor(() => expect(child).toBeDefined())
        await child!.whenIdle()
        const allowed = await tool(second.ctx, child!, 'alpha', 'skill', { name: 'alpha' })
        expect(allowed.isError).toBe(false)
        expect((allowed.value as { name: string }).name).toBe('alpha')
        const denied = await tool(second.ctx, child!, 'beta', 'skill', { name: 'beta' })
        expect(denied.isError).toBe(true)
        expect((denied.error as { message: string }).message).toContain('not allowed')
      } finally { stop() }
    } finally { await captain.dispose() }
  } finally {
    if (first !== undefined) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true })
  }
}, 30_000)
