import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps, ConversationController, DraftAttachmentId, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { memberChatPromptSchema, type MemberChatTarget } from '../shared/member-chat.js'
import { MemberChatClient } from './member-chat-client.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type AttachmentOwner = Pick<ConversationController, 'createDrafts' | 'resolveDraftAttachments' | 'serializeDraftAttachments'
  | 'releaseDraftAttachment' | 'releaseDraftAttachments' | 'retryFileUpload' | 'fileUploads'>
interface ComposerFace {
  input: SessionInput
  attachments: AttachmentOwner
  client: Pick<MemberChatClient, 'prompt'>
  cancel: () => Promise<void>
}
type Props = PropsLocale<typeof TEAM_DASHBOARD_NS> & ComposerFace & { sessionId: SessionId; session?: ComposerChainProps['session']; matched: MemberChatTarget }

/** A member-only send surface; draft and attachment ownership stay with the official Conversation. */
export function MemberChatComposer({ sessionId, session, matched, input, attachments, client, cancel, t }: Props) {
  const draft = useSyncExternalStore(input.state.subscribe, input.state.getSnapshot, input.state.getSnapshot)
  const uploads = useSyncExternalStore(attachments.fileUploads.subscribe, attachments.fileUploads.getSnapshot, attachments.fileUploads.getSnapshot)
  const scopeRef = useRef({ sessionId, input, active: true })
  if (scopeRef.current.sessionId !== sessionId || scopeRef.current.input !== input) {
    scopeRef.current.active = false
    scopeRef.current = { sessionId, input, active: true }
  }
  const scope = scopeRef.current
  const [notice, setNotice] = useState<{ scope: typeof scope; pending?: boolean; error?: string }>()
  const sending = useRef<{ scope: typeof scope; abort: AbortController }>()
  const retry = useRef<{ scope: typeof scope; payload: string; requestId: string }>()
  useEffect(() => {
    scope.active = true
    return () => {
      scope.active = false
      if (sending.current?.scope === scope) sending.current.abort.abort()
    }
  }, [scope])
  const pending = notice?.scope === scope && notice.pending === true
  const error = notice?.scope === scope ? notice.error : undefined
  const owned = attachments.resolveDraftAttachments(draft.attachmentIds)
  const report = (reason: unknown): void => {
    if (scope.active) setNotice({ scope, error: reason instanceof Error ? reason.message : t('error') })
  }
  const remove = (id: DraftAttachmentId): void => {
    if (!pending && input.removeAttachment(id)) attachments.releaseDraftAttachment(id)
  }
  const addFiles = (files: readonly File[]): void => {
    if (pending || !scope.active) return
    try {
      const added = attachments.createDrafts(sessionId, files)
      if (!input.addAttachments(added.map(row => row.id))) attachments.releaseDraftAttachments(added)
    } catch (reason) { report(reason) }
  }
  const send = async (delivery: 'queue' | 'steer'): Promise<void> => {
    if (!scope.active || sending.current?.scope === scope || matched.sessionId !== sessionId) return
    const captured = input.state.getSnapshot()
    if (captured.phase !== 'plain' || (!captured.draft.trim() && captured.attachmentIds.length === 0)) return
    const operation = { scope, abort: new AbortController() }
    sending.current = operation
    setNotice({ scope, pending: true })
    try {
      const serialized = await attachments.serializeDraftAttachments(captured.attachmentIds)
      if (!scope.active || operation.abort.signal.aborted) return
      if (serialized.attachments.some(part => part.type === 'file')) throw new Error(t('memberChat.fileUnavailable'))
      const content = [...serialized.attachments, ...(captured.draft.length ? [{ type: 'text' as const, text: captured.draft }] : [])]
      const payload = JSON.stringify({ content, delivery, target: matched.target, name: matched.name, sessionId })
      if (retry.current?.scope !== scope || retry.current.payload !== payload) retry.current = { scope, payload, requestId: crypto.randomUUID() }
      const request = memberChatPromptSchema.parse({ schemaVersion: 1, target: matched.target, name: matched.name, sessionId,
        requestId: retry.current.requestId, content, delivery, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      await client.prompt(request, operation.abort.signal)
      if (!scope.active || operation.abort.signal.aborted) return
      const current = input.state.getSnapshot()
      // An accepted old draft must not erase a programmatic edit made while it was in flight.
      if (current.draftRev === captured.draftRev && current.draft === captured.draft
        && current.attachmentIds.length === captured.attachmentIds.length && current.attachmentIds.every((id, index) => id === captured.attachmentIds[index])) {
        input.setDraft('')
        for (const id of captured.attachmentIds) if (input.removeAttachment(id)) attachments.releaseDraftAttachment(id)
      }
      retry.current = undefined
      setNotice({ scope })
    } catch (reason) { if (!operation.abort.signal.aborted) report(reason) }
    finally { if (sending.current === operation) sending.current = undefined }
  }
  return <section className="swarm-member-composer" data-swarm-member-composer={sessionId} aria-busy={pending}>
    <style>{composerCss}</style>
    <textarea aria-label={t('memberChat.input')} placeholder={t('memberChat.input')} value={draft.draft}
      disabled={pending || draft.phase !== 'plain'} onChange={event => { input.setDraft(event.currentTarget.value) }}
      onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event.shiftKey ? 'steer' : 'queue') } }} />
    {owned.length ? <ul>{owned.map(row => <li key={row.id}>
      {row.kind === 'image' ? <img src={row.previewUrl} alt={row.file.name} /> : null}<span>{row.file.name}</span>
      {uploads[row.id]?.status === 'uploading' ? <span role="status">{t('memberChat.uploading')}</span> : null}
      {uploads[row.id]?.status === 'error' ? <button type="button" disabled={pending} onClick={() => attachments.retryFileUpload(sessionId, row.id)}>{t('memberChat.retryFile')}</button> : null}
      <button type="button" disabled={pending} aria-label={`${t('memberChat.removeFile')} ${row.file.name}`} onClick={() => remove(row.id)}>×</button>
    </li>)}</ul> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="swarm-member-composer__actions"><label>{t('memberChat.attach')}<input type="file" multiple aria-label={t('memberChat.attach')} disabled={pending}
      onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} /></label>
      <button type="button" disabled={pending || draft.phase !== 'plain' || (!draft.draft.trim() && !draft.attachmentIds.length)} onClick={() => { void send('queue') }}>{t(pending ? 'memberChat.sending' : 'memberChat.send')}</button>
      {session?.running ? <button type="button" onClick={() => { void cancel().catch(report) }}>{t('memberChat.stop')}</button> : null}
    </div>
  </section>
}

/** Host attestation is necessary; official ownership and interaction guards remain necessary too. */
export function selectMemberChat(owner: ComposerChainProps, target: MemberChatTarget): MemberChatTarget | null {
  const session = owner.session, address = session?.subagent?.address
  return owner.pendingInteraction === undefined && owner.sessionId === target.sessionId && session?.sessionId === target.sessionId
    && session.openState === 'open' && !session.removed && address?.childSessionId === target.sessionId
    && address.parentSessionId === target.captainSessionId && address.mode === 'continuable' ? target : null
}

/** Target reads follow the actual selected Session, including direct opens after a cold browser load. */
export function installMemberChatComposer(ctx: Context, sessions: ISessions, client: MemberChatClient): void {
  ctx.slots.inject('conversation.composer', () => {
    let selected: SessionId | undefined, abort: AbortController | undefined, unregister: (() => void) | undefined
    const sync = (refresh = false): void => {
      const current = sessions.list.getSnapshot().current
      if (!refresh && selected === current) return
      selected = current; abort?.abort(); unregister?.(); unregister = undefined
      if (current === undefined) return
      const request = new AbortController(); abort = request
      void client.target(current, request.signal).then(target => {
        if (request.signal.aborted || selected !== target.sessionId) return
        // rc.2's parent-offline contribution is -10; chain election takes the first match.
        // The selector still declines pending interactions so their official composer owns the seat.
        unregister = ctx.slots.register({ name: 'conversation.composer', priority: -20, locale: TEAM_DASHBOARD_NS,
          select: owner => selectMemberChat(owner, target),
          inject: sessionId => {
            const scoped = sessions.scope(sessionId)
            if (scoped === undefined) throw new Error('Member Chat Session scope is unavailable')
            const conversation = scoped.conversation as ConversationController
            return { input: conversation.input.for(scoped), attachments: conversation, client, cancel: () => scoped.conversation.cancel() }
          },
        }, MemberChatComposer)
      }).catch(() => { /* An unavailable or unverified target leaves the official composer intact. */ })
    }
    const off = sessions.list.subscribe(sync)
    const offReset = ctx.on('connection/reset', () => { sync(true) })
    sync()
    return () => { selected = undefined; abort?.abort(); off(); offReset(); unregister?.() }
  })
}

const composerCss = `.swarm-member-composer{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.swarm-member-composer textarea{box-sizing:border-box;width:100%;min-height:88px;max-height:240px;resize:vertical;border:0;background:transparent;color:inherit;font:inherit;line-height:1.6}.swarm-member-composer button,.swarm-member-composer label{font:inherit;color:inherit}.swarm-member-composer__actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}.swarm-member-composer__actions input{max-width:min(200px,100%)}.swarm-member-composer ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px}.swarm-member-composer li{display:flex;align-items:center;gap:6px;max-width:100%;overflow-wrap:anywhere}.swarm-member-composer img{width:40px;height:40px;object-fit:cover}.swarm-member-composer [role=alert]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}.swarm-member-composer button:disabled{opacity:.55}`
