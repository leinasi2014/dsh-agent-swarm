import { expect, it, vi } from 'vitest'
import { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { captainMembers, goodFetch, ManualSchedule, requestOf, success, waitFor } from './helpers/dashboard-controller.js'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('dispatches independent read stages together and prevents a cancelled late round from publishing', async () => {
  const directory = deferred(), detail = deferred(), normal = goodFetch([])
  const seen: { method: string; signal: AbortSignal | null | undefined }[] = []
  let hold = true
  const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
    const request = requestOf(init)
    seen.push({ method: request.method, signal: init?.signal })
    if (hold) await (request.method === 'capabilities' || request.method === 'teams' ? directory.promise : detail.promise)
    return normal(input, init)
  }), new ManualSchedule())
  try {
    controller.open('root-1')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen.map(row => row.method)).toEqual(['capabilities', 'teams'])
    directory.release()
    await waitFor(() => seen.some(row => row.method === 'binding'))
    expect(seen.map(row => row.method).slice(2).toSorted()).toEqual(['binding', 'snapshot', 'captainAnnouncements', 'captainDiagnostics', 'captainMembers'].toSorted())
    const cancelled = seen.slice()
    hold = false
    controller.refresh()
    expect(cancelled.every(row => row.signal?.aborted)).toBe(true)
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const latest = controller.getSnapshot()
    const requests = seen.length
    detail.release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getSnapshot()).toBe(latest)
    expect(seen).toHaveLength(requests)
  } finally { directory.release(); detail.release(); controller.dispose() }
})

it.each([false, true])('reads both fresh member authorities concurrently before navigation (cancelled=%s)', async cancelled => {
  const gate = deferred(), normal = goodFetch([]), open = vi.fn(async () => {})
  const seen: { method: string; signal: AbortSignal | null | undefined }[] = []
  let handoff = false
  const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
    const request = requestOf(init)
    if (handoff) { seen.push({ method: request.method, signal: init?.signal }); await gate.promise }
    if (request.method === 'captainMembers') return success({ ...captainMembers, members: [{ ...captainMembers.members[0], sessionId: 'member-1' }] })
    return normal(input, init)
  }), new ManualSchedule())
  try {
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    handoff = true
    const navigation = controller.openMemberChat('worker', 'member-1', open).then(() => undefined, error => error)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen.map(row => row.method)).toEqual(['binding', 'captainMembers'])
    expect(open).not.toHaveBeenCalled()
    if (cancelled) { controller.close(); expect(seen.every(row => row.signal?.aborted)).toBe(true) }
    gate.release()
    const result = await navigation
    if (cancelled) { expect(result).toBeInstanceOf(Error); expect(open).not.toHaveBeenCalled() }
    else { expect(result).toBeUndefined(); expect(open).toHaveBeenCalledExactlyOnceWith('root-1', 'member-1', expect.any(AbortSignal)) }
  } finally { gate.release(); controller.dispose() }
})
