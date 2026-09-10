import { useRef, type KeyboardEvent } from 'react'
import type { PropsHooks, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PublicChatController } from './public-chat-controller.js'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { publicChatCss } from './public-chat-styles.js'

interface Actions {
  readonly edit: (text: string) => void
  readonly reply: (id: string | undefined) => void
  readonly send: () => void
  readonly recover: () => void
  readonly earlier: () => void
  readonly newer: () => void
  readonly refresh: () => void
  readonly openTeam: () => void
}
type Props = PropsHooks<{ chat: PublicChatController; team: TeamDashboardController; surface: TeamDashboardSurfaceCoordinator }> & PropsLocale<typeof TEAM_DASHBOARD_NS> & Actions

/** Enter inserts a newline; only an explicit accelerator outside IME submits. */
function isPublicChatSendKey(event: Pick<KeyboardEvent<HTMLTextAreaElement>, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'nativeEvent'>, composing: boolean): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
}

/** The single group main panel; the existing Session sidebar remains the task seat. */
export function TeamPublicChat(props: Props) {
  const { t } = props
  const state = props.useChat(value => value)
  const dashboard = props.useTeam(value => value)
  const surface = props.useSurface(value => value)
  const composing = useRef(false)
  const selected = state.selection
  const sameTeam = dashboard.phase === 'ready' && selected !== undefined && dashboard.targetSessionId === selected.viewer
    && dashboard.data?.projection.binding.teamId === selected.team && dashboard.data.projection.binding.rootSessionId === selected.captain
  const team = sameTeam ? dashboard.data?.teams.teams.find(row => row.teamId === selected.team) : undefined
  const bytes = new TextEncoder().encode(state.draft.text).length
  const canSend = sameTeam && state.history?.appendEligibility.state === 'available' && !state.pending && !state.sending
    && state.draft.text.trim() !== '' && bytes <= state.history.limits.maxTextBytes
  return <section className="swarm-public" data-swarm-public-chat data-team-id={sameTeam ? selected.team : undefined}>
    <style>{publicChatCss}</style>
    <header className="swarm-public__header"><div><h1>{team?.name ?? t('public.title')}</h1><p>{team?.goal.state === 'generated' ? team.goal.text : t('public.goalEmpty')}</p></div>
      {surface.mode !== 'docked' ? <button type="button" onClick={props.openTeam} disabled={!sameTeam}>{t('public.openTeam')}</button> : null}</header>
    {!sameTeam ? <p role="status">{t(dashboard.phase === 'error' ? 'error' : 'loading')}</p> : <>
      <div className="swarm-public__messages" aria-label={t('public.title')} aria-busy={state.loading}>
        {state.history?.hasEarlier ? <button type="button" disabled={state.loading} onClick={props.earlier}>{t('public.earlier')}</button> : null}
        {state.entries.length === 0 ? <p className="swarm-public__empty">{t(state.loading ? 'loading' : 'public.empty')}</p> : null}
        {state.entries.map(message => <article key={message.id} id={`swarm-message-${message.id}`} data-public-message={message.id} data-delivery={message.delivery.state} className={message.author.kind === 'local-operator' ? 'swarm-public__message swarm-public__message--operator' : 'swarm-public__message'}>
          <div className="swarm-public__meta"><strong>{message.author.kind === 'local-operator' ? t('public.operator') : message.author.displayName || message.author.name}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          {message.replyTo === undefined ? null : state.entries.some(row => row.id === message.replyTo)
            ? <a className="swarm-public__quote" href={`#swarm-message-${message.replyTo}`}>{t('public.reply')}: {state.entries.find(row => row.id === message.replyTo)?.text}</a>
            : <span className="swarm-public__quote">{t('public.replyOutside')}</span>}
          <p className="swarm-public__text">{message.text}</p>
          <footer><span>{message.delivery.state === 'not-requested' ? '' : t(message.delivery.state === 'queued' ? 'public.queued' : 'public.claimed')}</span><button type="button" onClick={() => { props.reply(message.id) }}>{t('public.reply')}</button></footer>
        </article>)}
        {state.history?.hasMore ? <button type="button" disabled={state.loading} onClick={props.newer}>{t('public.newer')}</button> : null}
      </div>
      <div className="swarm-public__composer">
        {state.error === undefined ? null : <p role="alert">{state.error} <button type="button" onClick={props.refresh} disabled={state.loading}>{t('refresh')}</button></p>}
        {state.pending ? <p role="status">{t('public.unknown')} <button type="button" onClick={props.recover} disabled={state.sending}>{t('public.recover')}</button></p> : null}
        {state.draft.replyTo === undefined ? null : <div className="swarm-public__quote">{t('public.reply')}: {state.entries.find(row => row.id === state.draft.replyTo)?.text ?? t('public.replyOutside')} <button type="button" onClick={() => { props.reply(undefined) }}>{t('public.cancelReply')}</button></div>}
        <textarea aria-label={t('public.input')} value={state.draft.text} placeholder={t('public.input')} rows={3}
          onChange={event => { props.edit(event.target.value) }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => { if (isPublicChatSendKey(event, composing.current)) { event.preventDefault(); if (canSend) props.send() } }} />
        <div className="swarm-public__send-row"><small>{state.history?.appendEligibility.state === 'unavailable' ? t('public.unavailable') : t('public.hint')}{state.history !== undefined && bytes > state.history.limits.maxTextBytes ? ` · ${bytes}/${state.history.limits.maxTextBytes} bytes` : ''}</small><button type="button" data-public-send disabled={!canSend} onClick={props.send}>{t(state.sending ? 'public.sending' : 'public.send')}</button></div>
      </div>
    </>}
  </section>
}
