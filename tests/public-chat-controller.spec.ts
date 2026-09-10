import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PublicChatController } from '../src/client/public-chat-controller.js'
import { TeamDashboardController, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { PublicChatRpcError } from '../src/client/public-rpc-client.js'
import { goodFetch, ManualSchedule, waitFor } from './helpers/dashboard-controller.js'
import type { PublicChatAppendRequest, PublicChatHistoryRequest, PublicChatHistoryResponse, PublicChatMessage } from '../src/rpc/public-rpc-contract.js'

let base: TeamDashboardState
beforeAll(async () => {
  const controller = new TeamDashboardController(new SwarmReadClient(goodFetch([])), new ManualSchedule())
  controller.open('root-1'); await waitFor(() => controller.getSnapshot().phase === 'ready')
  base = controller.getSnapshot(); controller.dispose()
})
function dashboard(team = 'a', revision = 4, viewer = 'viewer'): TeamDashboardState {
  const data = base.data!
  return { ...base, targetSessionId: viewer, data: { ...data,
    teams: { ...data.teams, binding: { rootSessionId: viewer, mainSessionId: 'main' } },
    projection: { ...data.projection, binding: { rootSessionId: `captain-${team}`, teamId: team }, team: { ...data.projection.team, id: team, revision } },
  } }
}
function message(sequence: number, state: 'queued' | 'claimed' = 'queued'): PublicChatMessage {
  return { id: `message-${sequence}`, sequence, createdAt: 1000, text: `Text ${sequence}`, author: { kind: 'local-operator' }, delivery: state === 'queued' ? { state, recipientSessionId: 'captain-a' } : { state, recipientSessionId: 'captain-a', claimedAt: 2000 } }
}
function page(team = 'a', entries: readonly PublicChatMessage[] = [], more = false, revision = 4): PublicChatHistoryResponse {
  return { schemaVersion: 1, binding: { rootSessionId: `captain-${team}`, teamId: team }, teamRevision: revision, observedAt: 2000,
    entries, totalCount: entries.length, returnedCount: entries.length, limit: 50, hasEarlier: false, hasMore: more,
    appendEligibility: { state: 'available' }, limits: { maxTextBytes: 4096, maxMessages: 1000, maxBytes: 100000 },
    ...(entries[0] === undefined ? {} : { firstSequence: entries[0].sequence, lastSequence: entries.at(-1)!.sequence }),
  }
}
function fixture(requestId = () => 'original-id') {
  const storage = new Map<string, string>()
  const port = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const client = {
    history: vi.fn(async (request: PublicChatHistoryRequest) => page(request.target.teamId)),
    append: vi.fn(async (request: PublicChatAppendRequest) => ({ ...page(request.target.teamId), message: message(1), replayed: false })),
    requestResult: vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({ ...page(), state: 'not-found' as const })),
  }
  const controller = new PublicChatController(client, 'http://host:3094', port, requestId)
  return { controller, client, port, storage }
}
async function ready(controller: PublicChatController, state = dashboard()): Promise<void> {
  controller.bind(state); await waitFor(() => !controller.getSnapshot().loading)
}

describe('public conversation view owner', () => {
  it('restores an unknown operation after reload and retries not-found with its original ID and frozen viewer payload', async () => {
    const f = fixture(); await ready(f.controller)
    f.client.append.mockRejectedValueOnce(new Error('transport disconnected'))
    f.controller.edit('first'); await f.controller.send()
    const original = f.client.append.mock.calls[0]![0]
    expect(f.controller.getSnapshot().pending).toBe(true)
    f.controller.edit('new draft'); f.controller.dispose()
    const restored = new PublicChatController(f.client, 'http://host:3094', f.port, () => 'WRONG-NEW-ID')
    await ready(restored, dashboard('a', 4, 'different-viewer'))
    expect(restored.getSnapshot().draft.text).toBe('new draft')
    await restored.recover()
    expect(f.client.requestResult).toHaveBeenCalledWith({ schemaVersion: 1, target: original.target, requestId: 'original-id' }, expect.any(AbortSignal))
    expect(f.client.append.mock.calls[1]![0]).toEqual(original)
    expect(restored.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'new draft' } })
    restored.dispose()
  })
  it('clears only the submitted Team draft version after switching to another Team', async () => {
    const f = fixture(); await ready(f.controller)
    let resolve!: (value: Awaited<ReturnType<typeof f.client.append>>) => void
    f.client.append.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    f.controller.edit('Team A'); const sending = f.controller.send()
    await ready(f.controller, dashboard('b'))
    f.controller.edit('Team B')
    resolve({ ...page('a'), message: message(1), replayed: false }); await sending
    expect(f.controller.getSnapshot().draft.text).toBe('Team B')
    await ready(f.controller, dashboard('a'))
    expect(f.controller.getSnapshot().draft.text).toBe('')
    f.controller.dispose()
  })
  it.each(['committed', 'unknown'] as const)('settles a %s send after navigating to another viewer of the same Team', async outcome => {
    const f = fixture(); await ready(f.controller)
    let resolve!: (value: Awaited<ReturnType<typeof f.client.append>>) => void
    let reject!: (error: Error) => void
    f.client.append.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    f.controller.edit('submitted draft'); const sending = f.controller.send()
    await ready(f.controller, dashboard('a', 4, 'member-viewer'))
    f.controller.edit('new member-view draft')
    expect(f.controller.getSnapshot().sending).toBe(true)
    if (outcome === 'committed') resolve({ ...page(), message: message(1), replayed: false })
    else reject(new Error('response lost'))
    await sending
    expect(f.controller.getSnapshot()).toMatchObject({ sending: false, pending: outcome === 'unknown', draft: { text: 'new member-view draft' } })
    if (outcome === 'committed') expect(f.controller.getSnapshot().entries.map(entry => entry.id)).toContain('message-1')
    else expect(f.controller.getSnapshot().error).toBe('response lost')
    f.controller.dispose()
  })
  it('allows a shorter new message after a definite capacity rejection while retaining the rejected draft', async () => {
    let nextRequest = 0
    const f = fixture(() => `request-${++nextRequest}`); await ready(f.controller)
    f.client.append.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_CAPACITY', 'public byte capacity reached'))
    f.controller.edit('long draft'); await f.controller.send()
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, sending: false, draft: { text: 'long draft' }, error: 'public byte capacity reached' })
    f.controller.edit('short'); await f.controller.send()
    expect(f.client.append.mock.calls.map(([request]) => [request.requestId, request.text])).toEqual([['request-1', 'long draft'], ['request-2', 'short']])
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: '' } })
    f.controller.dispose()
  })
  it('retains the original request on a decoded unavailable result that may follow a commit', async () => {
    const f = fixture(); await ready(f.controller)
    f.client.append.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_UNAVAILABLE', 'unknown storage outcome'))
    f.controller.edit('original'); await f.controller.send()
    const original = f.client.append.mock.calls[0]![0]
    expect(f.controller.getSnapshot().pending).toBe(true)
    f.controller.edit('new draft'); await f.controller.send()
    expect(f.client.append).toHaveBeenCalledTimes(1)
    await f.controller.recover()
    expect(f.client.append.mock.calls[1]![0]).toEqual(original)
    expect(f.controller.getSnapshot().draft.text).toBe('new draft')
    f.controller.dispose()
  })
  it('isolates environments and fails closed while a different Team binding is loading', async () => {
    const f = fixture(); await ready(f.controller)
    f.controller.edit('private draft')
    const other = new PublicChatController(f.client, 'http://host:3093', f.port)
    await ready(other); expect(other.getSnapshot().draft.text).toBe('')
    f.controller.bind({ ...dashboard('b'), phase: 'reconnecting' })
    await f.controller.send()
    expect(f.controller.getSnapshot().selection).toBeUndefined()
    expect(f.client.append).not.toHaveBeenCalled()
    other.dispose(); f.controller.dispose()
  })
  it.each(['not-managed', 'not-active', 'lineage-unavailable'] as const)('obeys server append eligibility %s', async reason => {
    const f = fixture(); f.client.history.mockResolvedValue({ ...page(), appendEligibility: { state: 'unavailable', reason } })
    await ready(f.controller); f.controller.edit('text'); await f.controller.send()
    expect(f.client.append).not.toHaveBeenCalled(); f.controller.dispose()
  })
  it('rejects cross-Team responses and refreshes the delivery of an already visible old message', async () => {
    const f = fixture(); f.client.history.mockResolvedValueOnce(page('wrong'))
    await ready(f.controller)
    expect(f.controller.getSnapshot().history).toBeUndefined()
    expect(f.controller.getSnapshot().error).toMatch(/binding/)
    f.client.history.mockResolvedValue(page('a', [message(1)]))
    await f.controller.refresh()
    f.client.history.mockResolvedValue(page('a', [message(1, 'claimed')], false, 5))
    f.controller.bind(dashboard('a', 5)); await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.history.mock.calls.some(([request]) => request.afterSequence === 0)).toBe(true)
    expect(f.controller.getSnapshot().entries[0]?.delivery.state).toBe('claimed')
    f.controller.dispose()
  })
  it('loads one recent page, then advances from the last seen sequence without silently skipping a burst', async () => {
    const f = fixture()
    f.client.history.mockResolvedValueOnce({ ...page('a', [message(50)]), hasEarlier: true })
    await ready(f.controller)
    expect(f.client.history).toHaveBeenCalledTimes(1)
    f.client.history.mockImplementation(async request => request.afterSequence === 50 ? page('a', [message(51)], true, 5) : page('a', [message(50)], false, 5))
    f.controller.bind(dashboard('a', 5)); await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.history.mock.calls[1]![0]).toMatchObject({ afterSequence: 50 })
    expect(f.controller.getSnapshot().history?.hasMore).toBe(true)
    expect(f.controller.getSnapshot().entries.map(entry => entry.sequence)).toEqual([50, 51])
    f.controller.dispose()
  })
  it.each([6, 126])('keeps messages before append receipt %i reachable through history pages', async appendedSequence => {
    const f = fixture()
    let server = [message(1)]
    f.client.history.mockImplementation(async request => {
      const eligible = server.filter(row => (request.afterSequence === undefined || row.sequence > request.afterSequence)
        && (request.beforeSequence === undefined || row.sequence < request.beforeSequence))
      const limit = request.limit ?? 50
      const entries = request.afterSequence === undefined ? eligible.slice(-limit) : eligible.slice(0, limit)
      return { ...page('a', entries), totalCount: server.length, limit,
        hasEarlier: entries[0] !== undefined && entries[0].sequence > 1,
        hasMore: entries.at(-1) !== undefined && entries.at(-1)!.sequence < server.length }
    })
    await ready(f.controller)
    f.client.append.mockImplementationOnce(async () => {
      server = Array.from({ length: appendedSequence }, (_, index) => message(index + 1))
      return { ...page(), message: message(appendedSequence), replayed: false }
    })
    f.controller.edit('send after concurrent replies'); await f.controller.send()
    await f.controller.refresh()
    for (let pageIndex = 0; f.controller.getSnapshot().history?.hasMore && pageIndex < 4; pageIndex++) await f.controller.newer()
    expect(f.controller.getSnapshot().entries.map(entry => entry.sequence)).toEqual(server.map(entry => entry.sequence))
    expect(f.controller.getSnapshot().history?.hasMore).toBe(false)
    f.controller.dispose()
  })
  it('does not send without durable pending metadata or clear a changed draft on late commit', async () => {
    const f = fixture()
    const controller = new PublicChatController(f.client, 'host', { ...f.port, setItem: () => { throw new Error('quota') } })
    await ready(controller); controller.edit('x'); await controller.send()
    expect(f.client.append).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toMatch(/storage/)
    controller.dispose()
  })
})
