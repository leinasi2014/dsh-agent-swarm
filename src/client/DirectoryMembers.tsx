import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PublicChatController } from './public-chat-controller.js'
import type { TeamDashboardState } from './team-dashboard-controller.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { MemberProfileSurface } from './MemberProfileSurface.js'
import { MemberProfileContent, profileCss, type MemberProfileTab } from './MemberProfileContent.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { TeamNavigationCallbacks } from './TeamGroupNavigation.js'
type T = TranslateNS<typeof TEAM_DASHBOARD_NS>

/** This is the same directory snapshot used by mention candidates and left navigation. */
export function DirectoryMembers({ chat, dashboard, onTask, navigation, t }: { chat: PublicChatController; dashboard?: TeamDashboardState; onTask?: ((id: string) => void) | undefined; navigation?: TeamNavigationCallbacks; t: T }) {
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot, chat.getSnapshot)
  const [memberId, setMemberId] = useState<string>(), trigger = useRef<HTMLButtonElement | null>(null), root = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<MemberProfileTab>('attributes')
  const [navigationError, setNavigationError] = useState<string>(), [opening, setOpening] = useState<string>()
  const entry = state.directory?.entries.find(row => row.memberId === memberId)
  const data = dashboard?.data
  const assets = dashboard?.phase === 'ready' && data !== undefined && dashboard.targetSessionId === state.selection?.viewer && data.teams.binding.rootSessionId === state.selection?.viewer
    && data.captainMembers.binding.teamId === state.selection?.team && data.captainMembers.binding.rootSessionId === state.selection?.captain ? data.captainMembers : undefined
  const result = assets?.members.find(row => row.sessionId === memberId)
  const captain = data?.teams.teams.find(row => row.teamId === state.selection?.team && row.captainSessionId === state.selection?.captain)
  const open = (id: string, action: () => Promise<void>) => {
    setOpening(id); setNavigationError(undefined)
    void action().catch(error => { setNavigationError(error instanceof Error ? error.message : t('error')) }).finally(() => { setOpening(undefined) })
  }
  const close = useCallback((restore: boolean): void => { setMemberId(undefined); if (restore) queueMicrotask(() => { if (trigger.current?.isConnected) trigger.current.focus() }) }, [])
  useEffect(() => { void chat.refreshDirectory() }, [chat, state.selection?.key])
  useEffect(() => { setMemberId(undefined) }, [state.selection?.key])
  useEffect(() => { if (memberId !== undefined && entry === undefined && !state.directoryLoading) close(false) }, [memberId, entry, state.directoryLoading, close])
  return <div ref={root} className="swarm-directory" data-swarm-directory onKeyDown={event => { if (event.key === 'Escape' && memberId !== undefined) { event.preventDefault(); event.stopPropagation(); close(true) } }} onFocusCapture={() => { if (!state.directoryLoading) void chat.refreshDirectory() }}>
    <style>{directoryCss}{profileCss}</style>
    {state.directoryLoading && state.directory === undefined ? <p role="status">{t('directory.loading')}</p> : null}
    {state.directoryError ? <p role="alert">{state.directoryError} <button type="button" onClick={() => { void chat.refreshDirectory() }}>{t('refresh')}</button></p> : null}
    {navigationError ? <p role="alert">{navigationError}</p> : null}
    <div className="swarm-directory__grid" aria-busy={state.directoryLoading}>{state.directory?.entries.map(row => {
      const member = assets?.members.find(value => value.sessionId === row.memberId && value.phase === 'active')
      const isCaptain = assets !== undefined && captain?.captainSessionId === row.memberId && row.role === 'captain'
      const profile = (event: MouseEvent<HTMLButtonElement>) => {
        trigger.current = event.currentTarget; setTab('attributes'); setMemberId(current => current === row.memberId ? undefined : row.memberId); void chat.refreshDirectory()
      }
      const identity = <><span className="swarm-directory__avatar"><SafePixelAvatar seed={row.memberId} asset={row.avatar} name={row.label} t={t} /></span><span>{row.label}</span><small>{row.role === 'captain' ? t('captainRole') : row.profession || t('members')}</small></>
      return navigation === undefined ? <button type="button" key={row.memberId} data-directory-member={row.memberId} aria-label={`${row.label} · ${row.name}`} aria-haspopup="dialog" aria-expanded={memberId === row.memberId} title={`${row.label} · ${row.responsibility}`} onClick={profile}>{identity}</button>
        : <div className="swarm-directory__card" key={row.memberId}>
          <button type="button" data-swarm-member-chat={row.memberId} disabled={opening !== undefined || (!isCaptain && member === undefined)} aria-current={dashboard?.targetSessionId === row.memberId ? 'page' : undefined} aria-busy={opening === row.memberId}
            onClick={() => { if (isCaptain) open(row.memberId, navigation.openCaptain); else if (member !== undefined) open(row.memberId, () => navigation.openMember(member.name, row.memberId)) }}>{identity}</button>
          <button type="button" data-directory-member={row.memberId} aria-label={`${row.label} · ${t('detail.section.profile')}`} aria-haspopup="dialog" aria-expanded={memberId === row.memberId} onClick={profile}>{t('detail.section.profile')}</button>
        </div>
    })}</div>
    {state.directory?.entries.length === 0 ? <p>{t('directory.empty')}</p> : null}
    {entry === undefined ? null : <MemberProfileSurface key={entry.memberId} anchorRef={trigger} rootRef={root} close={close} title={entry.label}>{dismiss => <MemberProfileContent tab={tab} onTabChange={setTab} entry={entry} result={result} resultObservedAt={assets?.observedAt} close={dismiss} onTask={onTask === undefined ? undefined : id => { close(false); onTask(id) }} t={t} />}
    </MemberProfileSurface>}
  </div>
}
const directoryCss = `
.swarm-directory{min-width:0;font-size:13px;overflow-wrap:anywhere}.swarm-directory button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 5px;cursor:pointer}.swarm-directory button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}
.swarm-directory__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px}.swarm-directory__grid>button,.swarm-directory__card>button:first-child{display:flex;align-items:center;flex-direction:column;min-width:0;gap:5px}.swarm-directory__avatar{display:block;flex:0 0 48px;width:48px;height:48px;overflow:hidden;border-radius:9px}.swarm-directory__grid span:not(.swarm-directory__avatar),.swarm-directory__grid small{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swarm-directory__card{display:flex;flex-direction:column;min-width:0;gap:4px}.swarm-directory small{font-size:11px;color:var(--dsw-alias-label-secondary)}
`
