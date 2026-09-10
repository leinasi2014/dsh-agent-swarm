// @vitest-environment jsdom
import { render, tZh } from './helpers/dashboard-ui.js'
import { act, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DirectoryMembers } from '../src/client/DirectoryMembers.js'
import type { PublicChatController, PublicChatState } from '../src/client/public-chat-controller.js'
import { directoryEntry, directoryPage } from './helpers/public-directory.js'
import { chromium } from 'playwright'

const originalWidth = window.innerWidth
afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); vi.restoreAllMocks() })

async function fixture() {
  const page = directoryPage('a', [{ ...directoryEntry(), currentTasks: [{ id: 'work-1', subject: '核对正文', status: 'in_progress' }], biography: '长简介'.repeat(200) }, directoryEntry('member-b', '另一位')])
  let state: PublicChatState = { selection: { team: 'a', captain: 'captain-a', key: 'key', viewer: 'viewer', revision: 1 }, entries: [], history: undefined, draft: { text: '保留草稿', tokens: [], version: 1 }, pending: false, legacyUpgrade: false, sending: false, loading: false, error: undefined, directory: { ...page, totalCount: page.entries.length }, directoryLoading: false, directoryError: undefined }
  const listeners = new Set<() => void>(), task = vi.fn()
  const chat = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, refreshDirectory: vi.fn(async () => {}) } as unknown as PublicChatController
  await render(<><DirectoryMembers chat={chat} onTask={task} t={tZh as ComponentProps<typeof DirectoryMembers>['t']} /><button data-outside>Outside</button></>)
  return { task, state: () => state, update: async (patch: Partial<PublicChatState>) => { await act(async () => { state = { ...state, ...patch }; listeners.forEach(listener => { listener() }) }) } }
}
const avatar = (id = 'member-a'): HTMLButtonElement => document.querySelector(`[data-directory-member="${id}"]`)!
const card = (): HTMLElement | null => document.querySelector('[data-directory-card]')
const tab = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('[data-directory-card] [role=tab]')].find(node => node.textContent === label)!
async function click(node: HTMLElement): Promise<void> { await act(async () => { node.click() }) }
async function key(node: HTMLElement, value: string, shiftKey = false): Promise<void> { await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })) }) }

it('opens one click-owned body portal, separates profile from work/capabilities, and preserves the draft', async () => {
  const f = await fixture()
  await click(avatar())
  expect(document.querySelector('[data-swarm-directory]')?.contains(card())).toBe(false)
  expect(document.querySelector('[data-profile-surface]')?.parentElement).toBe(document.body)
  expect(document.activeElement).toBe(card()?.querySelector('h3'))
  expect([...card()!.querySelectorAll('[role=tab]')].map(node => node.textContent)).toEqual(['属性', '工作', '能力', '成果'])
  expect(card()?.querySelector('[role=tabpanel]')?.textContent).toContain('长简介')
  expect(card()?.querySelector('.swarm-profile__source>small time')?.getAttribute('datetime')).toBe(new Date(10).toISOString())
  expect(card()?.querySelector('[role=tabpanel]')?.textContent).not.toContain('核对正文')
  const body = card()!.querySelector<HTMLElement>('[role=tabpanel]')!; body.scrollTop = 300
  await click(tab('能力'))
  expect(body.scrollTop).toBe(0); expect(body.textContent).not.toContain('长简介')
  expect(body.textContent).toContain(tZh('directory.imageUnknown'))
  expect([...body.querySelectorAll<HTMLDetailsElement>('.swarm-profile__collection')].every(node => !node.open)).toBe(true)
  await click(tab('工作')); expect(body.querySelector('[title="work-1"]')?.textContent).toBe('work-1'); await click(body.querySelector('button')!)
  expect(f.task).toHaveBeenCalledWith('work-1'); expect(card()).toBeNull(); expect(f.state().draft.text).toBe('保留草稿')
  await click(avatar()); await click(avatar())
  expect(card()).toBeNull()
  await click(avatar()); await click(avatar('member-b'))
  expect(document.querySelectorAll('[data-directory-card]')).toHaveLength(1)
  expect(card()?.getAttribute('data-directory-card')).toBe('member-b')
  expect(tab('属性').getAttribute('aria-selected')).toBe('true')
})

it('dismisses on external pointer/Tab focus without stealing it, and restores the trigger on Escape', async () => {
  await fixture(); await click(avatar())
  const outside = document.querySelector<HTMLButtonElement>('[data-outside]')!
  await act(async () => { outside.dispatchEvent(new Event('pointerdown', { bubbles: true })); outside.focus() })
  expect(card()).toBeNull(); expect(document.activeElement).toBe(outside)
  await click(avatar()); await act(async () => { outside.focus() })
  expect(card()).toBeNull(); expect(document.activeElement).toBe(outside)
  await click(avatar()); await key(card()!, 'Escape')
  expect(card()).toBeNull(); expect(document.activeElement).toBe(avatar())
})

it('uses the official modal on a narrow viewport and traps focus only there', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  await fixture(); await click(avatar())
  expect(card()?.closest('[role=dialog]')?.getAttribute('aria-modal')).toBe('true')
  const close = card()!.querySelector<HTMLButtonElement>('header button')!
  await act(async () => { close.focus() }); await key(close, 'Tab', true)
  const last = document.activeElement as HTMLElement
  expect(last.tagName).toBe('SUMMARY'); await key(last, 'Tab')
  expect(document.activeElement).toBe(close)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-outside]')!.focus() })
  expect(document.activeElement).toBe(card()?.querySelector('h3'))
  await click(document.querySelector<HTMLElement>('.fixture-modal-mask')!)
  expect(card()).toBeNull(); expect(document.activeElement).toBe(avatar())
})

it('retains the member through resize and refresh, but closes on team change or member removal', async () => {
  const f = await fixture(); await click(avatar()); await click(tab('能力'))
  await f.update({ directoryLoading: true })
  expect(document.querySelector('[data-swarm-directory] [role=status]')).toBeNull()
  expect(document.querySelector('.swarm-directory__grid')?.getAttribute('aria-busy')).toBe('true')
  await f.update({ directoryLoading: false })
  await f.update({ directory: { ...f.state().directory!, entries: f.state().directory!.entries.map(row => ({ ...row, personality: '更新属性' })) } })
  expect(tab('能力').getAttribute('aria-selected')).toBe('true')
  await act(async () => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); window.dispatchEvent(new Event('resize')) })
  expect(card()?.getAttribute('data-directory-card')).toBe('member-a')
  expect(card()?.closest('[role=dialog]')?.getAttribute('aria-modal')).toBe('true')
  await f.update({ selection: { ...f.state().selection!, key: 'another-team' } })
  expect(card()).toBeNull()
  await click(avatar()); await f.update({ directory: { ...f.state().directory!, entries: [] } })
  expect(card()).toBeNull()
})

it('runs installed anchoring above/right-clamped near the viewport edge and closes when the anchor scrolls away', async () => {
  let top = 700
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-directory-member')) return new DOMRect(950, top, 48, 48)
    if (this.hasAttribute('data-profile-surface')) return new DOMRect(0, 0, 400, 500)
    return original.call(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-profile-surface') ? 400 : 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-profile-surface') ? 500 : 0 })
  await fixture(); await click(avatar())
  const surface = document.querySelector<HTMLElement>('[data-profile-surface]')!
  expect(surface.style.left).toBe(`${window.innerWidth - 412}px`)
  expect(surface.style.top).toBe('192px')
  await act(async () => { top = 650; window.dispatchEvent(new Event('scroll')) })
  expect(surface.style.top).toBe('142px'); expect(card()).not.toBeNull()
  await act(async () => { top = -100; window.dispatchEvent(new Event('scroll')) })
  expect(card()).toBeNull()
})

// Real CSS geometry on exported component markup; live installed-app acceptance is separate.
it.each([390, 768, 1280])('%spx bounds long profile content while keeping the header and tabs fixed', async width => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  const f = await fixture()
  await f.update({ directory: { ...f.state().directory!, entries: f.state().directory!.entries.map(row => ({ ...row, label: '很长的成员姓名'.repeat(30), responsibility: '职责摘要'.repeat(30) })) } })
  await click(avatar())
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    await page.setContent(document.body.innerHTML)
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-profile-surface]')!, body = panel.querySelector<HTMLElement>('.swarm-profile__body')!
      const header = panel.querySelector<HTMLElement>('header')!, tabs = panel.querySelector<HTMLElement>('[role=tablist]')!
      const before = [header.getBoundingClientRect().top, tabs.getBoundingClientRect().top]
      body.scrollTop = body.scrollHeight
      return { width: panel.getBoundingClientRect().width, right: panel.getBoundingClientRect().right, height: panel.getBoundingClientRect().height,
        avatar: panel.querySelector('.swarm-profile__avatar')!.getBoundingClientRect().width,
        overflow: panel.scrollWidth - panel.clientWidth, bodyHeight: body.clientHeight, scroll: body.scrollTop,
        before, after: [header.getBoundingClientRect().top, tabs.getBoundingClientRect().top], headerHeight: header.getBoundingClientRect().height }
    })
    expect(geometry.right).toBeLessThanOrEqual(width)
    expect(geometry.overflow).toBeLessThanOrEqual(1)
    expect(geometry.avatar).toBe(48)
    expect(geometry.height).toBeLessThanOrEqual(844)
    expect(geometry.headerHeight).toBeLessThan(145)
    expect(geometry.bodyHeight).toBeGreaterThan(160)
    expect(geometry.scroll).toBeGreaterThan(100)
    expect(geometry.after).toEqual(geometry.before)
  } finally { await browser.close() }
}, 60_000)

