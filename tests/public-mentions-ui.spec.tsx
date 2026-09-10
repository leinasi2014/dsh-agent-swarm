// @vitest-environment jsdom
import { ready, render, t, tZh } from './helpers/dashboard-ui.js'
import { act, useState, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MentionComposer } from '../src/client/MentionComposer.js'
import { DirectoryMembers } from '../src/client/DirectoryMembers.js'
import { editDraft, replaceDraftRange, draftContent, type PublicDraft } from '../src/client/public-draft.js'
import { hasUnconfirmedPublicMention } from '../src/shared/public-content.js'
import { directoryEntry, directoryPage } from './helpers/public-directory.js'
import type { PublicChatController, PublicChatState } from '../src/client/public-chat-controller.js'

const empty: PublicDraft = { text: '', version: 0, tokens: [] }
function editor(initial: PublicDraft, initialEntries = [directoryEntry(), directoryEntry('member-b')]) {
  let latest = initial
  let updateEntries!: (entries: typeof initialEntries) => void
  const send = vi.fn(), refresh = vi.fn()
  function Harness() {
    const [draft, setDraft] = useState(initial); latest = draft
    const [entries, setEntries] = useState(initialEntries); updateEntries = setEntries
    return <MentionComposer draft={draft} entries={entries} directoryError={undefined} directoryLoading={false} t={t as ComponentProps<typeof MentionComposer>['t']}
      edit={text => { setDraft(old => editDraft(old, text)) }} replaceText={(start, end, text) => { setDraft(old => replaceDraftRange(old, start, end, text)) }}
      choose={(start, end, id) => { setDraft(old => replaceDraftRange(old, start, end, '@同舟', { memberId: id, label: '同舟' })) }}
      remove={(start, reselect) => { setDraft(old => replaceDraftRange(old, start, old.tokens.find(row => row.start === start)!.end, reselect ? '@' : '')) }}
      refreshDirectory={refresh} send={send} canSend={!hasUnconfirmedPublicMention(draftContent(draft))} />
  }
  return { node: <Harness />, send, refresh, draft: () => latest, updateEntries: (entries: typeof initialEntries) => { updateEntries(entries) } }
}
async function pressKey(keyName: string, options = {}): Promise<void> { await act(async () => { document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...options })) }) }
function transfer(type: 'paste' | 'cut' | 'drop', text: string) {
  const event = new Event(type, { bubbles: true, cancelable: true }), data = { getData: (format: string) => format === 'text/plain' ? text : '', setData: vi.fn() }
  Object.defineProperty(event, type === 'drop' ? 'dataTransfer' : 'clipboardData', { value: data })
  return { event, data }
}
describe('stable mention editor interactions', () => {
  it('opens after Chinese text, follows keyboard active descendant, confirms the exact same-name row', async () => {
    const f = editor({ ...empty, text: '请@同舟' }); await render(f.node)
    expect(document.querySelectorAll('[role=option]')).toHaveLength(2)
    await pressKey('ArrowDown')
    expect(document.querySelector('textarea')?.getAttribute('aria-activedescendant')).toBe(document.querySelectorAll('[role=option]')[1]!.id)
    await pressKey('Enter')
    expect(f.draft().tokens[0]?.memberId).toBe('member-b')
    expect(document.querySelector('[role=listbox]')).toBeNull(); expect(f.send).not.toHaveBeenCalled()
    await pressKey('Enter', { ctrlKey: true }); expect(f.send).toHaveBeenCalledOnce()
  })
  it('Esc only dismisses candidates, preserving unconfirmed input and preventing CtrlEnter send', async () => {
    const f = editor({ ...empty, text: '请@同舟' }); await render(f.node); await pressKey('Escape'); await pressKey('Enter', { ctrlKey: true })
    expect(document.querySelector('[role=listbox]')).toBeNull(); expect(f.send).not.toHaveBeenCalled()
    expect(f.draft().tokens).toEqual([]); expect(document.body.textContent).toContain(t('public.unconfirmed'))
  })
  it('does not confirm a candidate or send during IME Enter', async () => {
    const f = editor({ ...empty, text: '请@同舟' }); await render(f.node)
    await pressKey('Enter', { isComposing: true }); await pressKey('Enter', { keyCode: 229, ctrlKey: true })
    expect(f.draft().tokens).toEqual([]); expect(f.send).not.toHaveBeenCalled()
  })
  it.each(['paste', 'drop'] as const)('identical-text %s over a selected token removes receiving identity', async operation => {
    const f = editor(replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })); await render(f.node)
    const textarea = document.querySelector('textarea')!; textarea.setSelectionRange(0, 3)
    const { event } = transfer(operation, '@同舟'); await act(async () => { textarea.dispatchEvent(event) })
    expect(f.draft().text).toBe('@同舟'); expect(f.draft().tokens).toEqual([])
    await pressKey('Escape'); await pressKey('Enter', { ctrlKey: true }); expect(f.send).not.toHaveBeenCalled()
  })
  it('cutting part of a token copies only selected text and removes the whole token', async () => {
    const f = editor(replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })); await render(f.node)
    const textarea = document.querySelector('textarea')!; textarea.setSelectionRange(1, 2)
    const { event, data } = transfer('cut', ''); await act(async () => { textarea.dispatchEvent(event) })
    expect(data.setData).toHaveBeenCalledWith('text/plain', '同'); expect(f.draft().text).toBe(''); expect(f.draft().tokens).toEqual([])
  })
  it('pasted text never creates identity and email/escaped @ stays literal', async () => {
    const f = editor(empty); await render(f.node)
    const { event } = transfer('paste', 'a@example.com \\@同舟'); await act(async () => { document.querySelector('textarea')!.dispatchEvent(event) })
    expect(f.draft().tokens).toEqual([]); expect(hasUnconfirmedPublicMention(draftContent(f.draft()))).toBe(false)
  })
  it('touching a token atomically deletes it while preserving adjacent identities', () => {
    const first = replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })
    const both = replaceDraftRange(first, 3, 3, '@同舟', { memberId: 'member-b', label: '同舟' })
    const edited = editDraft(both, '@舟@同舟')
    expect(edited.text).toBe('@同舟'); expect(edited.tokens.map(token => token.memberId)).toEqual(['member-b'])
  })
})
it('shared directory card shows authoritative fields, keeps diagnostics collapsed and returns focus on Esc', async () => {
  const page = directoryPage(), state = { selection: { team: 'a', captain: 'captain-a', key: 'key', viewer: 'viewer', revision: 1 }, entries: [], history: undefined, draft: empty, pending: false, legacyUpgrade: false, sending: false, loading: false, error: undefined, directory: { ...page, totalCount: 2 }, directoryLoading: false, directoryError: undefined } as PublicChatState
  const chat = { getSnapshot: () => state, subscribe: () => () => {}, refreshDirectory: vi.fn(async () => {}) } as unknown as PublicChatController
  await render(<DirectoryMembers chat={chat} t={t as ComponentProps<typeof MentionComposer>['t']} />)
  const avatar = document.querySelector<HTMLButtonElement>('[data-directory-member="member-a"]')!
  await act(async () => { avatar.click() })
  const card = document.querySelector<HTMLElement>('[data-directory-card]')!
  expect(card.textContent).toContain('核对文字'); expect(card.textContent).toContain('校对员')
  expect(card.textContent).not.toContain(t('directory.imageUnknown')); expect(card.querySelector('details')?.open).toBe(false)
  expect(document.querySelector('[data-swarm-directory]')?.contains(card)).toBe(false)
  expect(card.closest('[role=dialog]')?.getAttribute('aria-modal')).toBe('false')
  expect(card.textContent).not.toContain('Open chat')
  const skills = [...card.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(button => button.textContent === t('directory.capabilities'))!
  await act(async () => { skills.click() }); expect(card.textContent).toContain('核对原文'); expect(card.textContent).toContain(t('directory.partial')); expect(card.textContent).toContain(t('directory.approval-required'))
  await act(async () => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('[data-directory-card]')).toBeNull(); expect(document.activeElement).toBe(avatar)
})

it.each(['Delete', 'Backspace'])('deletes the selected first same-name token using the actual %s selection', async keyName => {
  const first = replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })
  const both = replaceDraftRange(first, 3, 3, '@同舟', { memberId: 'member-b', label: '同舟' })
  const f = editor(both); await render(f.node)
  const textarea = document.querySelector('textarea')!; textarea.setSelectionRange(0, 3)
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)
    if (!event.defaultPrevented) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@同舟'); textarea.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  expect(f.draft().text).toBe('@同舟'); expect(draftContent(f.draft())).toEqual([{ type: 'mention', memberId: 'member-b' }])
})

it.each([
  ['Delete', 1, 2, '@舟@同舟'], ['Backspace', 1, 2, '@舟@同舟'],
  ['Delete', 0, 0, '同舟@同舟'], ['Backspace', 3, 3, '@同@同舟'],
] as const)('preserves the other same-name identity for %s range %i:%i', async (keyName, start, end, nativeText) => {
  const first = replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })
  const f = editor(replaceDraftRange(first, 3, 3, '@同舟', { memberId: 'member-b', label: '同舟' })); await render(f.node)
  const textarea = document.querySelector('textarea')!; textarea.setSelectionRange(start, end)
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }); textarea.dispatchEvent(event)
    if (!event.defaultPrevented) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, nativeText); textarea.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  expect(f.draft().text).toBe('@同舟'); expect(draftContent(f.draft())).toEqual([{ type: 'mention', memberId: 'member-b' }])
})
it('uses native beforeinput selection for an identical-text replacement without granting identity to the replacement', async () => {
  const first = replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })
  const f = editor(replaceDraftRange(first, 3, 3, '@同舟', { memberId: 'member-b', label: '同舟' })); await render(f.node)
  const textarea = document.querySelector('textarea')!; textarea.setSelectionRange(0, 3)
  await act(async () => {
    const event = new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: '@同舟', bubbles: true, cancelable: true }); textarea.dispatchEvent(event)
    if (!event.defaultPrevented) textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(f.draft().text).toBe('@同舟@同舟')
  expect(draftContent(f.draft())).toEqual([{ type: 'text', text: '@同舟' }, { type: 'mention', memberId: 'member-b' }])
  await pressKey('Escape'); await pressKey('Enter', { ctrlKey: true }); expect(f.send).not.toHaveBeenCalled()
})
it('invalidates ambiguous same-name identities if an input event has no edit-range evidence', async () => {
  const first = replaceDraftRange(empty, 0, 0, '@同舟', { memberId: 'member-a', label: '同舟' })
  const f = editor(replaceDraftRange(first, 3, 3, '@同舟', { memberId: 'member-b', label: '同舟' })); await render(f.node)
  const textarea = document.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@同舟'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(f.draft().text).toBe('@同舟'); expect(f.draft().tokens).toEqual([])
})

async function chineseProfile(summary: string) {
  const page = directoryPage()
  let snapshot: PublicChatState = { selection: { key: 'chinese-card', viewer: 'viewer', team: 'a', captain: 'captain-a', revision: 1 }, entries: [], history: undefined, draft: empty, pending: false, legacyUpgrade: false, sending: false, loading: false, error: undefined, directory: { ...page, totalCount: page.entries.length }, directoryLoading: false, directoryError: undefined }
  const subscribers = new Set<() => void>()
  const chat = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener) } }, refreshDirectory: vi.fn(async () => {}) } as unknown as PublicChatController
  const data = ready.data!
  const dashboard = { ...ready, data: { ...data, projection: { ...data.projection, binding: page.binding }, captainMembers: { ...data.captainMembers, binding: page.binding, members: [{ ...data.captainMembers.members[0]!, sessionId: 'member-a', growthSummary: summary }] } } }
  await render(<DirectoryMembers chat={chat} dashboard={dashboard} t={tZh as ComponentProps<typeof DirectoryMembers>['t']} />)
  const avatar = document.querySelector<HTMLButtonElement>('[data-directory-member="member-a"]')!
  await act(async () => { avatar.click() })
  return { avatar, unavailable: async () => { await act(async () => { snapshot = { ...snapshot, directory: undefined }; subscribers.forEach(listener => { listener() }) }) } }
}
it.each([
  ['Retained history: 0 accepted tasks · 0 rejected attempts', '保留记录：通过审核的任务 0 项 · 被驳回的尝试 0 次'],
  ['Retained history: 1 accepted task · 2 rejected attempts', '保留记录：通过审核的任务 1 项 · 被驳回的尝试 2 次'],
  ['Retained history: 2 accepted tasks · 1 rejected attempt', '保留记录：通过审核的任务 2 项 · 被驳回的尝试 1 次'],
  ['Member-authored public summary', 'Member-authored public summary'],
  ['Retained history: 0 accepted tasks · 0 rejected attempts; additional source detail', 'Retained history: 0 accepted tasks · 0 rejected attempts; additional source detail'],
])('localizes only the complete known retained-history summary: %s', async (summary, expected) => {
  await chineseProfile(summary)
  const card = document.querySelector<HTMLElement>('[data-directory-card]')!
  const results = [...card.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(button => button.textContent === '成果')!
  await act(async () => { results.click() })
  expect(card.querySelector('[role=tabpanel]')?.textContent).toContain(expected)
})
it('labels profile close, restores avatar focus and dismisses an unavailable member', async () => {
  const view = await chineseProfile('Retained history: 0 accepted tasks · 0 rejected attempts')
  const close = document.querySelector<HTMLButtonElement>('[data-directory-card] header button')!
  expect(close.getAttribute('aria-label')).toBe('关闭成员资料')
  await act(async () => { close.click() })
  expect(document.querySelector('[data-directory-card]')).toBeNull()
  expect(document.querySelector('[data-swarm-directory]')).not.toBeNull(); expect(document.activeElement).toBe(view.avatar)
  await act(async () => { view.avatar.click() }); await view.unavailable()
  expect(document.querySelector('[data-directory-card]')).toBeNull()
})

it('scrolls only the candidate list to reveal keyboard selection and rechecks changed row geometry', async () => {
  let rowHeight = 73
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'listbox') return new DOMRect(73, 631, 366, 160)
    if (this.getAttribute('role') === 'option') {
      const list = this.parentElement!, index = [...list.children].indexOf(this)
      return new DOMRect(73, 631 + index * rowHeight - list.scrollTop, 358, rowHeight)
    }
    return originalRect.call(this)
  })
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'listbox' ? 160 : 0 })
  const page = document.documentElement, messageList = document.body.appendChild(document.createElement('div'))
  page.scrollTop = 400; messageList.scrollTop = 75
  try {
    const rows = [directoryEntry(), directoryEntry('member-b'), directoryEntry('member-c')]
    const f = editor({ ...empty, text: '请@同舟' }, rows); await render(f.node)
    const list = document.querySelector<HTMLElement>('[role=listbox]')!
    await pressKey('ArrowDown'); await pressKey('ArrowDown')
    expect(document.querySelector('[role=option][aria-selected=true]')?.getAttribute('data-mention-candidate')).toBe('member-c')
    expect(list.scrollTop).toBe(59)
    rowHeight = 90
    await act(async () => { f.updateEntries(rows.map(row => ({ ...row, responsibility: 'Refreshed longer responsibility' }))) })
    expect(list.scrollTop).toBe(110)
    await pressKey('ArrowDown')
    expect(list.scrollTop).toBe(0)
    expect(page.scrollTop).toBe(400); expect(messageList.scrollTop).toBe(75)
  } finally { geometry.mockRestore(); height.mockRestore(); page.scrollTop = 0 }
})
