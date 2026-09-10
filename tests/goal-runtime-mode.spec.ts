import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { mountModesComposition, toolCall } from './helpers/modes-composition.js'

it('workflow-only configuration permits goal save/read/pause while rejecting autonomous start/resume', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-mode-'))
  const f = await mountModesComposition(sandbox, { orchestrationMode: 'workflow', workflowBridge: true })
  try {
    const created = await toolCall(f.ctx, f.lead, 'mode-create', 'agent_swarm_create', { name: 'Workflow goal', description: 'Editable with explicit capability limits.' })
    expect(created.isError, JSON.stringify(created)).toBe(false)
    const saved = await toolCall(f.ctx, f.lead, 'mode-save', 'agent_swarm_save_goal', { requestId: 'mode-save', expectedLifecycleRevision: 0, start: false,
      goal: { text: 'Editable goal', acceptanceCriteria: 'Explicit accepted work', constraints: '', mode: 'finite' } })
    expect(saved.isError, JSON.stringify(saved)).toBe(false)
    expect(saved.value).toMatchObject({ snapshot: { eligibility: { state: 'available' }, waitingReason: 'unsupported', lifecycle: { phase: 'draft', revision: 1 } } })
    const started = await toolCall(f.ctx, f.lead, 'mode-start', 'agent_swarm_control_goal', { requestId: 'mode-start', expectedLifecycleRevision: 1, action: 'start' })
    expect(started.isError).toBe(true)
    expect(JSON.stringify(started.error)).toContain('TEAM_GOAL_UNSUPPORTED')
    const paused = await toolCall(f.ctx, f.lead, 'mode-pause', 'agent_swarm_control_goal', { requestId: 'mode-pause', expectedLifecycleRevision: 1, action: 'pause' })
    expect(paused.isError, JSON.stringify(paused)).toBe(false)
    expect(paused.value).toMatchObject({ snapshot: { eligibility: { state: 'available' }, lifecycle: { phase: 'paused', revision: 2 } } })
    const resumed = await toolCall(f.ctx, f.lead, 'mode-resume', 'agent_swarm_control_goal', { requestId: 'mode-resume', expectedLifecycleRevision: 2, action: 'resume' })
    expect(resumed.isError).toBe(true)
    expect(JSON.stringify(resumed.error)).toContain('TEAM_GOAL_UNSUPPORTED')
    const read = await toolCall(f.ctx, f.lead, 'mode-read', 'agent_swarm_get_goal', {})
    expect(read.value).toMatchObject({ text: 'Editable goal', eligibility: { state: 'available' }, lifecycle: { phase: 'paused', revision: 2 } })
    expect(f.adapter.requests).toHaveLength(0)
  } finally {
    f.adapter.open(); for (const fiber of f.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
