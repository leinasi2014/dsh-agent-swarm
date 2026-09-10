import { draftStoreScript } from './draft-store-script.js'
import type { BrowserContext } from 'playwright'
import type { WorkDraftPersistence } from '../../src/client/work-request-controller.js'

/** Every storage operation runs the production store in real Edge IndexedDB. */
export function browserWorkDraftStore(context: BrowserContext, name: string): WorkDraftPersistence {
  const page = (async () => {
    const tab = await context.newPage()
    await tab.route('http://work-controller.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Work storage</title>' }))
    await tab.goto('http://work-controller.test/')
    const code = draftStoreScript('work-request-draft-store')
    await tab.addScriptTag({ content: `{const exports={}; ${code}; const store=new exports.WorkRequestDraftStore(indexedDB,${JSON.stringify(name)}); window.workDraftCall=(method,args)=>Reflect.apply(store[method],store,args);}` })
    return tab
  })()
  const call = async (methodName: string, methodArgs: unknown[]): Promise<unknown> => (await page).evaluate(async ({ method, args }) => {
    const bridge = window as unknown as { workDraftCall(method: string, args: unknown[]): Promise<unknown> }
    return await bridge.workDraftCall(method, args)
  }, { method: methodName, args: methodArgs })
  return {
    read: key => call('read', [key]), writeDraft: (...args) => call('writeDraft', args), freeze: (...args) => call('freeze', args), settle: (...args) => call('settle', args),
    close: () => { void call('close', []).then(async () => { await (await page).close() }).catch(() => {}) },
  } as WorkDraftPersistence
}
