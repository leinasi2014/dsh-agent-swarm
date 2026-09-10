import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryEntry } from '../rpc/directory-contract.js'
import { hasUnconfirmedPublicMention } from '../shared/public-content.js'
import { draftContent, mentionCandidate, type PublicDraft } from './public-draft.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export function MentionComposer({ draft, entries, directoryError, directoryLoading, edit, replaceText, choose, remove, refreshDirectory, send, canSend, t }: {
  draft: PublicDraft; entries: readonly DirectoryEntry[]; directoryError: string | undefined; directoryLoading: boolean;
  replaceText: (start: number, end: number, text: string) => void;
  edit: (text: string) => void; choose: (start: number, end: number, memberId: string) => void; remove: (start: number, reselect?: boolean) => void;
  refreshDirectory: () => void; send: () => void; canSend: boolean; t: TranslateNS<typeof TEAM_DASHBOARD_NS>;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null), composing = useRef(false), composingEnded = useRef(false)
  const [caret, setCaret] = useState(draft.text.length), [dismissed, setDismissed] = useState<string>(), [active, setActive] = useState(0)
  const beforeEdit = useRef<{ text: string; start: number; end: number }>()
  const listId = useId(), hintId = useId()
  const candidate = mentionCandidate(draft, caret)
  const candidateKey = candidate === undefined ? undefined : `${candidate.start}:${candidate.end}:${candidate.query}`
  const open = candidate !== undefined && candidateKey !== dismissed && !composing.current
  const candidates = entries.filter(entry => entry.phase === 'active' && `${entry.label} ${entry.name} ${entry.responsibility} ${entry.memberId}`.toLocaleLowerCase().includes(candidate?.query.toLocaleLowerCase() ?? ''))
  const selected = Math.min(active, Math.max(0, candidates.length - 1))
  useEffect(() => { if (open) { refreshDirectory(); setActive(0) } }, [candidate?.start, open])
  useEffect(() => { setCaret(position => Math.min(position, draft.text.length)) }, [draft.text])
  const focusAt = (position: number): void => { queueMicrotask(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(position, position); setCaret(position) }) }
  useEffect(() => {
    const element = textarea.current
    if (element === null) return
    const beforeInput = (event: InputEvent): void => {
      let start = element.selectionStart, end = element.selectionEnd
      if (start === end && event.inputType === 'deleteContentBackward') start = Math.max(0, start - 1)
      if (start === end && event.inputType === 'deleteContentForward') end = Math.min(draft.text.length, end + 1)
      beforeEdit.current = { text: draft.text, start, end }
      if (composing.current || event.isComposing || !event.cancelable) return
      const insertion = event.inputType.startsWith('insert') ? event.data : event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward' ? '' : null
      const touched = draft.tokens.filter(token => start < token.end && end > token.start || start === end && start > token.start && start < token.end)
      if (insertion !== null && touched.length > 0) {
        event.preventDefault(); beforeEdit.current = undefined
        replaceText(start, end, insertion); setDismissed(undefined)
        focusAt(Math.min(start, ...touched.map(token => token.start)) + insertion.length)
      }
    }
    element.addEventListener('beforeinput', beforeInput)
    return () => { element.removeEventListener('beforeinput', beforeInput) }
  }, [draft, replaceText])
  const confirm = (entry: DirectoryEntry): void => {
    if (candidate === undefined || directoryError !== undefined || directoryLoading) return
    choose(candidate.start, candidate.end, entry.memberId); setDismissed(undefined)
    focusAt(candidate.start + entry.label.length + 1)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composingEnded.current) return
    if ((event.key === 'Backspace' || event.key === 'Delete') && !(event.key === 'Delete' && event.shiftKey)) {
      let start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd
      if (start === end) { if (event.key === 'Backspace') start = Math.max(0, start - 1); else end = Math.min(draft.text.length, end + 1) }
      const touched = draft.tokens.filter(token => start < token.end && end > token.start)
      if (touched.length > 0) { event.preventDefault(); beforeEdit.current = undefined; replaceText(start, end, ''); focusAt(Math.min(start, ...touched.map(token => token.start))); return }
    }
    if (event.key === 'Escape' && open) { event.preventDefault(); setDismissed(candidateKey); return }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setActive(value => candidates.length === 0 ? 0 : (value + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return }
    if (open && event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); if (candidates[selected] !== undefined) confirm(candidates[selected]!); return }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) { event.preventDefault(); if (canSend) send() }
  }
  const unconfirmed = hasUnconfirmedPublicMention(draftContent(draft))
  return <div className="swarm-public__mention-editor">
    <textarea ref={textarea} aria-label={t('public.input')} aria-describedby={unconfirmed ? hintId : undefined} aria-autocomplete="list" aria-controls={open ? listId : undefined} aria-expanded={open} aria-activedescendant={open && candidates[selected] !== undefined ? `${listId}-${selected}` : undefined}
      value={draft.text} placeholder={t('public.input')} rows={3}
      onPaste={event => { event.preventDefault(); const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd, text = event.clipboardData.getData('text/plain'); replaceText(start, end, text); setDismissed(undefined); focusAt(start + text.length) }}
      onCut={event => { const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd; if (start === end) return; event.preventDefault(); event.clipboardData.setData('text/plain', draft.text.slice(start, end)); replaceText(start, end, ''); focusAt(start) }}
      onDrop={event => { event.preventDefault(); const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd, text = event.dataTransfer.getData('text/plain'); if (text !== '') { replaceText(start, end, text); setDismissed(undefined); focusAt(start + text.length) } }}
      onFocus={refreshDirectory} onChange={event => {
        setDismissed(undefined); setCaret(event.target.selectionStart)
        const range = beforeEdit.current, text = event.target.value; beforeEdit.current = undefined
        const suffix = range === undefined ? '' : range.text.slice(range.end)
        if (range !== undefined && range.text === draft.text && text.length >= range.start + suffix.length && text.slice(0, range.start) === range.text.slice(0, range.start) && text.endsWith(suffix)) replaceText(range.start, range.end, text.slice(range.start, text.length - suffix.length))
        else edit(text)
      }} onSelect={event => { setCaret(event.currentTarget.selectionStart) }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; composingEnded.current = true; queueMicrotask(() => { composingEnded.current = false }); setCaret(textarea.current?.selectionStart ?? 0) }} onKeyDown={onKeyDown} />
    {draft.tokens.length > 0 ? <div className="swarm-public__tokens" aria-label={t('public.directed')}>{draft.tokens.map(token => <span className="swarm-public__token" data-public-token={token.memberId} key={`${token.start}:${token.memberId}`}>
      <span title={token.memberId}>@{token.label}</span><button type="button" aria-label={`${t('public.reselect')} @${token.label}`} onClick={() => { remove(token.start, true); setDismissed(undefined); focusAt(token.start + 1) }}>↺</button>
      <button type="button" aria-label={`${t('public.removeMention')} @${token.label}`} onClick={() => { remove(token.start); focusAt(token.start) }}>×</button>
    </span>)}</div> : null}
    {unconfirmed ? <p id={hintId} role="status">{t('public.unconfirmed')}</p> : null}
    {open ? <div className="swarm-public__candidate-box">
      {directoryError !== undefined ? <p role="alert">{directoryError} <button type="button" onClick={refreshDirectory}>{t('refresh')}</button></p> : null}
      {directoryLoading ? <p role="status">{t('directory.loading')}</p> : null}
      <div role="listbox" id={listId} aria-label={t('public.candidates')} className="swarm-public__candidates">
        {candidates.map((entry, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={selected === index} key={entry.memberId} data-mention-candidate={entry.memberId} title={`${entry.label} · ${entry.name} · ${entry.memberId}`} tabIndex={-1}
          disabled={directoryLoading || directoryError !== undefined} onMouseDown={event => { event.preventDefault() }} onPointerMove={() => { setActive(index) }} onClick={() => { confirm(entry) }}>
          <SafePixelAvatar seed={entry.memberId} asset={entry.avatar} name={entry.label} t={t} /><span><strong>{entry.label}</strong><small>{entry.responsibility} · {entry.name} · {entry.memberId.slice(0, 8)}</small><small>{t(entry.model.imageInput === 'supported' ? 'directory.supported' : entry.model.imageInput === 'unsupported' ? 'directory.unsupported' : 'directory.imageUnknown')}</small></span>
        </button>)}
      </div>
      {!directoryLoading && !directoryError && candidates.length === 0 ? <p>{t('public.noCandidates')}</p> : null}
    </div> : null}
  </div>
}
