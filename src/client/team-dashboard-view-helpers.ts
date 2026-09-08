/** Display-only derivations from the single authoritative read projection. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadAssetStatusV1, SwarmReadCaptainMembersV1, SwarmReadMemberCompositionV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'

/** The read contract reports un-generated member assets with a stable reason; the UI never fabricates one. */
export const NOT_GENERATED_AVATAR: SwarmReadAssetStatusV1 = { state: 'not_generated', reason: 'avatar_backend_not_implemented' }
const NOT_GENERATED_IDENTITY: SwarmReadAssetStatusV1 = { state: 'not_generated', reason: 'identity_backend_not_implemented' }

export type DeskTone = 'standby' | 'executing' | 'pending' | 'failed' | 'offline'
export type TaskProgressState = 'completed' | 'running' | 'review' | 'blocked' | 'unknown' | 'ready' | 'failed' | 'cancelled'

/** Counts visible canonical tasks; callers disclose truncation before showing a total. */
export function taskProgressState(task: SwarmHostReadProjectionV1['tasks'][number], tasks: SwarmHostReadProjectionV1['tasks']): TaskProgressState {
  if (task.status === 'in_progress') return 'running'
  if (task.status === 'submitted' || task.status === 'verifying') return 'review'
  if (task.status === 'pending') {
    const dependencies = task.blockedBy.map(id => tasks.find(candidate => candidate.id === id))
    if (dependencies.some(dependency => dependency !== undefined && dependency.status !== 'completed')) return 'blocked'
    return dependencies.some(dependency => dependency === undefined) ? 'unknown' : 'ready'
  }
  return task.status
}
export type DetailSelection =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'growth' }
  | { readonly kind: 'overview' }
  | { readonly kind: 'diagnostics' }

export const TEAM_WORKSPACE_WIDE_MIN_WIDTH = 720
type TeamWorkspaceLayout = 'compact' | 'wide'
/** The Details container, rather than the browser viewport, chooses the layout branch. */
export function teamWorkspaceLayoutForWidth(width: number): TeamWorkspaceLayout { return width >= TEAM_WORKSPACE_WIDE_MIN_WIDTH ? 'wide' : 'compact' }

/** Strictly derives an activity only from a task's current attempt and matching member/task identifiers. */
export function deriveMemberActivity(data: SwarmHostReadProjectionV1, name: string, phase: SwarmHostReadProjectionV1['roster'][number]['phase']): MemberActivity {
  const currentAttempts = data.tasks.flatMap(task => {
    if (task.currentAttemptId === undefined) return []
    const attempt = data.attempts.find(candidate => candidate.id === task.currentAttemptId && candidate.taskId === task.id && candidate.memberName === name)
    return attempt === undefined ? [] : [{ task, attempt }]
  })
  const newest = currentAttempts.toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0]
  if (phase === 'failed') return { task: newest?.task, attempt: newest?.attempt, state: 'error' }
  if (phase === 'provisioning') return { task: newest?.task, attempt: newest?.attempt, state: 'provisioning' }
  if (phase === 'removed') return { task: newest?.task, attempt: newest?.attempt, state: 'removed' }
  const current = currentAttempts.filter(candidate => candidate.attempt.phase === 'running').toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0] ?? newest
  if (current?.attempt.phase === 'running') return { task: current.task, attempt: current.attempt, state: 'running' }
  if (current !== undefined) return { task: current.task, attempt: current.attempt, state: current.attempt.phase }
  return { task: undefined, attempt: undefined, state: 'idle' }
}

type MemberActivity = {
  readonly task: SwarmHostReadProjectionV1['tasks'][number] | undefined
  readonly attempt: SwarmHostReadProjectionV1['attempts'][number] | undefined
  readonly state: 'running' | 'idle' | 'error' | 'provisioning' | 'removed' | SwarmHostReadProjectionV1['attempts'][number]['phase']
}

/** Visible work-seat status mapped only from the real roster/tasks/attempts into five honest tones:
 *  executing (blue pulse) = running attempt; pending (amber) = provisioning lifecycle, a
 *  submitted/verifying attempt, or a pending/in-flight task owned but not running; failed =
 *  failed lifecycle or errored activity; standby (green) = settled (accepted/rejected/cancelled/
 *  stale are ended, never pending) or no current work; offline (gray) = removed member. */
export function deriveMemberTone(data: SwarmHostReadProjectionV1, name: string, phase: SwarmHostReadProjectionV1['roster'][number]['phase']): DeskTone {
  if (phase === 'removed') return 'offline'
  const activity = deriveMemberActivity(data, name, phase)
  if (phase === 'failed' || activity.state === 'error') return 'failed'
  if (phase === 'provisioning') return 'pending'
  if (activity.state === 'running') return 'executing'
  if (activity.attempt !== undefined && (activity.attempt.phase === 'submitted' || activity.attempt.phase === 'verifying')) return 'pending'
  // Terminal attempts (accepted/rejected/cancelled/stale) are ended, never pending — unless the
  // member still owns another genuinely in-flight or unstarted task.
  if (data.tasks.some(task => task.ownerName === name && ['pending', 'in_progress', 'submitted', 'verifying'].includes(task.status))) return 'pending'
  return 'standby'
}

export function toneLabel(tone: DeskTone, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  if (tone === 'executing') return t('tone.executing')
  if (tone === 'pending') return t('tone.pending')
  if (tone === 'failed') return t('tone.failed')
  if (tone === 'offline') return t('tone.offline')
  return t('tone.standby')
}

/** Pure display-only initials: NFC normalization plus the first grapheme cluster, never persisted. */
export function memberRosterInitial(name: string): string {
  const normalized = name.normalize('NFC')
  const segmenter = typeof Intl.Segmenter === 'undefined' ? undefined : new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return segmenter === undefined ? (Array.from(normalized)[0] ?? '') : (segmenter.segment(normalized)[Symbol.iterator]().next().value?.segment ?? '')
}

export function dedupeTeams(teams: SwarmReadTeamsV1 | undefined): SwarmReadTeamsV1['teams'] {
  const unique = new Map<string, SwarmReadTeamsV1['teams'][number]>()
  for (const team of teams?.teams ?? []) {
    if (!unique.has(team.teamId)) unique.set(team.teamId, team)
  }
  return [...unique.values()]
}

/** Fail-safe timestamp: a malformed/non-finite createdAt must never throw during render. */
export function formatTime(createdAt: number, localeTag: () => 'zh-CN' | 'en-US'): string | undefined {
  if (!Number.isFinite(createdAt)) return undefined
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return undefined
  try { return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(date) } catch { return undefined }
}

/** Real member identity card data comes from the captainMembers read keyed by the authoritative
 *  roster name; a missing row keeps the honest not-generated placeholder, never a fabricated asset. */
export function memberAssetOf(memberAssets: SwarmReadCaptainMembersV1 | undefined, name: string): {
  readonly sessionId?: string
  readonly avatar: SwarmReadAssetStatusV1
  readonly identityCard: SwarmReadAssetStatusV1
  readonly displayName?: string
  readonly profession?: string
  readonly personality?: string
  readonly biography?: string
  readonly growth: { readonly privateMemory: 'private_to_member'; readonly skills: 'not_implemented'; readonly capability: 'not_implemented' }
  readonly composition?: SwarmReadMemberCompositionV1
  readonly skills?: readonly string[]
  readonly assignedSkills?: readonly string[]
  readonly callableTools?: readonly string[]
  readonly growthSummary?: string
  readonly currentActivity?: SwarmReadCaptainMembersV1['members'][number]['currentActivity']
  readonly recentOutcome?: SwarmReadCaptainMembersV1['members'][number]['recentOutcome']
} {
  const row = memberAssets?.members.find(candidate => candidate.name === name)
  return {
    ...(row?.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    avatar: row?.avatar ?? NOT_GENERATED_AVATAR,
    identityCard: row?.identityCard ?? NOT_GENERATED_IDENTITY,
    ...(row?.displayName === undefined ? {} : { displayName: row.displayName }),
    ...(row?.profession === undefined ? {} : { profession: row.profession }),
    ...(row?.personality === undefined ? {} : { personality: row.personality }),
    ...(row?.biography === undefined ? {} : { biography: row.biography }),
    growth: row?.growth ?? { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
    ...(row?.composition === undefined ? {} : { composition: row.composition }),
    ...(row?.skills === undefined ? {} : { skills: row.skills }),
    ...(row?.assignedSkills === undefined ? {} : { assignedSkills: row.assignedSkills }),
    ...(row?.callableTools === undefined ? {} : { callableTools: row.callableTools }),
    ...(row?.growthSummary === undefined ? {} : { growthSummary: row.growthSummary }),
    ...(row?.currentActivity === undefined ? {} : { currentActivity: row.currentActivity }),
    ...(row?.recentOutcome === undefined ? {} : { recentOutcome: row.recentOutcome }),
  }
}

type WireEnum = SwarmHostReadProjectionV1['team']['phase'] | SwarmHostReadProjectionV1['roster'][number]['phase'] | SwarmHostReadProjectionV1['tasks'][number]['status'] | SwarmHostReadProjectionV1['attempts'][number]['phase']
const enumKey = Object.freeze({ staged: 'enum.staged', active: 'enum.active', archived: 'enum.archived', provisioning: 'enum.provisioning', failed: 'enum.failed', removed: 'enum.removed', pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying', completed: 'enum.completed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted', rejected: 'enum.rejected', stale: 'enum.stale' } as const satisfies Record<WireEnum, TeamDashboardKey>)
export function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string { return t(enumKey[value]) }
