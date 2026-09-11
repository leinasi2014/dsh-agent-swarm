import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { RetirementClient } from './retirement-client.js'
import type { RetirementRequest } from '../shared/team-retirement.js'

/** Stored operation recovery remains reachable even when the Team no longer exists. */
export function TeamRetirementRequests({ client, t, open }: {
  readonly client: RetirementClient
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly open: (request: RetirementRequest) => void
}) {
  const [saved, setSaved] = useState<ReturnType<RetirementClient['savedRequests']>>({ requests: [], invalid: 0 })
  const [error, setError] = useState(false)
  useEffect(() => {
    const read = () => { try { setSaved(client.savedRequests()); setError(false) } catch { setError(true) } }
    read(); return client.subscribe(read)
  }, [client])
  if (saved.requests.length === 0 && saved.invalid === 0 && !error) return null
  return <section className="swarm-retirement-requests" data-retirement-requests aria-label={t('retirement.saved')}>
    <style>{`.swarm-retirement-requests{min-width:0;padding:4px 8px 12px;font:12px/1.5 sans-serif;color:var(--dsw-alias-label-primary)}.swarm-retirement-requests summary{cursor:pointer;overflow-wrap:anywhere}.swarm-retirement-requests ul{list-style:none;padding:0;margin:5px 0}.swarm-retirement-requests button{width:100%;min-width:0;display:block;padding:7px;text-align:left;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:6px;cursor:pointer}.swarm-retirement-requests span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swarm-retirement-requests small{display:block;overflow-wrap:anywhere;opacity:.7}.swarm-retirement-requests p{overflow-wrap:anywhere}`}</style>
    <details open><summary>{t('retirement.saved')} ({saved.requests.length})</summary>
      <ul>{saved.requests.map(request => <li key={`${request.target.rootSessionId}:${request.target.teamId}:${request.requestId}`}>
        <button type="button" data-retirement-saved-request title={`${request.target.rootSessionId} · ${request.target.teamId}`} onClick={() => { open(request) }}>
          <span>{t(`retirement.${request.action}`)}</span><span>{request.target.teamId}</span><small>{t('retirement.query')}</small>
        </button>
      </li>)}</ul>
      {error || saved.invalid > 0 ? <p role="alert">{t('retirement.savedInvalid')}</p> : null}
    </details>
  </section>
}
