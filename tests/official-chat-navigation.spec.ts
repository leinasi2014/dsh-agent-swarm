// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import * as store from '@deepseek-ai/dsh-client-store'
import { expect, it } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const noop = () => () => {}
const selector = (source: any) => (select: (value: any) => unknown) => select(React.useSyncExternalStore(source.subscribe, source.getSnapshot))

function officialChat() {
  const require = createRequire(import.meta.url)
  const source = readFileSync(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-chat/package.json')), 'lib/client.js'), 'utf8')
  let exported: any
  const registrations: any[] = [], disposers: Array<() => void> = []
  const faces = new Map<string, any>()
  runInNewContext(source, { window: { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), __ModuleLoader__: { load: (entry: any) => {
    exported = entry.factory((name: string) => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsx
      if (name === '@deepseek-ai/dsh-client-store') return store
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconChevronDownOutline14: () => null }
      if (name === 'react-dom') return {}
      throw new Error(name)
    })
  } } }, AbortController, document, requestAnimationFrame, cancelAnimationFrame })
  const binding = { session: {} }
  exported.apply({
    effect: (effect: () => () => void) => { const off = effect(); disposers.push(off); return off },
    reflect: { provide: (name: string, value: any) => { faces.set(name, value); return () => { faces.delete(name) } } },
    locale: { register: noop, bind: () => (key: string) => key },
    settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: noop }) },
    uiSession: { provide: noop },
    uiConversation: { events: { register: noop, registerFallback: noop }, views: { register: noop }, binding: () => ({ target: () => ({ getSnapshot: () => exported.EMPTY_CHAT_SNAPSHOT, subscribe: noop }) }) },
    sessions: { binding: () => binding },
    slots: { inject: (_name: string, factory: () => any) => { const result = factory(); if (typeof result !== 'function') Array.from(result ?? []); return noop() }, register: (options: any, component: any) => { registrations.push({ options, component }); return noop() } },
  })
  const chat = registrations.find(entry => entry.options.name === 'conversation.view' && entry.options.id === 'chat')
  return { snapshot: exported.EMPTY_CHAT_SNAPSHOT, navigation: faces.get('chatNavigation'), chat, face: (id: string) => chat.options.inject(id), dispose: () => { disposers.toReversed().forEach(off => off?.()) } }
}

it('owns exact Session latest requests, one-shot consumption, stale cancellation and unload cleanup', () => {
  const f = officialChat()
  try {
    expect(f.navigation?.requestLatest).toBeTypeOf('function')
    const a = f.face('a'), b = f.face('b')
    const cancelOld = f.navigation.requestLatest('a')
    const first = a.hooks.latestRequest.getSnapshot()
    expect(first).toBeTypeOf('number')
    expect(b.hooks.latestRequest.getSnapshot()).toBeNull()
    f.navigation.requestLatest('a'); cancelOld()
    const second = a.hooks.latestRequest.getSnapshot()
    expect(second).not.toBe(first)
    expect(a.consumeLatest(first)).toBe(false)
    expect(a.consumeLatest(second)).toBe(true)
    expect(a.consumeLatest(second)).toBe(false)
    const signal = new AbortController()
    f.navigation.requestLatest('b', { signal: signal.signal }); signal.abort()
    expect(b.hooks.latestRequest.getSnapshot()).toBeNull()
    f.navigation.requestLatest('a')
    f.dispose()
    expect(a.hooks.latestRequest.getSnapshot()).toBeNull()
    f.navigation.requestLatest('a')
    expect(a.hooks.latestRequest.getSnapshot()).toBeNull()
  } finally { f.dispose() }
})

it('the installed ChatView restores normal history, consumes same-current reentry after loading, then preserves manual reading', async () => {
  const f = officialChat(), face = f.face('member')
  const container = document.createElement('div')
  container.setAttribute('data-conversation-scroll', '')
  document.body.append(container)
  // jsdom supplies no layout; model the real scroller's bounds and native clamping.
  let top = 0, height = 2400
  Object.defineProperties(container, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => 400 },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 400)) } },
  })
  const session = store.createSnapshotStore({ openState: 'open', openError: null, running: false, queue: [], pendingSubmissions: [], hasMore: true, loadingOlder: false })
  const sessions = store.createSnapshotStore({ current: 'member', byId: { member: {} } })
  const View = f.chat.component
  const props = { ...face, sessionId: 'member', useSession: selector(session), useSessions: selector(sessions),
    useChat: (select: any) => select(f.snapshot), useChatNode: () => undefined, useChatNodeProcess: () => undefined,
    useProjection: () => undefined, useStore: (select: any) => select({}), actions: {}, renderSlot: () => null,
    useLatestRequest: selector(face.hooks.latestRequest), useTranscriptView: selector(face.hooks.transcriptView), t: (key: string) => key,
  }
  let root = createRoot(container)
  try {
    face.chatScroll.save({ scrollTop: 450, anchorKey: 'historical-row', anchorTop: 20 })
    await React.act(async () => { root.render(React.createElement(View, props)) })
    expect(top).toBe(450) // Without the new intent, normal official restoration still works.
    await React.act(async () => { root.unmount() })
    session.set({ ...session.getSnapshot(), openState: 'loading' })
    f.navigation.requestLatest('member')
    root = createRoot(container)
    await React.act(async () => { root.render(React.createElement(View, props)) })
    expect(face.hooks.latestRequest.getSnapshot()).not.toBeNull()
    await React.act(async () => { session.set({ ...session.getSnapshot(), openState: 'open' }) })
    expect(top).toBe(2000)
    expect(face.hooks.latestRequest.getSnapshot()).toBeNull()
    expect(face.chatScroll.read()).toBeNull()
    await React.act(async () => { container.scrollTop = 600; container.dispatchEvent(new Event('scroll')); container.dispatchEvent(new Event('scrollend')) })
    height = 2800
    await React.act(async () => { root.render(React.createElement(View, { ...props })) })
    expect(top).toBe(600)
    // Reentry with no Session selection change and a still-mounted view is also one-shot.
    await React.act(async () => { f.navigation.requestLatest('member') })
    expect(top).toBe(2400)
    await React.act(async () => { container.scrollTop = 300; container.dispatchEvent(new Event('scroll')); container.dispatchEvent(new Event('scrollend')) })
    await React.act(async () => { root.render(React.createElement(View, { ...props })) })
    expect(top).toBe(300)
    await React.act(async () => { sessions.set({ ...sessions.getSnapshot(), current: 'other' }); f.navigation.requestLatest('member') })
    expect(face.hooks.latestRequest.getSnapshot()).not.toBeNull()
    expect(top).toBe(300)
    await React.act(async () => { sessions.set({ ...sessions.getSnapshot(), current: 'member' }) })
    expect(face.hooks.latestRequest.getSnapshot()).toBeNull()
    expect(top).toBe(2400)
  } finally { await React.act(async () => { root.unmount() }); f.dispose(); container.remove() }
})
