import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadCaptainMembersV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'
import { NOT_GENERATED_AVATAR, deriveMemberTone, memberAssetOf, toneLabel, enumLabel, type DeskTone } from './team-dashboard-view-helpers.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type Task = SwarmHostReadProjectionV1['tasks'][number]
type TeamRow = SwarmReadTeamsV1['teams'][number]

const IN_FLIGHT = new Set<Task['status']>(['in_progress', 'submitted', 'verifying'])

function taskProgressTone(task: Task, tasks: readonly Task[]): string {
  if (task.status === 'completed') return 'completed'
  if (task.status === 'failed') return 'failed'
  if (task.status === 'cancelled') return 'cancelled'
  if (task.status === 'in_progress') return 'executing'
  if (task.status === 'submitted' || task.status === 'verifying') return 'pending'
  const taskById = new Map(tasks.map(candidate => [candidate.id, candidate]))
  const blocked = task.blockedBy.some(id => taskById.get(id)?.status !== 'completed')
  return blocked ? 'blocked' : 'ready'
}

export function TaskProgressSummary({ tasks, number, t }: {
  readonly tasks: readonly Task[]
  readonly number: Intl.NumberFormat
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const tone = taskProgressTone(task, tasks)
    counts.set(tone, (counts.get(tone) ?? 0) + 1)
  }
  return <section className="swarm-team-workspace__progress" data-swarm-task-progress aria-label={t('tasks')}>
    <div className="swarm-team-workspace__block-head">
      <span>{t('tasks')}</span>
      <small>{number.format(tasks.length)} {t('taskCount')}</small>
    </div>
    {tasks.length === 0
      ? <p className="swarm-team-workspace__muted" data-swarm-task-progress-empty>{t('empty')}</p>
      : <>
        <div className="swarm-team-workspace__progress-track" aria-hidden="true">
          {tasks.map(task => <span key={task.id} data-state={task.status} data-swarm-progress-tone={taskProgressTone(task, tasks)} title={task.subject} />)}
        </div>
        <div className="swarm-team-workspace__progress-legend">
          <span>{t('tone.executing')} {number.format(counts.get('executing') ?? 0)}</span>
          <span>{t('tone.pending')} {number.format((counts.get('pending') ?? 0) + (counts.get('blocked') ?? 0))}</span>
          <span>{t('enum.completed')} {number.format(counts.get('completed') ?? 0)}</span>
          <span>{t('tone.failed')} {number.format(counts.get('failed') ?? 0)}</span>
        </div>
      </>}
  </section>
}

function preferredOwnedTask(data: SwarmHostReadProjectionV1, name: string): Task | undefined {
  return data.tasks
    .filter(task => task.ownerName === name)
    .toSorted((left, right) => {
      const leftLive = IN_FLIGHT.has(left.status) ? 1 : 0
      const rightLive = IN_FLIGHT.has(right.status) ? 1 : 0
      return rightLive - leftLive || right.updatedAt - left.updatedAt
    })[0]
}

export function ExecutionTree({ data, boundCaptain, memberAssets, handoffBusy, viewingCaptain, onCaptainSession, onOpenMember, number, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly boundCaptain: TeamRow | undefined
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly handoffBusy: boolean
  readonly viewingCaptain: boolean
  readonly onCaptainSession: () => void
  readonly onOpenMember: (name: string) => void
  readonly number: Intl.NumberFormat
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const tones = new Map<string, DeskTone>(data.roster.map(member => [member.name, deriveMemberTone(data, member.name, member.phase)]))
  const stats = { executing: 0, pending: 0, failed: 0, standby: 0, offline: 0 } as Record<DeskTone, number>
  for (const tone of tones.values()) stats[tone] += 1

  const captainGenerated = boundCaptain?.identityCard.state === 'generated'
  const captainName = captainGenerated && boundCaptain?.displayName !== undefined ? boundCaptain.displayName : t('profileIncomplete')
  const captainProfession = captainGenerated && boundCaptain?.profession !== undefined ? boundCaptain.profession : undefined
  const captainStateText = viewingCaptain ? t('captainCurrentSession') : t('captainOpenSession')

  return <section className="swarm-team-workspace__delegation" data-swarm-execution-tree>
    <div className="swarm-team-workspace__block-head">
      <span>{t('workspace.desks')}</span>
      <small data-swarm-desk-stats>{number.format(stats.executing)} {t('tone.executing')} · {number.format(stats.pending)} {t('tone.pending')} · {number.format(stats.failed)} {t('tone.failed')} · {number.format(stats.standby)} {t('tone.standby')} · {number.format(stats.offline)} {t('tone.offline')}</small>
    </div>
    <section className="swarm-team-workspace__workroom" aria-label={t('workspace.desks')} data-swarm-workroom>
      <button
        className="swarm-team-workspace__desk swarm-team-workspace__captain-node"
        type="button"
        disabled={handoffBusy || viewingCaptain}
        data-swarm-captain-desk
        data-swarm-captain-current={viewingCaptain ? 'true' : 'false'}
        data-swarm-tone="offline"
        title={viewingCaptain ? t('captainCurrentSessionTitle') : t('captainMainChatTitle')}
        onClick={onCaptainSession}
      >
        <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={boundCaptain?.name ?? ''} asset={boundCaptain?.avatar ?? NOT_GENERATED_AVATAR} name={captainName} t={t} /></span>
        <span className="swarm-team-workspace__desk-copy">
          <strong className="swarm-team-workspace__desk-name" data-swarm-captain-visible-name={captainName} title={captainName}>{captainName}<b className="swarm-team-workspace__captain-badge">{t('captainRole')}</b></strong>
          <small className="swarm-team-workspace__desk-role" data-swarm-captain-profession={captainProfession ?? ''}>{captainProfession ?? t('profileNotGenerated')}</small>
        </span>
        <span className="swarm-team-workspace__desk-state" data-swarm-captain-state={captainStateText}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" />{captainStateText}</span>
      </button>
      {data.roster.map(member => {
        const tone = tones.get(member.name) ?? 'standby'
        const asset = memberAssetOf(memberAssets, member.name)
        const generated = asset.identityCard.state === 'generated'
        const displayName = generated && asset.displayName !== undefined ? asset.displayName : member.name
        const profession = generated && asset.profession !== undefined ? asset.profession : member.role
        const label = toneLabel(tone, t)
        const task = preferredOwnedTask(data, member.name)
        return <div className="swarm-team-workspace__delegate-member" key={member.name}>
          <button
            className="swarm-team-workspace__desk"
            type="button"
            aria-haspopup="dialog"
            data-swarm-member-name={member.name}
            data-swarm-member-role={member.role}
            data-swarm-identity-state={asset.identityCard.state}
            data-swarm-tone={tone}
            onClick={() => { onOpenMember(member.name) }}
          >
            <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={member.name} asset={asset.avatar} name={displayName} t={t} /></span>
            <span className="swarm-team-workspace__desk-copy">
              <strong className="swarm-team-workspace__desk-name" data-swarm-member-visible-name={displayName} title={displayName}>{displayName}</strong>
              <small className="swarm-team-workspace__desk-role swarm-team-workspace__truncate" data-swarm-member-visible-profession={profession} title={profession}>{profession}</small>
              {member.phase === 'failed' || member.provisioningAttempt !== undefined
                ? <small className="swarm-team-workspace__desk-role" data-swarm-provisioning-attempt>{t(member.phase === 'failed' ? 'memberProvisioningFailed' : 'memberProvisioningAttempt', { count: member.provisioningAttempt ?? 1 })}</small>
                : null}
            </span>
            <span className="swarm-team-workspace__desk-state" data-swarm-member-tone={tone} data-swarm-member-visible-activity={label} title={label}><i className="swarm-team-workspace__desk-dot" aria-hidden="true" />{label}</span>
          </button>
          <div className="swarm-team-workspace__member-task" data-swarm-member-current-task={member.name}>
            <span aria-hidden="true">↳</span>
            <span className="swarm-team-workspace__member-task-copy" title={task?.subject ?? t('memberNone')}>{task === undefined ? t('memberNone') : `${enumLabel(task.status, t)} · ${task.subject}`}</span>
          </div>
        </div>
      })}
    </section>
    {data.truncated.roster ? <p className="swarm-team-workspace__muted">{t('rosterTruncated', { shown: number.format(data.roster.length), total: number.format(data.totals.roster) })}</p> : null}
  </section>
}
