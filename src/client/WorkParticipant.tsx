import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryEntry, DirectoryResponse } from '../rpc/directory-contract.js'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export type WorkDirectory = Pick<DirectoryResponse, 'binding' | 'entries'>
export function workMemberLabels(directory: WorkDirectory | undefined, binding: WorkDirectory['binding']): readonly DirectoryEntry[] {
  return directory?.binding.rootSessionId === binding.rootSessionId && directory.binding.teamId === binding.teamId ? directory.entries : []
}

/** Names describe the current bound directory, never a reconstructed historical identity. */
export function WorkParticipant({ sessionId, members, missing, main = false, t }: {
  readonly sessionId: string | undefined; readonly members: readonly DirectoryEntry[]; readonly missing?: string
  readonly main?: boolean
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  if (sessionId === undefined) return <>{missing ?? t('taskPanel.notRecorded')}</>
  const member = members.find(row => row.memberId === sessionId)
  const label = member?.label.trim() || undefined
  const shortId = sessionId.replace(/^session-/u, '').slice(0, 8)
  return <span data-work-participant={sessionId} title={label === undefined ? sessionId : `${t('current')}: ${label} · ${sessionId}`}>
    {label ?? `${t(main ? 'work.main' : 'members')} · ${shortId}`}
  </span>
}
