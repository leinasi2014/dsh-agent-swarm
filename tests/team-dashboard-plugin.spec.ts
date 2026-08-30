import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, IconUserOutline16: () => null }))
import { apply, inject } from '../src/client/plugin-entry.js'

describe('Team dashboard client composition', () => {
  it('publishes the complete Cordis client plugin face from the package entrypoint', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale', 'settingsScope', 'connection'])
  })

  it('registers the Session utility, Details declaration, and complete settings catalog without shell.overlay', async () => {
    const injected: string[] = []
    const registrations: { name: string; priority?: number; inject?: () => unknown }[] = []
    const slots = {
      inject: (name: string, callback: () => unknown) => { injected.push(name); callback() },
      register: (options: { name: string; priority?: number; inject?: () => unknown }) => { registrations.push(options); return () => {} },
      onEntryError: () => () => {}, subscribe: () => () => {}, entries: () => [], entriesOfSlot: () => [],
    }
    const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: 'session-1' }) } }
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
    const models = vi.fn(async () => ({ result: { ok: true as const, value: { groups: [{ id: 'dsv4f-local', name: 'DSV4 Local', models: [{ id: 'DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash' }] }] } } }))
    const connection = { api: { sessions: { models } } }
    const ctx = {
      slots, settingsScope: { bind: vi.fn(() => ({})) }, locale: { register: vi.fn(), getLocale: () => ({ active: 'en' }) }, get: (name: string) => name === 'sessions' ? sessions : name === 'connection' ? connection : undefined,
      effect: (callback: () => (() => void) | void) => { callback() }, on: vi.fn(),
      inject: (_names: string[], callback: (child: { get(name: string): unknown; effect(effectCallback: () => unknown): void }) => void) => callback({ get: () => layout, effect: effectCallback => { effectCallback() } }),
    }
    apply(ctx as never)
    expect(injected).toContain('details')
    expect(injected).toContain('conversation.session.header.utilities')
    expect(injected).toContain('settings.plugin.item')
    expect(injected).not.toContain('shell.overlay')
    expect(registrations.map(entry => entry.name)).toEqual([
      'conversation.session.header.utilities',
      'settings.plugin.item',
    ])
    const settings = registrations.at(-1)?.inject?.() as { readonly catalog: { listModelRoutes(): Promise<unknown> } }
    await expect(settings.catalog.listModelRoutes()).resolves.toEqual([{
      provider: 'dsv4f-local', providerName: 'DSV4 Local', model: 'DeepSeek-V4-Flash-0731', modelName: 'DeepSeek V4 Flash',
    }])
    expect(models).toHaveBeenCalledWith({ sessionId: 'session-1' })
  })
})
