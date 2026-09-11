import { expect, it } from 'vitest'
import { waitFor } from './helpers/dashboard-controller.js'
import { dashboard, fixture, message, page, ready } from './helpers/public-chat-controller-fixture.js'

it('re-enters at the actual latest tail after over fifty new messages while retaining drafts and earlier paging', async () => {
  const f = await fixture()
  let total = 1
  f.client.historyV3.mockImplementation(async request => {
    const server = Array.from({ length: total }, (_, index) => message(index + 1))
    const eligible = server.filter(row => (request.afterSequence === undefined || row.sequence > request.afterSequence)
      && (request.beforeSequence === undefined || row.sequence < request.beforeSequence))
    const entries = request.afterSequence === undefined ? eligible.slice(-(request.limit ?? 50)) : eligible.slice(0, request.limit ?? 50)
    return { ...page('a', entries), totalCount: total, hasEarlier: entries[0]!.sequence > 1, hasMore: entries.at(-1)!.sequence < total }
  })
  try {
    await ready(f.controller)
    f.controller.edit('retained draft')
    total = 151
    f.client.historyV3.mockClear()
    await f.controller.latest()
    expect(f.client.historyV3).toHaveBeenCalledTimes(1)
    expect(f.client.historyV3.mock.calls[0]![0]).toEqual({ schemaVersion: 3, target: { rootSessionId: 'viewer', teamId: 'a' }, limit: 50 })
    expect(f.controller.getSnapshot().entries.map(row => row.sequence)).toEqual(Array.from({ length: 50 }, (_, index) => 102 + index))
    expect(f.controller.getSnapshot().history).toMatchObject({ hasEarlier: true, hasMore: false })
    expect(f.controller.getSnapshot().draft.text).toBe('retained draft')
    await f.controller.earlier()
    expect(f.client.historyV3.mock.lastCall![0]).toMatchObject({ beforeSequence: 102 })
    expect(f.controller.getSnapshot().entries[0]!.sequence).toBe(52)
    await f.controller.latest()
    expect(f.controller.getSnapshot().entries[0]!.sequence).toBe(102)
  } finally { f.controller.dispose() }
})

it('ignores a delayed previous Team tail after a new Team has been selected', async () => {
  const f = await fixture()
  let release!: (value: ReturnType<typeof page>) => void
  try {
    await ready(f.controller)
    f.client.historyV3.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const previous = f.controller.latest()
    await waitFor(() => release !== undefined)
    f.client.historyV3.mockResolvedValue(page('b', [message(200)]))
    await ready(f.controller, dashboard('b'))
    release(page('a', [message(150)]))
    await previous
    expect(f.controller.getSnapshot().selection?.team).toBe('b')
    expect(f.controller.getSnapshot().entries.map(row => row.sequence)).toEqual([200])
  } finally { f.controller.dispose() }
})

it('retains a pending entry tail when a same-Team revision refresh supersedes its first request', async () => {
  const f = await fixture()
  let release!: (value: ReturnType<typeof page>) => void
  try {
    f.client.historyV3.mockResolvedValue(page('a', [message(1)]))
    await ready(f.controller)
    f.client.historyV3.mockClear()
    f.client.historyV3.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.controller.latest()
    await waitFor(() => release !== undefined)
    f.client.historyV3.mockResolvedValue({ ...page('a', [message(151)], false, 5), hasEarlier: true })
    f.controller.bind(dashboard('a', 5))
    await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV3.mock.calls.every(([request]) => request.afterSequence === undefined && request.beforeSequence === undefined)).toBe(true)
    expect(f.controller.getSnapshot().entries.map(row => row.sequence)).toEqual([151])
    release(page('a', [message(100)]))
    await first
    expect(f.controller.getSnapshot().entries.map(row => row.sequence)).toEqual([151])
  } finally { f.controller.dispose() }
})
