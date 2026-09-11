import { useEffect, useRef, useState } from 'react'
import { Modal, IconGaugeOutline16, IconDatabaseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { publicSessionStats, publicSpeedLabel, publicTokenLabel } from './public-session-stats.js'

const number = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 20 })

export function PublicSessionStats({ session, t }: { session: SessionSummary | undefined; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const [open, setOpen] = useState<'usage' | 'time'>(), close = useRef<HTMLButtonElement>(null)
  const stats = publicSessionStats(session?.projectionValues)
  const scope = t('public.statsScope', { name: session?.displayTitle ?? '—' })
  useEffect(() => {
    if (open === undefined) return
    const previous = document.activeElement
    close.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [open])
  return <div className="swarm-public__stats" data-public-session-stats role="group" aria-label={scope}>
      <button type="button" title={`${scope} · ${t('public.statsTime')}`} aria-haspopup="dialog" aria-expanded={open === 'time'} onClick={() => { setOpen('time') }}><span className="swarm-public__stat-icon" aria-hidden="true"><IconGaugeOutline16 /></span><span>{t('public.statsCounts', { turns: number(stats.turns), steps: number(stats.steps) })} · {publicSpeedLabel(stats.speed)} tok/s</span></button>
      <button type="button" title={`${scope} · ${t('public.statsUsage')}`} aria-haspopup="dialog" aria-expanded={open === 'usage'} onClick={() => { setOpen('usage') }}><span className="swarm-public__stat-icon" aria-hidden="true"><IconDatabaseOutline16 /></span><span>{publicTokenLabel(stats.total, t('public.statsThousand'), t('public.statsMillion'))} tok</span></button>
    <Modal open={open !== undefined} headless title={t(open === 'usage' ? 'public.statsUsage' : 'public.statsTime')} onClose={() => { setOpen(undefined) }}>
      <div className="swarm-public__stats-dialog" onKeyDown={event => {
        if (event.key === 'Tab') { event.preventDefault(); close.current?.focus() }
      }}>
        <header><strong>{t(open === 'usage' ? 'public.statsUsage' : 'public.statsTime')}</strong><button ref={close} type="button" onClick={() => { setOpen(undefined) }}>{t('public.closeStats')}</button></header>
        <p>{scope}</p><dl>{(open === 'usage' ? [
          ['public.statsInput', stats.input], ['public.statsRead', stats.read], ['public.statsWrite', stats.write], ['public.statsOutput', stats.output], ['public.statsTotal', stats.total],
        ] as const : [['public.statsTurns', stats.turns], ['public.statsSteps', stats.steps], ['public.statsSpeed', stats.speed], ['public.statsLlmMs', stats.llmMs], ['public.statsToolMs', stats.toolMs]] as const).map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{number(value)}</dd></div>)}</dl>
        <p>{t('public.statsSource')}</p>
      </div>
    </Modal>
  </div>
}
