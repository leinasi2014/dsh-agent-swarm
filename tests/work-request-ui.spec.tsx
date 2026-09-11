// @vitest-environment jsdom
import { ready, render, tZh, FakeCoordinator } from './helpers/dashboard-ui.js'
import { useTabInfo } from './helpers/sidebar-tab.js'
import { act, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { TeamWorkRequestForm } from '../src/client/TeamWorkRequestForm.js'
import { WorkActivityFeed } from '../src/client/WorkActivityFeed.js'
import { TeamDashboardDetails } from '../src/client/TeamDashboardDetails.js'
import { WorkRequestController, type WorkRequestState } from '../src/client/work-request-controller.js'
import { taskProgressState } from '../src/client/team-dashboard-view-helpers.js'
import { directoryEntry, directoryPage } from './helpers/public-directory.js'

const translate = tZh as ComponentProps<typeof TeamWorkRequestForm>['t']
function fixture() {
  const selection = { key: 'host/main/a', main: 'main', viewer: 'main', captain: 'captain-a', team: 'a', revision: 4 }
  let state: WorkRequestState = { ...new WorkRequestController({} as never, 'host', {} as never).getSnapshot(), selection, verified: true, draftStatus: 'ready',
    draft: { description: '修复真实问题', acceptanceCriteria: '通过实际验收', version: 4 },
    activity: { schemaVersion: 1, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 10, teamId: 'a', afterSequence: 0,
      retainedFromSequence: 9, throughSequence: 10, entries: [], referencedRequests: [], hasMore: false,
      submitEligibility: { state: 'available' }, limits: { maxDescriptionChars: 8192, maxAcceptanceCriteriaChars: 4096, maxRequests: 256, maxActivityEntries: 1024 } } }
  const listeners = new Set<() => void>()
  const patch = (value: Partial<WorkRequestState>): void => { state = { ...state, ...value }; listeners.forEach(listener => listener()) }
  const work = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    setFormOpen: vi.fn((open: boolean) => patch({ formOpen: open })), edit: vi.fn(), send: vi.fn(), recover: vi.fn(), retryDraftStorage: vi.fn(), useStoredDraft: vi.fn(), refresh: vi.fn(), more: vi.fn() }
  return { work: work as unknown as WorkRequestController, actions: work, patch: async (value: Partial<WorkRequestState>) => { await act(async () => patch(value)) } }
}
async function click(selector: string) { await act(async () => document.querySelector<HTMLElement>(selector)!.click()) }

it('places the proposal beside the right Task title, opens a separate form and restores focus on Escape', async () => {
  const f = fixture(), coordinator = new FakeCoordinator()
  const controller = { getSnapshot: () => ready, subscribe: () => () => {}, readTaskDetail: vi.fn() }
  await render(<TeamDashboardDetails {...{ controller, coordinator, work: f.work, localeTag: coordinator.localeTag, sessionId: 'main-brain', useTabInfo, t: tZh } as unknown as ComponentProps<typeof TeamDashboardDetails>} />)
  expect(document.querySelector('[data-swarm-task-panel] header [data-work-open]')).not.toBeNull()
  expect(document.querySelector('[data-work-form]')).toBeNull()
  await click('[data-work-open]')
  expect(document.querySelector('[data-work-form]')?.closest('[data-swarm-task-panel]')).not.toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[data-work-description]'))
  expect(document.querySelector<HTMLTextAreaElement>('[data-work-description]')?.value).toBe('修复真实问题')
  await act(async () => document.querySelector('[data-work-description]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[data-work-form]')).toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[data-work-open]'))
})

it('blocks unknown, stale, oversized and unpersisted drafts without offering human self-claim', async () => {
  const f = fixture(); await f.patch({ formOpen: true }); await render(<TeamWorkRequestForm work={f.work} t={translate} />)
  await click('[data-work-submit]'); expect(f.actions.send).toHaveBeenCalledTimes(1)
  for (const update of [{ pending: true }, { pending: false, verified: false }, { verified: true, draftStatus: 'unavailable' as const },
    { draftStatus: 'ready' as const, draft: { description: 'x'.repeat(8193), acceptanceCriteria: '', version: 6 } }]) {
    await f.patch(update); expect(document.querySelector<HTMLButtonElement>('[data-work-submit]')?.disabled).toBe(true)
  }
  expect(document.body.textContent).not.toContain('自领')
})

it('separates proposal acknowledgement from formal task creation and uses the saved recovery action', async () => {
  const f = fixture(); await f.patch({ formOpen: true, pending: true }); await render(<TeamWorkRequestForm work={f.work} t={translate} />)
  await click('[data-work-pending] button'); expect(f.actions.recover).toHaveBeenCalledOnce()
  await f.patch({ pending: false, lastSubmitted: { id: 'request-1', requestId: 'retry-1', origin: { kind: 'local-operator' }, description: 'Original', revision: 1, createdAt: 10 } })
  expect(document.querySelector('[data-work-submitted]')?.textContent).toBe('已交给队长整理')
  expect(document.querySelector('[data-work-submitted]')?.textContent).not.toContain('创建')
})

it('renders real event identities, proposal decisions, retained range and only actual task links', async () => {
  const f = fixture(), openTask = vi.fn()
  await f.patch({ entries: [{ id: 'event-9', sequence: 9, kind: 'request-accepted', workRequestId: 'request-1', actor: { kind: 'session', sessionId: 'captain-a' }, occurredAt: 1000 },
    { id: 'event-10', sequence: 10, kind: 'task-created', taskId: 'task-real', workRequestId: 'request-missing', actor: { kind: 'session', sessionId: 'captain-a' }, occurredAt: 2000 }],
    referencedRequests: [{ id: 'request-1', requestId: 'retry-1', origin: { kind: 'main', sessionId: 'main' }, description: 'Original request', acceptanceCriteria: 'Exact evidence', revision: 2, createdAt: 10,
      resolution: { kind: 'accept', actorSessionId: 'captain-a', occurredAt: 1000, taskIdsByItemKey: { deliverable: 'task-real' } } }] })
  await render(<WorkActivityFeed work={f.work} teamId="a" openTask={openTask} t={translate} />)
  expect(document.querySelector('[data-work-collapse]')?.getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelectorAll('[data-work-event]')).toHaveLength(2)
  expect(document.querySelector('[data-public-message]')).toBeNull()
  expect(document.querySelector('[data-work-retained]')?.textContent).toContain('9–10')
  expect(document.querySelector('[data-work-request="request-1"]')?.textContent).toContain('Exact evidence')
  expect(document.querySelector('[data-work-request="request-missing"]')?.textContent).toContain('不在本次返回记录')
  await click('[data-work-task="task-real"]'); expect(openTask).toHaveBeenCalledExactlyOnceWith('task-real')
  await f.patch({ selection: { ...f.work.getSnapshot().selection!, team: 'b', key: 'host/main/b' } })
  expect(document.querySelector('[data-work-activity]')).toBeNull()
})

it('uses Host readiness for open claims, budget holds and inactive Teams', () => {
  const task = { ...ready.data!.projection.tasks[0]!, status: 'pending' as const, blockedBy: [], assignmentMode: 'open-claim' as const }
  expect(taskProgressState({ ...task, readiness: 'ready' }, [])).toBe('open')
  expect(taskProgressState({ ...task, readiness: 'budget-hold' }, [])).toBe('budgetHold')
  expect(taskProgressState({ ...task, readiness: 'team-inactive' }, [])).toBe('teamInactive')
  expect(taskProgressState({ ...task, readiness: 'blocked' }, [])).toBe('blocked')
})

it('uses bound current names with inspectable IDs, compact proposals and honest missing identities', async () => {
  const f = fixture()
  const captain = 'c1f65a50-6d2e-4459-b6cd-770914b775c2', member = '60b10743-2e62-4fef-9989-db54f9c69302'
  const main = 'session-2060776d-f581-4a0d-b325-c5fd606ca418'
  const directory = { ...directoryPage('a', [directoryEntry(captain, '同名'), directoryEntry(member, '同名')]), binding: { rootSessionId: 'captain-a', teamId: 'a' } }
  await f.patch({ entries: [{ id: 'event-9', sequence: 9, kind: 'task-claimed', taskId: 'task-1', workRequestId: 'work-request-long-uuid', assigneeSessionId: member, actor: { kind: 'session', sessionId: captain }, occurredAt: 1000 },
    { id: 'event-10', sequence: 10, kind: 'request-proposed', actor: { kind: 'main', sessionId: main }, occurredAt: 2000 }] })
  await render(<WorkActivityFeed work={f.work} teamId="a" directory={directory} t={translate} />)
  expect(document.querySelector(`[data-work-participant="${captain}"]`)?.textContent).toBe('同名')
  expect(document.querySelector(`[data-work-participant="${member}"]`)?.getAttribute('title')).toContain(member)
  expect(document.querySelector(`[data-work-participant="${main}"]`)?.textContent).toBe('主对话 · 2060776d')
  expect(document.querySelector(`[data-work-participant="${main}"]`)?.getAttribute('title')).toBe(main)
  expect(document.querySelector('[data-work-request] summary')?.textContent).not.toContain('work-request-long-uuid')
  expect(document.querySelector('[data-work-request]')?.textContent).toContain('work-request-long-uuid')
  expect(document.querySelector('[data-work-event] header')?.textContent).not.toContain(captain)
  await render(<div data-other-directory><WorkActivityFeed work={f.work} teamId="a" directory={{ ...directory, binding: { ...directory.binding, rootSessionId: 'other-captain' } }} t={translate} /></div>)
  expect(document.querySelector(`[data-other-directory] [data-work-participant="${captain}"]`)?.textContent).not.toContain('同名')
  expect(document.querySelector(`[data-other-directory] [data-work-participant="${captain}"]`)?.getAttribute('title')).toContain(captain)
})

it('does not show a reversed retained range or zero visible range for an empty feed', async () => {
  const f = fixture()
  await f.patch({ activity: { ...f.work.getSnapshot().activity!, retainedFromSequence: 1, throughSequence: 0 } })
  await render(<WorkActivityFeed work={f.work} teamId="a" t={translate} />)
  expect(document.querySelector('[data-work-retained]')).toBeNull()
  expect(document.querySelector('[data-work-activity]')?.textContent).toContain('暂无')
})

it('keeps the actual proposal and event cards within 320px and 390px browser layouts', async () => {
  const memberId = '60b10743-2e62-4fef-9989-db54f9c69302'
  const directory = directoryPage('a', [directoryEntry(memberId, '校对员')])
  const f = fixture(); await f.patch({ formOpen: true, entries: [{ id: 'event-browser', sequence: 9, kind: 'request-proposed', workRequestId: 'request-browser', actor: { kind: 'local-operator' }, occurredAt: 1000 },
    { id: 'event-member', sequence: 10, kind: 'task-claimed', taskId: 'task-1', workRequestId: 'work-request-4718d5b9-long-identifier', actor: { kind: 'session', sessionId: memberId }, assigneeSessionId: memberId, occurredAt: 2000 }],
    referencedRequests: [{ id: 'request-browser', requestId: 'original-id', description: '修复任务栏的窄屏布局，并用真实浏览器验证。', acceptanceCriteria: '没有横向溢出；保留输入与焦点。', origin: { kind: 'local-operator' }, revision: 1, createdAt: 1000 }] })
  await render(<div data-work-browser><TeamWorkRequestForm work={f.work} t={translate} /><WorkActivityFeed work={f.work} teamId="a" directory={directory} t={translate} /></div>)
  const { chromium } = await import('playwright'), { mkdir } = await import('node:fs/promises')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const screenshotDirectory = process.env['WORK_UI_SCREENSHOTS']
    if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })
    const page = await browser.newPage()
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<style>body{margin:0;padding:12px;box-sizing:border-box;font:14px system-ui;color:#223047;background:#f8f9fc;--dsw-alias-label-primary:#223047;--dsw-alias-label-secondary:#69778c;--dsw-alias-bg-base:#f8f9fc;--dsw-alias-bg-layer-1:white;--dsw-alias-border-l2:#d8deea;--dsw-alias-state-business-primary:#4267bc}[data-work-browser]{container-type:inline-size}</style>${document.querySelector('[data-work-browser]')!.outerHTML}`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await page.locator('[data-work-description]').inputValue()).toBe('修复真实问题')
      expect(await page.locator('[data-work-event="event-member"] header').innerText()).toContain('校对员')
      expect(await page.locator('[data-work-event="event-member"]').innerText()).not.toContain(memberId)
      const taskReference = page.locator('[data-work-event="event-member"]>p')
      expect(await taskReference.innerText()).toBe('task-1')
      expect(await taskReference.evaluate(node => Math.abs(node.getBoundingClientRect().left - node.parentElement!.querySelector('header')!.getBoundingClientRect().left))).toBeLessThan(1)
      expect(await taskReference.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(25)
      await page.locator('[data-work-request="request-browser"] summary').click()
      expect(await page.locator('[data-work-request="request-browser"]').innerText()).toContain('修复任务栏的窄屏布局')
      if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/task-trace-corrected-${width}.png`, fullPage: true })
    }
  } finally { await browser.close() }
}, 30_000)
