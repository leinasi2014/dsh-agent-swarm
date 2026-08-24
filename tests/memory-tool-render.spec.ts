import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, toolCall } from './helpers/gated-composition.js'

describe('memory tool model output', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('renders the authorized memory content instead of only a record count', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-memory-render-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, lead, fibers, adapter, pluginFiber } = composition
    try {
      const marker = 'CATSHOP_MEMORY_MARKER'
      const added = await toolCall(ctx, lead, 'memory-add', 'agent_swarm_add_memory', {
        category: 'decision', content: marker,
        evidence_refs: Array.from({ length: 10 }, (_, index) => `${index}-${'x'.repeat(600)}`),
      })
      expect(added.isError).toBe(false)

      const listed = await toolCall(ctx, lead, 'memory-list', 'agent_swarm_list_memory', {
        scope: 'team', limit: 8,
      })
      expect(listed.isError).toBe(false)
      const block = listed.content[0]
      expect(block?.type).toBe('text')
      if (block?.type !== 'text') throw new Error('memory tool did not return a text block')
      expect(block.text).toContain(marker)
      const rendered = JSON.parse(block.text) as { entries: Array<{ evidence_refs: string[]; evidence_refs_truncated?: boolean }> }
      expect(rendered.entries[0]?.evidence_refs).toHaveLength(8)
      expect(rendered.entries[0]?.evidence_refs.every(reference => [...reference].length <= 512)).toBe(true)
      expect(rendered.entries[0]?.evidence_refs_truncated).toBe(true)

      const oversized = await toolCall(ctx, lead, 'memory-list-oversized', 'agent_swarm_list_memory', {
        scope: 'team', limit: 9,
      })
      expect(oversized).toMatchObject({ isError: true, error: { message: 'limit must be a safe integer from 1 to 8' } })
    } finally {
      adapter.open()
      await pluginFiber.dispose()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
