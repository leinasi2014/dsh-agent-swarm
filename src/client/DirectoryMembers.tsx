import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PublicChatController } from './public-chat-controller.js'
import type { TeamDashboardState } from './team-dashboard-controller.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { MemberProfileSurface } from './MemberProfileSurface.js'
import { MemberProfileContent, profileCss } from './MemberProfileContent.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
type T = TranslateNS<typeof TEAM_DASHBOARD_NS>

/** This is the same directory snapshot used by mention candidates and left navigation. */
export function DirectoryMembers({ chat, dashboard, onTask, t }: { chat: PublicChatController; dashboard?: TeamDashboardState; onTask?: ((id: string) => void) | undefined; t: T }) {
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot, chat.getSnapshot)
  const [memberId, setMemberId] = useState<string>(), trigger = useRef<HTMLButtonElement | null>(null), root = useRef<HTMLDivElement>(null)
  const entry = state.directory?.entries.find(row => row.memberId === memberId)
  const data = dashboard?.data
  const assets = dashboard?.phase === 'ready' && data !== undefined && data.captainMembers.binding.teamId === state.selection?.team && data.captainMembers.binding.rootSessionId === state.selection?.captain ? data.captainMembers : undefined
  const result = assets?.members.find(row => row.sessionId === memberId)
  const close = useCallback((restore: boolean): void => { setMemberId(undefined); if (restore) queueMicrotask(() => { if (trigger.current?.isConnected) trigger.current.focus() }) }, [])
  useEffect(() => { void chat.refreshDirectory() }, [chat, state.selection?.key])
  useEffect(() => { setMemberId(undefined) }, [state.selection?.key])
  useEffect(() => { if (memberId !== undefined && entry === undefined && !state.directoryLoading) close(false) }, [memberId, entry, state.directoryLoading, close])
  return <div ref={root} className="swarm-directory" data-swarm-directory onKeyDown={event => { if (event.key === 'Escape' && memberId !== undefined) { event.preventDefault(); event.stopPropagation(); close(true) } }} onFocusCapture={() => { if (!state.directoryLoading) void chat.refreshDirectory() }}>
    <style>{directoryCss}{profileCss}</style>
    {state.directoryLoading && state.directory === undefined ? <p role="status">{t('directory.loading')}</p> : null}
    {state.directoryError ? <p role="alert">{state.directoryError} <button type="button" onClick={() => { void chat.refreshDirectory() }}>{t('refresh')}</button></p> : null}
    <div className="swarm-directory__grid" aria-busy={state.directoryLoading}>{state.directory?.entries.map(row => <button type="button" key={row.memberId} data-directory-member={row.memberId} aria-label={`${row.label} · ${row.name}`} aria-haspopup="dialog" aria-expanded={memberId === row.memberId} title={`${row.label} · ${row.responsibility}`} onClick={event => {
      trigger.current = event.currentTarget; setMemberId(current => current === row.memberId ? undefined : row.memberId); void chat.refreshDirectory()
    }}><span className="swarm-directory__avatar"><SafePixelAvatar seed={row.memberId} asset={row.avatar} name={row.label} t={t} /></span><span>{row.label}</span><small>{row.role === 'captain' ? t('captainRole') : row.profession || t('members')}</small></button>)}</div>
    {state.directory?.entries.length === 0 ? <p>{t('directory.empty')}</p> : null}
    {entry === undefined ? null : <MemberProfileSurface key={entry.memberId} anchorRef={trigger} rootRef={root} close={close} title={entry.label}>{dismiss => <MemberProfileContent entry={entry} result={result} resultObservedAt={assets?.observedAt} close={dismiss} onTask={onTask === undefined ? undefined : id => { close(false); onTask(id) }} t={t} />}
    </MemberProfileSurface>}
  </div>
}
const directoryCss = `
.swarm-directory{min-width:0;font-size:13px;overflow-wrap:anywhere}.swarm-directory button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 5px;cursor:pointer}.swarm-directory button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}
.swarm-directory__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px}.swarm-directory__grid>button{display:flex;align-items:center;flex-direction:column;min-width:0;gap:5px}.swarm-directory__grid>button>.swarm-directory__avatar{display:block;flex:0 0 48px;width:48px;height:48px;overflow:hidden;border-radius:9px}.swarm-directory__grid>button>span:not(.swarm-directory__avatar),.swarm-directory__grid small{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swarm-directory small{font-size:11px;color:var(--dsw-alias-label-secondary)}
`
