// @vitest-environment jsdom
import { ready, render, t, mounted } from './helpers/dashboard-ui.js'
import { act, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { TeamGroupNavigation } from '../src/client/TeamGroupNavigation.js'
import type { PublicChatState } from '../src/client/public-chat-controller.js'

it('navigates verified members while the optional shared directory is pending and does not reread on focus', async () => {
  const data = ready.data!, member = { ...data.captainMembers.members[0]!, name: 'writer', sessionId: 'member-current', phase: 'active' as const, displayName: '已验证成员' }
  let state = { ...ready, data: { ...data, captainMembers: { ...data.captainMembers, members: [member] },
    projection: { ...data.projection, roster: [{ ...data.projection.roster[0]!, name: member.name, phase: member.phase }] } } }
  let chat = { directoryLoading: true } as PublicChatState
  let release!: () => void
  const openMember = vi.fn(() => new Promise<void>(resolve => { release = resolve })), refreshDirectory = vi.fn()
  const props: ComponentProps<typeof TeamGroupNavigation> = { t: t as ComponentProps<typeof TeamGroupNavigation>['t'], wide: true, expandSidebar: vi.fn(),
    useSessions: vi.fn(), useSessionPendingInteraction: vi.fn(), useWorkspaces: vi.fn(),
    useTeam: selector => selector(state), useChat: selector => selector(chat), usePanelInfo: selector => selector({ activePanelId: 'swarm.group' } as never),
    selectGroup: vi.fn(), openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember, refreshDirectory }
  await render(<TeamGroupNavigation {...props} />)
  await act(async () => { document.querySelector<HTMLButtonElement>(`[data-swarm-group="${data.projection.binding.teamId}"]`)!.click() })
  const button = document.querySelector<HTMLButtonElement>('[data-swarm-group-member="writer"]')
  expect(button).not.toBeNull()
  expect(button!.textContent).toContain('已验证成员')
  await act(async () => { button!.focus(); button!.click() })
  expect(openMember).toHaveBeenCalledExactlyOnceWith('writer', 'member-current')
  expect(button!.getAttribute('aria-busy')).toBe('true')
  expect(button!.textContent).toContain('已验证成员')
  await act(async () => { release() })
  expect(button!.getAttribute('aria-busy')).toBe('false')
  expect(refreshDirectory).not.toHaveBeenCalled()
  chat = { directoryLoading: false, directoryError: 'optional directory unavailable' } as PublicChatState
  await act(async () => { mounted.at(-1)!.render(<TeamGroupNavigation {...props} />) })
  expect(document.querySelector<HTMLButtonElement>('[data-swarm-group-member="writer"]')!.disabled).toBe(false)
  state = { ...state, pendingTeamId: data.projection.binding.teamId }
  await act(async () => { mounted.at(-1)!.render(<TeamGroupNavigation {...props} />) })
  expect(document.querySelector(`[data-swarm-group="${data.projection.binding.teamId}"]`)!.getAttribute('aria-busy')).toBe('true')
})

it('does not show a superseded member failure after a newer handoff or in another Session', async () => {
  const data = ready.data!, members = ['first', 'second'].map(name => ({ ...data.captainMembers.members[0]!, name, phase: 'active' as const, sessionId: `${name}-session` }))
  let state = { ...ready, data: { ...data, captainMembers: { ...data.captainMembers, members },
    projection: { ...data.projection, roster: members.map(member => ({ ...data.projection.roster[0]!, name: member.name, phase: member.phase })) } } }
  let rejectFirst!: (error: Error) => void, finishSecond!: () => void
  const openMember = vi.fn((name: string) => name === 'first' ? new Promise<void>((_resolve, reject) => { rejectFirst = reject }) : new Promise<void>(resolve => { finishSecond = resolve }))
  const props: ComponentProps<typeof TeamGroupNavigation> = { t: t as ComponentProps<typeof TeamGroupNavigation>['t'], wide: true, expandSidebar: vi.fn(),
    useSessions: vi.fn(), useSessionPendingInteraction: vi.fn(), useWorkspaces: vi.fn(), useTeam: selector => selector(state), useChat: vi.fn(),
    usePanelInfo: selector => selector({ activePanelId: 'swarm.group' } as never), selectGroup: vi.fn(),
    openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember, refreshDirectory: vi.fn() }
  await render(<TeamGroupNavigation {...props} />)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-swarm-group]')!.click() })
  const first = document.querySelector<HTMLButtonElement>('[data-swarm-group-member="first"]')!, second = document.querySelector<HTMLButtonElement>('[data-swarm-group-member="second"]')!
  await act(async () => { first.click() })
  await act(async () => { second.click() })
  await act(async () => { finishSecond() })
  await act(async () => { rejectFirst(new Error('old request aborted')) })
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(second.getAttribute('aria-busy')).toBe('false')
  openMember.mockRejectedValueOnce(new Error('current failure'))
  await act(async () => { first.click() })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('current failure')
  state = { ...state, targetSessionId: 'another-viewer' }
  await act(async () => { mounted.at(-1)!.render(<TeamGroupNavigation {...props} />) })
  expect(document.querySelector('[role="alert"]')).toBeNull()
})
