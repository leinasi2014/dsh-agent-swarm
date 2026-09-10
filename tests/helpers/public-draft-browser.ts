import { draftStoreScript } from './draft-store-script.js'
import ts from 'typescript'
import type { BrowserContext } from 'playwright'
import type { PublicDraftPersistence } from '../../src/client/public-chat-controller.js'

const storeScript = (): string => draftStoreScript('public-draft-store')
async function pack(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return { packedDraftBlob: true, type: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] }
  if (Array.isArray(value)) return Promise.all(value.map(pack))
  if (value !== null && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await pack(entry)])))
  return value
}
function unpack(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unpack)
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (row.packedDraftBlob === true) return new Blob([new Uint8Array(row.bytes as number[])], { type: row.type as string })
    return Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, unpack(entry)]))
  }
  return value
}
/** Only transport is adapted: every draft command executes the production store in real Edge IndexedDB. */
export function browserDraftStore(context: BrowserContext, name: string): PublicDraftPersistence {
  const page = (async () => {
    const tab = await context.newPage()
    await tab.route('http://controller-draft.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controller draft fixture</title>' }))
    await tab.goto('http://controller-draft.test/')
    const functions = ts.transpileModule(`${pack.toString()}\n${unpack.toString()}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    await tab.addScriptTag({ content: `{ const exports = {}; ${storeScript()}; ${functions}; const store = new exports.PublicDraftStore(indexedDB, ${JSON.stringify(name)}); window.draftCall = async (method, args) => pack(await Reflect.apply(store[method], store, unpack(args))); }` })
    return tab
  })()
  const call = async (methodName: string, methodArgs: unknown[]): Promise<unknown> => {
    const tab = await page, packed = await pack(methodArgs)
    const result = await tab.evaluate(async ({ method, args }) => {
      const bridge = window as unknown as Window & { draftCall: (method: string, args: unknown) => Promise<unknown> }
      return bridge.draftCall(method, args)
    }, { method: methodName, args: packed })
    return unpack(result)
  }
  // Generic method shapes are exactly the production interface; data is structured-cloned by the browser store.
  return {
    read: key => call('read', [key]), writeDraft: (...args) => call('writeDraft', args), freeze: (...args) => call('freeze', args),
    settle: (...args) => call('settle', args), migrateLegacy: (...args) => call('migrateLegacy', args),
    upgradePending: (...args) => call('upgradePending', args), markLegacyUpgrade: (...args) => call('markLegacyUpgrade', args), restoreLegacyPending: (...args) => call('restoreLegacyPending', args),
    close: () => { void call('close', []).then(async () => { await (await page).close() }).catch(() => {}) },
  } as PublicDraftPersistence
}
