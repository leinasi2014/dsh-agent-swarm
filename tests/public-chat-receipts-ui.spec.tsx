// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { render, t } from './helpers/dashboard-ui.js'
import { chatState, teamState } from './helpers/public-chat-fixtures.js'
import { chatProps } from './helpers/public-chat-ui.js'
import { TeamPublicChat } from '../src/client/TeamPublicChat.js'
import type { PublicChatState } from '../src/client/public-chat-controller.js'

describe('public conversation receipts and empty history', () => {
  it.each(['recipient', 'other-member', 'operator', 'other-message', 'post', 'earlier', 'delivery'] as const)('projects public reply evidence without inventing completion (%s)', async scenario => {
    const team = teamState(), chat = chatState(team), source = chat.entries[0]!
    const reply: PublicChatState['entries'][number] = { ...source, id: 'reply', sequence: scenario === 'earlier' ? 1 : 2,
      author: scenario === 'operator' ? { kind: 'local-operator' } : { kind: 'agent', role: 'captain', name: 'Captain', sessionId: scenario === 'other-member' ? 'different-session' : chat.selection!.captain },
      ...(scenario === 'post' ? {} : { replyTo: scenario === 'other-message' ? 'other-id' : source.id }),
      delivery: scenario === 'delivery' ? source.delivery : { kind: 'not-requested' } }
    await render(<TeamPublicChat {...chatProps(team, { ...chat, entries: [source, reply] }) as ComponentProps<typeof TeamPublicChat>} />)
    const receipt = document.querySelector('[data-public-message="public-1"] [data-recipient]')!
    expect(receipt.textContent?.includes(t('public.replied'))).toBe(scenario === 'recipient')
    expect(receipt.getAttribute('data-recipient-state')).toBe('claimed')
    expect(receipt.textContent).not.toContain('completion unconfirmed')
  })
  it('shows an empty conversation only after a successful empty history read', async () => {
    const team = teamState(), chat = chatState(team)
    for (const patch of [{ history: undefined, error: undefined }, { history: undefined, error: 'History RPC failed' }, { error: 'History refresh failed' }]) {
      await render(<TeamPublicChat {...chatProps(team, { ...chat, entries: [], ...patch }) as ComponentProps<typeof TeamPublicChat>} />)
      const panel = document.querySelectorAll('[data-swarm-public-chat]')[document.querySelectorAll('[data-swarm-public-chat]').length - 1]!
      expect(panel.textContent).not.toContain(t('public.empty'))
      if (patch.error !== undefined) expect(panel.querySelector('[role="alert"]')?.textContent).toContain(patch.error)
    }
    await render(<TeamPublicChat {...chatProps(team, { ...chat, entries: [] }) as ComponentProps<typeof TeamPublicChat>} />)
    expect(document.body.textContent).toContain(t('public.empty'))
  })
})
