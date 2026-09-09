import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGNAL, mountNodeComposition } from './helpers/node-composition.js'

describe('issue #148: official continuable session labels', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('keeps official labels as creation facts while members choose their public names', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-label-'))
    roots.push(sandbox)
    const stack = await mountNodeComposition(sandbox)
    const start = vi.spyOn(stack.ctx.subagents, 'startContinuable')
    try {
      const created = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: ToolCallId('label-create'),
        name: 'agent_swarm_create',
        arguments: { name: 'Label Team', description: 'Prove the official session-list label.' },
        agent: stack.lead,
      })
      expect(created.isError).toBe(false)

      const withDisplay = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: ToolCallId('label-add-display'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'worker-internal', role: 'Reader' },
        agent: stack.lead,
      })
      const withoutDisplay = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: ToolCallId('label-add-plain'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'plain-worker', role: 'Reader' },
        agent: stack.lead,
      })
      expect(withDisplay.isError).toBe(false)
      expect(withoutDisplay.isError).toBe(false)

      const labels = start.mock.calls.map(call => (call[0] as { label: string }).label)
      expect(labels).toContain('Label Team · worker-internal')
      const member = stack.ctx.agents.get(SessionId((withDisplay.value as { session_id: string }).session_id))!
      const membership = await stack.domain.requireMembership(stack.scope, member.id)
      const chosen = await stack.ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('self-name'), name: 'agent_swarm_set_member_profile', agent: member,
        arguments: { name: 'worker-internal', expected_revision: membership.team.revision, display_name: 'Worker Readable' } })
      expect(chosen.isError).toBe(false)
      expect((await stack.domain.requireMembership(stack.scope, member.id)).team.members[0]?.displayName).toBe('Worker Readable')
      expect(start.mock.calls[0]?.[0].label).toBe('Label Team · worker-internal')
      expect(labels).toContain('Label Team · plain-worker')
      expect(labels.some(label => label.startsWith('agent-swarm:'))).toBe(false)
    } finally {
      start.mockRestore()
      for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
