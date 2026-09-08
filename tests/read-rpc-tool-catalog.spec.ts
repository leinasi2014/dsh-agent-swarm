/** Exact live Session tool metadata discovery for permission settings. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import type { SwarmReadToolCatalogV1 } from '../src/rpc/read-rpc-contract.js'
import type { AgentSwarmHostReadService } from '../src/host/host-read-service.js'
import type { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { AgentSwarmReadRpcService } from '../src/rpc/read-rpc-service.js'

function harness(registry?: Context['tools']) {
  const root = { id: 'root', session: { header: { cwd: 'D:/workspace' } } } as unknown as Agent
  let agent: Agent | undefined = root
  let session: Agent['session'] | undefined = root.session
  const schemas = vi.fn((_scope: Agent) => [
    { name: 'z-tool', description: 'Last', execute: () => {}, parameters: {} },
    { name: 'a-tool', description: 'First', execute: () => {}, parameters: {} },
    { name: 'a-tool', description: 'First', parameters: {} },
  ])
  let available = true
  const tools = registry ?? { schemas }
  const ctx = { tools, get: (name: string) => name === 'tools' && available ? tools : undefined,
    agents: { get: (id: string) => id === root.id ? agent : undefined },
    sessions: { get: (id: string) => id === root.id ? session : undefined },
  } as unknown as Context
  const service = new AgentSwarmReadRpcService({ ctx, runtime: {} as AgentSwarmRuntime,
    hostRead: { withTargetRead: async <T>(operation: () => Promise<T>) => await operation() } as AgentSwarmHostReadService,
    webServer: { host: '127.0.0.1', port: 8279, register: () => () => {} },
  })
  return { root, schemas, service, unavailable: () => { available = false }, setAgent: (value: Agent | undefined) => { agent = value }, setSession: (value: Agent['session'] | undefined) => { session = value } }
}
const request = { schemaVersion: 1, method: 'toolCatalog', target: { rootSessionId: 'root' } }

describe('R2 live tool catalog', () => {
  it('projects actual official scoped tool registrations and observes disposal', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const h = harness(ctx.tools)
    let scoped!: ReturnType<typeof createScope>
    let foreign!: ReturnType<typeof createScope>
    const fiber = await ctx.plugin({ inject: ['tools'], apply: (injected: Context) => { scoped = createScope(injected, h.root); foreign = createScope(injected, {}) } })
    const executed = vi.fn(async () => 'ok')
    const definition = (name: string) => defineTool({ name, description: `Description ${name}`, parameters: {},
      output: { schema: { type: 'string' }, render: () => [{ type: 'text' as const, text: 'ok' }] }, execute: executed })
    try {
      scoped.ctx.tools.register(definition('local_probe'))
      foreign.ctx.tools.register(definition('foreign_probe'))
      const value = await h.service.invoke(request) as SwarmReadToolCatalogV1
      expect(value.tools).toContainEqual({ name: 'local_probe', description: 'Description local_probe' })
      expect(value.tools.some(tool => tool.name === 'foreign_probe')).toBe(false)
      await scoped.dispose()
      const after = await h.service.invoke(request) as SwarmReadToolCatalogV1
      expect(after.tools.some(tool => tool.name === 'local_probe')).toBe(false)
      expect(executed).not.toHaveBeenCalled()
    } finally { await foreign.dispose(); await scoped.dispose(); await fiber.dispose() }
  })

  it('reads public schemas for the exact Agent and emits sorted unique metadata only', async () => {
    const h = harness()
    await expect(h.service.invoke(request)).resolves.toEqual({ schemaVersion: 1, binding: { rootSessionId: 'root' }, complete: true,
      tools: [{ name: 'a-tool', description: 'First' }, { name: 'z-tool', description: 'Last' }], observedAt: expect.any(Number) })
    expect(h.schemas).toHaveBeenCalledWith(h.root)
  })
  it('rejects cold and replaced Sessions before reading a catalog', async () => {
    const h = harness()
    h.setAgent(undefined)
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    h.setAgent(h.root); h.setSession(undefined)
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    h.setSession({ ...h.root.session } as Agent['session'])
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_TARGET_NOT_LIVE' })
    expect(h.schemas).not.toHaveBeenCalled()
  })
  it('rejects changed live binding during discovery', async () => {
    const h = harness()
    h.schemas.mockImplementation(() => { h.setAgent({ ...h.root } as Agent); return [] })
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })
  it('reports unavailable service and changed cwd without returning another context catalog', async () => {
    const h = harness()
    h.unavailable()
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_TOOL_CATALOG_UNAVAILABLE' })
    expect(h.schemas).not.toHaveBeenCalled()
    const other = harness()
    other.schemas.mockImplementation(() => { Object.assign(other.root.session.header, { cwd: 'D:/other' }); return [] })
    await expect(other.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_HOST_BINDING_MISMATCH' })
  })

  it('bounds tool count and rejects a Team selector', async () => {
    const h = harness()
    h.schemas.mockReturnValue(Array.from({ length: 513 }, (_, i) => ({ name: `tool-${i}`, description: 'Tool', parameters: {} })))
    await expect(h.service.invoke(request)).rejects.toMatchObject({ code: 'SWARM_RPC_PROJECTION_LIMIT' })
    await expect(h.service.invoke({ ...request, target: { rootSessionId: 'root', teamId: 'other' } })).rejects.toMatchObject({ code: 'SWARM_RPC_INVALID_REQUEST' })
  })
})
