import { WorkActivityFeed } from './WorkActivityFeed.js'
import type { WorkRequestController } from './work-request-controller.js'
import { useRef } from 'react'
import { DraftImage } from './PublicImages.js'
import { PublicMessageContent, publicParticipantLabel } from './PublicMessageContent.js'
import { publicDraftImageIssue } from './public-image-draft.js'
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
  readonly work?: WorkRequestController | undefined
  readonly openWorkTask?: ((id: string) => void) | undefined
  readonly addImages: (files: readonly File[]) => void
  readonly removeImage: (id: string) => void
  readonly image: (messageId: string, imageId: string, signal: AbortSignal) => Promise<Blob>
  readonly retryDraftStorage: () => void
  readonly useStoredDraft: () => void
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
  const picker = useRef<HTMLInputElement>(null)
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
  const segments = draftContent(state.draft).length + (state.draft.images?.length ?? 0)
  const imageIssue = publicDraftImageIssue(state.draft, state.draftBlobs, state.history?.imageAvailability)
  const storageReady = state.draftStatus === 'ready' || state.draftStatus === 'saving'
  const editable = state.draftStatus !== 'loading'
  const draftReady = imageIssue === undefined && storageReady && bytes <= (state.history?.limits.maxTextBytes ?? 0) && !unconfirmed && !invalidMention && (state.draft.tokens.length === 0 || state.directoryError === undefined) && segments <= (state.history?.limits.maxSegments ?? 0)
  const canSend = draftReady && verified && sameTeam && state.history?.appendEligibility.state === 'available' && !state.pending && !state.sending
    && (state.draft.text.trim() !== '' || (state.draft.images?.length ?? 0) > 0) && bytes <= state.history.limits.maxTextBytes
  return <section className="swarm-public" data-swarm-public-chat data-team-id={sameTeam ? selected.team : undefined}>
    <style>{publicChatCss}</style>
    <header className="swarm-public__header"><div><h1>{team?.name ?? t('public.title')}</h1>{team?.goal.state === 'generated' ? <details className="swarm-public__goal"><summary>{team.goal.text}</summary><p>{team.goal.text}</p></details> : <p>{t('public.goalEmpty')}</p>}</div>
      {surface.mode !== 'docked' ? <button type="button" onClick={props.openTeam} disabled={!sameTeam || !verified}>{t('public.openTeam')}</button> : null}</header>
    {sameTeam && !verified ? <p role={dashboard.phase === 'stale' ? 'alert' : 'status'}>{t(dashboard.phase === 'stale' ? 'stale' : 'reconnecting')}{dashboard.error === undefined ? null : ` · ${dashboard.error.message}`}</p> : null}
    {!sameTeam ? <p role="status">{t(dashboard.phase === 'error' ? 'error' : 'loading')}</p> : <>
      <div className="swarm-public__messages" aria-label={t('public.title')} aria-busy={state.loading}>
        {props.work === undefined ? null : <WorkActivityFeed work={props.work} teamId={selected.team} directory={verified && state.directoryError === undefined ? state.directory : undefined} openTask={props.openWorkTask} t={t} />}
        {state.history?.hasEarlier ? <button type="button" disabled={!verified || state.loading} onClick={props.earlier}>{t('public.earlier')}</button> : null}
        {state.entries.length === 0 ? <p className="swarm-public__empty">{t(state.loading ? 'loading' : 'public.empty')}</p> : null}
        {state.entries.map(message => <article key={`${selected.key}:${message.id}`} id={`swarm-message-${message.id}`} data-public-message={message.id} data-delivery={message.delivery.kind === 'not-requested' ? 'not-requested' : message.delivery.recipients.every(row => row.state === 'claimed') ? 'claimed' : 'requested'} className={message.author.kind === 'local-operator' ? 'swarm-public__message swarm-public__message--operator' : 'swarm-public__message'}>
          <div className="swarm-public__meta"><strong>{message.author.kind === 'local-operator' ? t('public.operator') : message.author.kind === 'system' ? t('public.system') : message.author.displayName || message.author.name}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          {message.replyTo === undefined ? null : state.entries.some(row => row.id === message.replyTo)
            ? <a className="swarm-public__quote" href={`#swarm-message-${message.replyTo}`}>{t('public.reply')}: {state.entries.find(row => row.id === message.replyTo)?.text}</a>
            : <span className="swarm-public__quote">{t('public.replyOutside')}</span>}
          <PublicMessageContent message={message} entries={state.entries} image={props.image} memberLabels={state.directory?.entries ?? []} t={t} />
          <footer><span>{message.delivery.kind === 'not-requested' ? '' : message.delivery.recipients.map(recipient => <span className="swarm-public__receipt" data-recipient={recipient.recipientSessionId} data-recipient-state={recipient.state} key={recipient.recipientSessionId}><span title={recipient.recipientSessionId}>{publicParticipantLabel(message, state.entries, state.directory?.entries ?? [], recipient.recipientSessionId, recipient.recipientSessionId === selected.captain ? t('captainRole') : recipient.recipientSessionId)}</span> · {t(recipient.state === 'queued' ? 'public.queued' : recipient.state === 'claimed' ? 'public.claimed' : 'public.notDelivered')}{recipient.state === 'not-delivered' ? ` · ${t(`public.notDeliveredReason.${recipient.reason}`)}` : recipient.state === 'queued' && recipient.deferredReason !== undefined ? ` · ${t(`public.deferred.${recipient.deferredReason}`)}` : ''}</span>)}</span><button type="button" onClick={() => { props.reply(message.id) }}>{t('public.reply')}</button></footer>
        </article>)}
        {state.history?.hasMore ? <button type="button" disabled={!verified || state.loading} onClick={props.newer}>{t('public.newer')}</button> : null}
      </div>
      <div className="swarm-public__composer" onDragOver={event => { if (editable && event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (editable && event.dataTransfer.files.length > 0) props.addImages(Array.from(event.dataTransfer.files)) }}>
        {state.error === undefined ? null : <p role="alert">{state.error === 'public.imageRejected' || state.error === 'public.imageServiceUnavailable' ? t(state.error) : state.error} <button type="button" onClick={props.refresh} disabled={!verified || state.loading}>{t('refresh')}</button></p>}
        {state.pending ? <p role="status">{t('public.unknown')} <button type="button" onClick={props.recover} disabled={!verified || state.sending}>{t('public.recover')}</button></p> : null}
        {state.draft.replyTo === undefined ? null : <div className="swarm-public__quote">{t('public.reply')}: {state.entries.find(row => row.id === state.draft.replyTo)?.text ?? t('public.replyOutside')} <button type="button" onClick={() => { props.reply(undefined) }}>{t('public.cancelReply')}</button></div>}
        {state.legacyUpgrade ? <p role="status">{t('public.upgradeHint')} <button type="button" disabled={!draftReady || !verified || state.sending || state.history?.appendEligibility.state !== 'available' || (state.draft.text.trim() === '' && (state.draft.images?.length ?? 0) === 0)} onClick={props.upgradeLegacy}>{t('public.upgrade')}</button></p> : null}
        {state.draftStatus === 'ready' ? null : <p role={state.draftStatus === 'conflict' || state.draftStatus === 'unavailable' ? 'alert' : 'status'} data-public-draft-status={state.draftStatus}>{t(state.draftStatus === 'loading' ? 'public.draftLoading' : state.draftStatus === 'saving' ? 'public.draftSaving' : state.draftStatus === 'conflict' ? 'public.draftConflict' : 'public.draftUnavailable')}{state.draftStatus === 'unavailable' ? <button type="button" onClick={props.retryDraftStorage}>{t('public.retryDraft')}</button> : state.draftStatus === 'conflict' ? <button type="button" onClick={props.useStoredDraft}>{t('public.useStoredDraft')}</button> : null}</p>}
        {imageIssue === undefined ? null : <p role="alert">{t(`public.imageIssue.${imageIssue}`)}</p>}
        {invalidMention ? <p role="alert">{t('public.invalidMention')}</p> : null}
        {state.history !== undefined && segments > state.history.limits.maxSegments ? <p role="alert">{t('public.segmentLimit', { count: segments, limit: state.history.limits.maxSegments })}</p> : null}
        <MentionComposer key={selected.key} draft={state.draft} entries={state.directory?.entries ?? []} directoryLoading={state.directoryLoading} directoryError={state.directoryError}
          t={t} disabled={!editable} addImages={props.addImages} edit={props.edit} replaceText={props.replaceText} choose={props.chooseMention} remove={props.removeMention} refreshDirectory={props.refreshDirectory} send={props.send} canSend={canSend} />
        <div className="swarm-public__draft-images">{state.draft.images?.map(image => <DraftImage key={image.blobId} image={image} blob={state.draftBlobs[image.blobId]} remove={props.removeImage} t={t} />)}</div>
        <input ref={picker} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t('public.addImages')} disabled={!editable} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length > 0) props.addImages(files) }} />
        <button type="button" className="swarm-public__add-images" disabled={!editable} onClick={() => { picker.current?.click() }}>{t('public.addImages')}</button>
        <div className="swarm-public__send-row"><small>{state.history?.appendEligibility.state === 'unavailable' ? t('public.unavailable') : t(state.draft.tokens.length > 0 ? 'public.directed' : 'public.hint')}{state.history !== undefined && bytes > state.history.limits.maxTextBytes ? ` · ${bytes}/${state.history.limits.maxTextBytes} bytes` : ''}</small><button type="button" data-public-send disabled={!canSend} onClick={props.send}>{t(state.sending ? 'public.sending' : 'public.send')}</button></div>
      </div>
    </>}
  </section>
}
