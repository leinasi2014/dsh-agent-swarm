// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { render, tZh } from './helpers/dashboard-ui.js'
import { TeamGoalHeader } from '../src/client/TeamGoalHeader.js'
import { GoalController, type GoalState } from '../src/client/goal-controller.js'
import { goalDraftFromSnapshot } from '../src/client/goal-draft-store.js'

const t = tZh as ComponentProps<typeof TeamGoalHeader>['t']
function fixture() {
  let state: GoalState = { ...new GoalController({} as never, 'host', {} as never).getSnapshot(), verified: true, draftStatus: 'ready',
    selection: { key: 'host/main/a', main: 'main', viewer: 'main', captain: 'captain-a', team: 'a', revision: 4 },
    response: { schemaVersion: 1, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 100,
      snapshot: { text: '持续核查交付质量，保存实际证据。'.repeat(4), eligibility: { state: 'available' }, budget: { tokenLimit: 1000, usedTokens: 200, usedRequests: 2, usedRetries: 0 },
        remainingActiveTasks: 3, remainingActiveAttempts: 2,
        lifecycle: { schemaVersion: 1, revision: 2, goalRevision: 1, phase: 'paused', mode: 'maintenance', intervalMs: 60_000,
          acceptanceCriteria: '每个修订有实际验证记录。', constraints: '保留既有会话与未提交草稿。', resultSequence: 1, coordinatedResultSequence: 0, coordinatedGoalRevision: 0 } } } }
  state = { ...state, draft: goalDraftFromSnapshot(state.response!.snapshot, 1) }
  const listeners = new Set<() => void>(), patch = (update: Partial<GoalState>) => { state = { ...state, ...update }; listeners.forEach(listener => listener()) }
  const actions = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    setExpanded: vi.fn((expanded: boolean) => patch({ expanded })), beginEdit: vi.fn(() => { if (!state.verified || state.response === undefined || !['ready', 'saving'].includes(state.draftStatus)) return; patch({ editing: true, expanded: true }) }), closeEditor: vi.fn(() => patch({ editing: false })),
    edit: vi.fn(), save: vi.fn(), control: vi.fn(), recover: vi.fn(), retryStorage: vi.fn(), useStoredDraft: vi.fn() }
  return { goal: actions as unknown as GoalController, actions, patch: async (update: Partial<GoalState>) => { await act(async () => patch(update)) } }
}
async function click(selector: string) { await act(async () => document.querySelector<HTMLElement>(selector)!.click()) }

it('keeps the goal collapsed, reveals actual cleanup and budget facts, and restores focus on closing the editor', async () => {
  const f = fixture(); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
  expect(document.querySelector('[data-goal-details]')).toBeNull()
  await click('[data-goal-toggle]')
  expect(document.querySelector('[data-goal-budget]')?.textContent).toContain('800')
  expect(document.querySelector('[data-goal-cleanup]')?.textContent).toContain('3 项任务未结束，2 项执行待收尾')
  await click('[data-goal-primary]'); expect(f.actions.control).toHaveBeenCalledExactlyOnceWith('resume')
  await click('[data-goal-edit]')
  expect(document.activeElement).toBe(document.querySelector('[data-goal-field="text"]'))
  await click('[data-goal-save]'); expect(f.actions.save).toHaveBeenCalledExactlyOnceWith(false)
  await click('[data-goal-save-start]'); expect(f.actions.save).toHaveBeenLastCalledWith(true)
  await act(async () => document.querySelector('[data-goal-form]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[data-goal-form]')).toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[data-goal-toggle]'))
})
it('separates save and coordination, blocks stale or unknown operations, and exposes expired recovery honestly', async () => {
  const f = fixture(); await f.patch({ expanded: true, editing: true }); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
  await f.patch({ pending: { kind: 'control', version: 1, request: { schemaVersion: 1, target: { rootSessionId: 'captain-a', teamId: 'a' }, requestId: 'original', expectedLifecycleRevision: 2, action: 'resume' } } })
  expect(document.querySelector<HTMLButtonElement>('[data-goal-save]')?.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-goal-primary]')?.disabled).toBe(true)
  await click('[data-goal-pending] button'); expect(f.actions.recover).toHaveBeenCalledOnce()
  await f.patch({ pending: undefined, outcome: { requestId: 'original', state: 'expired' } })
  expect(document.querySelector('[data-goal-expired]')?.textContent).toContain('原操作结果无法确认')
  await f.patch({ outcome: { requestId: 'original', state: 'committed', operationRevision: 3 } })
  expect(document.querySelector('[data-goal-saved]')?.textContent).toContain('已保存。')
  expect(document.querySelector('[data-goal-coordinated]')).toBeNull()
  await f.patch({ draft: { ...f.goal.getSnapshot().draft, baseLifecycleRevision: 1 } })
  expect(document.querySelector<HTMLButtonElement>('[data-goal-save]')?.disabled).toBe(true)
  await f.patch({ selection: { ...f.goal.getSnapshot().selection!, team: 'b' } })
  expect(document.querySelector('[data-goal-details]')).toBeNull()
})
it('validates maintenance interval, budget usage and code point limits before enabling save and start', async () => {
  const f = fixture(); await f.patch({ expanded: true, editing: true }); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
  for (const update of [{ intervalSeconds: '59' }, { intervalSeconds: '60', tokenLimit: '1.5' }, { tokenLimit: '1000', text: '界'.repeat(4097) }]) {
    await f.patch({ draft: { ...f.goal.getSnapshot().draft, ...update } }); expect(document.querySelector<HTMLButtonElement>('[data-goal-save]')?.disabled).toBe(true)
  }
  await f.patch({ draft: { ...f.goal.getSnapshot().draft, text: '😀'.repeat(4096), tokenLimit: '200' } })
  expect(document.querySelector<HTMLButtonElement>('[data-goal-save]')?.disabled).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('[data-goal-save-start]')?.disabled).toBe(true)
})
it('offers draft storage recovery even when hydration failed before the editor could open', async () => {
  const f = fixture(); await f.patch({ draftStatus: 'unavailable' }); await render(<TeamGoalHeader goal={f.goal} teamId="a" t={t} />)
  await click('[data-goal-toggle]') // 真实单击路径（不预设 expanded）：beginEdit 被拒时窗口仍打开
  expect(document.querySelector('[data-goal-form]')).toBeNull()
  await click('[data-goal-draft-state] button'); expect(f.actions.retryStorage).toHaveBeenCalledOnce()
})
// 模态开闭/输入焦点/320/390/宽屏由 public-chat-ui.spec.tsx 的真实 React 装配浏览器测试验证（真 portal，非静态拷贝）。
