/** Complete, metadata-only Skill directory for the Agent Swarm settings surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'

const ROOT = { id: 'root-session', session: { header: { cwd: 'D:\\workspace' } } } as unknown as Agent

function skillCatalogHarness() {
  const skillRegistry = {
    snapshot: vi.fn(async () => ({
      complete: true,
      skills: [
        { name: 'model-only', description: 'Model route', whenToUse: 'During work', invocation: { modelInvocable: true, userInvocable: false } },
        { name: 'user-only', description: 'Human command', invocation: { modelInvocable: false, userInvocable: true } },
      ],
    })),
  }
  const ctx = {
    get: (name: string) => name === 'skills' ? skillRegistry : undefined,
    agents: { get: (id: string) => id === ROOT.id ? ROOT : undefined },
    sessions: { get: (id: string) => id === ROOT.id ? ROOT.session : undefined },
  } as unknown as Context
  const service = new AgentSwarmReadRpcService({
    ctx,
    runtime: {} as AgentSwarmRuntime,
    hostRead: { withTargetRead: async <T>(operation: () => Promise<T>) => await operation() } as AgentSwarmHostReadService,
    webServer: { host: '127.0.0.1', port: 8279, register: () => () => {} },
  })
  return { service, skillRegistry }
}

describe('R2 complete model Skill catalog', () => {
  it('lists the exact live Session model-invocable metadata without bodies or paths', async () => {
    const harness = skillCatalogHarness()
    await expect(harness.service.invoke({
      schemaVersion: 1, method: 'skillCatalog', target: { rootSessionId: ROOT.id },
    })).resolves.toEqual({
      schemaVersion: 1,
      binding: { rootSessionId: ROOT.id },
      complete: true,
      skills: [{ name: 'model-only', description: 'Model route', whenToUse: 'During work', modelInvocable: true }],
      observedAt: expect.any(Number),
    })
    expect(harness.skillRegistry.snapshot).toHaveBeenCalledWith({
      cwd: ROOT.session.header.cwd,
      scope: ROOT,
      signal: expect.any(AbortSignal),
    })
    await expect(harness.service.invoke({
      schemaVersion: 1, method: 'skillCatalog', target: { rootSessionId: 'missing' },
    })).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
  })
})
