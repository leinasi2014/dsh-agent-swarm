/**
 * Issue #186: the plugin-wide tool policy must fail fast when an operator
 * declares a DENY or ASK tier for a mandatory member-protocol tool
 * (`agent_swarm_submit_task`, `agent_swarm_send_message`). A global deny/ask
 * of a protocol tool would strip every delegated member of the surface it
 * needs to submit results and message the captain, so it must be rejected
 * by `assertServiceableConfig` BEFORE any runtime, storage or listener side
 * effect is created (apply() calls it before runtime.start()).
 *
 * These tests are RED on the current base: `effectiveToolPolicy` merges the
 * declaration monotonically but never rejects a protocol tool in deny/ask, so
 * `assertServiceableConfig` currently completes without throwing.
 */
import { describe, expect, it } from 'vitest'
import { assertServiceableConfig, type Config } from '../src/plugin/config.js'

function config(toolPolicy: { allow?: string[]; ask?: string[]; deny?: string[] }): Config {
  return { toolPolicy }
}

describe('assertServiceableConfig global toolPolicy protocol-floor guard (issue #186)', () => {
  it('rejects a global toolPolicy deny containing a mandatory member-protocol tool', () => {
    expect(() => assertServiceableConfig(config({ deny: ['agent_swarm_submit_task'] }))).toThrow()
    expect(() => assertServiceableConfig(config({ deny: ['agent_swarm_send_message'] }))).toThrow()
  })

  it('rejects a global toolPolicy ask containing a mandatory member-protocol tool', () => {
    expect(() => assertServiceableConfig(config({ ask: ['agent_swarm_submit_task'] }))).toThrow()
    expect(() => assertServiceableConfig(config({ ask: ['agent_swarm_send_message'] }))).toThrow()
  })

  it('still accepts a global toolPolicy deny of an ordinary tool (issue #186 regression guard)', () => {
    expect(() => assertServiceableConfig(config({ deny: ['bash'] }))).not.toThrow()
    expect(() => assertServiceableConfig(config({ deny: ['bash'], ask: ['ls'] }))).not.toThrow()
  })
})
