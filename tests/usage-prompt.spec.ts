import { describe, expect, it } from 'vitest'
import { AGENT_SWARM_USAGE_PROMPT } from '../src/runtime/usage-prompt.js'

describe('Team usage prompt supervision discipline', () => {
  it('forbids progress-based and batch interruption of quiet workers', () => {
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('Never interrupt for silence')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('model-written evidence cannot authorize it')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('Direct-user stops use authenticated Human Control')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('never batch-reset quiet workers')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('its return count is not elapsed time')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('not evidence that a member is stalled')
  })
})
