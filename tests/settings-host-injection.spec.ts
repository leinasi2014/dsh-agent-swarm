import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('agent-swarm settings composition', () => {
  it('always delegates namespace registration to the official optional-settings helper', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/installSettingsSection\(ctx, AGENT_SWARM_SETTINGS_NAMESPACE, Config, config/u)
    expect(source).not.toMatch(/ctx\.get\('settings'\) !== undefined/u)
  })
})
