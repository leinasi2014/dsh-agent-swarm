// Regression: dsh-agent-swarm install activates the Team group by default.
//
// task-1 found that a clean official Profile assembled via `dsh plugin add`
// contributed a DEFAULT-DISABLED `agent-swarm` structural group, so the host
// read RPC (/swarm/v1) was never mounted and the Team UI surface never
// appeared (0 [data-swarm*] elements, selection invalid, read-failed). task-2
// migrated the Bundle to an ENABLED-BY-DEFAULT contract.
//
// This spec is an assembly/component contract test over the real shipped
// Bundle artifact (cordis.patch.yml): it asserts the group ships enabled,
// the runtime child is enabled, and that merely enabling registers runtime/UI
// without auto-creating a Team/member/task (activation, not side effects).
// It reads the repository artifact directly (no mock-only projection).
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const PATCH_URL = new URL('../cordis.patch.yml', import.meta.url)

describe('agent-swarm install contract (enabled-by-default regression)', () => {
  it('ships the structural group enabled by default (disabled:false) in the Bundle artifact', async () => {
    const yaml = await readFile(PATCH_URL, 'utf8')
    expect(yaml).toContain('disabled: false')
    expect(yaml).not.toContain('disabled: true')
    expect(yaml).toMatch(/^    - id: agent-swarm$/m)
    expect(yaml).toMatch(/^      name: cordis:group$/m)
    expect(yaml).toMatch(/^      group: true$/m)
  })

  it('declares the enabled runtime child with the bounded default scheduler/review contract', async () => {
    const yaml = await readFile(PATCH_URL, 'utf8')
    expect(yaml).toContain('id: agent-swarm-runtime')
    expect(yaml).toContain('name: dsh-agent-swarm')
    expect(yaml).toContain('enabled: true')
    expect(yaml).toContain('memberProvider: spawn')
    expect(yaml).toContain('memberMaxDepth: 1')
    expect(yaml).toContain('schedulerProvider: priority-ready')
    expect(yaml).toContain('reviewProvider: manual')
  })

  it('registers activation without emitting any auto-create side effect (no Team/member/task provisioning in Bundle)', async () => {
    const yaml = await readFile(PATCH_URL, 'utf8')
    // The patch contributes only registration/configuration rows; it must not
    // fabricate Team/member/task instances or write-side tool wiring.
    expect(yaml).not.toMatch(/agent_swarm_create/i)
    expect(yaml).not.toMatch(/provisioning|spawnMember|createTeam/i)
    expect(yaml).toMatch(/never auto-creates a Team/i)
  })
})
