import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGNAL, mountNodeComposition } from './helpers/node-composition.js'

describe('issue #148: official continuable session labels', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('uses readable Team and member identities, with the internal name only as a fallback', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-label-'))
    roots.push(sandbox)
    const stack = await mountNodeComposition(sandbox)
    const start = vi.spyOn(stack.ctx.subagents, 'startContinuable')
    try {
      const created = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('label-create'),
        name: 'agent_swarm_create',
        arguments: { name: 'Label Team', description: 'Prove the official session-list label.' },
        agent: stack.lead,
      })
      expect(created.isError).toBe(false)

      const withDisplay = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('label-add-display'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'worker-internal', role: 'Reader', display_name: 'Worker Readable' },
        agent: stack.lead,
      })
      const withoutDisplay = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('label-add-plain'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'plain-worker', role: 'Reader' },
        agent: stack.lead,
      })
      expect(withDisplay.isError).toBe(false)
      expect(withoutDisplay.isError).toBe(false)

      const labels = start.mock.calls.map(call => (call[0] as { label: string }).label)
      expect(labels).toContain('Label Team · Worker Readable')
      expect(labels).toContain('Label Team · plain-worker')
      expect(labels.some(label => label.startsWith('agent-swarm:'))).toBe(false)
    } finally {
      start.mockRestore()
      for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
