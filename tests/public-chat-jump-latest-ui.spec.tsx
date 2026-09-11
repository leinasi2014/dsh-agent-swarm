// @vitest-environment jsdom
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { mounted, ready, render, t } from './helpers/dashboard-ui.js'
import { act, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TeamPublicChat } from '../src/client/TeamPublicChat.js'
import type { PublicChatState } from '../src/client/public-chat-controller.js'
import type { TeamDashboardState } from '../src/client/team-dashboard-controller.js'

// #276 floating "jump to latest" state machine. Semantics per root public-ec769327 (covers earlier shorthand):
// the entry exists whenever the view is not at the TRUE latest — hiding is limited to
// empty records or (hasMore=false && already at the loaded bottom). hasMore=true keeps the entry
// even when the loaded page is short or already scrolled to its bottom (a stale page tail is not latest).
// latest() call counts are asserted as increments over the entry effect's initial call (J5 pattern).
// Baseline (RED run): J1/J2/J2b/J3/J3b/J5/J6 fail. J4 is the keep-green keep-safe cell.

function chatState(state: TeamDashboardState, over: { hasMore?: boolean; empty?: boolean; key?: string; tail?: boolean; loading?: boolean; error?: string } = {}): PublicChatState {
  const binding = state.data!.projection.binding
  const selection = { key: over.key ?? 'draft-key', viewer: state.targetSessionId!, captain: binding.rootSessionId, team: binding.teamId, revision: state.data!.projection.team.revision }
  const row = (id: string, sequence: number) => ({ id, sequence, createdAt: 1000 + sequence, author: { kind: 'local-operator' as const }, text: '真实消息', formatVersion: 2 as const, content: [{ type: 'text' as const, text: '真实消息' }], mentionLabels: [], delivery: { kind: 'requested' as const, recipients: [{ state: 'claimed' as const, claimedAt: 2000, recipientSessionId: binding.rootSessionId }] } })
  const entries = over.empty ? [] : over.tail ? [row('public-1', 1), row('public-2', 2)] : [row('public-1', 1)]
  return { selection, entries, draft: { text: '', version: 1, tokens: [] }, sending: false, loading: over.loading ?? false, pending: false, error: over.error, directory: undefined, directoryError: undefined, directoryLoading: false, legacyUpgrade: false, draftStatus: 'ready', draftBlobs: {},
    history: { schemaVersion: 3, binding, observedAt: 2000, teamRevision: selection.revision, entries, totalCount: entries.length, returnedCount: entries.length, limit: 50, hasEarlier: false, hasMore: over.hasMore ?? false, firstSequence: 1, lastSequence: entries.at(-1)?.sequence ?? 1, appendEligibility: { state: 'available' }, limits: { maxSegments: 256, maxTextBytes: 4096, maxBytes: 100000, maxMessages: 1000 }, imageAvailability: { state: 'available', imageLimits: { maxImageBytes: 2000, maxImagesPerMessage: 20, maxMessageImageBytes: 20000, maxImagePixels: 10000, maxImageDimension: 1000, mediaTypes: ['image/png'] } } },
  } as unknown as PublicChatState
}
function chatProps(state: TeamDashboardState, chat: PublicChatState, latest?: ReturnType<typeof vi.fn>) {
  return { t, useSessions: <T,>(selector: (state: SessionListState) => T) => selector({ ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined } as SessionListState), useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(state), useChat: <T,>(selector: (state: PublicChatState) => T) => selector(chat),
    useSurface: <T,>(selector: (state: { mode: 'inactive'; view: 'overview'; targetSessionId: undefined }) => T) => selector({ mode: 'inactive', view: 'overview', targetSessionId: undefined }),
    replaceText: vi.fn(), chooseMention: vi.fn(), removeMention: vi.fn(), refreshDirectory: vi.fn(), upgradeLegacy: vi.fn(), send: vi.fn(), recover: vi.fn(), earlier: vi.fn(), newer: vi.fn(), refresh: vi.fn(), latest: latest ?? vi.fn(), edit: vi.fn(), reply: vi.fn(), openTeam: vi.fn(),
    addImages: vi.fn(), removeImage: vi.fn(), image: vi.fn(async () => new Blob(['image'], { type: 'image/png' })), retryDraftStorage: vi.fn(), useStoredDraft: vi.fn(),
  }
}
type Props = ComponentProps<typeof TeamPublicChat>
const box = () => document.querySelector<HTMLElement>('.swarm-public__messages')!
const jumpButton = () => document.querySelector<HTMLButtonElement>('[data-public-jump-latest]')
function stubScroll(node: HTMLElement, height: number, viewport: number) {
  let top = node.scrollTop
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, get: () => height }, clientHeight: { configurable: true, get: () => viewport },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - viewport)) } },
  })
}
// jsdom never fires scroll for programmatic scrollTop; mirror the existing convention (:486) and dispatch.
const scroll = async (node: HTMLElement, top: number) => { await act(async () => { node.scrollTop = top; node.dispatchEvent(new Event('scroll')) }) }
const rerender = async (props: Props) => { await act(async () => { mounted.at(-1)!.render(<TeamPublicChat {...props} />) }) }

describe('#276 floating jump-to-latest', () => {
  it('#276 J1 header locate menu is gone and earlier/newer entries remain', async () => {
    const team = ready, chat = chatState(team, { hasMore: true })
    const props = chatProps(team, { ...chat, history: { ...chat.history!, hasEarlier: true } })
    await render(<TeamPublicChat {...props as unknown as Props} />)
    expect(document.querySelectorAll('[data-public-navigation]')).toHaveLength(0)
    expect(document.querySelector('details.swarm-public__navigation')).toBeNull()
    expect([...box().querySelectorAll(':scope > button:not([data-public-jump-latest])')]).toHaveLength(2) // earlier + newer 入口保持
  })

  it('#276 J2 hasMore=true: entry exists at the stale tail, click requests latest, arrival only on published hasMore=false state', async () => {
    const team = ready, latest = vi.fn(), props = chatProps(team, chatState(team, { hasMore: true }), latest)
    await render(<TeamPublicChat {...props as unknown as Props} />)
    const node = box(); stubScroll(node, 2000, 600)
    expect(jumpButton()).not.toBeNull() // 不是真最新（hasMore=true）就有入口，即使在已载入底部
    expect(jumpButton()!.type).toBe('button')
    expect(jumpButton()!.getAttribute('aria-label')).toBeTruthy() // 无障碍名（实现给 zh/en locale）
    await scroll(node, 100)
    expect(jumpButton()).not.toBeNull()
    const before = latest.mock.calls.length // 初始进入 effect 已调用（J5 同款增量口径）
    await act(async () => { jumpButton()!.click() })
    expect(latest).toHaveBeenCalledTimes(before + 1) // hasMore=true 走既有 latest 真最新入口
    expect(node.scrollTop).toBe(1400) // 先随已载入末尾
    expect(jumpButton()).not.toBeNull() // 未收到新 state：不得宣称已到底
    // 发布含真正末条的新 state（hasMore=false），新几何 2600；tail follow 归位新末尾。
    stubScroll(node, 2600, 600)
    await rerender(chatProps(team, chatState(team, { tail: true }), latest) as unknown as Props)
    await act(async () => { node.dispatchEvent(new Event('scroll')) }) // 真实浏览器由 scrollTop 变更自然排队 scroll
    expect(node.scrollTop).toBe(2000) // 滚到“新”末尾
    expect(jumpButton()).toBeNull() // 到达真最新才隐藏
    expect(document.activeElement).toBe(node) // 点击后焦点去向显式：不落 body，回消息区
  })

  it('#276 J2b a failed latest keeps the floating entry retryable', async () => {
    const team = ready, latest = vi.fn(), props = chatProps(team, chatState(team, { hasMore: true }), latest)
    await render(<TeamPublicChat {...props as unknown as Props} />)
    const node = box(); stubScroll(node, 2000, 600)
    const before = latest.mock.calls.length
    await act(async () => { jumpButton()!.click() })
    expect(latest).toHaveBeenCalledTimes(before + 1)
    await rerender(chatProps(team, chatState(team, { hasMore: true, error: 'boom' }), latest) as unknown as Props)
    const retry = jumpButton()
    expect(retry).not.toBeNull() // 载入失败：旧页重试入口保留，不得永久消失
    await act(async () => { retry!.click() })
    expect(latest).toHaveBeenCalledTimes(before + 2) // 可重试
  })

  it('#276 J3 manual scroll to the tail hides the button only when that tail is the true latest', async () => {
    const team = ready, props = chatProps(team, chatState(team)) // hasMore=false
    await render(<TeamPublicChat {...props as unknown as Props} />)
    const node = box(); stubScroll(node, 2000, 600)
    await scroll(node, 100)
    expect(jumpButton()).not.toBeNull()
    await scroll(node, 1400)
    expect(jumpButton()).toBeNull()
  })

  it('#276 J3b scrolling to the loaded tail while hasMore=true keeps the entry (stale page bottom is not latest)', async () => {
    const team = ready, props = chatProps(team, chatState(team, { hasMore: true }))
    await render(<TeamPublicChat {...props as unknown as Props} />)
    const node = box(); stubScroll(node, 2000, 600)
    await scroll(node, 100)
    expect(jumpButton()).not.toBeNull()
    await scroll(node, 1400) // 滚到已载入末尾
    expect(jumpButton()).not.toBeNull() // hasMore=true：旧页底不算最新，入口保留
  })

  it('#276 J4 empty records and true-latest non-overflowing frames never show the button', async () => {
    const team = ready, props = chatProps(team, chatState(team, { empty: true }))
    await render(<TeamPublicChat {...props as unknown as Props} />)
    const node = box(); stubScroll(node, 2000, 600)
    await scroll(node, 100)
    expect(jumpButton()).toBeNull() // 空记录：即使几何可滚也不出现
    await rerender(chatProps(team, chatState(team)) as unknown as Props) // 真最新(hasMore=false) + 非空 + 不溢出
    stubScroll(node, 600, 600)
    await scroll(node, 0)
    expect(jumpButton()).toBeNull()
  })

  it('#276 J5 switching Team routes entry through the new latest callback without stale mock calls', async () => {
    const team = ready, oldLatest = vi.fn(), props = chatProps(team, chatState(team, { hasMore: true }), oldLatest)
    await render(<TeamPublicChat {...props as unknown as Props} />)
    expect(oldLatest).toHaveBeenCalledTimes(1) // 初始进入 effect
    const node = box(); stubScroll(node, 2000, 600)
    await scroll(node, 100)
    expect(jumpButton()).not.toBeNull()
    const newLatest = vi.fn()
    await rerender(chatProps(team, chatState(team, { key: 'team-b-key' }), newLatest) as unknown as Props) // 新 Team 帧：hasMore=false
    expect(oldLatest).toHaveBeenCalledTimes(1) // 旧 mock 不再被调用
    expect(newLatest).toHaveBeenCalledTimes(1) // 新 selection key 的进入走新回调恰一次
    expect(jumpButton()).toBeNull() // 新帧 tail 归位（hasMore=false 且归尾）：旧帧状态不串台
  })

  it('#276 J6 clicking with hasMore=false scrolls to the loaded tail without a spurious latest call', async () => {
    const team = ready, latest = vi.fn(), props = chatProps(team, chatState(team), latest)
    await render(<TeamPublicChat {...props as unknown as Props} />)
    const node = box(); stubScroll(node, 2000, 600)
    await scroll(node, 100)
    const before = latest.mock.calls.length // 初始进入的 1 次不算点击增量
    await act(async () => { jumpButton()!.click() })
    expect(latest).toHaveBeenCalledTimes(before) // 真最新帧点击不得白调 latest（整窗替换会换掉用户在读页）
    expect(node.scrollTop).toBe(1400)
    expect(jumpButton()).toBeNull()
  })
})
