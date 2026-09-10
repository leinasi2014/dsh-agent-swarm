import type { TeamDashboardState } from './team-dashboard-controller.js'
import type { SwarmReadCaptainMemberRowV1 } from '../rpc/read-rpc-contract.js'
import { enumLabel } from './team-dashboard-view-helpers.js'
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryEntry, DirectorySource } from '../rpc/directory-contract.js'
import type { PublicChatController } from './public-chat-controller.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type T = TranslateNS<typeof TEAM_DASHBOARD_NS>
/** Display adaptation of the existing Host summary; unknown public prose stays literal. */
function retainedHistoryLabel(value: string, t: T): string {
  const match = /^Retained history: (0|[1-9]\d*) accepted (task|tasks) · (0|[1-9]\d*) rejected (attempt|attempts)$/u.exec(value)
  if (match === null || match[0] !== value || match[2] !== (match[1] === '1' ? 'task' : 'tasks') || match[4] !== (match[3] === '1' ? 'attempt' : 'attempts')) return value
  return t('directory.retainedHistory', { accepted: match[1]!, rejected: match[3]! })
}
function Source({ value, t }: { value: DirectorySource; t: T }) {
  const sourceLabel = value.source.startsWith('team-aggregate') ? 'directory.sourceTeam' : value.source.startsWith('team-assignment') ? 'directory.sourceAssignment' : value.source.startsWith('session-') ? 'directory.sourceSession' : value.source.startsWith('scoped-') ? 'directory.sourceRegistry' : 'directory.source'
  return <div className="swarm-directory__source"><small>{t(`directory.${value.state}`)} · {t(sourceLabel)}{value.updatedAt === undefined ? '' : ` · ${t('directory.updated')}: ${new Date(value.updatedAt).toLocaleString()}`}</small>
    <details><summary>{t('directory.sourceDetails')}</summary><small>{value.source}{value.version ? ` · ${t('directory.version')}: ${value.version}` : ''}{` · ${t('directory.observed')}: ${new Date(value.observedAt).toLocaleString()}`}{value.reason ? ` · ${value.reason}` : ''}</small></details>
  </div>
}

function MemberCard({ entry, close, result, resultObservedAt, t }: { entry: DirectoryEntry; close: () => void; result: SwarmReadCaptainMemberRowV1 | undefined; resultObservedAt: number | undefined; t: T }) {
  const [tab, setTab] = useState<'capabilities' | 'skillsTools' | 'results'>('capabilities'), id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { heading.current?.focus() }, [entry.memberId])
  const tabs = ['capabilities', 'skillsTools', 'results'] as const
  return <section className="swarm-directory__card" data-directory-card={entry.memberId} aria-labelledby={id}>
    <header><h3 id={id} ref={heading} tabIndex={-1}>{entry.label}</h3><button type="button" aria-label={t('directory.closeProfile')} onClick={close}>×</button></header>
    <dl>{([
      ['identity', `${entry.name} · ${entry.role === 'captain' ? t('captainRole') : t('members')} · ${enumLabel(entry.phase, t)}`], ['responsibility', entry.responsibility], ['profession', entry.profession], ['personality', entry.personality], ['biography', entry.biography],
    ] as const).map(([key, value]) => <div key={key}><dt>{t(`directory.${key}`)}</dt><dd>{value || t('directory.unknown')}</dd></div>)}</dl>
    <details><summary>{t('directory.identity')}</summary><code>{entry.memberId}</code></details>
    <Source value={entry.profile} t={t} />
    <h4>{t('directory.tasks')}</h4>{entry.currentTasks.length === 0 ? <p>{t('directory.none')}</p> : <ul>{entry.currentTasks.map(task => <li key={task.id}>{task.subject} · {task.status === 'in_progress' || task.status === 'submitted' || task.status === 'verifying' ? enumLabel(task.status, t) : task.status}</li>)}</ul>}
    <div role="tablist" aria-label={entry.label}>{tabs.map((value, index) => <button type="button" key={value} role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => { setTab(value) }} onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
      if (next !== undefined) { event.preventDefault(); setTab(tabs[next]!); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus() }
    }}>{t(`directory.${value}`)}</button>)}</div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === 'capabilities' ? <><p>{entry.model.provider ?? t('directory.unknown')} / {entry.model.model ?? t('directory.unknown')}</p><p>{t(entry.model.imageInput === 'supported' ? 'directory.supported' : entry.model.imageInput === 'unsupported' ? 'directory.unsupported' : 'directory.imageUnknown')}</p><Source value={entry.model} t={t} /></> : null}
      {tab === 'skillsTools' ? <>{(['assigned', 'sessionVisible', 'catalog'] as const).map(kind => <section key={kind}><h4>{t(`directory.${kind}`)}</h4><Source value={entry.skills[kind]} t={t} />{entry.skills[kind].entries.length === 0 ? <p>{t(entry.skills[kind].state === 'available' ? 'directory.none' : 'directory.unknown')}</p> : <ul>{entry.skills[kind].entries.map(skill => <li key={skill.name}><strong>{skill.name}</strong> · {skill.description ?? t('directory.unknown')}{skill.descriptionTruncated ? <small> · {t('directory.truncated')}</small> : null}</li>)}</ul>}</section>)}
        <h4>{t('directory.tools')}</h4><Source value={entry.tools} t={t} />{!entry.tools.complete ? <p>{t('directory.partial')}</p> : null}
        <ul>{entry.tools.entries.map(tool => <li key={tool.name}>{tool.name} · {t(`directory.${tool.state}`)} · {t('directory.policy')}: {t(`directory.${tool.teamPolicy}`)}</li>)}</ul>
      </> : null}
      {tab === 'results' ? result?.recentOutcome === undefined && result?.growthSummary === undefined ? <p>{t('directory.resultsUnknown')}</p> : <><p>{t('directory.resultScope')}</p>{result.recentOutcome ? <p><span title={result.recentOutcome.taskId}>{result.recentOutcome.taskId.slice(0, 8)}</span> · {enumLabel(result.recentOutcome.phase, t)} · {new Date(result.recentOutcome.at).toLocaleString()}</p> : null}{result.growthSummary ? <p>{retainedHistoryLabel(result.growthSummary, t)}</p> : null}{resultObservedAt === undefined ? null : <small>{t('directory.observed')}: {new Date(resultObservedAt).toLocaleString()}</small>}</> : null}
    </div>
  </section>
}
/** This is the same directory snapshot used by mention candidates and left navigation. */
export function DirectoryMembers({ chat, dashboard, t }: { chat: PublicChatController; dashboard?: TeamDashboardState; t: T }) {
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot, chat.getSnapshot)
  const [memberId, setMemberId] = useState<string>(), trigger = useRef<HTMLButtonElement | null>(null), root = useRef<HTMLDivElement>(null)
  const entry = state.directory?.entries.find(row => row.memberId === memberId)
  const data = dashboard?.data
  const assets = dashboard?.phase === 'ready' && data !== undefined && data.captainMembers.binding.teamId === state.selection?.team && data.captainMembers.binding.rootSessionId === state.selection?.captain ? data.captainMembers : undefined
  const result = assets?.members.find(row => row.sessionId === memberId)
  const close = (restore: boolean): void => { setMemberId(undefined); if (restore) queueMicrotask(() => { trigger.current?.focus() }) }
  useEffect(() => { void chat.refreshDirectory() }, [chat, state.selection?.key])
  useEffect(() => {
    if (memberId === undefined) return
    const pointer = (event: PointerEvent): void => { const node = event.target; if (node instanceof Node && !root.current?.contains(node)) close(false) }
    const focus = (event: FocusEvent): void => { const node = event.target; if (node instanceof Node && !root.current?.contains(node)) close(false) }
    document.addEventListener('focusin', focus)
    document.addEventListener('pointerdown', pointer)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('focusin', focus) }
  }, [memberId])
  useEffect(() => { setMemberId(undefined) }, [state.selection?.key])
  return <div ref={root} className="swarm-directory" data-swarm-directory onKeyDown={event => { if (event.key === 'Escape' && memberId !== undefined) { event.preventDefault(); event.stopPropagation(); close(true) } }} onFocusCapture={() => { if (!state.directoryLoading) void chat.refreshDirectory() }}>
    <style>{directoryCss}</style>
    {state.directoryLoading ? <p role="status">{t('directory.loading')}</p> : null}
    {state.directoryError ? <p role="alert">{state.directoryError} <button type="button" onClick={() => { void chat.refreshDirectory() }}>{t('refresh')}</button></p> : null}
    <div className="swarm-directory__grid">{state.directory?.entries.map(row => <button type="button" key={row.memberId} data-directory-member={row.memberId} aria-label={`${row.label} · ${row.name} · ${row.memberId}`} title={`${row.label} · ${row.responsibility} · ${row.memberId}`} onClick={event => {
      trigger.current = event.currentTarget; setMemberId(row.memberId); void chat.refreshDirectory()
    }}><SafePixelAvatar seed={row.memberId} asset={row.avatar} name={row.label} t={t} /><span>{row.label}</span><small>{row.role === 'captain' ? t('captainRole') : row.name}</small></button>)}</div>
    {state.directory?.entries.length === 0 ? <p>{t('directory.empty')}</p> : null}
    {memberId !== undefined ? entry === undefined ? <p role="status">{t(state.directoryLoading ? 'directory.loading' : 'directory.unavailable')} <button type="button" onClick={() => { close(true) }}>{t('directory.closeProfile')}</button></p> : <MemberCard key={entry.memberId} entry={entry} result={result} resultObservedAt={assets?.observedAt} close={() => { close(true) }} t={t} /> : null}
  </div>
}
const directoryCss = `
.swarm-directory{min-width:0;font-size:13px;overflow-wrap:anywhere}.swarm-directory button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px;cursor:pointer}.swarm-directory button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}
.swarm-directory__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px}.swarm-directory__grid>button{display:flex;align-items:center;flex-direction:column;min-width:0;gap:5px}.swarm-directory__grid svg{width:36px;height:36px}.swarm-directory__grid span{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swarm-directory small{font-size:11px;color:var(--dsw-alias-label-secondary)}
.swarm-directory__card{margin-top:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;min-width:0;background:var(--dsw-alias-bg-layer-1)}.swarm-directory__card header{display:flex;justify-content:space-between;align-items:start;gap:8px}.swarm-directory__card h3{margin:0;font-size:15px;min-width:0}.swarm-directory__card header button{flex:none}.swarm-directory__card h4{margin:12px 0 5px;font-size:13px}.swarm-directory__card p{margin:7px 0}.swarm-directory__card dl{margin:10px 0}.swarm-directory__card dt{color:var(--dsw-alias-label-secondary)}.swarm-directory__card dd{margin:2px 0 8px;white-space:pre-wrap}.swarm-directory__card [role=tablist]{display:flex;flex-wrap:wrap;gap:4px;margin-top:12px}.swarm-directory__card [aria-selected=true]{border-color:var(--dsw-alias-state-business-primary)}.swarm-directory__source{display:block;word-break:break-word}.swarm-directory__card ul{padding-left:18px}
`
