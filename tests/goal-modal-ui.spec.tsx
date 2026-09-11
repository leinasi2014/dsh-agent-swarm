// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, tZh } from './helpers/dashboard-ui.js'
import { TeamGoalHeader } from '../src/client/TeamGoalHeader.js'
import { GoalController, type GoalState } from '../src/client/goal-controller.js'
import { goalDraftFromSnapshot } from '../src/client/goal-draft-store.js'

// #276 goal-modal track: one click opens a body-portaled primitives.Modal editor (root public-da51eafa / public-05a99d6a).
// Baseline (RED run): every cell fails — clicking only toggles the inline `state.expanded` block inside the header, no dialog exists.
// Modal content lives under [data-goal-modal]; the dialog frame (role=dialog, portal to body) comes from primitives.Modal,
// which has NO focus trap / auto-focus / focus restore — the component must supply them (verified in G3).

const t = tZh as ComponentProps<typeof TeamGoalHeader>['t']
function fixture() {
  let state: GoalState = { ...new GoalController({} as never, 'host', {} as never).getSnapshot(), verified: true, draftStatus: 'ready',
    selection: { key: 'host/main/a', main: 'main', viewer: 'main', captain: 'captain-a', team: 'a', revision: 4 },
    response: { schemaVersion: 1, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 100,
      snapshot: { text: '持续核查交付质量，保存实际证据。', eligibility: { state: 'available' }, budget: { tokenLimit: 1000, usedTokens: 200, usedRequests: 2, usedRetries: 0 },
        remainingActiveTasks: 3, remainingActiveAttempts: 2,
        lifecycle: { schemaVersion: 1, revision: 2, goalRevision: 1, phase: 'paused', mode: 'maintenance', intervalMs: 60_000,
          acceptanceCriteria: '每个修订有实际验证记录。', constraints: '保留既有会话与未提交草稿。', nextAction: '核查下一修订。',
          lastCoordination: { triggerId: 'trigger-1', goalRevision: 1, resultSequence: 1, actorSessionId: 'captain-a', at: 90, summary: '上轮核查完成。', taskIds: [], outcome: 'coordinated' },
          resultSequence: 1, coordinatedResultSequence: 0, coordinatedGoalRevision: 0 } } } }
  state = { ...state, draft: goalDraftFromSnapshot(state.response!.snapshot, 1) }
  const listeners = new Set<() => void>(), patch = (update: Partial<GoalState>) => { state = { ...state, ...update }; listeners.forEach(listener => listener()) }
  const actions = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setExpanded: vi.fn((expanded: boolean) => { patch({ expanded }) }), beginEdit: vi.fn(() => { if (!state.verified || state.response === undefined || !['ready', 'saving'].includes(state.draftStatus)) return; patch({ editing: true, expanded: true }) }), closeEditor: vi.fn(() => { patch({ editing: false }) }),
    edit: vi.fn(), save: vi.fn(), control: vi.fn(), recover: vi.fn(), retryStorage: vi.fn(), useStoredDraft: vi.fn() }
  return { goal: actions as unknown as GoalController, actions, patch: async (update: Partial<GoalState>) => { await act(async () => { patch(update) }) } }
}
async function click(selector: string) { await act(async () => { document.querySelector<HTMLElement>(selector)!.click() }) }
const modal = () => document.querySelector<HTMLElement>('[data-goal-modal]')
const dialog = () => modal()!.closest<HTMLElement>('[role=dialog]')
// Real Modal structure (root public-c6318425): body > div(role=presentation) > mask + div(role=dialog).
function portalRoot(): HTMLElement | null { let el: HTMLElement | null = dialog(); while (el !== null && el.parentElement !== document.body) el = el.parentElement; return el }

describe('#276 goal entry modal', () => {
  it('#276 G1 one click on the goal entry opens a body-portaled modal and starts editing', async () => {
    const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    expect(modal()).toBeNull()
    await click('[data-goal-toggle]')
    expect(modal()).not.toBeNull() // 单击直达模态（不是先展开详情再点编辑）
    expect(f.actions.beginEdit).toHaveBeenCalledOnce() // 打开即进入可输入编辑，无二段式下拉
    const frame = dialog()
    expect(frame).not.toBeNull() // primitives.Modal 提供 role=dialog 框架
    expect(modal()!.closest('.swarm-public, header')).toBeNull() // 内容不在群聊/header 子树（root ②样式前提）
    expect(portalRoot()?.parentElement).toBe(document.body) // 门户根落 body（官方 DOM 形状，不要求 dialog 直接挂 body）
  })

  it('#276 G2 opening the modal keeps the page header free of goal details and the editor', async () => {
    const f = fixture()
    await render(<section className="swarm-public"><header className="swarm-public__header"><div><h1>制作团队</h1><TeamGoalHeader goal={f.goal} teamId="a" t={t} /></div></header><div className="swarm-public__messages">消息</div></section>)
    await click('[data-goal-toggle]')
    expect(modal()).not.toBeNull()
    expect(document.querySelector('.swarm-public__header [data-goal-details]')).toBeNull() // 详情不再内联撑页头
    expect(document.querySelector('.swarm-public__header [data-goal-form]')).toBeNull() // 编辑器不在页头内联/下拉
    expect(document.querySelector('.swarm-public__header details')).toBeNull()
  })

  it('#276 G3 focus enters the modal, is kept inside, and Escape returns it to the goal button', async () => {
    const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    await click('[data-goal-toggle]')
    const frame = dialog()!
    expect(frame.contains(document.activeElement)).toBe(true) // 打开即进焦点（库无自动聚焦，组件须最小补齐）
    // 真实把焦点移走（body 前置外部按钮真聚焦），再由实现的 focusin 收口拉回——不“靠焦点本来就还在模态内”充数。
    const outside = document.createElement('button'); outside.textContent = 'outside focus target'; document.body.prepend(outside)
    let slipped = false
    const probe = (event: Event) => { if (event.target === outside) slipped = true }
    document.addEventListener('focusin', probe)
    await act(async () => { outside.focus() })
    document.removeEventListener('focusin', probe)
    expect(slipped).toBe(true)
    expect(frame.contains(document.activeElement)).toBe(true) // 又被拉回模态（PublicImages focusin 收口样板模式）
    outside.remove()
    await act(async () => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(modal()).toBeNull() // Escape 关闭
    expect(document.activeElement).toBe(document.querySelector('[data-goal-toggle]')) // 焦点回目标按钮
    expect(f.actions.closeEditor).toHaveBeenCalledOnce() // 既有 closeEditor 语义保持
  })

  it('#276 G4 every read-only fact and the primary action have a landing spot inside the modal', async () => {
    const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    await click('[data-goal-toggle]')
    const inModal = <T extends Element,>(selector: string) => modal()!.querySelector(selector) as T | null
    expect(inModal('[data-goal-text]')?.textContent).toContain('持续核查交付质量')
    expect(inModal('[data-goal-details]')?.textContent).toContain('每个修订有实际验证记录。') // 验收/约束 dl
    expect(inModal('[data-goal-details]')?.textContent).toContain('保留既有会话与未提交草稿。')
    expect(inModal('[data-goal-details]')?.textContent).toContain('核查下一修订。') // 下次动作
    expect(inModal('[data-goal-coordinated]')?.textContent).toContain('上轮核查完成。') // 上次协调
    expect(inModal('[data-goal-budget]')?.textContent).toContain('800') // 预算
    expect(inModal('[data-goal-cleanup]')?.textContent).toContain('3 项任务未结束，2 项执行待收尾') // 清理
    expect(inModal('[data-goal-primary]')).not.toBeNull() // 主操作 start/pause/resume 有落点
    await act(async () => { inModal<HTMLElement>('[data-goal-primary]')!.click() })
    expect(f.actions.control).toHaveBeenCalledExactlyOnceWith('resume') // 且真连通 GoalController
    expect(inModal('[data-goal-form]')).not.toBeNull() // 打开即编辑：表单直接在场
    expect(inModal<HTMLTextAreaElement>('[data-goal-field="text"]')!.value).toContain('持续核查交付质量') // 编辑框预填当前持久快照，可输入
    await act(async () => { inModal<HTMLElement>('[data-goal-edit]')!.click() })
    expect(f.actions.beginEdit.mock.calls.at(-1)).toEqual([]) // 普通编辑保持 dirty 草稿：不传“使用最新”覆盖标志（goal.latest 按钮才传 true）
  })

  it('#276 G4b unavailable, waiting, pending, outcome and draft states surface inside the modal', async () => {
    const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    await click('[data-goal-toggle]')
    await f.patch({ pending: { kind: 'control', version: 1, request: { schemaVersion: 1, target: { rootSessionId: 'captain-a', teamId: 'a' }, requestId: 'original', expectedLifecycleRevision: 2, action: 'resume' } } })
    expect(modal()!.querySelector('[data-goal-pending]')).not.toBeNull() // pending 未上链在模态内可见可恢复
    await f.patch({ pending: undefined, outcome: { requestId: 'original', state: 'expired' } })
    expect(modal()!.querySelector('[data-goal-expired]')).not.toBeNull() // outcome 诚实展示
    await f.patch({ outcome: undefined, draftStatus: 'unavailable' })
    expect(modal()!.querySelector('[data-goal-draft-state] button')).not.toBeNull() // 草稿 conflict/unavailable 恢复入口
    await act(async () => { modal()!.querySelector<HTMLElement>('[data-goal-draft-state] button')!.click() })
    expect(f.actions.retryStorage).toHaveBeenCalledOnce() // 无第二 draft 状态机：按钮直连 controller
    await f.patch({ draftStatus: 'ready', selection: { ...f.goal.getSnapshot().selection!, team: 'b' } })
    expect(modal()).toBeNull() // 切 Team 后模态清理
  })

  it('#276 G5 modal edits flow only through GoalController and reflect patched drafts', async () => {
    const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    await click('[data-goal-toggle]')
    const field = modal()!.querySelector<HTMLTextAreaElement>('[data-goal-field="text"]')!
    // React 受控值：原生 value setter + input 事件才走真实 onChange（直接赋值会被 value tracker 吞掉）。
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '新目标文本'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(f.actions.edit).toHaveBeenCalledWith('text', '新目标文本') // 编辑值只能经 GoalController（本地 useState=blocker）
    await f.patch({ draft: { ...f.goal.getSnapshot().draft, text: '外部合并后的文本' } })
    expect(modal()!.querySelector<HTMLTextAreaElement>('[data-goal-field="text"]')!.value).toBe('外部合并后的文本') // 单向受控：state 是唯一显示来源
  })

  it('#276 G6 the modal close button removes the dialog and restores focus to the goal button', async () => {
    const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    await click('[data-goal-toggle]')
    const close = modal()!.querySelector<HTMLButtonElement>('[data-goal-close]')!
    await act(async () => { close.click() })
    expect(modal()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-goal-toggle]'))
  })

  it('#276 G7 collapsed unavailable state still opens the window through a real click and exposes retry', async () => {
    const f = fixture(); await f.patch({ draftStatus: 'unavailable' }); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
    expect(f.goal.getSnapshot().expanded).toBe(false)
    await click('[data-goal-toggle]') // 真实单击；beginEdit 在 unavailable 下按真实 controller 语义直接 return
    expect(modal()).not.toBeNull() // 开窗先 setExpanded(true)：恢复入口可达，不被 beginEdit 早退吞掉
    expect(modal()!.querySelector('[data-goal-form]')).toBeNull() // beginEdit 被拒时不伪造编辑态
    const retry = modal()!.querySelector<HTMLElement>('[data-goal-draft-state] button')!
    await act(async () => { retry.click() })
    expect(f.actions.retryStorage).toHaveBeenCalledOnce()
    expect(modal()!.querySelector('[role="status"], [role="alert"]')).not.toBeNull() // 状态展示保持可观察
  })
})
