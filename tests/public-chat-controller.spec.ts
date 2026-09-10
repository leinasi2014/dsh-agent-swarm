import { directoryEntry, directoryPage } from './helpers/public-directory.js'
import { mergePublicMessages } from '../src/client/public-v2-schema.js'
import type { DirectoryRequest } from '../src/rpc/directory-contract.js'
import type { PublicChatV2RequestResultResponse } from '../src/rpc/public-rpc-contract.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PublicChatController } from '../src/client/public-chat-controller.js'
import { TeamDashboardController, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { PublicChatRpcError } from '../src/client/public-rpc-client.js'
import { goodFetch, ManualSchedule, waitFor } from './helpers/dashboard-controller.js'
import type { PublicChatV2AppendRequest, PublicChatV2HistoryRequest, PublicChatV2HistoryResponse, PublicChatV2Message } from '../src/rpc/public-rpc-contract.js'

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
function message(sequence: number, state: 'queued' | 'claimed' = 'queued'): PublicChatV2Message {
  return { id: `message-${sequence}`, sequence, createdAt: 1000, text: `Text ${sequence}`, formatVersion: 2, content: [{ type: 'text', text: `Text ${sequence}` }], mentionLabels: [], author: { kind: 'local-operator' }, delivery: { kind: 'requested', recipients: [state === 'queued' ? { state, recipientSessionId: 'captain-a' } : { state, recipientSessionId: 'captain-a', claimedAt: 2000 }] } }
}
function page(team = 'a', entries: readonly PublicChatV2Message[] = [], more = false, revision = 4): PublicChatV2HistoryResponse {
  return { schemaVersion: 2, binding: { rootSessionId: `captain-${team}`, teamId: team }, teamRevision: revision, observedAt: 2000,
    entries, totalCount: entries.length, returnedCount: entries.length, limit: 50, hasEarlier: false, hasMore: more,
    appendEligibility: { state: 'available' }, limits: { maxSegments: 256, maxTextBytes: 4096, maxMessages: 1000, maxBytes: 100000 },
    ...(entries[0] === undefined ? {} : { firstSequence: entries[0].sequence, lastSequence: entries.at(-1)!.sequence }),
  }
}
function fixture(requestId = () => 'original-id') {
  const storage = new Map<string, string>()
  const port = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const client = {
    directory: vi.fn(async (request: DirectoryRequest) => directoryPage(request.target.teamId)),
    requestResult: vi.fn(async () => ({ schemaVersion: 1 as const, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 20, state: 'not-found' as const })),
    historyV2: vi.fn(async (request: PublicChatV2HistoryRequest) => page(request.target.teamId)),
    appendV2: vi.fn(async (request: PublicChatV2AppendRequest) => ({ ...page(request.target.teamId), message: message(1), replayed: false })),
    requestResultV2: vi.fn(async (_request: unknown, _signal?: AbortSignal): Promise<PublicChatV2RequestResultResponse> => ({ ...page(), state: 'not-found' as const })),
  }
  const controller = new PublicChatController(client, 'http://host:3094', port, requestId)
  return { controller, client, port, storage }
}
async function ready(controller: PublicChatController, state = dashboard()): Promise<void> {
  controller.bind(state); await waitFor(() => !controller.getSnapshot().loading)
}

describe('public conversation view owner', () => {
  it('retains the verified public view through an actual dashboard connection reset and re-proves it before requests resume', async () => {
    const schedule = new ManualSchedule()
    const normal = goodFetch([])
    const dashboardController = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
      const response = await normal(input, init)
      const request = JSON.parse(String(init?.body)) as { method: string }
      if (request.method !== 'teams') return response
      const envelope = await response.json()
      envelope.value.binding.mainSessionId = 'main'
      return new Response(JSON.stringify(envelope), { status: 200 })
    }), schedule)
    const f = fixture()
    f.client.historyV2.mockResolvedValue({ ...page('a', [message(1)]), binding: { rootSessionId: 'root-1', teamId: 'team-1' } })
    const disconnect = f.controller.connect(dashboardController)
    dashboardController.open('root-1')
    await waitFor(() => f.controller.getSnapshot().entries.length === 1)
    f.controller.edit('original')
    f.client.appendV2.mockRejectedValueOnce(new Error('response lost'))
    await f.controller.send()
    f.controller.edit('next draft')
    const before = f.controller.getSnapshot()
    dashboardController.connectionReset()
    expect(dashboardController.getSnapshot().phase).toBe('stale')
    expect(f.controller.getSnapshot()).toMatchObject({ selection: before.selection, entries: before.entries, pending: true, draft: { text: 'next draft' } })
    await f.controller.send(); await f.controller.recover(); await f.controller.refresh()
    expect(f.client.appendV2).toHaveBeenCalledTimes(1)
    expect(f.client.requestResultV2).not.toHaveBeenCalled()
    expect(f.client.historyV2).toHaveBeenCalledTimes(1)
    schedule.fire()
    expect(dashboardController.getSnapshot().phase).toBe('reconnecting')
    expect(f.controller.getSnapshot().entries).toEqual(before.entries)
    await waitFor(() => dashboardController.getSnapshot().phase === 'ready')
    await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV2).toHaveBeenCalledTimes(3)
    expect(f.controller.getSnapshot()).toMatchObject({ pending: true, draft: { text: 'next draft' } })
    disconnect(); dashboardController.dispose()
  })
  it('restores an unknown operation after reload and retries not-found with its original ID and frozen viewer payload', async () => {
    const f = fixture(); await ready(f.controller)
    f.client.appendV2.mockRejectedValueOnce(new Error('transport disconnected'))
    f.controller.edit('first'); await f.controller.send()
    const original = f.client.appendV2.mock.calls[0]![0]
    expect(f.controller.getSnapshot().pending).toBe(true)
    f.controller.edit('new draft'); f.controller.dispose()
    const restored = new PublicChatController(f.client, 'http://host:3094', f.port, () => 'WRONG-NEW-ID')
    await ready(restored, dashboard('a', 4, 'different-viewer'))
    expect(restored.getSnapshot().draft.text).toBe('new draft')
    await restored.recover()
    expect(f.client.requestResultV2).toHaveBeenCalledWith({ schemaVersion: 2, target: original.target, requestId: 'original-id' }, expect.any(AbortSignal))
    expect(f.client.appendV2.mock.calls[1]![0]).toEqual(original)
    expect(restored.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'new draft' } })
    restored.dispose()
  })
  it('clears only the submitted Team draft version after switching to another Team', async () => {
    const f = fixture(); await ready(f.controller)
    let resolve!: (value: Awaited<ReturnType<typeof f.client.appendV2>>) => void
    f.client.appendV2.mockImplementationOnce(() => new Promise(done => { resolve = done }))
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
    let resolve!: (value: Awaited<ReturnType<typeof f.client.appendV2>>) => void
    let reject!: (error: Error) => void
    f.client.appendV2.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
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
    f.client.appendV2.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_CAPACITY', 'public byte capacity reached'))
    f.controller.edit('long draft'); await f.controller.send()
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, sending: false, draft: { text: 'long draft' }, error: 'public byte capacity reached' })
    f.controller.edit('short'); await f.controller.send()
    expect(f.client.appendV2.mock.calls.map(([request]) => [request.requestId, request.content])).toEqual([['request-1', [{ type: 'text', text: 'long draft' }]], ['request-2', [{ type: 'text', text: 'short' }]]])
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: '' } })
    f.controller.dispose()
  })
  it('retains the original request on a decoded unavailable result that may follow a commit', async () => {
    const f = fixture(); await ready(f.controller)
    f.client.appendV2.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_UNAVAILABLE', 'unknown storage outcome'))
    f.controller.edit('original'); await f.controller.send()
    const original = f.client.appendV2.mock.calls[0]![0]
    expect(f.controller.getSnapshot().pending).toBe(true)
    f.controller.edit('new draft'); await f.controller.send()
    expect(f.client.appendV2).toHaveBeenCalledTimes(1)
    await f.controller.recover()
    expect(f.client.appendV2.mock.calls[1]![0]).toEqual(original)
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
    expect(f.client.appendV2).not.toHaveBeenCalled()
    other.dispose(); f.controller.dispose()
  })
  it.each(['not-managed', 'not-active', 'lineage-unavailable'] as const)('obeys server append eligibility %s', async reason => {
    const f = fixture(); f.client.historyV2.mockResolvedValue({ ...page(), appendEligibility: { state: 'unavailable', reason } })
    await ready(f.controller); f.controller.edit('text'); await f.controller.send()
    expect(f.client.appendV2).not.toHaveBeenCalled(); f.controller.dispose()
  })
  it('rejects cross-Team responses and refreshes the delivery of an already visible old message', async () => {
    const f = fixture(); f.client.historyV2.mockResolvedValueOnce(page('wrong'))
    await ready(f.controller)
    expect(f.controller.getSnapshot().history).toBeUndefined()
    expect(f.controller.getSnapshot().error).toMatch(/binding/)
    f.client.historyV2.mockResolvedValue(page('a', [message(1)]))
    await f.controller.refresh()
    f.client.historyV2.mockResolvedValue(page('a', [message(1, 'claimed')], false, 5))
    f.controller.bind(dashboard('a', 5)); await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV2.mock.calls.some(([request]) => request.afterSequence === 0)).toBe(true)
    expect(f.controller.getSnapshot().entries[0]?.delivery).toMatchObject({ kind: 'requested', recipients: [{ state: 'claimed' }] })
    f.controller.dispose()
  })
  it('loads one recent page, then advances from the last seen sequence without silently skipping a burst', async () => {
    const f = fixture()
    f.client.historyV2.mockResolvedValueOnce({ ...page('a', [message(50)]), hasEarlier: true })
    await ready(f.controller)
    expect(f.client.historyV2).toHaveBeenCalledTimes(1)
    f.client.historyV2.mockImplementation(async request => request.afterSequence === 50 ? page('a', [message(51)], true, 5) : page('a', [message(50)], false, 5))
    f.controller.bind(dashboard('a', 5)); await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV2.mock.calls[1]![0]).toMatchObject({ afterSequence: 50 })
    expect(f.controller.getSnapshot().history?.hasMore).toBe(true)
    expect(f.controller.getSnapshot().entries.map(entry => entry.sequence)).toEqual([50, 51])
    f.controller.dispose()
  })
  it.each([6, 126])('keeps messages before append receipt %i reachable through history pages', async appendedSequence => {
    const f = fixture()
    let server = [message(1)]
    f.client.historyV2.mockImplementation(async request => {
      const eligible = server.filter(row => (request.afterSequence === undefined || row.sequence > request.afterSequence)
        && (request.beforeSequence === undefined || row.sequence < request.beforeSequence))
      const limit = request.limit ?? 50
      const entries = request.afterSequence === undefined ? eligible.slice(-limit) : eligible.slice(0, limit)
      return { ...page('a', entries), totalCount: server.length, limit,
        hasEarlier: entries[0] !== undefined && entries[0].sequence > 1,
        hasMore: entries.at(-1) !== undefined && entries.at(-1)!.sequence < server.length }
    })
    await ready(f.controller)
    f.client.appendV2.mockImplementationOnce(async () => {
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
    expect(f.client.appendV2).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toMatch(/storage/)
    controller.dispose()
  })
})

it('blocks unconfirmed Chinese-adjacent mention text instead of dispatching to Captain', async () => {
  const f = fixture(); await ready(f.controller)
  f.controller.edit('请@同舟 核对这条文字。'); await f.controller.send()
  expect(f.client.appendV2).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().draft.text).toBe('请@同舟 核对这条文字。')
  f.controller.dispose()
})
it('submits new public text with structured v2 content', async () => {
  const f = fixture(); await ready(f.controller)
  f.controller.edit('new public text'); await f.controller.send()
  expect(f.client.appendV2.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 2, content: [{ type: 'text', text: 'new public text' }] })
  f.controller.dispose()
})

it('retains the actual legacy draft key as unconfirmed text', async () => {
  const f = fixture(), key = 'swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a'])
  f.storage.set(key, JSON.stringify({ draft: { text: '请@同舟 核对这条文字。', version: 3 } }))
  await ready(f.controller); await f.controller.send()
  expect(f.controller.getSnapshot().draft).toMatchObject({ text: '请@同舟 核对这条文字。', tokens: [] })
  expect(f.client.appendV2).not.toHaveBeenCalled(); f.controller.dispose()
})
it('binds multiple same-name tokens to exact IDs and freezes their request through rename/reload', async () => {
  const f = fixture(); await ready(f.controller)
  f.controller.edit('请@同舟'); f.controller.chooseMention(1, 4, 'member-a')
  f.controller.edit(f.controller.getSnapshot().draft.text + ' 和@同舟'); f.controller.chooseMention(6, 9, 'member-b')
  f.client.appendV2.mockRejectedValueOnce(new Error('lost'))
  await f.controller.send()
  const original = f.client.appendV2.mock.calls[0]![0]
  expect(original.content).toEqual([{ type: 'text', text: '请' }, { type: 'mention', memberId: 'member-a' }, { type: 'text', text: ' 和' }, { type: 'mention', memberId: 'member-b' }])
  f.client.directory.mockResolvedValue(directoryPage('a', [directoryEntry('member-a', '改名'), directoryEntry('member-b')], 'v2'))
  await f.controller.refreshDirectory(); await f.controller.recover()
  expect(f.client.appendV2.mock.calls[1]![0]).toEqual(original); f.controller.dispose()
})
it('does not silently replace a removed selected identity with a same-name member', async () => {
  const f = fixture(); await ready(f.controller)
  f.controller.edit('@同舟'); f.controller.chooseMention(0, 3, 'member-a')
  f.client.directory.mockResolvedValue(directoryPage('a', [directoryEntry('member-b')], 'v2')); await f.controller.refreshDirectory()
  await f.controller.send(); expect(f.client.appendV2).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().draft.tokens[0]?.memberId).toBe('member-a'); f.controller.dispose()
})
it('re-reads capability changes on Dashboard refresh even at unchanged Team revision', async () => {
  const f = fixture(); await ready(f.controller)
  f.client.directory.mockResolvedValue(directoryPage('a', [{ ...directoryEntry(), model: { ...directoryEntry().model, model: 'new-model', imageInput: 'supported' } }], 'model-v2'))
  f.controller.bind(dashboard()); await waitFor(() => f.controller.getSnapshot().directory?.directoryRevision === 'model-v2')
  expect(f.controller.getSnapshot().directory?.entries[0]?.model.imageInput).toBe('supported'); f.controller.dispose()
})
it('discards mixed directory pages and restarts from page zero once', async () => {
  const f = fixture(); const a = directoryPage('a', [directoryEntry()]), b = directoryPage('a', [directoryEntry('member-b')], 'new-generation')
  f.client.directory.mockResolvedValueOnce({ ...a, page: { ...a.page, totalCount: 2, hasMore: true, nextCursor: 'old-cursor', unreadRanges: [{ offset: 1, count: 1 }] } })
    .mockResolvedValueOnce({ ...b, page: { ...b.page, offset: 1, totalCount: 2 } }).mockResolvedValueOnce(b)
  await ready(f.controller); await waitFor(() => !f.controller.getSnapshot().directoryLoading)
  expect(f.client.directory.mock.calls.map(([request]) => request.cursor)).toEqual([undefined, 'old-cursor', undefined])
  expect(f.controller.getSnapshot().directory?.entries.map(row => row.memberId)).toEqual(['member-b']); f.controller.dispose()
})
it('merges settlement separately for every recipient and never downgrades to queued', () => {
  const initialMessage = message(1), old = { ...initialMessage, delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'a', state: 'claimed' as const, claimedAt: 2 }, { recipientSessionId: 'b', state: 'queued' as const }] } }
  const incoming = { ...initialMessage, delivery: { kind: 'requested' as const, recipients: [{ recipientSessionId: 'a', state: 'queued' as const }, { recipientSessionId: 'b', state: 'not-delivered' as const, settledAt: 3, reason: 'recipient-removed' as const }] } }
  const merged = mergePublicMessages([old], [incoming])
  expect(mergePublicMessages(merged, [old])[0]?.delivery).toEqual({ kind: 'requested', recipients: [old.delivery.recipients[0], incoming.delivery.recipients[1]] })
})
function storeLegacy(f: ReturnType<typeof fixture>): void {
  f.storage.set('swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a']), JSON.stringify({ draft: { text: 'legacy draft', version: 5 }, pending: { captain: 'captain-a', version: 5, request: { schemaVersion: 1, target: { rootSessionId: 'original-viewer', teamId: 'a' }, requestId: 'legacy-id', text: 'legacy draft' } } }))
}
it('requires explicit legacy upgrade and preserves the same ID/target through lost responses', async () => {
  const f = fixture(() => 'WRONG-NEW-ID'); storeLegacy(f); await ready(f.controller)
  await f.controller.recover(); expect(f.controller.getSnapshot().legacyUpgrade).toBe(true); expect(f.client.appendV2).not.toHaveBeenCalled()
  f.controller.edit('upgraded content'); f.client.appendV2.mockRejectedValueOnce(new Error('lost'))
  await f.controller.upgradeLegacy()
  expect(f.client.appendV2.mock.calls[0]?.[0]).toMatchObject({ requestId: 'legacy-id', target: { rootSessionId: 'original-viewer', teamId: 'a' }, content: [{ type: 'text', text: 'upgraded content' }] })
  await f.controller.recover(); expect(f.client.appendV2.mock.calls[1]?.[0]).toEqual(f.client.appendV2.mock.calls[0]?.[0]); f.controller.dispose()
})
it('reads a late legacy commit without clearing the explicitly upgraded draft or appending twice', async () => {
  const f = fixture(); storeLegacy(f); await ready(f.controller); await f.controller.recover(); f.controller.edit('upgraded content')
  f.client.requestResultV2.mockResolvedValue({ ...page(), state: 'committed', message: { ...message(1), formatVersion: 1 } })
  await f.controller.upgradeLegacy(); expect(f.client.appendV2).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'upgraded content' }, entries: [{ formatVersion: 1 }] }); f.controller.dispose()
})
it('handles a late v1 commit discovered by conflict after the v2 preflight read', async () => {
  const f = fixture(); storeLegacy(f); await ready(f.controller); await f.controller.recover(); f.controller.edit('upgraded content')
  f.client.requestResultV2.mockResolvedValueOnce({ ...page(), state: 'not-found' }).mockResolvedValueOnce({ ...page(), state: 'committed', message: { ...message(1), formatVersion: 1 } })
  f.client.appendV2.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_REQUEST_CONFLICT', 'old request won'))
  await f.controller.upgradeLegacy(); expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'upgraded content' } }); f.controller.dispose()
})

it('retains an unknown operation on a decoded requestResult read rejection', async () => {
  const f = fixture(); await ready(f.controller); f.controller.edit('original')
  f.client.appendV2.mockRejectedValueOnce(new Error('response lost')); await f.controller.send()
  f.client.requestResultV2.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_INVALID_REQUEST', 'query rejected'))
  await f.controller.recover(); expect(f.controller.getSnapshot().pending).toBe(true)
  f.controller.edit('new draft'); await f.controller.send(); expect(f.client.appendV2).toHaveBeenCalledTimes(1)
  await f.controller.recover(); expect(f.client.appendV2.mock.calls[1]?.[0]).toEqual(f.client.appendV2.mock.calls[0]?.[0]); f.controller.dispose()
})
it('retains a legacy request identity on read rejection, and on definite upgraded append rejection', async () => {
  const f = fixture(); storeLegacy(f); await ready(f.controller)
  f.client.requestResult.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_INVALID_REQUEST', 'read rejected'))
  await f.controller.recover(); expect(f.controller.getSnapshot()).toMatchObject({ pending: true, legacyUpgrade: false })
  await f.controller.recover(); f.controller.edit('reviewed upgrade')
  f.client.appendV2.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_CAPACITY', 'capacity rejected'))
  await f.controller.upgradeLegacy(); expect(f.controller.getSnapshot()).toMatchObject({ pending: true, legacyUpgrade: true })
  f.controller.edit('short'); await f.controller.upgradeLegacy()
  expect(f.client.appendV2.mock.calls.map(([request]) => request.requestId)).toEqual(['legacy-id', 'legacy-id']); f.controller.dispose()
})
