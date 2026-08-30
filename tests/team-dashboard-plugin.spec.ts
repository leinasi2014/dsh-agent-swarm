import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, IconUserOutline16: () => null }))
import { apply, inject } from '../src/client/plugin-entry.js'

describe('Team dashboard client composition', () => {
  it('publishes the complete Cordis client plugin face from the package entrypoint', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale'])
  })

  it('registers the Session utility and Details declaration without shell.overlay', () => {
    const injected: string[] = []
    const registrations: { name: string; priority?: number }[] = []
    const slots = {
      inject: (name: string, callback: () => unknown) => { injected.push(name); callback() },
      register: (options: { name: string; priority?: number }) => { registrations.push(options); return () => {} },
      onEntryError: () => () => {}, subscribe: () => () => {}, entries: () => [], entriesOfSlot: () => [],
    }
    const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: undefined }) } }
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
    const ctx = {
      slots, locale: { register: vi.fn(), getLocale: () => ({ active: 'en' }) }, get: (name: string) => name === 'sessions' ? sessions : undefined,
      effect: (callback: () => (() => void) | void) => { callback() }, on: vi.fn(),
      inject: (_names: string[], callback: (child: { get(name: string): unknown; effect(effectCallback: () => unknown): void }) => void) => callback({ get: () => layout, effect: effectCallback => { effectCallback() } }),
    }
    apply(ctx as never)
    expect(injected).toContain('details')
    expect(injected).toContain('conversation.session.header.utilities')
    expect(injected).not.toContain('shell.overlay')
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.name).toBe('conversation.session.header.utilities')
  })
})
