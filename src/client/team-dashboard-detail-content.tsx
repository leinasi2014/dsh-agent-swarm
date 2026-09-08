/** Stateless view sections; selection and focus ownership remain in Workspace. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, type KeyboardEvent, type RefObject } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadCaptainDiagnosticsV1, SwarmReadCaptainMembersV1 } from '../rpc/read-rpc-contract.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { deriveMemberActivity, deriveMemberTone, memberAssetOf, formatTime, toneLabel, enumLabel, type DetailSelection } from './team-dashboard-view-helpers.js'

export function ManageView({ data, memberAssets, number, onManageViaCaptain, onOpenDetail, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly number: Intl.NumberFormat
  readonly onManageViaCaptain: () => void
  readonly onOpenDetail: (selection: DetailSelection) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  return <div className="swarm-team-workspace__manage" data-swarm-manage-view>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-members>
      <span className="swarm-team-workspace__table-copy"><strong>{t('manage.membersTitle')}</strong><small>{t('manage.membersDesc', { count: number.format(data.totals.roster) })}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" onClick={onManageViaCaptain} title={t('manageViaCaptain')}>{t('manage.open')}</button>
    </div>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-growth>
      <span className="swarm-team-workspace__table-copy"><strong>{t('manage.growthTitle')}</strong><small>{t('manage.growthDesc')}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" onClick={() => { onOpenDetail({ kind: 'growth' }) }}>{t('manage.open')}</button>
    </div>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-overview>
      <span className="swarm-team-workspace__table-copy"><strong>{t('manage.overviewTitle')}</strong><small>{t('manage.overviewDesc')}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" onClick={() => { onOpenDetail({ kind: 'overview' }) }}>{t('manage.open')}</button>
    </div>
    <div className="swarm-team-workspace__manage-row" data-swarm-manage-diagnostics>
      <span className="swarm-team-workspace__table-copy"><strong>{t('diagnostics')}</strong><small>{t('manage.diagnosticsDesc')}</small></span>
      <button className="swarm-team-workspace__manage-action" type="button" onClick={() => { onOpenDetail({ kind: 'diagnostics' }) }}>{t('manage.open')}</button>
    </div>
    {/* Member growth is the only real growth projection available; it also backs the growth overlay. */}
    <p className="swarm-team-workspace__contact-note">{memberAssets === undefined ? t('loading') : t('manageViaCaptainHint')}</p>
  </div>
}

export function DetailView({ detail, data, localeTag, number, headingRef, memberAssets, diagnostics, onClose, onKeyDown, t }: {
  readonly detail: DetailSelection
  readonly data: SwarmHostReadProjectionV1
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly number: Intl.NumberFormat
  readonly headingRef: RefObject<HTMLHeadingElement>
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly onClose: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const heading = detailHeading(detail, data, t)
  const headingId = useId()
  return <div className="swarm-team-workspace__detail-view" role="region" aria-labelledby={headingId} data-swarm-detail-view data-swarm-detail-kind={detail.kind} onKeyDown={onKeyDown}>
    <header className="swarm-team-workspace__detail-head">
      <Button size="sm" variant="ghost" aria-label={t('detail.back')} data-swarm-detail-back onClick={onClose}><span aria-hidden="true">←</span> {t('detail.back')}</Button>
      <div className="swarm-team-workspace__truncate">
        <h3 className="swarm-team-workspace__detail-title" id={headingId} ref={headingRef} tabIndex={-1}>{heading.title}</h3>
        <small className="swarm-team-workspace__detail-sub">{heading.sub}</small>
      </div>
    </header>
    <div className="swarm-team-workspace__detail-body">
      {detail.kind === 'member' ? <MemberDetail detail={detail} data={data} localeTag={localeTag} memberAssets={memberAssets} t={t} />
        : detail.kind === 'task' ? <TaskDetail detail={detail} data={data} number={number} localeTag={localeTag} t={t} />
          : detail.kind === 'growth' ? <GrowthDetail data={data} t={t} />
            : detail.kind === 'overview' ? <OverviewDetail data={data} number={number} t={t} />
              : <DiagnosticsDetail data={data} diagnostics={diagnostics} number={number} t={t} />}
    </div>
  </div>
}

function detailHeading(detail: DetailSelection, data: SwarmHostReadProjectionV1, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): { readonly title: string; readonly sub: string } {
  if (detail.kind === 'member') {
    const member = data.roster.find(candidate => candidate.name === detail.name)
    return { title: t('memberDetailHeading', { name: detail.name }), sub: member?.role ?? '' }
  }
  if (detail.kind === 'task') {
    const task = data.tasks.find(candidate => candidate.id === detail.id)
    return { title: t('taskDetailHeading', { subject: task?.subject ?? detail.id }), sub: detail.id }
  }
  if (detail.kind === 'growth') return { title: t('manage.growthTitle'), sub: '' }
  if (detail.kind === 'overview') return { title: t('manage.overviewTitle'), sub: data.team.name }
  return { title: t('diagnostics'), sub: data.team.name }
}

/** Inline member detail. Every field renders its real read value or the explicit
 *  "not available yet" marker — never a fabricated profile, skill, tool or model claim. */
export function MemberDetail({ detail, data, localeTag, memberAssets, t }: {
  readonly detail: { readonly kind: 'member'; readonly name: string }
  readonly data: SwarmHostReadProjectionV1
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const member = data.roster.find(candidate => candidate.name === detail.name)
  if (member === undefined) return null
  const asset = memberAssetOf(memberAssets, member.name)
  const generated = asset.identityCard.state === 'generated'
  const displayName = generated && asset.displayName !== undefined ? asset.displayName : member.name
  const activity = deriveMemberActivity(data, member.name, member.phase)
  const tone = deriveMemberTone(data, member.name, member.phase)
  // "Current task" accepts ONLY genuinely in-flight work: a task in an in-flight status whose
  // current attempt is running/submitted/verifying. Any terminal status or attempt phase is
  // recent history, never current work.
  const hasCurrentWork = activity.task !== undefined && activity.attempt !== undefined
    && ['in_progress', 'submitted', 'verifying'].includes(activity.task.status)
    && ['running', 'submitted', 'verifying'].includes(activity.attempt.phase)
  const currentTask = hasCurrentWork ? activity.task : undefined
  const unavailable = <span className="swarm-team-workspace__unavailable">{t('detail.unavailable')}</span>
  const value = (real: string | undefined): string | typeof unavailable => real === undefined ? unavailable : real
  // captainMembers.composition.v1: real derived composition only. A non-`available` row
  // discloses state/reason plus runtimeProvider and nothing else (contract fail-closed);
  // a missing composition renders honest unavailable markers, never a fabricated claim.
  const composition = asset.composition
  const compositionReady = composition?.state === 'available'
  const compositionValue = (real: string | undefined): string | typeof unavailable =>
    composition === undefined || !compositionReady || real === undefined ? unavailable : real
  const personaValue = composition !== undefined && compositionReady && typeof composition.personaConfigured === 'boolean'
    ? t(composition.personaConfigured ? 'detail.yes' : 'detail.no')
    : unavailable
  return <>
    <div className="swarm-team-workspace__detail-section" data-swarm-detail-profile>
      <h4>{t('detail.section.profile')}</h4>
      <div className="swarm-team-workspace__identity-head">
        <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={displayName} t={t} /></span>
        <span className="swarm-team-workspace__desk-copy">
          <strong className="swarm-team-workspace__truncate" title={displayName}>{displayName}</strong>
          <small className="swarm-team-workspace__desk-role" data-swarm-member-visible-activity={toneLabel(tone, t)}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" /> {toneLabel(tone, t)}</small>
        </span>
      </div>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('memberRole')}</dt><dd data-swarm-detail-role>{member.role}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('profileProfession')}</dt><dd data-swarm-detail-profession>{generated && asset.profession !== undefined ? asset.profession : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('profilePersonality')}</dt><dd data-swarm-detail-personality>{value(generated && asset.personality !== undefined ? asset.personality : undefined)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.intro')}</dt><dd data-swarm-detail-biography>{value(generated ? asset.biography : undefined)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.model')}</dt><dd data-swarm-detail-model>{compositionValue(composition?.model)}</dd></div>
      </dl>
      <details className="swarm-team-workspace__fold" data-swarm-runtime-details>
        <summary>{t('detail.runtime')}</summary>
        <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.provider')}</dt><dd data-swarm-detail-provider>{value(composition?.runtimeProvider)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.llmProvider')}</dt><dd data-swarm-detail-llm-provider>{compositionValue(composition?.llmProvider)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.preset')}</dt><dd data-swarm-detail-preset>{compositionValue(composition?.presetId)}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.persona')}</dt><dd data-swarm-detail-persona>{personaValue}</dd></div>
        {composition !== undefined && !compositionReady ? <>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.compositionState')}</dt><dd data-swarm-detail-composition-state>{composition.state}</dd></div>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.compositionReason')}</dt><dd data-swarm-detail-composition-reason>{composition.reason}</dd></div>
        </> : null}
      </dl>
      </details>
    </div>
    <details className="swarm-team-workspace__detail-section" data-swarm-detail-skills>
      <summary>{t('detail.section.skills')}</summary>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.teamAllowed')}</dt><dd data-swarm-detail-team-allowed>{memberAssets?.teamAllowedSkills === undefined ? unavailable : memberAssets.teamAllowedSkills.length === 0 ? t('detail.field.none') : memberAssets.teamAllowedSkills.join(', ')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.skills')}</dt><dd data-swarm-detail-skills-value>{asset.skills === undefined ? unavailable : asset.skills.length === 0 ? t('detail.field.none') : asset.skills.join(', ')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.assignedSkills')}</dt><dd data-swarm-detail-assigned-skills>{asset.assignedSkills === undefined ? unavailable : asset.assignedSkills.length === 0 ? t('detail.field.none') : asset.assignedSkills.join(', ')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.tools')}</dt><dd data-swarm-detail-callable-tools>{asset.callableTools === undefined ? unavailable : asset.callableTools.length === 0 ? t('detail.field.none') : asset.callableTools.join(', ')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.deniedTools')}</dt><dd data-swarm-detail-denied-tools>{composition !== undefined && compositionReady ? (composition.deniedTools === undefined ? unavailable : composition.deniedTools.length === 0 ? t('detail.field.none') : composition.deniedTools.join(', ')) : unavailable}</dd></div>
      </dl>
    </details>
    <div className="swarm-team-workspace__detail-section" data-swarm-detail-task>
      <h4>{t('detail.section.currentTask')}</h4>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('tasks')}</dt><dd data-swarm-detail-task-subject>{currentTask?.subject ?? asset.currentActivity?.subject ?? t('memberNone')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('status')}</dt><dd data-swarm-detail-task-status>{currentTask !== undefined ? enumLabel(currentTask.status, t) : asset.currentActivity !== undefined ? enumLabel(asset.currentActivity.status, t) : t('memberNone')}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.started')}</dt><dd data-swarm-detail-task-started>{value(currentTask !== undefined && activity.attempt !== undefined ? formatTime(activity.attempt.createdAt, localeTag) : undefined)}</dd></div>
      </dl>
    </div>
    <details className="swarm-team-workspace__detail-section" data-swarm-detail-growth>
      <summary>{t('detail.section.growth')}</summary>
      <dl className="swarm-team-workspace__field-list">
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.recentTask')}</dt><dd data-swarm-detail-recent-attempt>{activity.attempt !== undefined ? `${activity.attempt.phase} · ${formatTime(activity.attempt.updatedAt, localeTag) ?? ''}` : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.recentOutput')}</dt><dd data-swarm-detail-recent-outcome>{asset.recentOutcome !== undefined ? `${asset.recentOutcome.phase} · ${formatTime(asset.recentOutcome.at, localeTag) ?? ''}` : unavailable}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthTitle')}</dt><dd data-swarm-detail-growth-summary>{asset.growthSummary === undefined ? unavailable : asset.growthSummary === '' ? t('detail.field.none') : asset.growthSummary}</dd></div>
        <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.memory')}</dt><dd data-swarm-detail-memory>{t('growthMemoryPrivate')}</dd></div>
      </dl>
    </details>
    {/* Ordinary members have no direct chat capability in the current base; the honest disabled
        note explains the Captain coordination path instead of a fabricated contact action. */}
    <p className="swarm-team-workspace__contact-note" data-swarm-contact-disabled>{t('detail.contactDisabled')}</p>
  </>
}

function TaskDetail({ detail, data, number, localeTag, t }: {
  readonly detail: { readonly kind: 'task'; readonly id: string }
  readonly data: SwarmHostReadProjectionV1
  readonly number: Intl.NumberFormat
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const task = data.tasks.find(candidate => candidate.id === detail.id)
  if (task === undefined) return null
  const attempt = task.currentAttemptId === undefined ? undefined : data.attempts.find(candidate => candidate.id === task.currentAttemptId)
  return <div className="swarm-team-workspace__detail-section" data-swarm-task-detail>
    <dl className="swarm-team-workspace__field-list">
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('status')}</dt><dd>{enumLabel(task.status, t)}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskOwner')}</dt><dd>{task.ownerName ?? t('hostUnavailable')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskTarget')}</dt><dd>{task.targetMemberName ?? t('hostUnavailable')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskBlocked', { count: number.format(task.blockedBy.length) })}</dt><dd>{task.blockedBy.length === 0 ? t('empty') : task.blockedBy.join(', ')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('detail.field.created')}</dt><dd>{formatTime(task.createdAt, localeTag) ?? t('detail.unavailable')}</dd></div>
      <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('taskCurrentAttempt')}</dt><dd>{task.currentAttemptId ?? t('memberNone')}{attempt === undefined ? '' : ` · ${enumLabel(attempt.phase, t)}`}</dd></div>
    </dl>
  </div>
}

function GrowthDetail({ data, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const unavailable = <span className="swarm-team-workspace__unavailable">{t('detail.unavailable')}</span>
  return <div data-swarm-growth-detail>
    {data.roster.length === 0 ? <p className="swarm-team-workspace__muted">{t('empty')}</p> : data.roster.map(member => {
  return <div key={member.name} className="swarm-team-workspace__detail-section" data-swarm-growth-member={member.name}>
        <h4>{member.name}</h4>
        <dl className="swarm-team-workspace__field-list">
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthMemory')}</dt><dd>{t('growthMemoryPrivate')}</dd></div>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthSkills')}</dt><dd>{unavailable}</dd></div>
          <div className="swarm-team-workspace__fact" style={{ display: 'contents' }}><dt>{t('growthCapability')}</dt><dd>{unavailable}</dd></div>
        </dl>
      </div>
    })}
  </div>
}

function OverviewDetail({ data, number, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly number: Intl.NumberFormat
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const metric = (used: number, limit?: number): string => limit === undefined ? number.format(used) : `${number.format(used)} / ${number.format(limit)}`
  return <div data-swarm-overview-detail>
    <div className="swarm-team-workspace__summary" data-swarm-overview-metrics>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.roster)}</strong><span className="swarm-team-workspace__muted">{t('members')}</span></div>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.tasks)}</strong><span className="swarm-team-workspace__muted">{t('tasks')}</span></div>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.attempts)}</strong><span className="swarm-team-workspace__muted">{t('attempts')}</span></div>
      <div className="swarm-team-workspace__metric"><strong>{number.format(data.totals.pendingInteractions)}</strong><span className="swarm-team-workspace__muted">{t('interactions')}</span></div>
    </div>
    <div className="swarm-team-workspace__detail-section" data-swarm-overview-budget>
      <h4>{t('budget')}</h4>
      <Facts rows={[
        [t('usedTokens'), metric(data.budget.usedTokens, data.budget.tokenLimit)],
        [t('usedRequests'), metric(data.budget.usedRequests, data.budget.requestLimit)],
        [t('usedRetries'), metric(data.budget.usedRetries, data.budget.retryLimit)],
      ]} />
    </div>
  </div>
}

function DiagnosticsDetail({ data, diagnostics, number, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly number: Intl.NumberFormat
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  return <div className="swarm-team-workspace__detail-section" data-swarm-diagnostics-detail>
    <Facts rows={[
      [t('diagnosticsSession'), data.binding.rootSessionId],
      [t('diagnosticsRevision'), number.format(diagnostics?.diagnostics.revision ?? data.team.revision)],
      ...(diagnostics === undefined ? [] : [[t('diagnosticsBackend'), diagnostics.diagnostics.backend] as const]),
      [t('diagnosticsAttempts'), number.format(data.totals.attempts)],
      [t('diagnosticsTrace'), t('diagnosticsTraceUnavailable')],
    ]} />
  </div>
}

function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) { return <dl className="swarm-team-workspace__facts">{rows.map(([label, value]) => <div className="swarm-team-workspace__fact" key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl> }
