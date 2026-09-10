import { MentionComposer } from './MentionComposer.js'
import { draftContent } from './public-draft.js'
import { hasUnconfirmedPublicMention } from '../shared/public-content.js'
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
  readonly replaceText: (start: number, end: number, text: string) => void
  readonly chooseMention: (start: number, end: number, memberId: string) => void
  readonly removeMention: (start: number, reselect?: boolean) => void
  readonly refreshDirectory: () => void
  readonly upgradeLegacy: () => void
  readonly openTeam: () => void
}
type Props = PropsHooks<{ chat: PublicChatController; team: TeamDashboardController; surface: TeamDashboardSurfaceCoordinator }> & PropsLocale<typeof TEAM_DASHBOARD_NS> & Actions

/** The single group main panel; the existing Session sidebar remains the task seat. */
export function TeamPublicChat(props: Props) {
  const { t } = props
  const state = props.useChat(value => value)
  const dashboard = props.useTeam(value => value)
  const surface = props.useSurface(value => value)
  const selected = state.selection
  const verified = dashboard.phase === 'ready'
  const sameTeam = (verified || dashboard.phase === 'stale' || dashboard.phase === 'reconnecting')
    && selected !== undefined && dashboard.targetSessionId === selected.viewer
    && (dashboard.pendingTeamId === undefined || dashboard.pendingTeamId === selected.team)
    && dashboard.data?.projection.binding.teamId === selected.team && dashboard.data.projection.binding.rootSessionId === selected.captain
  const team = sameTeam ? dashboard.data?.teams.teams.find(row => row.teamId === selected.team) : undefined
  const bytes = new TextEncoder().encode(state.draft.text).length
  const unconfirmed = hasUnconfirmedPublicMention(draftContent(state.draft))
  const invalidMention = state.draft.tokens.some(token => !state.directory?.entries.some(entry => entry.memberId === token.memberId && entry.phase === 'active'))
  const segments = draftContent(state.draft).length
  const draftReady = bytes <= (state.history?.limits.maxTextBytes ?? 0) && !unconfirmed && !invalidMention && (state.draft.tokens.length === 0 || state.directoryError === undefined) && draftContent(state.draft).length <= (state.history?.limits.maxSegments ?? 0)
  const canSend = draftReady && verified && sameTeam && state.history?.appendEligibility.state === 'available' && !state.pending && !state.sending
    && state.draft.text.trim() !== '' && bytes <= state.history.limits.maxTextBytes
  return <section className="swarm-public" data-swarm-public-chat data-team-id={sameTeam ? selected.team : undefined}>
    <style>{publicChatCss}</style>
    <header className="swarm-public__header"><div><h1>{team?.name ?? t('public.title')}</h1><p>{team?.goal.state === 'generated' ? team.goal.text : t('public.goalEmpty')}</p></div>
      {surface.mode !== 'docked' ? <button type="button" onClick={props.openTeam} disabled={!sameTeam || !verified}>{t('public.openTeam')}</button> : null}</header>
    {sameTeam && !verified ? <p role={dashboard.phase === 'stale' ? 'alert' : 'status'}>{t(dashboard.phase === 'stale' ? 'stale' : 'reconnecting')}{dashboard.error === undefined ? null : ` · ${dashboard.error.message}`}</p> : null}
    {!sameTeam ? <p role="status">{t(dashboard.phase === 'error' ? 'error' : 'loading')}</p> : <>
      <div className="swarm-public__messages" aria-label={t('public.title')} aria-busy={state.loading}>
        {state.history?.hasEarlier ? <button type="button" disabled={!verified || state.loading} onClick={props.earlier}>{t('public.earlier')}</button> : null}
        {state.entries.length === 0 ? <p className="swarm-public__empty">{t(state.loading ? 'loading' : 'public.empty')}</p> : null}
        {state.entries.map(message => <article key={message.id} id={`swarm-message-${message.id}`} data-public-message={message.id} data-delivery={message.delivery.kind === 'not-requested' ? 'not-requested' : message.delivery.recipients.every(row => row.state === 'claimed') ? 'claimed' : 'requested'} className={message.author.kind === 'local-operator' ? 'swarm-public__message swarm-public__message--operator' : 'swarm-public__message'}>
          <div className="swarm-public__meta"><strong>{message.author.kind === 'local-operator' ? t('public.operator') : message.author.displayName || message.author.name}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          {message.replyTo === undefined ? null : state.entries.some(row => row.id === message.replyTo)
            ? <a className="swarm-public__quote" href={`#swarm-message-${message.replyTo}`}>{t('public.reply')}: {state.entries.find(row => row.id === message.replyTo)?.text}</a>
            : <span className="swarm-public__quote">{t('public.replyOutside')}</span>}
          <p className="swarm-public__text">{message.text}</p>
          <footer><span>{message.delivery.kind === 'not-requested' ? '' : message.delivery.recipients.map(recipient => <span className="swarm-public__receipt" data-recipient={recipient.recipientSessionId} data-recipient-state={recipient.state} key={recipient.recipientSessionId}><span title={recipient.recipientSessionId}>{message.mentionLabels.find(label => label.memberId === recipient.recipientSessionId)?.label ?? (message.mentionLabels.length === 0 ? t('captainRole') : recipient.recipientSessionId)}</span> · {t(recipient.state === 'queued' ? 'public.queued' : recipient.state === 'claimed' ? 'public.claimed' : 'public.notDelivered')}{recipient.state === 'not-delivered' ? ` · ${recipient.reason}` : ''}</span>)}</span><button type="button" onClick={() => { props.reply(message.id) }}>{t('public.reply')}</button></footer>
        </article>)}
        {state.history?.hasMore ? <button type="button" disabled={!verified || state.loading} onClick={props.newer}>{t('public.newer')}</button> : null}
      </div>
      <div className="swarm-public__composer">
        {state.error === undefined ? null : <p role="alert">{state.error} <button type="button" onClick={props.refresh} disabled={!verified || state.loading}>{t('refresh')}</button></p>}
        {state.pending ? <p role="status">{t('public.unknown')} <button type="button" onClick={props.recover} disabled={!verified || state.sending}>{t('public.recover')}</button></p> : null}
        {state.draft.replyTo === undefined ? null : <div className="swarm-public__quote">{t('public.reply')}: {state.entries.find(row => row.id === state.draft.replyTo)?.text ?? t('public.replyOutside')} <button type="button" onClick={() => { props.reply(undefined) }}>{t('public.cancelReply')}</button></div>}
        {state.legacyUpgrade ? <p role="status">{t('public.upgradeHint')} <button type="button" disabled={!draftReady || !verified || state.sending || state.history?.appendEligibility.state !== 'available' || state.draft.text.trim() === ''} onClick={props.upgradeLegacy}>{t('public.upgrade')}</button></p> : null}
        {invalidMention ? <p role="alert">{t('public.invalidMention')}</p> : null}
        {state.history !== undefined && segments > state.history.limits.maxSegments ? <p role="alert">{t('public.segmentLimit', { count: segments, limit: state.history.limits.maxSegments })}</p> : null}
        <MentionComposer key={selected.key} draft={state.draft} entries={state.directory?.entries ?? []} directoryLoading={state.directoryLoading} directoryError={state.directoryError}
          t={t} edit={props.edit} replaceText={props.replaceText} choose={props.chooseMention} remove={props.removeMention} refreshDirectory={props.refreshDirectory} send={props.send} canSend={canSend} />
        <div className="swarm-public__send-row"><small>{state.history?.appendEligibility.state === 'unavailable' ? t('public.unavailable') : t(state.draft.tokens.length > 0 ? 'public.directed' : 'public.hint')}{state.history !== undefined && bytes > state.history.limits.maxTextBytes ? ` · ${bytes}/${state.history.limits.maxTextBytes} bytes` : ''}</small><button type="button" data-public-send disabled={!canSend} onClick={props.send}>{t(state.sending ? 'public.sending' : 'public.send')}</button></div>
      </div>
    </>}
  </section>
}
