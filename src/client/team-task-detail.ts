import { useEffect, useMemo, useRef, useState } from 'react'
import type { SwarmReadTaskDetailV1 } from '../rpc/read-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState, TaskDetailTarget } from './team-dashboard-controller.js'

export type TaskDetailRead =
  | { readonly phase: 'waiting' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'available'; readonly value: SwarmReadTaskDetailV1 }
  | { readonly phase: 'failed'; readonly code: string }

/** Only a mounted, selected detail leases reads. No timer, persistent cache or domain state. */
export function useTaskDetail(controller: TeamDashboardController, state: TeamDashboardState, taskId: string | undefined): TaskDetailRead {
  const projection = state.data?.projection
  const root = projection?.binding.rootSessionId, team = projection?.binding.teamId
  const cursor = projection?.cursor, revision = projection?.team.revision, session = state.targetSessionId
  const target = useMemo<TaskDetailTarget | undefined>(() => state.phase === 'ready' && state.open
    && taskId !== undefined && root !== undefined && team !== undefined && cursor !== undefined && revision !== undefined && session !== undefined
    ? { targetSessionId: session, binding: { rootSessionId: root, teamId: team }, taskId, cursor, teamRevision: revision } : undefined,
  [state.phase, state.open, taskId, root, team, cursor, revision, session])
  const key = state.open && (state.phase === 'ready' || state.phase === 'stale' || state.phase === 'reconnecting')
    && taskId !== undefined && root !== undefined && team !== undefined && cursor !== undefined && revision !== undefined && session !== undefined
    && (state.pendingTeamId === undefined || state.pendingTeamId === team)
    ? JSON.stringify([session, root, team, taskId, cursor, revision]) : undefined
  const sequence = useRef(0)
  const [result, setResult] = useState<{ readonly key: string; readonly read: TaskDetailRead }>()
  useEffect(() => {
    if (target === undefined || key === undefined) return
    const request = ++sequence.current, abort = new AbortController()
    setResult({ key, read: { phase: 'loading' } })
    void (async () => {
      try {
        const value = await controller.readTaskDetail(target, abort.signal)
        if (!abort.signal.aborted && request === sequence.current) setResult({ key, read: { phase: 'available', value } })
      } catch (error) {
        if (!abort.signal.aborted && request === sequence.current) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'SWARM_UI_READ_FAILED'
          setResult({ key, read: { phase: 'failed', code } })
        }
      }
    })()
    return () => { sequence.current++; abort.abort() }
  }, [controller, target, key])
  // Identity changes are hidden synchronously, before the old effect's cleanup runs.
  return key === undefined ? { phase: 'waiting' } : result?.key === key ? result.read : { phase: target === undefined ? 'waiting' : 'loading' }
}
