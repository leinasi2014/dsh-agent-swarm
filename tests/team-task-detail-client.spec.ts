import { describe, expect, it } from 'vitest'
import { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import type { SwarmReadTaskDetailV1, SwarmReadRpcRequest } from '../src/rpc/read-rpc-contract.js'
import { binding, snapshot, goodFetch, ManualSchedule, requestOf, success, waitFor } from './helpers/dashboard-controller.js'

function detail(): SwarmReadTaskDetailV1 {
  return { schemaVersion: 1, state: 'available', binding: binding.binding, taskId: 'task-0', teamRevision: snapshot.team.revision,
    task: { ...snapshot.tasks[0]!, description: 'Actual description', acceptanceCriteria: ['Actual criterion'] },
    attempts: { scope: 'retained', entries: [{ ...snapshot.attempts[0]!, evidence: ['actual reference'] }], retainedCount: 1, returnedCount: 1, limit: 100, truncated: false }, observedAt: snapshot.observedAt }
}

async function harness(response: () => Promise<Response> | Response = () => success(detail())) {
  const seen: SwarmReadRpcRequest[] = [], base = goodFetch(seen), schedule = new ManualSchedule()
  const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
    const request = requestOf(init)
    if (request.method === 'taskDetail') { seen.push(request); return await response() }
    const result = await base(input, init)
    // Prove that requests keep the calling Main Brain even when the Host resolves a Captain.
    if (request.method === 'teams') {
      const envelope = await result.json()
      envelope.value.binding.rootSessionId = 'main-session'
      for (const team of envelope.value.teams) for (const endpoint of Object.values(team.endpoints) as { target: { rootSessionId: string } }[]) endpoint.target.rootSessionId = 'main-session'
      return success(envelope.value)
    }
    return result
  }), schedule)
  controller.open('main-session')
  await waitFor(() => ['ready', 'error'].includes(controller.getSnapshot().phase))
  expect(controller.getSnapshot().error).toBeUndefined()
  const target = { targetSessionId: 'main-session', binding: binding.binding, taskId: 'task-0', cursor: snapshot.cursor, teamRevision: snapshot.team.revision }
  return { controller, target, seen, schedule }
}

describe('task detail client authority', () => {
  it('keeps the calling Session as request root, returns verified detail, and adds no scheduler', async () => {
    const { controller, target, seen, schedule } = await harness()
    try {
      const timers = schedule.pending.size
      const value = await controller.readTaskDetail(target, new AbortController().signal)
      expect(value.task.description).toBe('Actual description')
      expect(seen.at(-1)).toEqual({ schemaVersion: 1, method: 'taskDetail', target: { rootSessionId: 'main-session', teamId: 'team-1' }, taskId: 'task-0' })
      expect(value.binding.rootSessionId).toBe('root-1')
      expect(schedule.pending.size).toBe(timers)
    } finally { controller.dispose() }
  })

  it.each(['root', 'team', 'taskId', 'task', 'attempt', 'revision'] as const)('rejects a mismatched %s instead of displaying it as current', async field => {
    const value = detail()
    const invalid = field === 'root' ? { ...value, binding: { ...value.binding, rootSessionId: 'other-root' } }
      : field === 'team' ? { ...value, binding: { ...value.binding, teamId: 'other-team' } }
      : field === 'taskId' ? { ...value, taskId: 'other-task' }
      : field === 'task' ? { ...value, task: { ...value.task, id: 'other-task' } }
      : field === 'attempt' ? { ...value, attempts: { ...value.attempts, entries: [{ ...value.attempts.entries[0]!, taskId: 'other-task' }] } }
      : { ...value, teamRevision: value.teamRevision - 1 }
    const { controller, target } = await harness(() => success(invalid))
    try { await expect(controller.readTaskDetail(target, new AbortController().signal)).rejects.toThrow() }
    finally { controller.dispose() }
  })

  it('rejects an old close/reopen response even when the transport ignores cancellation and the identity is reused', async () => {
    let release!: (response: Response) => void
    const { controller, target } = await harness(() => new Promise(resolve => { release = resolve }))
    try {
      const result = controller.readTaskDetail(target, new AbortController().signal)
      const rejection = expect(result).rejects.toThrow()
      controller.close(); controller.open('main-session')
      await waitFor(() => controller.getSnapshot().phase === 'ready')
      release(success(detail()))
      await rejection
    } finally { controller.dispose() }
  })

  it('rejects an aborted response even if fetch completes successfully', async () => {
    let release!: (response: Response) => void
    const { controller, target } = await harness(() => new Promise(resolve => { release = resolve }))
    const abort = new AbortController()
    try {
      const result = controller.readTaskDetail(target, abort.signal), rejection = expect(result).rejects.toThrow()
      abort.abort(); release(success(detail())); await rejection
    } finally { controller.dispose() }
  })
})
