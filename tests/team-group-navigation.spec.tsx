// @vitest-environment jsdom
import { ready, render, t, mounted } from './helpers/dashboard-ui.js'
import { act, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { TeamGroupNavigation } from '../src/client/TeamGroupNavigation.js'
import type { PublicChatState } from '../src/client/public-chat-controller.js'

it('navigates verified members while the optional shared directory is pending and does not reread on focus', async () => {
  const data = ready.data!, member = { ...data.captainMembers.members[0]!, name: 'writer', sessionId: 'member-current', phase: 'active' as const, displayName: '已验证成员' }
  const state = { ...ready, data: { ...data, captainMembers: { ...data.captainMembers, members: [member] },
    projection: { ...data.projection, roster: [{ ...data.projection.roster[0]!, name: member.name, phase: member.phase }] } } }
  let chat = { directoryLoading: true } as PublicChatState
  const openMember = vi.fn(async () => {}), refreshDirectory = vi.fn()
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
  expect(refreshDirectory).not.toHaveBeenCalled()
  chat = { directoryLoading: false, directoryError: 'optional directory unavailable' } as PublicChatState
  await act(async () => { mounted.at(-1)!.render(<TeamGroupNavigation {...props} />) })
  expect(document.querySelector<HTMLButtonElement>('[data-swarm-group-member="writer"]')!.disabled).toBe(false)
})
