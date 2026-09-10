import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { emptyGoalDraft, goalDefinitionFromDraft, type GoalPending } from '../src/client/goal-draft-store.js'
import { browserGoalDrafts } from './goal-browser-draft.js'

let browser: Browser, context: BrowserContext
beforeAll(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); context = await browser.newContext() }, 30_000)
afterAll(async () => { await browser?.close() })
it('preserves a newer persisted edit when settling an older operation from another tab', async () => {
  const name = crypto.randomUUID(), first = await browserGoalDrafts(context, name), second = await browserGoalDrafts(context, name)
  const draft = { ...emptyGoalDraft(), text: 'Original', initialized: true, dirty: true, version: 1 }
  const pending: GoalPending = { kind: 'save', version: 1, request: { schemaVersion: 1, target: { rootSessionId: 'captain', teamId: 'a' }, requestId: 'same', expectedLifecycleRevision: 0, goal: goalDefinitionFromDraft(draft), start: false } }
  await first.writeDraft('a', draft, 0); await first.freeze('a', pending, 1)
  await second.writeDraft('a', { ...draft, text: 'Newer', version: 2 }, 1)
  await first.settle('a', pending, { requestId: 'same', state: 'committed', operationRevision: 1 }, { ...draft, dirty: false, version: 2 })
  expect((await second.read('a')).draft.text).toBe('Newer')
  expect((await second.read('a')).pending).toBeUndefined()
  first.close(); second.close()
}, 30_000)
it('freezes one exact request and rejects stale writers while keeping another Team independent', async () => {
  const store = await browserGoalDrafts(context, crypto.randomUUID()), draft = { ...emptyGoalDraft(), text: 'A', initialized: true, version: 1 }
  const pending: GoalPending = { kind: 'control', version: 1, request: { schemaVersion: 1, target: { rootSessionId: 'captain', teamId: 'a' }, requestId: 'same', expectedLifecycleRevision: 2, action: 'pause' } }
  await store.writeDraft('a', draft, 0); await store.freeze('a', pending, 1)
  await expect(store.freeze('a', pending, 1)).rejects.toThrow('pending operation')
  await expect(store.writeDraft('a', { ...draft, text: 'Stale', version: 2 }, 0)).rejects.toThrow('revision conflict')
  expect((await store.read('a')).pending).toEqual(pending)
  expect((await store.read('b')).draft.text).toBe('')
  store.close()
}, 30_000)
