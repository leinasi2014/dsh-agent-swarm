import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

interface MemorySettingsStore {
  doc: Record<string, unknown>
}

interface MemorySettingsOptions {
  readonly store: MemorySettingsStore
}

class MemorySettings extends SettingsProvider {
  private readonly store: MemorySettingsStore

  constructor(ctx: Context, options: MemorySettingsOptions) {
    super(ctx)
    this.store = options.store
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.store.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.store.doc = { ...this.store.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function mountOptionalSettingsAgentSwarm(
  ctx: Context,
  base: Parameters<typeof AgentSwarm.apply>[1],
): Promise<Fiber> {
  const fiber = ctx.plugin({
    apply: (child: Context) => AgentSwarm.apply(child, base),
  })
  await fiber.await()
  return fiber
}

function descriptor(ctx: Context) {
  return ctx.settings.describe().find(row => row.ns === AgentSwarm.AGENT_SWARM_SETTINGS_NAMESPACE)
}

describe('agent-swarm settings composition', () => {
  it('re-registers its restart-applied namespace across settings-provider and owner generations', async () => {
    const ctx = new Context()
    const store: MemorySettingsStore = {
      doc: {
        'agent-swarm': {
          enabled: false,
          maxMembers: 11,
          allowedSkills: ['frontend-review'],
        },
      },
    }

    try {
      let swarmFiber = await mountOptionalSettingsAgentSwarm(ctx, { enabled: false, maxMembers: 3 })
      let settingsFiber = ctx.plugin(MemorySettings, { store })
      await settingsFiber.await()
      await vi.waitFor(() => {
        expect(descriptor(ctx)).toMatchObject({
          ns: AgentSwarm.AGENT_SWARM_SETTINGS_NAMESPACE,
          applies: 'restart',
          base: { enabled: false, maxMembers: 3 },
          user: { enabled: false, maxMembers: 11, allowedSkills: ['frontend-review'] },
          value: { enabled: false, maxMembers: 11, allowedSkills: ['frontend-review'] },
        })
      })

      await ctx.settings.update(AgentSwarm.AGENT_SWARM_SETTINGS_NAMESPACE, { maxMembers: 17 })
      expect(descriptor(ctx)?.value).toMatchObject({ maxMembers: 17 })

      await settingsFiber.dispose()
      settingsFiber = ctx.plugin(MemorySettings, { store })
      await settingsFiber.await()
      await vi.waitFor(() => {
        expect(descriptor(ctx)).toMatchObject({
          applies: 'restart',
          value: { enabled: false, maxMembers: 17, allowedSkills: ['frontend-review'] },
        })
      })

      await swarmFiber.dispose()
      await vi.waitFor(() => { expect(descriptor(ctx)).toBeUndefined() })

      swarmFiber = await mountOptionalSettingsAgentSwarm(ctx, { enabled: false, maxMembers: 3 })
      await vi.waitFor(() => {
        expect(descriptor(ctx)).toMatchObject({
          applies: 'restart',
          value: { enabled: false, maxMembers: 17, allowedSkills: ['frontend-review'] },
        })
      })
      await swarmFiber.dispose()
      await vi.waitFor(() => { expect(descriptor(ctx)).toBeUndefined() })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-registers when Settings existed before Agent Swarm and is replaced', async () => {
    const ctx = new Context()
    const store: MemorySettingsStore = { doc: { 'agent-swarm': { enabled: false, maxMembers: 9 } } }

    try {
      let settingsFiber = ctx.plugin(MemorySettings, { store })
      await settingsFiber.await()
      const swarmFiber = await mountOptionalSettingsAgentSwarm(ctx, { enabled: false, maxMembers: 3 })
      await vi.waitFor(() => {
        expect(descriptor(ctx)?.value).toMatchObject({ enabled: false, maxMembers: 9 })
      })

      await settingsFiber.dispose()
      settingsFiber = ctx.plugin(MemorySettings, { store })
      await settingsFiber.await()
      await vi.waitFor(() => {
        expect(descriptor(ctx)).toMatchObject({
          applies: 'restart',
          value: { enabled: false, maxMembers: 9 },
        })
      })

      await swarmFiber.dispose()
      await vi.waitFor(() => { expect(descriptor(ctx)).toBeUndefined() })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
