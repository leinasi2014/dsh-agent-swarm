import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { addMember, mount, snapshotOf, toolCall } from './helpers/gated-composition.js'
import { openStorageStack, unitFilePath } from './helpers/storage-stack.js'
import { TeamId } from '../src/domain/types.js'

it('real add/list tools share sanitized Captain/member memory and durable reopen, with private memory unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-admission-tools-'))
  const composition = await mount(root, 60_000)
  const { ctx, lead } = composition
  try {
    const memberId = await addMember(composition, 'memory-worker')
    const member = ctx.agents.get(SessionId(memberId))!
    expect(member).toBeDefined()
    const added = await toolCall(ctx, lead, 'memory-captain', 'agent_swarm_add_memory', {
      category: 'decision', content: 'Authorization: Bearer synthetic-tool-bearer',
      evidence_refs: ['密码：合成工具引用', 'synthetic-tool@example.test'],
    })
    expect(added.isError).toBe(false)
    expect(added.value).toEqual({ memory_id: 'memory-1', category: 'decision' })
    const peer = await toolCall(ctx, member, 'memory-member', 'agent_swarm_add_memory', {
      category: 'lesson', content: 'Safe member lesson', evidence_refs: ['API key: synthetic-member-ref'],
    })
    expect(peer.isError).toBe(false)
    const listed = await toolCall(ctx, member, 'memory-list', 'agent_swarm_list_memory', {})
    expect(listed.isError).toBe(false)
    expect(listed.value).toMatchObject({ memories: [
      { memory_id: 'memory-1', content: 'Authorization: Bearer [REDACTED]', evidence_refs: ['密码：[REDACTED]', '[REDACTED]'] },
      { memory_id: 'memory-2', content: 'Safe member lesson', evidence_refs: ['API key: [REDACTED]'] },
    ] })
    const sharedBeforePrivate = (await snapshotOf(composition)).team.memory
    const privateWrite = await toolCall(ctx, member, 'private-add', 'agent_swarm_add_private_memory', {
      content: 'password=synthetic-private-kept',
    })
    expect(privateWrite.isError).toBe(false)
    const privateList = await toolCall(ctx, member, 'private-list', 'agent_swarm_list_private_memory', {})
    expect(privateList.value).toMatchObject({ memories: [{ content: 'password=synthetic-private-kept' }] })
    expect((await snapshotOf(composition)).team.memory).toEqual(sharedBeforePrivate)
    const json = await readFile(unitFilePath(join(root, 'storage')), 'utf8')
    for (const forbidden of ['synthetic-tool-bearer', '合成工具引用', 'synthetic-tool@example.test', 'synthetic-member-ref', 'synthetic-private-kept']) {
      expect(json).not.toContain(forbidden)
      expect(JSON.stringify(listed.value)).not.toContain(forbidden)
    }
    await composition.pluginFiber.dispose()
    const reopened = await openStorageStack(join(root, 'storage'))
    try {
      const team = (await reopened.port.snapshot(composition.scope, TeamId(composition.teamId), lead.id)).team
      expect(team.memory).toEqual(sharedBeforePrivate)
    } finally { await reopened.close() }
  } finally {
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
