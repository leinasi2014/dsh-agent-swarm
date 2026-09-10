import { draftStoreScript } from './helpers/draft-store-script.js'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }) }, 30_000)
afterAll(async () => { await browser?.close() }, 30_000)
declare global { interface Window { workDrafts: import('../src/client/work-request-draft-store.js').WorkRequestDraftStore } }
async function fixture(): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext()
  const code = draftStoreScript('work-request-draft-store')
  await context.addInitScript(`{const exports={}; ${code}; window.workDrafts=new exports.WorkRequestDraftStore(indexedDB,'work-fixture');}`)
  await context.route('http://work.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Work drafts</title>' }))
  const page = await context.newPage(); await page.goto('http://work.test/')
  return { page, close: () => context.close() }
}
const key = 'swarm.work.v1:["host","main","a"]'

it('retains the frozen original across reload while a late commit preserves newer edits and another Team', async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(async scope => {
      await window.workDrafts.freeze(scope, { description: 'Original work', acceptanceCriteria: 'Actual result', version: 1 },
        { version: 1, request: { schemaVersion: 1, requestId: 'stable', target: { rootSessionId: 'captain-a', teamId: 'a' }, description: 'Original work', acceptanceCriteria: 'Actual result' } }, 0)
      await window.workDrafts.writeDraft(scope, { description: 'New edit', acceptanceCriteria: '', version: 2 }, 1)
      await window.workDrafts.writeDraft('team-b', { description: 'Other Team', acceptanceCriteria: '', version: 1 }, 0)
    }, key)
    await f.page.reload()
    const result = await f.page.evaluate(async scope => {
      const before = await window.workDrafts.read(scope)
      const wrong = await window.workDrafts.settle(scope, 'other-request', 1, true)
      const after = await window.workDrafts.settle(scope, 'stable', 1, true)
      return { before, wrong, after, other: await window.workDrafts.read('team-b') }
    }, key)
    expect(result.before.pending?.request).toMatchObject({ requestId: 'stable', description: 'Original work', acceptanceCriteria: 'Actual result' })
    expect(result.wrong).toEqual(result.before)
    expect(result.after).toMatchObject({ draft: { description: 'New edit', version: 2 } })
    expect(result.after.pending).toBeUndefined()
    expect(result.other.draft.description).toBe('Other Team')
  } finally { await f.close() }
}, 30_000)

it('allows only one unknown operation when two real pages race to freeze the same draft', async () => {
  const f = await fixture()
  try {
    const other = await f.page.context().newPage(); await other.goto('http://work.test/')
    await f.page.evaluate(async scope => { await window.workDrafts.writeDraft(scope, { description: 'Same work', acceptanceCriteria: '', version: 1 }, 0) }, key)
    const results = await Promise.all([f.page, other].map((page, attemptIndex) => page.evaluate(async ({ scope, index }) => {
      try {
        await window.workDrafts.freeze(scope, { description: 'Same work', acceptanceCriteria: '', version: 1 },
          { version: 1, request: { schemaVersion: 1, requestId: `id-${index}`, target: { rootSessionId: 'captain-a', teamId: 'a' }, description: 'Same work' } }, 1)
        return 'saved'
      } catch { return 'conflict' }
    }, { scope: key, index: attemptIndex })))
    expect(results.toSorted()).toEqual(['conflict', 'saved'])
  } finally { await f.close() }
}, 30_000)

it('aborts both the pending request and draft write when the real storage transaction fails', async () => {
  const f = await fixture()
  try {
    const saved = await f.page.evaluate(async scope => {
      await window.workDrafts.writeDraft(scope, { description: 'Kept', acceptanceCriteria: '', version: 1 }, 0)
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value: unknown, recordKey?: IDBValidKey) {
        put.call(this, value, recordKey); throw new DOMException('Fixture quota failure after put', 'QuotaExceededError')
      }
      try {
        await window.workDrafts.freeze(scope, { description: 'Failed', acceptanceCriteria: '', version: 2 },
          { version: 2, request: { schemaVersion: 1, requestId: 'never-send', target: { rootSessionId: 'captain-a', teamId: 'a' }, description: 'Failed' } }, 1)
      } catch {} finally { IDBObjectStore.prototype.put = put }
      return await window.workDrafts.read(scope)
    }, key)
    expect(saved).toEqual({ schemaVersion: 1, draft: { description: 'Kept', acceptanceCriteria: '', version: 1 } })
  } finally { await f.close() }
}, 30_000)
