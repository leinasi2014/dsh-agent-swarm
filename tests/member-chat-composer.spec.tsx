// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposerChainProps, DraftAttachmentId, InputState, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MemberChatComposer, installMemberChatComposer, selectMemberChat } from '../src/client/MemberChatComposer.js'
import { MemberChatClient } from '../src/client/member-chat-client.js'
import { MEMBER_CHAT_CHANNEL, type MemberChatPrompt, type MemberChatPromptResult, type MemberChatTarget } from '../src/shared/member-chat.js'
import { en, zh } from '../src/client/team-dashboard-locales.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const target: MemberChatTarget = { schemaVersion: 1, target: { rootSessionId: 'main', teamId: 'team' }, name: 'alice', sessionId: 'member', captainSessionId: 'captain' }
const result: MemberChatPromptResult = { schemaVersion: 1, sessionId: 'member', messageId: 'message' }
const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'aW1hZ2U=', name: 'one.png' }
type Props = ComponentProps<typeof MemberChatComposer>
const t: Props['t'] = key => zh[key as keyof typeof zh] ?? key
const roots: Root[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren() })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(text = '  original\ntext  ', serialized: Awaited<ReturnType<Props['attachments']['serializeDraftAttachments']>>['attachments'] = []) {
  const ids = serialized.map((_, i) => `draft-${i}` as DraftAttachmentId)
  const state = createSnapshotStore<InputState>({ draft: text, attachmentIds: ids, draftRev: 1, phase: 'plain', occurrences: [], queue: [] })
  const input: SessionInput = {
    state, setDraft: value => { const old = state.getSnapshot(); state.set({ ...old, draft: value, draftRev: old.draftRev + 1 }) },
    addAttachments: next => { state.set({ ...state.getSnapshot(), attachmentIds: [...state.getSnapshot().attachmentIds, ...next] }); return true },
    removeAttachment: id => { const old = state.getSnapshot(); if (!old.attachmentIds.includes(id)) return false; state.set({ ...old, attachmentIds: old.attachmentIds.filter(row => row !== id) }); return true },
    pruneAttachments: vi.fn(), submit: vi.fn(), notify: vi.fn(), beginCommand: () => false, insertReference: () => false,
  }
  const attachments: Props['attachments'] = {
    fileUploads: createSnapshotStore({}), createDrafts: vi.fn(() => []),
    resolveDraftAttachments: vi.fn(() => []), serializeDraftAttachments: vi.fn(async () => ({ attachments: serialized })),
    releaseDraftAttachment: vi.fn(), releaseDraftAttachments: vi.fn(), retryFileUpload: vi.fn(),
  }
  const prompt = vi.fn(async (_request: MemberChatPrompt, _signal?: AbortSignal) => result)
  const props: Props = { sessionId: target.sessionId as Props['sessionId'], matched: target, input, attachments, client: { prompt }, cancel: vi.fn(async () => {}), t }
  return { props, state, input, attachments, prompt, ids }
}
async function mount(props: Props) {
  const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
  await act(async () => root.render(<MemberChatComposer {...props} />))
  return async (next: Props) => { await act(async () => root.render(<MemberChatComposer {...next} />)) }
}
const sendButton = () => Array.from(document.querySelectorAll('button')).find(button => button.textContent === zh['memberChat.send'] || button.textContent === zh['memberChat.sending'])!
async function send(twice = false) { await act(async () => { sendButton().click(); if (twice) sendButton().click() }) }

describe('managed member composer', () => {
  it('sends exact text and ordered official images once on a double click and clears only after success', async () => {
    const images = [image, { ...image, name: 'two.png', data: 'c2Vjb25k' }]
    const f = fixture(undefined, images), pending = deferred<MemberChatPromptResult>()
    f.prompt.mockReturnValue(pending.promise)
    await mount(f.props); await send(true)
    expect(f.prompt).toHaveBeenCalledTimes(1)
    expect(f.prompt.mock.calls[0]![0]).toMatchObject({ schemaVersion: 1, target: target.target, name: target.name, sessionId: target.sessionId, delivery: 'queue', content: [...images, { type: 'text', text: '  original\ntext  ' }] })
    expect(f.prompt.mock.calls[0]![0].requestId).toMatch(/^[\da-f-]{36}$/u)
    expect(f.attachments.serializeDraftAttachments).toHaveBeenCalledWith(f.ids)
    expect(f.state.getSnapshot().draft).toBe('  original\ntext  ')
    expect(f.attachments.releaseDraftAttachment).not.toHaveBeenCalled()
    await act(async () => pending.resolve(result))
    expect(f.state.getSnapshot()).toMatchObject({ draft: '', attachmentIds: [] })
    expect(f.attachments.releaseDraftAttachment).toHaveBeenCalledTimes(2)
  })

  it('retains a rejected text/image draft, never retries automatically, and explicitly retries the same request identity', async () => {
    const f = fixture(undefined, [image])
    f.prompt.mockRejectedValueOnce(new Error('CAPTAIN_UNAVAILABLE'))
    await mount(f.props); await send()
    expect(document.querySelector('[role=alert]')?.textContent).toBe('CAPTAIN_UNAVAILABLE')
    expect(f.state.getSnapshot()).toMatchObject({ draft: '  original\ntext  ', attachmentIds: f.ids })
    expect(f.attachments.releaseDraftAttachment).not.toHaveBeenCalled()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(f.prompt).toHaveBeenCalledTimes(1)
    const first = f.prompt.mock.calls[0]![0]
    await send()
    expect(f.prompt).toHaveBeenCalledTimes(2)
    expect(f.prompt.mock.calls[1]![0]).toEqual(first)
    expect(f.state.getSnapshot().draft).toBe('')
  })

  it.each(['success', 'failure'] as const)('ignores a late %s after switching Session, preserving both Session drafts', async outcome => {
    const first = fixture('old draft', [image]), pending = deferred<MemberChatPromptResult>()
    first.prompt.mockReturnValue(pending.promise)
    const rerender = await mount(first.props); await send()
    const second = fixture('new draft')
    second.props = { ...second.props, sessionId: 'second' as Props['sessionId'], matched: { ...target, sessionId: 'second' } }
    await rerender(second.props)
    expect(first.prompt.mock.calls[0]![1]?.aborted).toBe(true)
    await act(async () => { if (outcome === 'success') pending.resolve(result); else pending.reject(new Error('late old failure')) })
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('new draft')
    expect(document.querySelector('[role=alert]')).toBeNull()
    expect(sendButton().disabled).toBe(false)
    expect(second.state.getSnapshot().draft).toBe('new draft')
    expect(first.state.getSnapshot()).toMatchObject({ draft: 'old draft', attachmentIds: first.ids })
    expect(first.attachments.releaseDraftAttachment).not.toHaveBeenCalled()
  })

  it('does not send when Session changes during attachment serialization', async () => {
    const first = fixture('old', [image]), pending = deferred<{ attachments: typeof image[] }>()
    vi.mocked(first.attachments.serializeDraftAttachments).mockReturnValue(pending.promise)
    const rerender = await mount(first.props); await send()
    const next = fixture('new')
    await rerender({ ...next.props, sessionId: 'second' as Props['sessionId'], matched: { ...target, sessionId: 'second' } })
    await act(async () => pending.resolve({ attachments: [image] }))
    expect(first.prompt).not.toHaveBeenCalled()
    expect(first.state.getSnapshot().draft).toBe('old')
  })

  it('retains a generic-file receipt draft with the official unsupported boundary and does not invent an image or durable attachment ID', async () => {
    const f = fixture('file draft', [{ type: 'file', receiptId: 'official-receipt' }])
    await mount(f.props); await send()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(document.querySelector('[role=alert]')?.textContent).toBe(zh['memberChat.fileUnavailable'])
    expect(en['memberChat.fileUnavailable']).toContain('draft is retained')
    expect(f.state.getSnapshot()).toMatchObject({ draft: 'file draft', attachmentIds: f.ids })
    expect(f.attachments.releaseDraftAttachment).not.toHaveBeenCalled()
  })

  it('supports an image-only prompt and explicit steering while ignoring an IME composition gesture', async () => {
    const f = fixture('', [image]); await mount(f.props)
    const textarea = document.querySelector('textarea')!
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true, shiftKey: true, isComposing: true })))
    expect(f.prompt).not.toHaveBeenCalled()
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true, shiftKey: true })))
    expect(f.prompt.mock.calls[0]![0]).toMatchObject({ delivery: 'steer', content: [image] })
  })

  it('does not erase a newer programmatic edit when the previous draft is accepted', async () => {
    const f = fixture('captured', [image]), pending = deferred<MemberChatPromptResult>(); f.prompt.mockReturnValue(pending.promise)
    await mount(f.props); await send()
    await act(async () => f.input.setDraft('newer edit'))
    await act(async () => pending.resolve(result))
    expect(f.state.getSnapshot().draft).toBe('newer edit')
    expect(f.state.getSnapshot().attachmentIds).toEqual(f.ids)
    expect(f.attachments.releaseDraftAttachment).not.toHaveBeenCalled()
  })

  it('retains a programmatically changed attachment draft after the earlier prompt succeeds', async () => {
    const f = fixture('captured', [image]), pending = deferred<MemberChatPromptResult>(); f.prompt.mockReturnValue(pending.promise)
    await mount(f.props); await send()
    await act(async () => { f.input.addAttachments(['new-image' as DraftAttachmentId]) })
    await act(async () => pending.resolve(result))
    expect(f.state.getSnapshot()).toMatchObject({ draft: 'captured', attachmentIds: [...f.ids, 'new-image'] })
    expect(f.attachments.releaseDraftAttachment).not.toHaveBeenCalled()
  })

  it('keeps the official Stop action available for a running member even when parentAvailable is false', async () => {
    const f = fixture('keep draft')
    await mount({ ...f.props, session: { ...owner().session!, running: true } })
    const stop = Array.from(document.querySelectorAll('button')).find(button => button.textContent === zh['memberChat.stop'])!
    await act(async () => stop.click())
    expect(f.props.cancel).toHaveBeenCalledTimes(1)
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.state.getSnapshot().draft).toBe('keep draft')
  })
})

function owner(): ComposerChainProps {
  return { sessionId: target.sessionId, session: { sessionId: target.sessionId, openState: 'open', removed: false,
    subagent: { parentAvailable: false, address: { childSessionId: target.sessionId, parentSessionId: target.captainSessionId, mode: 'continuable' } } } } as ComposerChainProps
}
describe('official composer chain ownership and Host target read', () => {
  it('accepts only the attested open continuable member and yields to official pending interactions', () => {
    const valid = owner()
    expect(selectMemberChat(valid, target)).toBe(target)
    expect(selectMemberChat({ ...valid, pendingInteraction: {} as never }, target)).toBeNull()
    expect(selectMemberChat({ ...valid, sessionId: 'other' as never }, target)).toBeNull()
    expect(selectMemberChat({ ...valid, session: { ...valid.session!, removed: true } }, target)).toBeNull()
    expect(selectMemberChat({ ...valid, session: { ...valid.session!, openState: 'loading' } }, target)).toBeNull()
    expect(selectMemberChat(valid, { ...target, captainSessionId: 'other-captain' })).toBeNull()
    expect(selectMemberChat({ ...valid, session: { ...valid.session!, subagent: { ...valid.session!.subagent!, address: { ...valid.session!.subagent!.address, mode: 'one-shot' } } } }, target)).toBeNull()
  })

  it('reads a directly opened Session, registers only after Host attestation, and disposes stale reads and entries', async () => {
    const list = createSnapshotStore({ current: 'member' as Props['sessionId'] | undefined })
    const first = deferred<MemberChatTarget>(), second = deferred<MemberChatTarget>()
    const targetRead = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const unregister = vi.fn(), register = vi.fn((_options: unknown, _component: unknown) => unregister)
    let dispose!: () => void
    const slots = { inject: (_name: string, callback: () => () => void) => { dispose = callback() }, register }
    const client = { target: targetRead } as unknown as MemberChatClient
    installMemberChatComposer({ slots, on: () => () => {} } as never, { list } as never, client)
    expect(targetRead).toHaveBeenCalledWith('member', expect.any(AbortSignal))
    expect(register).not.toHaveBeenCalled()
    list.set({ current: 'second' as Props['sessionId'] })
    expect(targetRead.mock.calls[0]![1].aborted).toBe(true)
    first.resolve(target); await Promise.resolve()
    expect(register).not.toHaveBeenCalled()
    second.resolve({ ...target, sessionId: 'second' }); await Promise.resolve()
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'conversation.composer', priority: 100 })
    dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(targetRead.mock.calls[1]![1].aborted).toBe(true)
    list.set({ current: 'third' as Props['sessionId'] })
    expect(targetRead).toHaveBeenCalledTimes(2)
  })

  it('leaves the official composer unchanged after an unavailable target and does not poll or auto retry', async () => {
    const targetRead = vi.fn().mockRejectedValue(new Error('NOT_MANAGED')), register = vi.fn()
    let dispose!: () => void
    installMemberChatComposer({ on: () => () => {}, slots: { inject: (_name: string, callback: () => () => void) => { dispose = callback() }, register } } as never,
      { list: createSnapshotStore({ current: 'ordinary-session' }) } as never, { target: targetRead } as unknown as MemberChatClient)
    await Promise.resolve(); await Promise.resolve()
    expect(register).not.toHaveBeenCalled(); expect(targetRead).toHaveBeenCalledTimes(1); dispose()
  })

  it('rechecks the same selected Session on connection reset and withdraws stale attestation before that read', async () => {
    const targetRead = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce(target).mockRejectedValueOnce(new Error('MEMBER_REMOVED'))
    const unregister = vi.fn(), register = vi.fn((_options: unknown, _component: unknown) => unregister), offReset = vi.fn()
    let reset!: () => void, dispose!: () => void
    installMemberChatComposer({ on: (name: string, callback: () => void) => { expect(name).toBe('connection/reset'); reset = callback; return offReset },
      slots: { inject: (_name: string, callback: () => () => void) => { dispose = callback() }, register } } as never,
    { list: createSnapshotStore({ current: 'member' }) } as never, { target: targetRead } as unknown as MemberChatClient)
    await Promise.resolve(); await Promise.resolve(); expect(register).not.toHaveBeenCalled()
    reset(); await Promise.resolve(); expect(register).toHaveBeenCalledTimes(1)
    reset(); expect(unregister).toHaveBeenCalledTimes(1)
    await Promise.resolve(); await Promise.resolve()
    expect(register).toHaveBeenCalledTimes(1); expect(targetRead).toHaveBeenCalledTimes(3)
    dispose(); expect(offReset).toHaveBeenCalledTimes(1)
  })
})

describe('member Chat RPC transport', () => {
  it('uses the authenticated channel and preserves explicit Host errors without retries', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, error: { code: 'MEMBER_UNAVAILABLE', message: 'Member removed', details: {} } })
    const client = new MemberChatClient({ call }), abort = new AbortController()
    await expect(client.target('member', abort.signal)).rejects.toMatchObject({ code: 'MEMBER_UNAVAILABLE', message: 'Member removed' })
    expect(call).toHaveBeenCalledExactlyOnceWith(MEMBER_CHAT_CHANNEL, 'target', { schemaVersion: 1, sessionId: 'member' }, abort.signal)
  })

  it('rejects a target or prompt response for a different Session', async () => {
    const call = vi.fn().mockResolvedValueOnce({ ok: true, value: { ...target, sessionId: 'other' } }).mockResolvedValueOnce({ ok: true, value: { ...result, sessionId: 'other' } })
    const client = new MemberChatClient({ call })
    await expect(client.target('member')).rejects.toThrow('target Session changed')
    await expect(client.prompt({ schemaVersion: 1, target: target.target, name: target.name, sessionId: 'member', requestId: crypto.randomUUID(), content: [image], delivery: 'queue' })).rejects.toThrow('prompt Session changed')
    expect(call).toHaveBeenCalledTimes(2)
  })
})
