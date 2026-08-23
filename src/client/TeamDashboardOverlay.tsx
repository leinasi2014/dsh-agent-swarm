import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, Modal, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export interface TeamDashboardOverlayInjected {
  readonly controller: TeamDashboardController
  readonly openCaptainChat: () => Promise<void>
}

export type TeamDashboardOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardOverlayInjected

const stack: CSSProperties = { display: 'grid', gap: 12 }
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }
const card: CSSProperties = {
  minWidth: 0,
  padding: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-base)',
}
const title: CSSProperties = { margin: '0 0 8px', fontSize: 14, color: 'var(--dsw-alias-text-primary)' }
const list: CSSProperties = { display: 'grid', gap: 6, margin: 0, padding: 0, listStyle: 'none' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }
const muted: CSSProperties = { color: 'var(--dsw-alias-text-secondary)', fontSize: 12 }

/** Root overlay that renders only while the controller owns an open target. */
export function TeamDashboardOverlay({ controller, openCaptainChat, t }: TeamDashboardOverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [handoffBusy, setHandoffBusy] = useState(false)

  useEffect(() => () => { controller.close() }, [controller])

  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void openCaptainChat().finally(() => { setHandoffBusy(false) })
  }

  return (
    <Modal
      open={state.open}
      onClose={() => { controller.close() }}
      title={t('title')}
      closeLabel={t('close')}
      description={t('description')}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%' }}>
          <Button variant="ghost" onClick={() => { controller.refresh() }}>{t('refresh')}</Button>
          <Button autoFocus variant="primary" disabled={state.data === undefined || handoffBusy} onClick={handoff}>
            {handoffBusy ? t('openingChat') : t('openChat')}
          </Button>
        </div>
      )}
    >
      <div style={stack} data-swarm-team-dashboard data-phase={state.phase}>
        <Status state={state} t={t} />
        {state.data === undefined ? <EmptyState state={state} t={t} controller={controller} /> : <Dashboard data={state.data.projection} t={t} />}
        <p style={{ ...muted, margin: 0 }}>{t('trust')}</p>
      </div>
    </Modal>
  )
}

function Status({ state, t }: { state: TeamDashboardState; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading')
    : state.phase === 'reconnecting' ? t('reconnecting')
      : state.phase === 'stale' ? t('stale') : t('error')
  return (
    <div role={failed ? 'alert' : 'status'} aria-live="polite" style={{ ...row, justifyContent: 'flex-start' }}>
      <StateDot state={failed ? 'warning' : 'ongoing'} />
      <span>{label}</span>
      {state.error === undefined ? null : <code title={state.error.message}>{state.error.code}</code>}
    </div>
  )
}

function EmptyState({ state, t, controller }: {
  state: TeamDashboardState
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  controller: TeamDashboardController
}) {
  if (state.phase !== 'error') return null
  return <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button>
}

function Dashboard({ data, t }: { data: SwarmHostReadProjectionV1; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return (
    <div style={stack}>
      <div style={grid}>
        <Section heading={t('team')}>
          <Fact label={data.team.name} value={data.team.phase} />
          <Fact label={t('revision')} value={String(data.team.revision)} />
          <Fact label={t('updated')} value={new Date(data.team.updatedAt).toLocaleString()} />
        </Section>
        <Section heading={t('budget')}>
          <Fact label={t('usedTokens')} value={limit(data.budget.usedTokens, data.budget.tokenLimit)} />
          <Fact label={t('usedRequests')} value={limit(data.budget.usedRequests, data.budget.requestLimit)} />
          <Fact label={t('usedRetries')} value={limit(data.budget.usedRetries, data.budget.retryLimit)} />
        </Section>
      </div>
      <div style={grid}>
        <Section heading={`${t('members')} (${String(data.totals.roster)})`}>
          <Rows empty={t('empty')} rows={data.roster.map(member => ({
            key: member.name,
            primary: member.name,
            secondary: member.role,
            state: member.phase,
          }))} />
        </Section>
        <Section heading={`${t('tasks')} (${String(data.totals.tasks)})`}>
          <Rows empty={t('empty')} rows={data.tasks.map(task => ({
            key: task.id,
            primary: task.subject,
            secondary: task.ownerName === undefined
              ? (task.blockedBy.length === 0 ? task.id : t('blocked', { count: task.blockedBy.length }))
              : t('owner', { name: task.ownerName }),
            state: task.status,
          }))} />
        </Section>
        <Section heading={`${t('attempts')} (${String(data.totals.attempts)})`}>
          <Rows empty={t('empty')} rows={data.attempts.map(attempt => ({
            key: attempt.id,
            primary: attempt.memberName ?? attempt.taskId,
            secondary: t('generation', { generation: attempt.generation }),
            state: attempt.phase,
          }))} />
        </Section>
        <Section heading={`${t('interactions')} (${String(data.totals.pendingInteractions)})`}>
          <Rows empty={t('empty')} rows={data.pendingInteractions.map(interaction => ({
            key: interaction.requestId,
            primary: interaction.intent,
            secondary: t('target', { kind: interaction.targetKind }),
            state: interaction.status,
          }))} />
        </Section>
      </div>
      <Section heading={t('capabilities')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {data.capabilities.map(capability => (
            <Pill key={capability.capability} active={capability.state === 'available'}>
              {capability.capability}: {t(capability.state)}
            </Pill>
          ))}
        </div>
      </Section>
    </div>
  )
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return <section style={card}><h3 style={title}>{heading}</h3>{children}</section>
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div style={row}><span style={muted}>{label}</span><span>{value}</span></div>
}

function Rows({ empty, rows }: {
  empty: string
  rows: readonly { readonly key: string; readonly primary: string; readonly secondary: string; readonly state: string }[]
}) {
  if (rows.length === 0) return <span style={muted}>{empty}</span>
  return (
    <ul style={list}>
      {rows.map(item => (
        <li key={item.key} style={row}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.primary}>{item.primary}</span>
          <span style={{ ...muted, whiteSpace: 'nowrap' }} title={item.secondary}>{item.state}</span>
        </li>
      ))}
    </ul>
  )
}

function limit(used: number, maximum: number | undefined): string {
  return maximum === undefined ? String(used) : `${String(used)} / ${String(maximum)}`
}
