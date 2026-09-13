import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, IconUserOutline16: () => null }))
import { apply, inject } from '../src/client/plugin-entry.js'
import { teamEntryVisible, type TeamDashboardData } from '../src/client/team-dashboard-controller.js'

interface LayoutFixture {
  registerPanelPresentation?: (id: string, presentation: unknown) => () => void
  selectPanel: unknown
}

/** Host composition fixture: only services the host really owns are faked. */
function harness(layout: LayoutFixture) {
  const injected: string[] = []
  const registrations: { name: string; id?: string; key?: string; order?: number; label?: () => string; inject?: () => unknown }[] = []
  const effects: string[] = []
  const slots = {
    inject: (name: string, callback: () => unknown) => { injected.push(name); const returned = callback(); if (returned !== null && typeof returned === 'object' && Symbol.iterator in returned) Array.from(returned as Iterable<unknown>) },
    register: (options: { name: string }) => { registrations.push(options); return () => {} },
    onEntryError: () => () => {}, subscribe: () => () => {}, entries: () => [], entriesOfSlot: () => [],
  }
  const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: 'session-1' }) } }
  const tabTypes: { id: string; kind: string; guide: { title(): string }[] }[] = []
  const models = vi.fn(async () => ({ ok: true as const, value: { groups: [{ id: 'dsv4f-local', name: 'DSV4 Local', models: [{ id: 'DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash' }] }] } }))
  const connection = { rpc: { call: vi.fn() } }
  const get = vi.fn((name: string) => name === 'sessions' ? sessions : name === 'connection' ? connection : undefined)
  const ctx = {
    slots, remote: { session: { modelCatalog: models } }, layout,
    sidebarRightTabs: { register: (definition: typeof tabTypes[number]) => { tabTypes.push(definition); return () => {} } },
    settingsScope: { bind: vi.fn(() => ({})) },
    locale: { bind: () => (key: string) => key, register: vi.fn(), getLocale: () => ({ active: 'en' }) },
    get,
    effect: (callback: () => (() => void) | void, label: string) => { effects.push(label); if (label === 'swarm Team panel geometry' || label === 'swarm Team Sidebar tab type') callback() },
    on: vi.fn(),
  }
  return { ctx, injected, registrations, effects, tabTypes, models, get }
}

describe('Team dashboard client composition', () => {
  it('publishes the complete Cordis client plugin face from the package entrypoint', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale', 'settingsScope', 'remote', 'remote.session', 'remote.subagents', 'sidebarRight', 'sidebarRightTabs', 'layout', 'connection'])
  })

  it('registers only official seats: right-pane tab, conditional Main Conversation, header actions, settings card', async () => {
    const layout = { selectPanel: vi.fn() }
    const f = harness(layout)
    apply(f.ctx as never)
    expect(f.injected).toContain('sidebar.right.pane.tab')
    expect(f.injected).toContain('conversation.session.header.actions')
    expect(f.injected).toContain('main.conversation')
    expect(f.injected).not.toContain('sidebar.panellist')
    expect(f.injected).toContain('settings.plugin.item')
    expect(f.injected).not.toContain('shell.overlay')
    expect(f.injected).not.toContain('conversation.session.header.utilities')
    expect(f.injected).not.toContain('details')
    // No patch-only seat survives: the retired sidebar section and lineage display are gone.
    expect(f.injected).not.toContain('sidebar.navigation.section')
    expect(f.injected).not.toContain('conversation.session.header.lineage.display')
    expect(f.registrations.map(entry => [entry.name, entry.id ?? entry.key])).toEqual([
      ['sidebar.right.pane.tab', 'dsh-agent-swarm/team'],
      ['conversation.session.header.actions', 'swarm-team'],
      ['settings.plugin.item', 'agent-swarm'],
    ])
    // Empty or unverified Main keeps the original official Conversation root.
    expect(f.registrations.some(entry => entry.name === 'main.conversation')).toBe(false)
    const header = f.registrations.find(entry => entry.name === 'conversation.session.header.actions')!.inject!() as { hooks: { team: unknown } }
    const sidebar = f.registrations[0]?.inject?.() as { controller: unknown }
    expect(header.hooks.team).toBe(sidebar.controller)
    // A2 stays un-applied on this host, so the framework keeps its own geometry.
    expect(f.effects).not.toContain('swarm Team panel geometry')
    expect(f.tabTypes).toHaveLength(1)
    expect(f.tabTypes[0]).toMatchObject({ id: 'dsh-agent-swarm/team', kind: 'swarm-team' })
    expect(f.tabTypes[0]?.guide[0]?.title()).toBe('title')
    const settings = f.registrations.find(entry => entry.name === 'settings.plugin.item')!.inject!() as { readonly catalog: { listModelRoutes(): Promise<unknown> } }
    await expect(settings.catalog.listModelRoutes()).resolves.toEqual([{
      provider: 'dsv4f-local', providerName: 'DSV4 Local', model: 'DeepSeek-V4-Flash-0731', modelName: 'DeepSeek V4 Flash',
    }])
    expect(f.models).toHaveBeenCalledWith()
  })

  it('keeps the sidebar Team entry absent while the session can see no Team', () => {
    const f = harness({ selectPanel: vi.fn() })
    apply(f.ctx as never)
    expect(f.injected).toContain('main.conversation')
    expect(f.injected).not.toContain('sidebar.panellist')
    expect(f.registrations.some(entry => entry.name === 'sidebar.panellist')).toBe(false)
    // The predicate decides registration: an empty or failed read is not a Team.
    expect(teamEntryVisible({ open: true, phase: 'ready' })).toBe(false)
    expect(teamEntryVisible({ open: true, phase: 'error', error: { code: 'SWARM_UI_NO_VISIBLE_TEAM', message: 'No visible Team' } })).toBe(false)
    expect(teamEntryVisible({ open: true, phase: 'ready', data: { teams: { complete: true, teams: [{ teamId: 'team-1' }] } } as unknown as TeamDashboardData })).toBe(true)
  })

  it('leaves geometry owned by the official Conversation layout', () => {
    const registerPanelPresentation = vi.fn(() => () => {})
    const f = harness({ registerPanelPresentation, selectPanel: vi.fn() })
    apply(f.ctx as never)
    expect(f.effects).not.toContain('swarm Team panel geometry')
    expect(registerPanelPresentation).not.toHaveBeenCalled()
  })
})
