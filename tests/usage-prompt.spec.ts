import { describe, expect, it } from 'vitest'
import { AGENT_SWARM_USAGE_PROMPT } from '../src/runtime/usage-prompt.js'

describe('Team usage prompt supervision discipline', () => {
  it('forbids treating wait-call count or silence as stall evidence before interruption', () => {
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('Never infer a stall from silence alone or from a count of wait calls')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('send one wakeup probe before interrupting')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('its return count is not elapsed time')
    expect(AGENT_SWARM_USAGE_PROMPT).toContain('not evidence that a member is stalled')
  })
})
