import { readFileSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import ts from 'typescript'
import { addDraftImages, editDraft, removeDraftImage, replaceDraftRange, replyDraft } from '../src/client/public-draft.js'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }) })
afterAll(async () => { await browser?.close() }, 30_000)
const scopeKey = 'swarm.public.v1:["host","main","a"]'
function script(): string {
  const source = new URL('../src/client/public-draft-store.ts', import.meta.url)
  return ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}
async function fixture(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext()
  await context.route('http://draft.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Draft persistence</title>' }))
  const page = await context.newPage()
  await context.addInitScript(`{const exports={}; ${script()}; window.draftStore = new exports.PublicDraftStore(indexedDB, 'test-drafts');}`)
  await page.goto('http://draft.test/')
  return { page, close: () => context.close() }
}
// Page evaluation runs the actual store against Edge IndexedDB, never a fake-IDB implementation.
declare global { interface Window { draftStore: import('../src/client/public-draft-store.js').PublicDraftStore } }

it('restores original Blob bytes, tokens, revision and frozen request after page reload', async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(async key => {
      const image = { blobId: 'a', mediaType: 'image/png', name: '图.png' }
      const draft = { text: '@队长', version: 3, tokens: [{ start: 0, end: 3, memberId: 'captain', label: '队长' }], images: [image] }
      await window.draftStore.freeze(key, draft, { version: 3, captain: 'captain', request: { schemaVersion: 3, requestId: 'stable-id', content: [{ type: 'image', ...image }] }, blobIds: ['a'] }, 0, { a: new Blob(['original bytes'], { type: 'image/png' }) })
    }, scopeKey)
    await f.page.reload()
    const restored = await f.page.evaluate(async key => {
      const saved = await window.draftStore.read(key)
      return { saved: { ...saved, blobs: undefined }, bytes: await saved.blobs.a!.text() }
    }, scopeKey)
    expect(restored.bytes).toBe('original bytes')
    expect(restored.saved).toMatchObject({ draft: { version: 3, text: '@队长', tokens: [{ memberId: 'captain' }] }, pending: { version: 3, request: { requestId: 'stable-id' }, blobIds: ['a'] } })
  } finally { await f.close() }
}, 30_000)

it('rolls back the draft, pending and new Blob together when the transaction fails after put', async () => {
  const f = await fixture()
  try {
    const result = await f.page.evaluate(async key => {
      await window.draftStore.writeDraft(key, { text: 'kept', tokens: [], version: 1 }, 0)
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value: unknown, recordKey?: IDBValidKey) {
        put.call(this, value, recordKey)
        throw new DOMException('Injected storage failure after put', 'QuotaExceededError')
      }
      let error = ''
      try {
        await window.draftStore.freeze(key, { text: '', tokens: [], version: 2, images: [{ blobId: 'new', mediaType: 'image/png' }] }, { version: 2, captain: 'captain', request: { schemaVersion: 3, requestId: 'not-dispatched' }, blobIds: ['new'] }, 1, { new: new Blob(['not committed']) })
      } catch (cause) { error = (cause as Error).name } finally { IDBObjectStore.prototype.put = put }
      return { error, saved: await window.draftStore.read(key) }
    }, scopeKey)
    expect(result.error).toBe('QuotaExceededError')
    expect(result.saved).toEqual({ draft: { text: 'kept', tokens: [], version: 1 }, blobs: {} })
    await f.page.reload()
    expect(await f.page.evaluate(async key => (await window.draftStore.read(key)).pending, scopeKey)).toBeUndefined()
  } finally { await f.close() }
}, 30_000)

it('serializes two pages racing to freeze and rejects a stale revision without replacing the winner', async () => {
  const f = await fixture()
  try {
    const other = await f.page.context().newPage()
    await other.goto('http://draft.test/')
    await f.page.evaluate(async key => { await window.draftStore.writeDraft(key, { text: 'same', tokens: [], version: 1 }, 0) }, scopeKey)
    const attempts = await Promise.all([f.page, other].map((page, attemptIndex) => page.evaluate(async ({ key, index }) => {
      try {
        await window.draftStore.freeze(key, { text: 'same', tokens: [], version: 1 }, { version: 1, captain: 'captain', request: { schemaVersion: 3, requestId: `request-${index}` } }, 1)
        return 'saved'
      } catch { return 'conflict' }
    }, { key: scopeKey, index: attemptIndex })))
    expect(attempts.toSorted()).toEqual(['conflict', 'saved'])
    const result = await other.evaluate(async key => {
      const before = await window.draftStore.read(key)
      await window.draftStore.writeDraft(key, { text: 'newer', tokens: [], version: 2 }, 1)
      let stale = false
      try { await window.draftStore.writeDraft(key, { text: 'stale', tokens: [], version: 1 }, 1) } catch { stale = true }
      return { before, after: await window.draftStore.read(key), stale }
    }, scopeKey)
    expect(result.stale).toBe(true)
    expect(result.after.pending).toEqual(result.before.pending)
    expect(result.after.draft.text).toBe('newer')
  } finally { await f.close() }
}, 30_000)

it('settles only the matching request and revision, preserving edits and other Team scopes', async () => {
  const f = await fixture()
  try {
    const result = await f.page.evaluate(async key => {
      const draft = { text: '', tokens: [], version: 1, images: [{ blobId: 'a', mediaType: 'image/png' }] }
      await window.draftStore.freeze(key, draft, { version: 1, captain: 'captain', request: { schemaVersion: 3, requestId: 'one' }, blobIds: ['a'] }, 0, { a: new Blob(['kept while pending']) })
      await window.draftStore.writeDraft(key, { text: 'next', tokens: [], version: 2, replyTo: 'reply' }, 1)
      await window.draftStore.writeDraft(key + '-team-b', { text: 'other Team', tokens: [], version: 1 }, 0)
      const wrongId = await window.draftStore.settle(key, 'other', 1, true)
      const wrongRevision = await window.draftStore.settle(key, 'one', 0, true)
      const settled = await window.draftStore.settle(key, 'one', 1, true)
      const other = await window.draftStore.read(key + '-team-b')
      await window.draftStore.freeze(key, settled.draft, { version: 2, captain: 'captain', request: { schemaVersion: 3, requestId: 'two' } }, 2)
      const cleared = await window.draftStore.settle(key, 'two', 2, true)
      return { pinnedBytes: await wrongId.blobs.a!.text(), wrongRevision: wrongRevision.pending?.request.requestId, settled, other, cleared }
    }, scopeKey)
    expect(result.pinnedBytes).toBe('kept while pending')
    expect(result.wrongRevision).toBe('one')
    expect(result.settled).toEqual({ draft: { text: 'next', tokens: [], version: 2, replyTo: 'reply' }, blobs: {} })
    expect(result.other.draft.text).toBe('other Team')
    expect(result.cleared).toEqual({ draft: { text: '', tokens: [], version: 3 }, blobs: {} })
  } finally { await f.close() }
}, 30_000)

it('preserves v1/v2 pending payloads and the existing unsent draft during one-time migration', async () => {
  const f = await fixture()
  try {
    const result = await f.page.evaluate(async key => {
      const draft = { text: '请@同舟从', tokens: [], version: 7 }
      const v1 = { draft, legacyUpgrade: true, pending: { version: 3, captain: 'old-captain', request: { schemaVersion: 1 as const, requestId: 'legacy-id', target: { rootSessionId: 'original-viewer', teamId: 'a' }, text: 'old content', replyTo: 'old-reply' } } }
      const v2 = { draft, pending: { version: 4, captain: 'old-captain', upgradedLegacy: true, legacyVersion: 3, legacyRequest: v1.pending.request, request: { schemaVersion: 2 as const, requestId: 'legacy-id', target: v1.pending.request.target, content: [{ type: 'mention', memberId: 'old-member' }] } } }
      const first = await window.draftStore.migrateLegacy(key, v1)
      const second = await window.draftStore.migrateLegacy(key + '-v2', v2)
      await window.draftStore.writeDraft(key, { ...draft, text: 'new edit', version: 8 }, 7)
      const again = await window.draftStore.migrateLegacy(key, v1)
      return { v1, v2, first, second, again }
    }, scopeKey)
    expect(result.first).toEqual({ ...result.v1, blobs: {} })
    expect(result.second).toEqual({ ...result.v2, blobs: {} })
    expect(result.again.draft).toMatchObject({ text: 'new edit', version: 8 })
    expect(result.again.pending).toEqual(result.v1.pending)
  } finally { await f.close() }
}, 30_000)

it('rejects missing or replacement Blobs and snapshots caller input before asynchronous open', async () => {
  const f = await fixture()
  try {
    const result = await f.page.evaluate(async key => {
      const draft = { text: '', tokens: [], version: 1, images: [{ blobId: 'a', mediaType: 'image/png' }] }
      const pending = { version: 1, captain: 'captain', request: { schemaVersion: 3 as const, requestId: 'original' }, blobIds: ['a'] }
      const saving = window.draftStore.freeze(key, draft, pending, 0, { a: new Blob(['original']) })
      pending.request.requestId = 'mutated'; draft.images[0]!.blobId = 'mutated'
      await saving
      const failures = []
      for (const run of [
        () => window.draftStore.writeDraft(key, { text: 'changed', version: 2, tokens: [] }, 1, { a: new Blob(['replacement']) }),
        () => window.draftStore.writeDraft(key, { text: 'changed', version: 2, tokens: [], images: [{ blobId: 'missing', mediaType: 'image/png' }] }, 1),
      ]) { try { await run(); failures.push(false) } catch { failures.push(true) } }
      const saved = await window.draftStore.read(key)
      return { failures, id: saved.pending?.request.requestId, bytes: await saved.blobs.a!.text(), version: saved.draft.version }
    }, scopeKey)
    expect(result).toEqual({ failures: [true, true], id: 'original', bytes: 'original', version: 1 })
  } finally { await f.close() }
}, 30_000)

it('keeps attachments and token offsets through text edits and reply changes, and versions image changes', () => {
  const original = { text: '@队长', version: 1, tokens: [{ start: 0, end: 3, memberId: 'captain', label: '队长' }] }
  const image = { blobId: 'a', mediaType: 'image/png' }
  const attached = addDraftImages(original, [image])
  expect(attached).toMatchObject({ version: 2, tokens: original.tokens, images: [image] })
  const edited = editDraft(attached, '@队长 请看')
  const replaced = replaceDraftRange(edited, edited.text.length, edited.text.length, '!')
  const reply = replyDraft(replaced, 'message')
  const cancelled = replyDraft(reply, undefined)
  expect(cancelled).toMatchObject({ text: '@队长 请看!', version: 6, tokens: original.tokens, images: [image] })
  expect(cancelled.replyTo).toBeUndefined()
  expect(removeDraftImage(cancelled, 'a')).toMatchObject({ version: 7, images: [], tokens: original.tokens })
})

it('keeps pending and its Blob when an edited draft removes the image', async () => {
  const f = await fixture()
  try {
    const result = await f.page.evaluate(async key => {
      const draft = { text: '', version: 1, tokens: [], images: [{ blobId: 'a', mediaType: 'image/png' }] }
      await window.draftStore.freeze(key, draft, { version: 1, captain: 'captain', request: { schemaVersion: 3, requestId: 'frozen' }, blobIds: ['a'] }, 0, { a: new Blob(['retained']) })
      await window.draftStore.writeDraft(key, { text: 'new', version: 2, tokens: [], images: [] }, 1)
      return (await window.draftStore.read(key)).pending?.request.requestId
    }, scopeKey)
    expect(result).toBe('frozen')
  } finally { await f.close() }
}, 30_000)

it.each(['write', 'freeze'] as const)('rejects a higher local revision based on stale persisted data in another page for %s', async method => {
  const f = await fixture()
  try {
    const other = await f.page.context().newPage()
    await other.goto('http://draft.test/')
    const caseKey = `${scopeKey}/${method}`
    await f.page.evaluate(async key => { await window.draftStore.writeDraft(key, { text: 'original', tokens: [], version: 1 }, 0) }, caseKey)
    const persistedRevision = await f.page.evaluate(async key => (await window.draftStore.read(key)).draft.version, caseKey)
    await other.evaluate(async key => { await window.draftStore.writeDraft(key, { text: 'B saved', tokens: [], version: 2 }, 1) }, caseKey)
    const result = await f.page.evaluate(async ({ key, observed, operation }) => {
      const draft = { text: 'A stale edits', tokens: [], version: 3 }
      let rejected = false
      try {
        if (operation === 'write') await window.draftStore.writeDraft(key, draft, observed)
        else await window.draftStore.freeze(key, draft, { version: 3, captain: 'captain', request: { schemaVersion: 3, requestId: 'stale' } }, observed)
      } catch { rejected = true }
      return { rejected, saved: await window.draftStore.read(key) }
    }, { key: caseKey, observed: persistedRevision, operation: method })
    expect(result, method).toMatchObject({ rejected: true, saved: { draft: { text: 'B saved', version: 2 } } })
    expect(result.saved.pending, method).toBeUndefined()
  } finally { await f.close() }
}, 30_000)

it('accepts multiple local edits when each save uses the last committed revision as its witness', async () => {
  const f = await fixture()
  try {
    const saved = await f.page.evaluate(async key => {
      let current = await window.draftStore.read(key)
      current = await window.draftStore.writeDraft(key, { text: 'three local edits', tokens: [], version: 3 }, current.draft.version)
      current = await window.draftStore.writeDraft(key, { text: 'seven local edits', tokens: [], version: 7 }, current.draft.version)
      return window.draftStore.freeze(key, current.draft, { version: 7, captain: 'captain', request: { schemaVersion: 3, requestId: 'serial' } }, current.draft.version)
    }, scopeKey)
    expect(saved).toMatchObject({ draft: { version: 7, text: 'seven local edits' }, pending: { version: 7, request: { requestId: 'serial' } } })
  } finally { await f.close() }
}, 30_000)

it('atomically upgrades a legacy pending with its original identity and Blob, rolling back all parts on failure', async () => {
  const f = await fixture()
  try {
    const result = await f.page.evaluate(async key => {
      const original = { schemaVersion: 1 as const, requestId: 'legacy', target: { rootSessionId: 'original-viewer', teamId: 'a' }, text: 'original', replyTo: 'old-reply' }
      await window.draftStore.migrateLegacy(key, { draft: { text: 'original', tokens: [], version: 1 }, pending: { version: 1, captain: 'captain', request: original } })
      await window.draftStore.markLegacyUpgrade(key, 'legacy', 1)
      const draft = { text: 'updated', tokens: [], version: 3, images: [{ blobId: 'a', mediaType: 'image/png' }] }
      const pending = { version: 3, captain: 'captain', request: { schemaVersion: 3 as const, requestId: 'legacy', target: original.target, content: [{ type: 'image', blobId: 'a', mediaType: 'image/png' }] }, blobIds: ['a'], legacyRequest: original, legacyVersion: 1, upgradedLegacy: true }
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value: unknown, recordKey?: IDBValidKey) { put.call(this, value, recordKey); throw new DOMException('injected failure', 'QuotaExceededError') }
      let rejected = false
      try { await window.draftStore.upgradePending(key, draft, pending, 1, { a: new Blob(['image']) }) } catch { rejected = true } finally { IDBObjectStore.prototype.put = put }
      const rolledBack = await window.draftStore.read(key)
      const upgraded = await window.draftStore.upgradePending(key, draft, pending, 1, { a: new Blob(['image']) })
      return { rejected, rolledBack, pending: upgraded.pending, bytes: await upgraded.blobs.a!.text(), original }
    }, scopeKey)
    expect(result.rejected).toBe(true)
    expect(result.rolledBack).toMatchObject({ draft: { version: 1, text: 'original' }, pending: { request: result.original }, blobs: {} })
    expect(result.pending).toMatchObject({ version: 3, legacyVersion: 1, legacyRequest: result.original, request: { schemaVersion: 3, requestId: 'legacy', target: result.original.target } })
    expect(result.bytes).toBe('image')
    await f.page.reload()
    expect(await f.page.evaluate(async key => (await window.draftStore.read(key)).pending?.request.schemaVersion, scopeKey)).toBe(3)
    const restored = await f.page.evaluate(async key => {
      const saved = await window.draftStore.restoreLegacyPending(key, 'legacy', 3)
      return { ...saved, blobs: { a: await saved.blobs.a!.text() } }
    }, scopeKey)
    expect(restored).toMatchObject({ draft: { version: 3, text: 'updated' }, pending: { request: result.original, version: 1, legacyVersion: 1, upgradedLegacy: true }, blobs: { a: 'image' } })
  } finally { await f.close() }
}, 30_000)
