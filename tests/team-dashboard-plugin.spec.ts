import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, IconUserOutline16: () => null }))
import { apply, inject } from '../src/client/plugin-entry.js'

describe('Team dashboard client composition', () => {
  it('publishes the complete Cordis client plugin face from the package entrypoint', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale', 'settingsScope', 'remote', 'remote.session', 'remote.subagents', 'sidebarRight', 'sidebarRightTabs', 'layout', 'connection'])
  })

  it('registers an official Team tab with Guide reentry and a complete settings catalog without toolbar or overlay', async () => {
    const injected: string[] = []
    const registrations: { name: string; priority?: number; inject?: () => unknown }[] = []
    const slots = {
      inject: (name: string, callback: () => unknown) => { injected.push(name); const returned = callback(); if (returned !== null && typeof returned === 'object' && Symbol.iterator in returned) Array.from(returned as Iterable<unknown>) },
      register: (options: { name: string; priority?: number; inject?: () => unknown }) => { registrations.push(options); return () => {} },
      onEntryError: () => () => {}, subscribe: () => () => {}, entries: () => [], entriesOfSlot: () => [],
    }
    const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: 'session-1' }) } }
    const tabTypes: { id: string; kind: string; guide: { title(): string }[] }[] = []
    const models = vi.fn(async () => ({ ok: true as const, value: { groups: [{ id: 'dsv4f-local', name: 'DSV4 Local', models: [{ id: 'DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash' }] }] } }))
    const remote = { session: { modelCatalog: models } }
    const connection = { rpc: { call: vi.fn() } }
    const layout = { registerPanelPresentation: vi.fn(() => () => {}), selectPanel: vi.fn() }
    const ctx = {
      slots, remote, layout, sidebarRightTabs: { register: (definition: typeof tabTypes[number]) => { tabTypes.push(definition); return () => {} } }, settingsScope: { bind: vi.fn(() => ({})) }, locale: { bind: () => (key: string) => key, register: vi.fn(), getLocale: () => ({ active: 'en' }) }, get: (name: string) => name === 'sessions' ? sessions : name === 'connection' ? connection : undefined,
      effect: (callback: () => (() => void) | void, label: string) => { if (label === 'swarm Team Sidebar tab type') callback() }, on: vi.fn(),
    }
    apply(ctx as never)
    expect(injected).toContain('sidebar.right.pane.tab')
    expect(injected).not.toContain('conversation.session.header.utilities')
    expect(injected).toContain('settings.plugin.item')
    expect(injected).toContain('conversation.session.header.lineage.display')
    expect(injected).not.toContain('shell.overlay')
    expect(registrations.map(entry => entry.name)).toEqual([
      'sidebar.right.pane.tab',
      'conversation.session.header.lineage.display',
      'main',
      'sidebar.navigation.section',
      'settings.plugin.item',
    ])
    const sidebar = registrations[0]?.inject?.() as { controller: unknown }
    const lineage = registrations[1]?.inject?.() as { hooks: { team: unknown } }
    expect(lineage.hooks.team).toBe(sidebar.controller)
    expect(layout.registerPanelPresentation).toHaveBeenCalledExactlyOnceWith('swarm.group', { rightSidebar: 'current-session' })
    expect(injected).not.toContain('details')
    expect(tabTypes).toHaveLength(1)
    expect(tabTypes[0]).toMatchObject({ id: 'dsh-agent-swarm/team', kind: 'swarm-team' })
    expect(tabTypes[0]?.guide[0]?.title()).toBe('title')
    const settings = registrations.at(-1)?.inject?.() as { readonly catalog: { listModelRoutes(): Promise<unknown> } }
    await expect(settings.catalog.listModelRoutes()).resolves.toEqual([{
      provider: 'dsv4f-local', providerName: 'DSV4 Local', model: 'DeepSeek-V4-Flash-0731', modelName: 'DeepSeek V4 Flash',
    }])
    expect(models).toHaveBeenCalledWith()
  })
})
