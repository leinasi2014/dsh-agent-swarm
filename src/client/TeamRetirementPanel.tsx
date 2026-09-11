import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RetirementHistory, RetirementPreview, RetirementRequest, RetirementResult, RetirementTarget } from '../shared/team-retirement.js'
import type { RetirementClient } from './retirement-client.js'
import { RetirementRpcError } from './retirement-client.js'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PublicTextFold } from './PublicTextFold.js'

interface Props {
  readonly client: RetirementClient
  readonly target: RetirementTarget
  readonly action: 'archive' | 'delete' | 'history'
  readonly initialSessionId?: string | undefined
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly close: () => void
  readonly completed: (result: RetirementResult) => Promise<void>
}
const countLabels = { sessions: 'sessions', memories: 'memories', humanInteractions: 'interactions', workflowRuns: 'workflows',
  unfinishedTasks: 'tasks', activeAttempts: 'attempts', protectedSessions: 'protected' } as const

export function TeamRetirementPanel({ client, target, action, initialSessionId, t, close, completed }: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<RetirementPreview>()
  const [history, setHistory] = useState<RetirementHistory>()
  const [historyTrail, setHistoryTrail] = useState<number[]>([])
  const [request, setRequest] = useState<RetirementRequest>()
  const [result, setResult] = useState<RetirementResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  const alive = useRef(true)
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
  const accept = async (value: RetirementResult) => {
    if (!alive.current) return
    setResult(value)
    if (value.state === 'completed') { await completed(value); close() }
    if (value.state === 'confirmation-required') setRequest(undefined)
  }
  const inspect = async () => {
    setBusy(true); setError(undefined); setName('')
    try { const value = await client.preview(target); if (alive.current) { setPreview(value); setResult(undefined); setRequest(undefined) } }
    catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const readHistory = async (sessionId?: string, cursor = 0) => {
    setBusy(true); setError(undefined)
    try { const value = await client.history({ schemaVersion: 1, target, cursor, ...(sessionId === undefined ? {} : { sessionId }) }); if (alive.current) setHistory(value) }
    catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    const trigger = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    void (async () => {
      if (action === 'history') { await readHistory(initialSessionId); return }
      try {
        const pending = client.pending(target)
        if (pending === undefined) { await inspect(); return }
        setRequest(pending); setBusy(true)
        const value = await client.result(pending)
        if (value.state !== 'not-found') await accept(value)
      } catch (cause) { if (alive.current) setError(message(cause)) }
      finally { if (alive.current) setBusy(false) }
    })()
    return () => { alive.current = false; trigger?.focus() }
  }, [client, target.rootSessionId, target.teamId, action, initialSessionId])
  const execute = async () => {
    if (action === 'history') return
    setBusy(true); setError(undefined)
    const next = request ?? (preview === undefined ? undefined : { schemaVersion: 1 as const, target, action,
      requestId: crypto.randomUUID(), expectedTeamRevision: preview.teamRevision, ...(action === 'delete' ? { previewDigest: preview.previewDigest } : {}) })
    if (next === undefined) { setBusy(false); return }
    setRequest(next)
    try { await accept(await client.execute(next)) }
    catch (cause) {
      if (alive.current) {
        setError(message(cause))
        if (cause instanceof RetirementRpcError && ['TEAM_RETIREMENT_PREVIEW_CHANGED', 'TEAM_REVISION_CONFLICT', 'SWARM_RPC_INVALID_REQUEST'].includes(cause.code)) { setRequest(undefined); setPreview(undefined) }
      }
    }
    finally { if (alive.current) setBusy(false) }
  }
  const query = async () => {
    if (request === undefined) return
    setBusy(true); setError(undefined)
    try { const value = await client.result(request); if (value.state !== 'not-found') await accept(value) }
    catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')]
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
  }
  const counts = preview?.counts ?? result?.counts
  const displayAction = request?.action ?? action
  return createPortal(<div className="swarm-retirement-shade" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <style>{`.swarm-retirement-shade{position:fixed;inset:0;z-index:10000;background:#0006;display:grid;place-items:center;padding:20px;box-sizing:border-box}.swarm-retirement-panel{box-sizing:border-box;width:min(620px,100%);max-height:85vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202124);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:14px;padding:24px;box-shadow:0 18px 70px #0005;font:14px/1.5 sans-serif;outline:none}.swarm-retirement-transcript{display:flex;flex-direction:column;gap:18px;margin:18px 0}.swarm-retirement-transcript article{padding:14px 16px;background:color-mix(in srgb,currentColor 4%,transparent);border-radius:10px}.swarm-retirement-transcript article[data-history-role=user]{margin-left:30px;background:color-mix(in srgb,#6485d9 12%,transparent)}.swarm-retirement-transcript small{display:block;margin-bottom:6px;opacity:.65}.swarm-retirement-transcript .swarm-public__text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.swarm-retirement-transcript .swarm-public__text[data-expanded=false]{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}.swarm-retirement-transcript details{border:0;padding:0}.swarm-retirement-panel h2{font-size:19px;margin:0 0 8px}.swarm-retirement-panel p{overflow-wrap:anywhere}.swarm-retirement-panel dl{display:grid;grid-template-columns:1fr auto;gap:7px 20px;padding:14px 0}.swarm-retirement-panel dd{margin:0;font-variant-numeric:tabular-nums}.swarm-retirement-panel input,.swarm-retirement-panel select{box-sizing:border-box;width:100%;padding:9px;margin:8px 0 14px;border:1px solid #9996;border-radius:6px;color:inherit;background:transparent}.swarm-retirement-panel footer{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:20px}.swarm-retirement-panel button{padding:8px 14px;border:1px solid #9996;border-radius:7px;background:transparent;color:inherit;cursor:pointer}.swarm-retirement-panel button:disabled{opacity:.45;cursor:default}.swarm-retirement-panel button[data-danger]{background:#b3261e;color:#fff;border-color:#b3261e}.swarm-retirement-panel [role=alert]{color:#c43c35}.swarm-retirement-panel details{border-top:1px solid #8883;padding:10px 0}.swarm-retirement-panel summary{cursor:pointer;overflow-wrap:anywhere}.swarm-retirement-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace}`}</style>
    <div ref={dialog} className="swarm-retirement-panel" role="dialog" aria-modal="true" aria-labelledby="swarm-retirement-title" tabIndex={-1} onKeyDown={keys} data-team-retirement-dialog>
      <h2 id="swarm-retirement-title">{t(`retirement.${displayAction}`)}</h2>
      {action === 'history' ? <>
        <p>{t('retirement.historyHelp')}</p>
        {history === undefined ? null : <><strong>{history.teamName}</strong><select aria-label={t('retirement.sessions')} disabled={busy} value={history.sessionId ?? ''}
          onChange={event => { setHistoryTrail([]); void readHistory(event.target.value) }}>{history.sessions.map(row => <option key={row.id} value={row.id} disabled={!row.available}>{row.label} · {row.role}</option>)}</select>
          <div className="swarm-retirement-transcript">{history.entries.length === 0 ? <p>{t('retirement.noHistory')}</p> : history.entries.map(entry => <article data-history-role={entry.role} key={`${history.sessionId}:${entry.sequence}`}>
            <small>{t(`retirement.${entry.role}`)}</small>{entry.role === 'context' || entry.role === 'tool' ? <details><summary>{entry.content.split('\n')[0]?.slice(0, 110)}</summary><PublicTextFold foldKey={`${history.sessionId}:${entry.sequence}`} t={t}>{entry.content}</PublicTextFold></details>
              : <PublicTextFold foldKey={`${history.sessionId}:${entry.sequence}`} t={t}>{entry.content}</PublicTextFold>}{entry.truncated ? <small>{t('retirement.truncated')}</small> : null}</article>)}</div>
          <footer><button type="button" disabled={busy || historyTrail.length === 0} onClick={() => { const previous = historyTrail.at(-1); if (previous !== undefined) { setHistoryTrail(historyTrail.slice(0, -1)); void readHistory(history.sessionId, previous) } }}>{t('retirement.earlier')}</button>
            <button type="button" disabled={busy || history.nextCursor === undefined} onClick={() => { if (history.nextCursor !== undefined) { setHistoryTrail([...historyTrail, history.cursor]); void readHistory(history.sessionId, history.nextCursor) } }}>{t('retirement.later')}</button></footer></>}
      </> : <>
        <strong>{preview?.teamName}</strong><p>{t(displayAction === 'archive' ? 'retirement.archiveHelp' : 'retirement.deleteHelp')}</p><p>{t('retirement.preserve')}</p>
        {counts === undefined ? null : <dl>{Object.entries(countLabels).map(([key, label]) => <div key={key} style={{ display: 'contents' }}><dt>{t(`retirement.${label}`)}</dt><dd>{counts[key as keyof typeof counts]}</dd></div>)}</dl>}
        {result?.state === 'confirmation-required' ? <p role="status">{t('retirement.changed')}</p> : request !== undefined ? <p role="status">{t('retirement.pending')}</p> : null}
        {preview?.deletion.available === false && action === 'delete' ? <p role="alert">{t('retirement.unavailable')} {preview.deletion.reason}</p> : null}
        {action === 'delete' && request === undefined && preview !== undefined ? <label>{t('retirement.confirmName')}：<strong>{preview.teamName}</strong><input value={name} onChange={event => { setName(event.target.value) }} autoComplete="off" data-retirement-confirm-name /></label> : null}
      </>}
      {busy ? <p role="status">{t(request === undefined ? 'retirement.loading' : 'retirement.processing')}</p> : null}
      {error === undefined ? null : <p role="alert">{error}</p>}
      <footer><button type="button" onClick={close}>{t('retirement.close')}</button>
        {action === 'history' ? null : request !== undefined ? <><button type="button" disabled={busy} onClick={() => { void query() }}>{t('retirement.query')}</button><button type="button" disabled={busy} onClick={() => { void execute() }}>{t('retirement.continue')}</button></>
          : result?.state === 'confirmation-required' || preview === undefined ? <button type="button" disabled={busy} onClick={() => { void inspect() }}>{t('retirement.refresh')}</button>
          : <button type="button" data-danger={action === 'delete' ? true : undefined} data-retirement-confirm disabled={busy || (action === 'delete' && (!preview.deletion.available || name !== preview.teamName))} onClick={() => { void execute() }}>{t(`retirement.${action}`)}</button>}
      </footer>
    </div>
  </div>, document.body)
}
