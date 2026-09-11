import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
// @vitest-environment jsdom
import { ready, render, t, mounted } from './helpers/dashboard-ui.js'
import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageImage } from '../src/client/PublicImages.js'
import { PublicMessageContent } from '../src/client/PublicMessageContent.js'
import { TeamPublicChat } from '../src/client/TeamPublicChat.js'
import { TeamGroupNavigation } from '../src/client/TeamGroupNavigation.js'
import type { PublicChatState } from '../src/client/public-chat-controller.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

beforeEach(() => { vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture-image'), revokeObjectURL: vi.fn() })) })
afterEach(() => { vi.unstubAllGlobals() })

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
  const entries = [{ id: 'public-1', sequence: 1, createdAt: 1000, author: { kind: 'local-operator' as const }, text: '真实消息', formatVersion: 2 as const, content: [{ type: 'text' as const, text: '真实消息' }], mentionLabels: [], delivery: { kind: 'requested' as const, recipients: [{ state: 'claimed' as const, claimedAt: 2000, recipientSessionId: binding.rootSessionId }] } }]
  return { selection, entries, draft: { text: 'send me', version: 1, tokens: [] }, sending: false, loading: false, pending: false, error: undefined, directory: undefined, directoryError: undefined, directoryLoading: false, legacyUpgrade: false, draftStatus: 'ready', draftBlobs: {},
    history: { schemaVersion: 3, binding, observedAt: 2000, teamRevision: selection.revision, entries, totalCount: 1, returnedCount: 1, limit: 50, hasEarlier: false, hasMore: false, firstSequence: 1, lastSequence: 1, appendEligibility: { state: 'available' }, limits: { maxSegments: 256, maxTextBytes: 4096, maxBytes: 100000, maxMessages: 1000 }, imageAvailability: { state: 'available', imageLimits: { maxImageBytes: 2000, maxImagesPerMessage: 20, maxMessageImageBytes: 20000, maxImagePixels: 10000, maxImageDimension: 1000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } } },
  }
}
function chatProps(state = teamState(), chat = chatState(state)) {
  return { t, useSessions: <T,>(selector: (state: SessionListState) => T) => selector({ ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }), useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(state), useChat: <T,>(selector: (state: PublicChatState) => T) => selector(chat),
    useSurface: <T,>(selector: (state: { mode: 'inactive'; view: 'overview'; targetSessionId: undefined }) => T) => selector({ mode: 'inactive', view: 'overview', targetSessionId: undefined }),
    replaceText: vi.fn(), chooseMention: vi.fn(), removeMention: vi.fn(), refreshDirectory: vi.fn(), upgradeLegacy: vi.fn(), send: vi.fn(), recover: vi.fn(), earlier: vi.fn(), newer: vi.fn(), refresh: vi.fn(), edit: vi.fn(), reply: vi.fn(), openTeam: vi.fn(),
    addImages: vi.fn(), removeImage: vi.fn(), image: vi.fn(async () => new Blob(['image'], { type: 'image/png' })), retryDraftStorage: vi.fn(), useStoredDraft: vi.fn(),
  }
}


describe('public conversation composition', () => {
  it('shows official current-Session statistics only for a ready matching viewer', async () => {
    const team = teamState(), chat = chatState(team), viewer = chat.selection!.viewer as SessionListState['ids'][number]
    const sessions = { phase: 'ready', current: viewer, ids: [viewer], byId: { [viewer]: { id: viewer, displayTitle: 'Actual current Session', running: false, blank: false, updatedAt: 1,
      projectionValues: { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 30 }, sessionStats: { turns: 3, steps: 8, decodeTokens: 120, decodeMs: 2000 } } } }, subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined } as unknown as SessionListState
    const props = { ...chatProps(team, chat), useSessions: <T,>(selector: (state: SessionListState) => T) => selector(sessions) }
    await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
    expect(document.querySelector('[data-public-session-stats]')?.textContent).toContain('200 tok')
    expect(document.querySelector('[data-public-session-stats]')?.textContent).toContain('60 tok/s')
    expect(document.querySelector('[data-public-session-stats]')?.textContent).toContain('Actual current Session')
    for (const patch of [{ phase: 'pending' as const }, { current: 'other-session' as typeof sessions.current }]) {
      await act(async () => { mounted.at(-1)!.render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} useSessions={selector => selector({ ...sessions, ...patch })} />) })
      expect(document.querySelector('[data-public-session-stats]')?.textContent).not.toContain('200 tok')
      expect(document.querySelector('[data-public-session-stats]')?.textContent).toContain('— tok/s')
    }
  })
  it('offers one explicit loaded-tail navigation menu and keyboard-accessible full quotes', async () => {
    const team = teamState(), chat = chatState(team), source = chat.entries[0]!
    await render(<TeamPublicChat {...chatProps(team, { ...chat, entries: [source, { ...source, id: 'reply', replyTo: source.id }] }) as ComponentProps<typeof TeamPublicChat>} />)
    expect(document.querySelectorAll('[data-public-navigation]')).toHaveLength(1)
    const trigger = document.querySelector<HTMLButtonElement>('[data-public-quote-trigger]')!
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.focus() })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-public-quote-full]')?.textContent).toContain(source.text)
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(document.querySelector('[data-public-expand]')).toBeNull()
  })
  it('offers a local image picker and blocks sending until draft storage is restored', async () => {
    const base = teamState(), props = chatProps(base, { ...chatState(base), draftStatus: 'loading' })
    await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
    expect(document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-public-send]')?.disabled).toBe(true)
  })

  it('passes pasted image files with text once and preserves mention-aware text editing', async () => {
    const props = chatProps()
    await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
    const textarea = document.querySelector('textarea')!, file = new File(['png'], 'paste.png', { type: 'image/png' })
    textarea.setSelectionRange(0, 7)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [file], getData: () => '@copied' } })
    await act(async () => { textarea.dispatchEvent(event) })
    expect(props.addImages).toHaveBeenCalledExactlyOnceWith([file])
    expect(props.replaceText).toHaveBeenCalledExactlyOnceWith(0, 7, '@copied')
  })

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
    const base = teamState()
    const state = { ...base, data: { ...base.data!, teams: { ...base.data!.teams,
      binding: { ...base.data!.teams.binding, mainSessionTitle: '教师正式启动：维护方已完成3' } } } }
    const selectGroup = vi.fn()
    const openMember = vi.fn(async () => {})
    const props = { t, wide: true, expandSidebar: vi.fn(), useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(state),
      usePanelInfo: <T,>(selector: (value: { activePanelId: string }) => T) => selector({ activePanelId: 'swarm.group' }),
      selectGroup, openMain: vi.fn(async () => {}), openCaptain: vi.fn(async () => {}), openMember,
    }
    await render(<TeamGroupNavigation {...props as ComponentProps<typeof TeamGroupNavigation>} />)
    const navigation = document.querySelector('[data-swarm-group-navigation]')!
    expect(navigation.textContent).not.toContain(state.data.teams.binding.mainSessionTitle)
    expect(navigation.querySelectorAll('button')).toHaveLength(state.data.teams.teams.length)
    const group = document.querySelector<HTMLButtonElement>(`[data-swarm-group="${state.data!.projection.binding.teamId}"]`)!
    expect(group.title).toBe(state.data.teams.teams[0]!.name)
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
    expect(props.openMain).not.toHaveBeenCalled()
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

// Container geometry fixture, not a claim about the installed app's host chrome.
it('keeps two short messages and the composer visible in a 390px container with a long folded goal', async () => {
  const base = teamState(), data = base.data!
  const state = { ...base, data: { ...data, teams: { ...data.teams, teams: data.teams.teams.map(row => ({ ...row, goal: { state: 'generated' as const, text: '这是较长的团队公开目标。'.repeat(80) } })) } } }
  const chat = chatState(state)
  const props = chatProps(state, { ...chat, entries: [...chat.entries, { ...chat.entries[0]!, id: 'public-2', sequence: 2, text: '第二条简短消息' }] })
  await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
  const { chromium } = await import('playwright'), browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 } })
    await page.setContent(`<div style="width:390px;height:700px">${document.querySelector('[data-swarm-public-chat]')!.outerHTML}</div>`)
    const geometry = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-swarm-public-chat]')!, messages = root.querySelector<HTMLElement>('.swarm-public__messages')!
      const rect = messages.getBoundingClientRect(), send = root.querySelector('[data-public-send]')!.getBoundingClientRect()
      return { messagesHeight: rect.height, headerHeight: root.querySelector('header')!.getBoundingClientRect().height,
        messagePadding: getComputedStyle(messages).paddingLeft, overflow: root.scrollWidth - root.clientWidth,
        shown: [...messages.querySelectorAll('article')].every(node => node.getBoundingClientRect().top >= rect.top && node.getBoundingClientRect().bottom <= rect.bottom),
        sendBottom: send.bottom, bottom: root.getBoundingClientRect().bottom }
    })
    expect(geometry.messagesHeight).toBeGreaterThan(280)
    expect(geometry.headerHeight).toBeLessThan(110)
    expect(geometry.messagePadding).toBe('12px')
    expect(geometry.overflow).toBeLessThanOrEqual(1)
    expect(geometry.shown).toBe(true)
    expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.bottom)
  } finally { await browser.close() }
}, 60_000)

const draftImage = { blobId: 'draft-image', mediaType: 'image/png', name: '草稿图.png', status: 'ready' as const, width: 10, height: 10 }
const historyImage = { type: 'image' as const, imageId: 'image-1', mediaType: 'image/png' as const, name: '参考.png', bytes: 3, width: 10, height: 10 }

it.each([1, 2, 3] as const)('preserves public escape rendering for format %s and literal agent replies', async formatVersion => {
  const base = chatState(teamState()).entries[0]!, raw = String.raw`one \@a; two \\@b; three \\\@c`
  const decoded = String.raw`one @a; two \\@b; three \@c`
  for (const author of [{ kind: 'local-operator' as const }, { kind: 'agent' as const, sessionId: 'helper', name: 'Helper', role: 'member' as const }]) {
    const message = { ...base, formatVersion, author, content: [{ type: 'text' as const, text: raw },
      ...(formatVersion === 3 ? [historyImage] : []), { type: 'mention' as const, memberId: 'member' }],
      mentionLabels: [{ memberId: 'member', label: 'Member' }] }
    await render(<PublicMessageContent message={message} entries={[message]} image={async () => new Blob(['png'])} t={t as ComponentProps<typeof PublicMessageContent>['t']} />)
    expect(document.querySelectorAll('[data-public-text] > span')[0]?.textContent).toBe(formatVersion > 1 && author.kind === 'local-operator' ? decoded : raw)
    expect(document.querySelector('[data-public-mention]')?.textContent).toBe('@Member')
    await act(async () => { mounted.pop()!.unmount() })
  }
})

it('enables pure-image send and retains invalid images with explicit removal', async () => {
  const base = teamState(), chat = chatState(base), props = chatProps(base, { ...chat, draft: { text: '', version: 2, tokens: [], images: [draftImage] }, draftBlobs: { 'draft-image': new Blob(['png']) } })
  await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
  expect(document.querySelector<HTMLButtonElement>('[data-public-send]')!.disabled).toBe(false)
  await act(async () => { document.querySelector<HTMLButtonElement>('.swarm-public__remove-image')!.click() })
  expect(props.removeImage).toHaveBeenCalledExactlyOnceWith('draft-image')
  await act(async () => { mounted.at(-1)!.render(<TeamPublicChat {...chatProps(base, { ...chat, draft: { ...chat.draft, images: [{ ...draftImage, status: 'invalid', error: 'decode' }] }, draftBlobs: props.useChat(value => value.draftBlobs) }) as ComponentProps<typeof TeamPublicChat>} />) })
  expect(document.querySelector<HTMLButtonElement>('[data-public-send]')!.disabled).toBe(true)
  expect(document.querySelector('[data-draft-image]')?.textContent).toContain(t('public.imageIssue.decode'))
})

it.each(['unavailable', 'conflict'] as const)('exposes explicit %s storage recovery without losing the local draft', async draftStatus => {
  const base = teamState(), props = chatProps(base, { ...chatState(base), draftStatus })
  await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('send me')
  expect(document.querySelector<HTMLButtonElement>('[data-public-send]')!.disabled).toBe(true)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-public-draft-status] button')!.click() })
  expect(draftStatus === 'conflict' ? props.useStoredDraft : props.retryDraftStorage).toHaveBeenCalledOnce()
})

it('accepts multiple selected files, resets the picker, and handles a textarea drop exactly once', async () => {
  const props = chatProps(), files = [new File(['png'], 'one.png', { type: 'image/png' }), new File(['png'], 'two.png', { type: 'image/png' })]
  await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { value: files })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(props.addImages).toHaveBeenCalledExactlyOnceWith(files)
  expect(input.value).toBe('')
  props.addImages.mockClear()
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files, getData: () => '' } })
  await act(async () => { document.querySelector('textarea')!.dispatchEvent(drop) })
  expect(props.addImages).toHaveBeenCalledExactlyOnceWith(files)
  expect(props.replaceText).not.toHaveBeenCalled()
})

it('renders ordered mixed content with frozen mention labels and bounded queued reasons', async () => {
  const base = teamState(), chat = chatState(base), message = { ...chat.entries[0]!, formatVersion: 3 as const, text: 'flattened must not duplicate',
    content: [{ type: 'text' as const, text: '前文' }, historyImage, { type: 'mention' as const, memberId: 'member' }, { type: 'text' as const, text: '后文' }], mentionLabels: [{ memberId: 'member', label: '当时的名字' }],
    delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'member', state: 'queued' as const, deferredReason: 'image-model-unsupported' as const }] } }
  const props = chatProps(base, { ...chat, entries: [message] })
  await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
  const content = document.querySelector('[data-public-content]')!
  expect([...content.querySelectorAll('[data-public-text] > span, [data-public-image]')].map(node => node.textContent)).toEqual(['前文', '参考.png', '@当时的名字', '后文'])
  expect(content.textContent).not.toContain('flattened')
  expect(document.querySelector('[data-recipient]')?.textContent).toContain(t('public.deferred.image-model-unsupported'))
  expect(props.image).toHaveBeenCalledOnce()
})

it('renders system assistance provenance and localizes assistance closure', async () => {
  const base = teamState(), chat = chatState(base), message = { ...chat.entries[0]!, formatVersion: 3 as const, author: { kind: 'system' as const },
    assistance: { kind: 'result' as const, assistanceId: 'assist', sourceMessageId: 'not-loaded', imageIds: ['image-1'], requesterSessionId: 'requester', helperSessionId: 'helper', expiresAt: 10, resultId: 'result', outcome: { state: 'failed' as const, reason: 'expired' as const } },
    delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'helper', state: 'not-delivered' as const, reason: 'assistance-closed' as const, settledAt: 10 }] } }
  await render(<TeamPublicChat {...chatProps(base, { ...chat, entries: [message] }) as ComponentProps<typeof TeamPublicChat>} />)
  expect(document.querySelector('.swarm-public__meta strong')?.textContent).toBe(t('public.system'))
  expect(document.querySelector('[data-public-assistance]')?.textContent).toContain(t('public.assistanceOutside', { id: 'not-loaded' }))
  expect(document.querySelector('[data-public-assistance]')?.textContent).toContain(t('public.assistanceFailed.expired'))
  expect(document.querySelector('[data-recipient]')?.textContent).toContain(t('public.notDeliveredReason.assistance-closed'))
})

it('resolves assistance participants by exact public identity and preserves unknown IDs', async () => {
  const base = chatState(teamState()).entries[0]!
  const request = { ...base, id: 'request', author: { kind: 'agent' as const, sessionId: 'requester', name: 'writer', displayName: '原写作者', role: 'member' as const } }
  const message = { ...base, id: 'result', formatVersion: 3 as const,
    author: { kind: 'agent' as const, sessionId: 'helper', name: 'vision', displayName: '原视觉员', role: 'member' as const },
    assistance: { kind: 'result' as const, assistanceId: 'assist', sourceMessageId: 'not-loaded', imageIds: ['image-1'], requesterSessionId: 'requester', helperSessionId: 'helper', expiresAt: 10, resultId: 'result', outcome: { state: 'completed' as const, summary: 'Done' } } }
  const props = { message, entries: [request, message], image: async () => new Blob(['png']), t: t as ComponentProps<typeof PublicMessageContent>['t'],
    memberLabels: [{ memberId: 'helper', label: '现在视觉员' }, { memberId: 'requester', label: '现在写作者' }] }
  await render(<PublicMessageContent {...props} />)
  expect(document.querySelector('[data-public-assistance] strong')?.textContent).toBe(t('public.assistanceRequest', { requester: '原写作者', helper: '原视觉员' }))
  await act(async () => { mounted.at(-1)!.render(<PublicMessageContent {...props} entries={[]} message={{ ...message, author: { kind: 'system' } }} />) })
  expect(document.querySelector('[data-public-assistance] strong')?.textContent).toBe(t('public.assistanceRequest', { requester: '现在写作者', helper: '现在视觉员' }))
  await act(async () => { mounted.at(-1)!.render(<PublicMessageContent {...props} memberLabels={[]} entries={[]} message={{ ...message, author: { kind: 'system' } }} />) })
  expect(document.querySelector('[data-public-assistance] strong')?.textContent).toBe(t('public.assistanceRequest', { requester: 'requester', helper: 'helper' }))
})

it('labels an assistance receipt with its actual helper instead of the Captain', async () => {
  const state = teamState(), chat = chatState(state)
  const message = { ...chat.entries[0]!, formatVersion: 3 as const, author: { kind: 'agent' as const, role: 'member' as const, sessionId: 'requester', name: 'Writer' },
    assistance: { kind: 'request' as const, assistanceId: 'assist', sourceMessageId: 'source', imageIds: ['image-1'], requesterSessionId: 'requester', helperSessionId: 'helper', expiresAt: 10 },
    delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'helper', state: 'queued' as const }] } }
  const helper = { ...chat.entries[0]!, id: 'helper-reply', author: { kind: 'agent' as const, role: 'member' as const, sessionId: 'helper', name: 'Vision' } }
  await render(<TeamPublicChat {...chatProps(state, { ...chat, entries: [message, helper] }) as ComponentProps<typeof TeamPublicChat>} />)
  expect(document.querySelector('[data-recipient="helper"] > span')?.textContent).toBe('Vision')
})


it('uses actual Edge for responsive image layout, modal focus/Escape, lazy reads and URL cleanup', async () => {
  const { publicImagesBrowserScript } = await import('./helpers/public-images-browser.js')
  const { chromium } = await import('playwright'), { mkdir } = await import('node:fs/promises'), { join } = await import('node:path')
  const script = await publicImagesBrowserScript(), browser = await chromium.launch({ channel: 'msedge', headless: true })
  const team = teamState(), chat = chatState(team)
  const message = { ...chat.entries[0]!, formatVersion: 3 as const, content: [{ type: 'text' as const, text: '请查看这张参考图，核对结构和配色。' }, historyImage, { type: 'mention' as const, memberId: 'helper' }], mentionLabels: [{ memberId: 'helper', label: '视觉协助员' }], delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'helper', state: 'queued' as const, deferredReason: 'image-model-unsupported' as const }] } }
  const fixture = { ...chat, history: { ...chat.history!, imageAvailability: { state: 'available' as const, imageLimits: { ...chat.history!.imageAvailability.state === 'available' ? chat.history!.imageAvailability.imageLimits : {}, maxImageBytes: 200000, maxMessageImageBytes: 500000 } } }, entries: [message], draft: { ...chat.draft, text: '这两处有什么区别？', images: [draftImage] } }
  const directory = process.env['SWARM_UI_EVIDENCE_DIR']
  if (directory) await mkdir(directory, { recursive: true })
  try {
    for (const width of [390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const pageErrors: string[] = []
      page.on('pageerror', error => { pageErrors.push(error.message) })
      await page.setContent(`<style>body{margin:0;font-family:system-ui;background:#f4f5f7;--dsw-alias-label-primary:#223047;--dsw-alias-label-secondary:#69778c;--dsw-alias-bg-base:#f8f9fc;--dsw-alias-bg-layer-1:white;--dsw-alias-border-l2:#d8deea;--dsw-alias-state-business-primary:#4267bc}#fixture-root{height:900px}.fixture-modal-root{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center}.fixture-modal-mask{position:absolute;inset:0;background:#0009}.fixture-modal-dialog{position:relative}</style><div id="fixture-root"></div>`)
      await page.addScriptTag({ content: script })
      await page.evaluate(async ({ team: teamValue, chat: chatValue }) => { await (window as unknown as { mountChat: (team: unknown, chat: unknown) => Promise<void> }).mountChat(teamValue, chatValue) }, { team, chat: fixture })
      await page.locator('[data-public-image] img').waitFor()
      await page.locator('[data-draft-image] img').waitFor()
      const bounds = await page.evaluate(() => { const root = document.querySelector<HTMLElement>('[data-swarm-public-chat]')!, send = root.querySelector('[data-public-send]')!.getBoundingClientRect(); return { overflow: root.scrollWidth-root.clientWidth, sendBottom: send.bottom, bottom: root.getBoundingClientRect().bottom, reads: (window as unknown as { reads: number }).reads } })
      expect(bounds.overflow).toBeLessThanOrEqual(1); expect(bounds.sendBottom).toBeLessThanOrEqual(bounds.bottom); expect(bounds.reads).toBe(1)
      if (directory) await page.screenshot({ path: join(directory, `images-${width}.png`), fullPage: true })
      const thumb = page.locator('[data-public-image] .swarm-public__image-thumb')
      await thumb.click(); await page.getByRole('dialog').waitFor({ timeout: 3000 })
      await expect.poll(() => page.getByRole('button', { name: '关闭大图', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
      await page.keyboard.press('Tab')
      expect(await page.getByRole('button', { name: '关闭大图', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
      if (directory && width === 390) await page.screenshot({ path: join(directory, 'image-modal-390.png'), fullPage: true })
      await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' })
      expect(await thumb.evaluate(node => node === document.activeElement)).toBe(true)
      await page.evaluate(() => { (window as unknown as { unmountChat: () => void }).unmountChat() })
      await expect.poll(() => page.evaluate(() => { const w = window as unknown as { created: string[]; revoked: string[] }; return w.created.length > 0 && w.created.every(url => w.revoked.includes(url)) })).toBe(true)
      expect(pageErrors).toEqual([])
      await page.close()
    }
  } finally { await browser.close() }
}, 60_000)


it('defers offscreen reads, retries only its failed image, and aborts pending reads on unmount', async () => {
  let intersect!: IntersectionObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback } observe = vi.fn(); disconnect = disconnect })
  const read = vi.fn(async (_messageId: string, _imageId: string, _signal: AbortSignal) => new Blob(['png']))
  read.mockRejectedValueOnce(new Error('private provider data'))
  await render(<MessageImage messageId="message" image={historyImage} read={read} t={t as ComponentProps<typeof MessageImage>['t']} />)
  expect(read).not.toHaveBeenCalled()
  await act(async () => { intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver) })
  expect(read).toHaveBeenCalledOnce()
  expect(document.querySelector('[role=alert]')?.textContent).toContain(t('public.imageReadFailed'))
  expect(document.body.textContent).not.toContain('private provider')
  await act(async () => { document.querySelector<HTMLButtonElement>('[role=alert] button')!.click() })
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls.every(call => call[0] === 'message' && call[1] === historyImage.imageId)).toBe(true)
  const signal = read.mock.calls[1]![2]
  await act(async () => { mounted.pop()!.unmount() })
  expect(signal.aborted).toBe(true)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-image')
})


it.each(['public.imageRejected', 'public.imageServiceUnavailable'] as const)('translates the known controller error %s', async error => {
  const base = teamState()
  await render(<TeamPublicChat {...chatProps(base, { ...chatState(base), error }) as ComponentProps<typeof TeamPublicChat>} />)
  expect(document.querySelector('.swarm-public__composer [role=alert]')?.textContent).toContain(t(error))
  expect(document.querySelector('.swarm-public__composer [role=alert]')?.textContent).not.toContain(error)
})
it('retains other controller error messages verbatim', async () => {
  const base = teamState(), error = 'An unrelated transport error'
  await render(<TeamPublicChat {...chatProps(base, { ...chatState(base), error }) as ComponentProps<typeof TeamPublicChat>} />)
  expect(document.querySelector('.swarm-public__composer [role=alert]')?.textContent).toContain(error)
})
it.each(['ready', 'saving', 'loading', 'conflict', 'unavailable'] as const)('handles Ctrl Enter during %s draft persistence', async draftStatus => {
  const base = teamState(), props = chatProps(base, { ...chatState(base), draftStatus })
  await render(<TeamPublicChat {...props as ComponentProps<typeof TeamPublicChat>} />)
  await act(async () => { document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
  expect(props.send).toHaveBeenCalledTimes(draftStatus === 'ready' || draftStatus === 'saving' ? 1 : 0)
})
it('keeps an image read across ordinary refreshes and remounts it for another Team with the same message/image IDs', async () => {
  const base = teamState(), chat = chatState(base), entry = { ...chat.entries[0]!, formatVersion: 3 as const, content: [historyImage] }
  const props = chatProps(base, { ...chat, entries: [entry] })
  const image = vi.fn(async (_messageId: string, _imageId: string, _signal: AbortSignal) => new Blob(['png']))
  await render(<TeamPublicChat {...{ ...props, image } as ComponentProps<typeof TeamPublicChat>} />)
  expect(image).toHaveBeenCalledOnce()
  const refreshed = chatProps({ ...base, data: { ...base.data! } }, { ...chat, entries: [{ ...entry }] })
  await act(async () => { mounted.at(-1)!.render(<TeamPublicChat {...{ ...refreshed, image } as ComponentProps<typeof TeamPublicChat>} />) })
  expect(image).toHaveBeenCalledOnce()
  const nextTeam = { ...base, data: { ...base.data!, projection: { ...base.data!.projection, binding: { rootSessionId: 'captain-b', teamId: 'b' } } } }
  const nextChat = { ...chat, selection: { ...chat.selection!, key: 'draft-key-b', team: 'b', captain: 'captain-b' }, entries: [{ ...entry }] }
  await act(async () => { mounted.at(-1)!.render(<TeamPublicChat {...{ ...chatProps(nextTeam, nextChat), image } as ComponentProps<typeof TeamPublicChat>} />) })
  expect(image).toHaveBeenCalledTimes(2)
  expect(image.mock.calls[0]![2].aborted).toBe(true)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-image')
})


it('keeps real React activity, folds, quote access and reading position stable in Edge', async () => {
  const { publicImagesBrowserScript } = await import('./helpers/public-images-browser.js')
  const { chromium } = await import('playwright'), { mkdir } = await import('node:fs/promises'), { join } = await import('node:path')
  const browser = await chromium.launch({ channel: 'msedge', headless: true }), script = await publicImagesBrowserScript()
  const team = teamState(), chat = chatState(team), source = chat.entries[0]!
  const longText = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行：按已批准交互稿保留真实任务、消息和阅读位置。`).join('\n')
  const entries = Array.from({ length: 12 }, (_, i) => ({ ...source, id: `message-${i}`, sequence: i + 1,
    text: i === 0 ? longText : `第 ${i + 1} 条简短消息`, content: [{ type: 'text' as const, text: i === 0 ? longText : `第 ${i + 1} 条简短消息` }], ...(i === 1 ? { replyTo: 'message-0' } : {}) }))
  const fixture = { ...chat, entries, history: { ...chat.history!, hasEarlier: true, hasMore: true } }
  const activity = { selection: chat.selection, verified: true, loading: false, error: undefined,
    entries: Array.from({ length: 4 }, (_, i) => ({ id: `event-${i}`, sequence: i + 1, kind: 'task-created', taskId: `task-${i}`, actor: { kind: 'local-operator' }, occurredAt: 1000 + i })),
    referencedRequests: [], activity: { retainedFromSequence: 1, throughSequence: 4, hasMore: true } }
  const directory = process.env['SWARM_UI_EVIDENCE_DIR']; if (directory) await mkdir(directory, { recursive: true })
  type Driver = { mountChat: (team: unknown, chat: unknown, activity: unknown) => Promise<void>; updateChat: (team: unknown, chat: unknown, activity?: unknown) => void; actions: unknown[] }
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 })
      const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message) })
      await page.setContent(`<style>body{margin:0;font-family:system-ui;--dsw-alias-label-primary:#223047;--dsw-alias-label-secondary:#69778c;--dsw-alias-bg-base:#f8f9fc;--dsw-alias-bg-layer-1:white;--dsw-alias-border-l2:#d8deea;--dsw-alias-state-business-primary:#4267bc}#fixture-root{height:900px}.fixture-modal-root{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center}.fixture-modal-mask{position:absolute;inset:0;background:#0009}.fixture-modal-dialog{position:relative}</style><div id="fixture-root"></div>`)
      await page.addScriptTag({ content: script })
      await page.evaluate(viewer => { (window as unknown as { sessionState: unknown }).sessionState = { phase: 'ready', current: viewer, byId: { [viewer]: { displayTitle: '浏览器测试会话', projectionValues: { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 30 }, sessionStats: { turns: 3, steps: 8, decodeTokens: 120, decodeMs: 2000 } } } } } }, chat.selection!.viewer)
      await page.evaluate(async ({ team: teamValue, fixture: chatValue, activity: activityValue }) => { await (window as unknown as Driver).mountChat(teamValue, chatValue, activityValue) }, { team, fixture, activity })
      await page.locator('[data-work-collapse]').waitFor()
      await page.getByRole('button', { name: '200 tok', exact: true }).click()
      await page.getByRole('dialog', { name: 'Token 用量', exact: true }).waitFor()
      expect(await page.getByRole('dialog').textContent()).toContain('浏览器测试会话')
      expect(await page.getByRole('dialog').textContent()).toContain('缓存读取50')
      if (directory) await page.screenshot({ path: join(directory, `statistics-${width}.png`) })
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'detached' })
      expect(await page.getByRole('button', { name: '200 tok', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
      const box = page.locator('.swarm-public__messages'), long = page.locator('[data-public-message="message-0"]'), short = page.locator('[data-public-message="message-1"]')
      await expect.poll(() => long.locator('[data-public-expand]').count()).toBe(1)
      expect(await short.locator('[data-public-expand]').count()).toBe(0)
      expect(await long.locator('[data-public-text]').evaluate(node => node.clientHeight <= parseFloat(getComputedStyle(node).lineHeight) * 6 + 1)).toBe(true)
      expect(await page.locator('[data-work-event]').first().evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(width === 390 ? 120 : 70)
      if (directory) await page.screenshot({ path: join(directory, `activity-chat-${width}.png`) })
      await page.locator('[data-work-collapse]').click()
      expect(await page.locator('[data-work-collapse]').getAttribute('aria-expanded')).toBe('false')
      expect(await page.locator('[data-work-event]').first().isVisible()).toBe(false)
      await long.locator('[data-public-expand]').click()
      expect(await long.locator('[data-public-text]').getAttribute('data-expanded')).toBe('true')
      await long.locator('[data-public-expand]').click()
      expect(await long.locator('[data-public-text]').getAttribute('data-expanded')).toBe('false')
      const quote = short.locator('[data-public-quote-trigger]')
      await quote.scrollIntoViewIfNeeded()
      if (width === 390) await quote.tap(); else await quote.hover()
      await expect.poll(() => quote.getAttribute('aria-expanded')).toBe('true')
      expect(await page.locator('[data-public-quote-full]').textContent()).toContain(longText)
      expect(await quote.evaluate(node => getComputedStyle(node).textOverflow)).toBe('ellipsis')
      if (directory) await page.screenshot({ path: join(directory, `quote-chat-${width}.png`) })
      await quote.focus(); await page.keyboard.press('Tab')
      expect(await page.getByRole('link', { name: '定位原消息' }).evaluate(node => node === document.activeElement)).toBe(true)
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
      expect(await page.locator('[data-public-quote-full]').evaluate(node => node === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await quote.getAttribute('aria-expanded')).toBe('false')
      await page.locator('[data-public-navigation] summary').click()
      await page.getByRole('button', { name: '已载入消息末尾', exact: true }).click()
      expect(await box.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2)
      // Read a middle message, then add earlier/newer pages and resize content above it.
      const anchor = page.locator('[data-public-message="message-5"]')
      await anchor.evaluate(node => { const scrolling = node.closest('.swarm-public__messages')!; scrolling.scrollTop += node.getBoundingClientRect().top - scrolling.getBoundingClientRect().top - 12; scrolling.dispatchEvent(new Event('scroll')) })
      const offset = () => anchor.evaluate(node => node.getBoundingClientRect().top - node.closest('.swarm-public__messages')!.getBoundingClientRect().top)
      const before = await offset()
      const more = { ...fixture, entries: [{ ...source, id: 'earlier', sequence: 0 }, ...entries, { ...source, id: 'later', sequence: 13 }] }
      await page.evaluate(({ team: teamValue, more: chatValue }) => { (window as unknown as Driver).updateChat(teamValue, chatValue) }, { team, more })
      await page.locator('[data-public-message="later"]').waitFor({ state: 'attached' })
      await expect.poll(offset).toBeCloseTo(before, 0)
      const other = { ...more, selection: { ...more.selection!, key: 'other-view' }, entries: [{ ...source, id: 'other' }] }
      await page.evaluate(({ team: teamValue, other: chatValue }) => { (window as unknown as Driver).updateChat(teamValue, chatValue) }, { team, other })
      await page.locator('[data-public-message="other"]').waitFor()
      await page.evaluate(({ team: teamValue, more: chatValue }) => { (window as unknown as Driver).updateChat(teamValue, chatValue) }, { team, more })
      await expect.poll(offset).toBeCloseTo(before, 0)
      expect(await page.locator('[data-work-collapse]').getAttribute('aria-expanded')).toBe('false')
      await page.locator('[data-public-navigation] summary').click()
      await page.getByRole('button', { name: '任务活动 · 群聊顶部', exact: true }).click()
      await expect.poll(() => box.evaluate(node => node.scrollTop)).toBe(0)
      expect(await page.locator('[data-work-collapse]').getAttribute('aria-expanded')).toBe('true')
      expect(await page.locator('[data-swarm-public-chat]').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      // The composer quote remains readable above its independently scrolling area.
      const replying = { ...more, draft: { ...more.draft, replyTo: 'message-0' } }
      await page.evaluate(({ team: teamValue, replying: chatValue }) => { (window as unknown as Driver).updateChat(teamValue, chatValue) }, { team, replying })
      const composerQuote = page.locator('.swarm-public__composer [data-public-quote-trigger]')
      await composerQuote.focus()
      await page.locator('[data-public-quote-full]').waitFor()
      const popupBounds = await page.locator('.swarm-public__quote-pop').boundingBox()
      expect(popupBounds!.y).toBeGreaterThanOrEqual(0); expect(popupBounds!.y + popupBounds!.height).toBeLessThanOrEqual(900)
      if (directory) await page.screenshot({ path: join(directory, `composer-quote-${width}.png`) })
      await page.getByRole('link', { name: '定位原消息' }).click()
      await expect.poll(() => long.evaluate(node => node.getBoundingClientRect().top - node.closest('.swarm-public__messages')!.getBoundingClientRect().top)).toBeCloseTo(0, 0)
      // A slow image preceding the text in the SAME article must not move that text.
      await page.evaluate(() => { const w = window as unknown as { imageWait: Promise<void>; releaseImage: () => void }; w.imageWait = new Promise(resolve => { w.releaseImage = resolve }) })
      const imageFirst = { ...more, entries: [{ ...entries[0]!, content: [historyImage, { type: 'text' as const, text: longText }] }, ...entries.slice(1)] }
      await page.evaluate(({ team: teamValue, imageFirst: chatValue }) => { (window as unknown as Driver).updateChat(teamValue, chatValue) }, { team, imageFirst })
      await long.locator('[data-public-image]').scrollIntoViewIfNeeded()
      await page.waitForFunction(() => document.querySelector('[data-public-image] [aria-busy=true]') !== null || (window as unknown as { reads: number }).reads > 0)
      const textAfterImage = long.locator('[data-public-text]')
      await textAfterImage.evaluate(node => { const scrolling = node.closest('.swarm-public__messages')!; scrolling.scrollTop += node.getBoundingClientRect().top - scrolling.getBoundingClientRect().top; scrolling.dispatchEvent(new Event('scroll')) })
      const textOffset = () => textAfterImage.evaluate(node => node.getBoundingClientRect().top - node.closest('.swarm-public__messages')!.getBoundingClientRect().top)
      const imageBefore = await textOffset()
      await page.evaluate(() => { (window as unknown as { releaseImage: () => void }).releaseImage() })
      await long.locator('[data-public-image] img').waitFor({ state: 'attached' })
      await expect.poll(textOffset).toBeCloseTo(imageBefore, 0)
      // When only the header/image is visible, never chase text below the viewport.
      await page.evaluate(() => { const w = window as unknown as { imageWait: Promise<void>; releaseImage: () => void }; w.imageWait = new Promise(resolve => { w.releaseImage = resolve }) })
      const imageHead = { ...more, entries: [...entries.slice(1, 6), { ...imageFirst.entries[0]!, id: 'image-head' }, ...entries.slice(6)] }
      await page.evaluate(({ team: teamValue, imageHead: chatValue }) => { (window as unknown as Driver).updateChat(teamValue, chatValue) }, { team, imageHead })
      const head = page.locator('[data-public-message="image-head"]')
      await head.waitFor({ state: 'attached' })
      await head.evaluate(node => { const scrolling = node.closest('.swarm-public__messages')!; scrolling.scrollTop += node.getBoundingClientRect().top - scrolling.getBoundingClientRect().bottom + 45; scrolling.dispatchEvent(new Event('scroll')) })
      expect(await head.locator('[data-public-text]').evaluate(node => node.getBoundingClientRect().top >= node.closest('.swarm-public__messages')!.getBoundingClientRect().bottom)).toBe(true)
      const headOffset = () => head.evaluate(node => node.getBoundingClientRect().top - node.closest('.swarm-public__messages')!.getBoundingClientRect().top)
      const headBefore = await headOffset()
      await page.evaluate(() => { (window as unknown as { releaseImage: () => void }).releaseImage() })
      await head.locator('[data-public-image] img').waitFor({ state: 'attached' })
      await expect.poll(headOffset).toBeCloseTo(headBefore, 0)
      expect(errors).toEqual([])
      await page.close()
    }
  } finally { await browser.close() }
}, 60_000)
