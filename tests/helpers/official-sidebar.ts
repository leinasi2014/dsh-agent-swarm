import { readFileSync as sidebarReadFile } from 'node:fs'
import { createRequire as sidebarCreateRequire } from 'node:module'
import { dirname as sidebarDirname, join as sidebarJoin } from 'node:path'
import { runInNewContext as sidebarRun } from 'node:vm'
import * as SidebarReact from 'react'
import * as SidebarJsx from 'react/jsx-runtime'
import * as SidebarStore from '@deepseek-ai/dsh-client-store'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'

/** Installed official controller, store actions, dock engine and adoption path. */
export function installedTargetedSidebar() {
  const require = sidebarCreateRequire(import.meta.url)
  const dockkitSource = sidebarReadFile(require.resolve('@deepseek-ai/dsh-client-ui-dockkit'), 'utf8')
  const dockkit = { exports: {} }
  sidebarRun(transpileModule(dockkitSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
    exports: dockkit.exports, module: dockkit, require: (name: string) => {
      if (name === 'react') return SidebarReact
      if (name === 'react/jsx-runtime') return SidebarJsx
      return {} // Unrendered dock widgets, CSS and their UI dependencies.
    },
  })
  const source = sidebarReadFile(sidebarJoin(sidebarDirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json')), 'lib/client.js'), 'utf8')
  const calls: string[] = []
  const faces = new Map<string, any>()
  const stores = new Map<string, any>()
  const disposers: Array<() => void> = []
  let registration: any
  let exported!: { apply(ctx: unknown): void }
  sidebarRun(source, { window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): typeof exported }) => {
    exported = entry.factory(name => {
      if (name === 'react') return SidebarReact
      if (name === 'react/jsx-runtime') return SidebarJsx
      if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      if (name === '@deepseek-ai/dsh-client-ui-dockkit') return dockkit.exports
      if (name === '@deepseek-ai/dsh-client-store') return { ...SidebarStore, defineStore: (definition: any) => {
        const factory = SidebarStore.defineStore(definition)
        return { create: (sessionId: string) => {
          const actual = factory.create(sessionId)
          const actions = actual.actions as Record<string, (...args: any[]) => any>
          const store = { ...actual, actions: { ...actions, openContent: (target: string, ...args: any[]) => { calls.push(target); return actions.openContent!(target, ...args) } } }
          stores.set(sessionId, store); return store
        } }
      } }
      throw new Error(`Unexpected official sidebar dependency: ${name}`)
    })
  } } }, AbortController, crypto })
  exported.apply({
    effect: (effect: () => (() => void), _label: string) => { const off=effect(); disposers.push(off); return off },
    locale: { bind: () => (key: string) => key, register: () => () => {} },
    resources: { pin: () => {} }, layout: { openRightbar: () => {}, closeRightbar: () => {} },
    reflect: { provide: (name: string, value: unknown) => { faces.set(name,value); return () => {} } },
    slots: {
      inject: (_name: string, factory: () => (() => void) | Iterable<() => void>) => {
        const contributions = factory()
        const releases = typeof contributions === 'function' ? [contributions] : Array.from(contributions)
        return () => { releases.toReversed().forEach(release => release()) }
      },
      register: (options: any) => { if(options.name==='rightbar.session') registration=options; return () => {} },
    },
  })
  const controller=faces.get('sidebarRight')
  faces.get('sidebarRightTabs').register({ id:'swarm-test',kind:'swarm-team',title:()=> 'Team' })
  return { controller,calls,
    adopt: (id: string) => { registration.store.create(id) },
    bind: (id: string) => controller.bind({ sessionId:id,actions:stores.get(id).actions,surfaces:{},canSplitPane:()=>true }),
    dispose: () => { disposers.toReversed().forEach(off=>off?.()) },
  }
}
