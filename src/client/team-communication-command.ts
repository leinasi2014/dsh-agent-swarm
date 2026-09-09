import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent/client'
import type { TeamDashboardController } from './team-dashboard-controller.js'
import type { TeamCommunicationChoice } from './TeamCommunicationControl.js'

export interface CaptainHumanPrompt {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly text: string
}

/** Validate a fresh Team binding and official child catalog before a user-authored command. */
export async function queueCommunicationChange(options: {
  readonly sessions: ISessions
  readonly controller: TeamDashboardController
  readonly choice: TeamCommunicationChoice
  readonly send: (request: CaptainHumanPrompt, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const { sessions, controller, choice } = options
  if (!['inherit', 'quiet', 'balanced', 'active'].includes(choice)) throw new Error('Unknown communication intensity')
  const before = controller.getSnapshot()
  const teamId = before.data?.projection.team.id
  const viewer = sessions.list.getSnapshot().current
  if (before.phase !== 'ready' || before.targetSessionId !== viewer || teamId === undefined) throw new Error('A current Team view is required')
  const check = (): void => {
    const current = controller.getSnapshot()
    if (sessions.list.getSnapshot().current !== viewer || current.targetSessionId !== viewer || current.data?.projection.team.id !== teamId) {
      throw new Error('Team selection changed before the request was sent')
    }
  }
  await controller.openCaptainChat(async (id, signal) => {
    check()
    const row = sessions.list.getSnapshot().byId[id as SessionId]
    if (row === undefined) throw new Error('Captain is absent from the official Session list')
    let parentSessionId: string | undefined
    if (row.origin === 'subagent') {
      if (row.parentId === undefined) throw new Error('Captain has no official parent')
      await sessions.refreshSubagents(row.parentId)
      signal.throwIfAborted()
      check()
      const list = sessions.list.getSnapshot()
      const current = list.byId[id as SessionId]
      const catalog = list.subagentsByParent[row.parentId]
      const child = catalog?.state === 'ready' ? catalog.entries.find((item: SubagentListEntry) => item.id === id) as SubagentListEntry | undefined : undefined
      if (current?.origin !== 'subagent' || current.parentId !== row.parentId || child?.kind !== 'child' || child.mode !== 'continuable') {
        throw new Error('Captain continuation is no longer available')
      }
      parentSessionId = row.parentId
    } else if (row.parentId !== undefined) throw new Error('Captain Session lineage changed')
    signal.throwIfAborted()
    check()
    const text = `用户在团队面板请求调整本队交流强度。Team: ${JSON.stringify(teamId)}；intensity: ${JSON.stringify(choice)}。请读取当前 Team revision，调用 agent_swarm_set_communication 保存此选项，再读回报告。仅调整交流设置，继续保留已有任务；失败请说明原因，不要轮询或重复提交。`
    await options.send({ sessionId: id, ...(parentSessionId === undefined ? {} : { parentSessionId }), text }, signal)
  })
}
