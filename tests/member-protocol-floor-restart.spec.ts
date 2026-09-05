/**
 * Issue #186: a cold-resumed member must keep the member-protocol floor
 * non-deniable across a true two-Context reopen. The floor tools
 * (agent_swarm_submit_task, agent_swarm_send_message) are the surface a
 * member needs to submit results and message the captain; they must never be
 * in the composed deny/toolFilter, not even after the real restart
 * composition reopens the durable SQLite / Storage roots and resumes a cold
 * member from its stored descriptor.
 *
 * This uses the REAL restart composition helper (restart-real-composition.ts):
 * the second Context opens only the same durable roots, and the member is
 * recovered cold from the persisted descriptor — not from a re-provisioned
 * in-memory policy, so the invariant cannot be fabricated by a self-equality
 * (memberToolDeny(x) === memberToolDeny(x)).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { expect, it, vi } from 'vitest'
import {
  disposeRestartComposition as dispose, mountRestartComposition,
  restartTool as tool, type RestartMounted,
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
  const mounted = await mountRestartComposition(sandbox, 60_000)
  mounted.ctx.llm.registerAdapter(['mock'], new IdleAdapter())
  return mounted
}

async function durableToolFilter(ctx: RestartMounted['ctx'], childId: string): Promise<{ deny?: readonly string[] } | undefined> {
  const stored = await ctx.sessionPersistence.inspect(SessionId(childId))
  const suffix = stored.events.slice(stored.meta.seedLength ?? 0)
  const descriptor = foldSubagentDescriptor(suffix)
  // Only the continuable descriptor variant carries the durable toolFilter.
  if (descriptor?.mode !== 'continuable') return undefined
  return descriptor.toolFilter
}

it('keeps the member-protocol floor non-deniable for a cold-resumed member across two real Contexts (issue #186)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-member-protocol-floor-restart-'))
  const captainId = SessionId('member-protocol-floor-captain')
  let first: RestartMounted | undefined
  let second: RestartMounted | undefined
  try {
    first = await mount(sandbox)
    const leadA = first.ctx.agentLoop.create(captainId, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
    const created = await tool(first.ctx, leadA, 'create', 'agent_swarm_create', { name: 'Protocol floor restart', description: 'Persist the member-protocol floor.' })
    expect(created.isError).toBe(false)
    const added = await tool(first.ctx, leadA, 'add', 'agent_swarm_add_member', { name: 'worker', role: 'worker', deny_tools: ['agent_swarm_status'] })
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

    // Only durable SQLite / Storage roots cross this boundary, exactly like
    // the #184 cold-restart proof: no in-memory policy can be re-injected.
    second = await mount(sandbox)
    expect(second.ctx.agents.get(childId)).toBeUndefined()
    const captain = await second.ctx.agents.resume({ resumeSessionId: captainId })
    try {
      let child: Agent | undefined
      const stop = second.ctx.on('agent/created', ({ agent }) => { if (agent.id === childId) child = agent })
      try {
        const woke = await tool(second.ctx, captain.agent, 'wake', 'agent_swarm_send_message', { target: 'worker', content: 'Resume with your persisted member-protocol floor.', delivery: 'wakeup' })
        expect(woke.isError).toBe(false)
        await vi.waitFor(() => expect(child).toBeDefined())
        await child!.whenIdle()
        const filter = await durableToolFilter(second.ctx, childId.toString())
        // The ordinary tool deny survives the cold resume...
        expect(filter?.deny).toContain('agent_swarm_status')
        // ...while the member-protocol floor is never denied in the actual
        // composed deny/toolFilter, so the member can still submit and message.
        expect(filter?.deny).not.toContain('agent_swarm_submit_task')
        expect(filter?.deny).not.toContain('agent_swarm_send_message')
      } finally { stop() }
    } finally { await captain.dispose() }
  } finally {
    if (first !== undefined) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true })
  }
}, 30_000)