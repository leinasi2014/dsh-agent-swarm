import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { mountNodeComposition, SIGNAL } from './helpers/node-composition.js'

it('materializes the parent before concurrent child admission, and leaves no child on checkpoint failure', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-parent-checkpoint-'))
  const mounted = await mountNodeComposition(sandbox)
  const { ctx, lead } = mounted
  const start = ctx.subagents.startContinuable.bind(ctx.subagents)
  const calls = vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async options => {
    // A child must never become durable ahead of its own resumable parent.
    const parent = await readPersistedSession(ctx.sessionPersistence, lead.id)
    expect(parent.meta.id).toBe(lead.id)
    return await start(options)
  })
  try {
    const created = await ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('parent-create'), name: 'agent_swarm_create',
      arguments: { name: 'Parent durability', description: 'Verify canonical lineage before child admission.' }, agent: lead })
    expect(created.isError).toBe(false)
    const checkpoint = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('checkpoint unavailable'))
    const failed = await ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('parent-failed'), name: 'agent_swarm_add_member',
      arguments: { name: 'failed-before-admission', role: 'Must not exist.' }, agent: lead })
    expect(failed.isError).toBe(true)
    expect(calls).not.toHaveBeenCalled()
    const roster = await ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('parent-roster'), name: 'agent_swarm_list_members', arguments: {}, agent: lead })
    expect(roster).toMatchObject({ isError: false, value: { members: [] } })
    checkpoint.mockRestore()
    const admitted = await Promise.all(Array.from({ length: 5 }, (_value, index) => ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId(`parent-child-${index}`), name: 'agent_swarm_add_member',
      arguments: { name: `worker-${index}`, role: 'Check concurrent admission.' }, agent: lead,
    })))
    expect(admitted.every(result => !result.isError)).toBe(true)
    expect(calls).toHaveBeenCalledTimes(5)
  } finally {
    calls.mockRestore()
    mounted.adapter.open()
    for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
