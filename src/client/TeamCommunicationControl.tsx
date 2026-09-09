import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export type TeamCommunicationChoice = 'inherit' | 'quiet' | 'balanced' | 'active'
export interface TeamCommunicationValue {
  readonly intensity: Exclude<TeamCommunicationChoice, 'inherit'>
  readonly source: 'team' | 'plugin'
  readonly peerWakeupsPerMinute: number
}

/** A human request uses the official Captain inbox; only canonical readback proves effect. */
export function TeamCommunicationControl({ value, revision, disabled, onRequest, t }: {
  readonly value: TeamCommunicationValue | undefined
  readonly revision: number
  readonly disabled: boolean
  readonly onRequest: (choice: TeamCommunicationChoice) => Promise<void>
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const current = value?.source === 'plugin' ? 'inherit' : value?.intensity
  const [choice, setChoice] = useState<TeamCommunicationChoice>(current ?? 'inherit')
  const [request, setRequest] = useState<{ choice: TeamCommunicationChoice; revision: number; state: 'sending' | 'queued' | 'failed'; error?: string }>()
  const applied = request !== undefined && request.state === 'queued' && revision > request.revision && current === request.choice
  const sending = request?.state === 'sending'
  const pendingSame = request?.state === 'queued' && !applied && request.choice === choice
  const submit = (): void => {
    if (disabled || sending || pendingSame || value === undefined || current === choice) return
    const next = { choice, revision }
    setRequest({ ...next, state: 'sending' })
    void onRequest(choice).then(() => { setRequest({ ...next, state: 'queued' }) }, error => {
      setRequest({ ...next, state: 'failed', error: error instanceof Error ? error.message : String(error) })
    })
  }
  return <section className="swarm-team-workspace__detail-section" data-swarm-communication>
    <h4>{t('communication.title')}</h4>
    <p className="swarm-team-workspace__muted" data-swarm-communication-current>{value === undefined ? t('detail.unavailable')
      : t('communication.current', { intensity: t(`communication.${value.intensity}`), source: t(`communication.${value.source}`), limit: value.peerWakeupsPerMinute })}</p>
    <label>{t('communication.choose')} <select aria-label={t('communication.choose')} value={choice} disabled={disabled || sending || value === undefined}
      onChange={event => { setChoice(event.target.value as TeamCommunicationChoice) }}>
      {(['inherit', 'quiet', 'balanced', 'active'] as const).map(item => <option key={item} value={item}>{t(`communication.${item}`)}</option>)}
    </select></label>{' '}
    <button type="button" className="swarm-team-workspace__manage-action" disabled={disabled || sending || pendingSame || value === undefined || current === choice} onClick={submit}>{t('communication.apply')}</button>
    <p className="swarm-team-workspace__muted">{t('communication.hint')}</p>
    {request === undefined ? null : <p role={request.state === 'failed' ? 'alert' : 'status'}>{request.state === 'failed'
      ? `${t('communication.failed')} ${request.error ?? ''}`
      : t(sending ? 'communication.sending' : applied ? 'communication.applied' : 'communication.queued')}</p>}
  </section>
}
