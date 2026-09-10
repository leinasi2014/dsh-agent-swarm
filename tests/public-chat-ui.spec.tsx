// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TeamPublicChat } from '../src/client/TeamPublicChat.js'
import { TeamGroupNavigation } from '../src/client/TeamGroupNavigation.js'
import type { PublicChatState } from '../src/client/public-chat-controller.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { ready, render, t } from './helpers/dashboard-ui.js'

function teamState(): TeamDashboardState {
  const data = ready.data!
  const a = data.teams.teams[0]!
  return { ...ready, data: { ...data,
    projection: { ...data.projection, roster: [{ ...data.projection.roster[0]!, name: 'writer', phase: 'active' }] },
    teams: { ...data.teams, teams: [a, { ...a, teamId: 'b', name: 'Team B', captainSessionId: 'captain-b' }] },
    captainMembers: { ...data.captainMembers, members: [{ ...data.captainMembers.members[0]!, name: 'writer', displayName: 'Lin', phase: 'active', sessionId: 'member-1' }] },
  } }
}
function chatState(state: TeamDashboardState): PublicChatState {
  const binding = state.data!.projection.binding
  const selection = { key: 'draft-key', viewer: state.targetSessionId!, captain: binding.rootSessionId, team: binding.teamId, revision: state.data!.projection.team.revision }
  const entries = [{ id: 'public-1', sequence: 1, createdAt: 1000, author: { kind: 'local-operator' as const }, text: '真实消息', delivery: { state: 'claimed' as const, claimedAt: 2000, recipientSessionId: binding.rootSessionId } }]
  return { selection, entries, draft: { text: 'send me', version: 1 }, sending: false, loading: false, pending: false, error: undefined,
    history: { schemaVersion: 1, binding, observedAt: 2000, teamRevision: selection.revision, entries, totalCount: 1, returnedCount: 1, limit: 50, hasEarlier: false, hasMore: false, firstSequence: 1, lastSequence: 1, appendEligibility: { state: 'available' }, limits: { maxTextBytes: 4096, maxBytes: 100000, maxMessages: 1000 } },
  }
}
function chatProps(state = teamState(), chat = chatState(state)) {
  return { t, useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(state), useChat: <T,>(selector: (state: PublicChatState) => T) => selector(chat),
    useSurface: <T,>(selector: (state: { mode: 'inactive'; view: 'overview'; targetSessionId: undefined }) => T) => selector({ mode: 'inactive', view: 'overview', targetSessionId: undefined }),
    send: vi.fn(), recover: vi.fn(), earlier: vi.fn(), newer: vi.fn(), refresh: vi.fn(), edit: vi.fn(), reply: vi.fn(), openTeam: vi.fn(),
  }
}

describe('public conversation composition', () => {
  it.each(['stale', 'reconnecting'] as const)('retains verified history and pending draft during %s while preventing dispatch', async phase => {
    const readyState = teamState()
    const props = chatProps({ ...readyState, phase, error: { code: 'RESET', message: 'connection lost' } }, { ...chatState(readyState), pending: true })
    await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
    expect(document.querySelector('[data-public-message]')?.textContent).toContain('真实消息')
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('send me')
    expect(document.querySelector('[data-swarm-public-chat]')?.textContent).toContain(t(phase))
    expect(document.querySelector('[data-swarm-public-chat]')?.textContent).toContain(t('public.unknown'))
    expect(document.querySelector<HTMLButtonElement>('[data-public-send]')?.disabled).toBe(true)
    const recovery = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t('public.recover'))!
    expect(recovery.disabled).toBe(true)
    await act(async () => { document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(props.send).not.toHaveBeenCalled()
  })
  it('selects and folds a group on its name, while nested member clicks do not toggle it', async () => {
    const state = teamState()
    const selectGroup = vi.fn()
    const openMember = vi.fn(async () => {})
    const props = { t, wide: true, expandSidebar: vi.fn(), useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(state),
      usePanelInfo: <T,>(selector: (value: { activePanelId: string }) => T) => selector({ activePanelId: 'swarm.group' }),
      selectGroup, openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember,
    }
    await render(<TeamGroupNavigation {...props as ComponentProps<typeof TeamGroupNavigation>} />)
    const group = document.querySelector<HTMLButtonElement>(`[data-swarm-group="${state.data!.projection.binding.teamId}"]`)!
    await act(async () => { group.click() })
    expect(group.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-group-member="writer"]')!.click() })
    expect(openMember).toHaveBeenCalledExactlyOnceWith('writer', 'member-1')
    expect(selectGroup).toHaveBeenCalledTimes(1)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { group.click() })
    expect(group.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-group="b"]')!.click() })
    expect(selectGroup).toHaveBeenLastCalledWith('b')
    expect(props.openCaptain).not.toHaveBeenCalled()
  })
  it('keeps Enter and IME for composition; Ctrl/Cmd Enter submits only a ready Team', async () => {
    const props = chatProps()
    await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
    const textarea = document.querySelector('textarea')!
    for (const options of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true, isComposing: true }, { key: 'Enter', ctrlKey: true, keyCode: 229 }]) {
      await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true })) })
    }
    expect(props.send).not.toHaveBeenCalled()
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })) })
    expect(props.send).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-delivery="claimed"]')?.textContent).toContain('completion unconfirmed')
    expect(document.querySelector('button[data-public-send]')).not.toBeNull()
  })
  it.each(['binding', 'pending'] as const)('hides Team A messages and composer when the Team B %s is selected', async change => {
    const a = teamState()
    const b: TeamDashboardState = change === 'pending' ? { ...a, phase: 'stale', pendingTeamId: 'b' }
      : { ...a, data: { ...a.data!, projection: { ...a.data!.projection, binding: { teamId: 'b', rootSessionId: 'captain-b' } } } }
    const props = chatProps(b, chatState(a))
    await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
    expect(document.querySelector('[data-public-message]')).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('[data-swarm-public-chat]')?.hasAttribute('data-team-id')).toBe(false)
    expect(props.send).not.toHaveBeenCalled()
  })
})
