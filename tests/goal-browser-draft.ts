import { build } from 'tsdown'
import type { BrowserContext } from 'playwright'
import type { GoalDraftStore } from '../src/client/goal-draft-store.js'

export type BrowserGoalDrafts = Pick<GoalDraftStore, 'read' | 'writeDraft' | 'freeze' | 'settle' | 'close'>
let bundle: Promise<string> | undefined
async function script(): Promise<string> {
  bundle ??= (async () => {
    const output = await build({ entry: ['src/client/goal-draft-store.ts'], format: 'iife', globalName: 'GoalDraftModule', platform: 'browser',
      config: false, write: false, dts: false, noExternal: [/./], logLevel: 'silent' })
    const code = output.flatMap(result => result.chunks).filter(chunk => chunk.type === 'chunk').map(chunk => chunk.code).join('\n')
    for (const result of output) await result[Symbol.asyncDispose]()
    return code
  })()
  return bundle
}
/** Browser initialization completes before any controller deadline begins. Every call uses production IndexedDB storage. */
export async function browserGoalDrafts(context: BrowserContext, name: string): Promise<BrowserGoalDrafts> {
  const page = await context.newPage()
  await page.route('http://goal-drafts.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Goal drafts</title>' }))
  await page.goto('http://goal-drafts.test/')
  await page.addScriptTag({ content: `${await script()}; const goalStore = new GoalDraftModule.GoalDraftStore(indexedDB,${JSON.stringify(name)}); window.goalDraftCall = (method,args) => Reflect.apply(goalStore[method],goalStore,args);` })
  const invoke = (method: string, args: unknown[]) => page.evaluate(async value => (window as unknown as { goalDraftCall(method: string, args: unknown[]): Promise<unknown> }).goalDraftCall(value.method, value.args), { method, args })
  await invoke('read', ['browser-initialized'])
  return { read: key => invoke('read', [key]), writeDraft: (...args) => invoke('writeDraft', args), freeze: (...args) => invoke('freeze', args), settle: (...args) => invoke('settle', args),
    close: () => { void invoke('close', []).then(() => page.close()).catch(() => {}) } } as BrowserGoalDrafts
}
