import { directoryEntry, directoryPage } from './helpers/public-directory.js'
import { mergePublicMessages } from '../src/client/public-v2-schema.js'
import type { DirectoryRequest } from '../src/rpc/directory-contract.js'
import type { PublicChatV3RequestResultResponse, PublicChatRequestResultResponse } from '../src/rpc/public-rpc-contract.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { browserDraftStore } from './helpers/public-draft-browser.js'
import { PublicChatController } from '../src/client/public-chat-controller.js'
import { TeamDashboardController, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { PublicChatRpcError } from '../src/client/public-rpc-client.js'
import { goodFetch, ManualSchedule, waitFor } from './helpers/dashboard-controller.js'
import type { PublicChatV3AppendRequest, PublicChatV3HistoryRequest, PublicChatV3HistoryResponse, PublicChatV3Message } from '../src/rpc/public-rpc-contract.js'

let base: TeamDashboardState
let browser: Browser, draftContext: BrowserContext
beforeAll(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true }); draftContext = await browser.newContext()
  const controller = new TeamDashboardController(new SwarmReadClient(goodFetch([])), new ManualSchedule())
  controller.open('root-1'); await waitFor(() => controller.getSnapshot().phase === 'ready')
  base = controller.getSnapshot(); controller.dispose()
}, 30_000)
afterAll(async () => { await browser?.close() }, 30_000)
function dashboard(team = 'a', revision = 4, viewer = 'viewer'): TeamDashboardState {
  const data = base.data!
  return { ...base, targetSessionId: viewer, data: { ...data,
    teams: { ...data.teams, binding: { rootSessionId: viewer, mainSessionId: 'main' } },
    projection: { ...data.projection, binding: { rootSessionId: `captain-${team}`, teamId: team }, team: { ...data.projection.team, id: team, revision } },
  } }
}
function message(sequence: number, state: 'queued' | 'claimed' = 'queued'): PublicChatV3Message {
  return { id: `message-${sequence}`, sequence, createdAt: 1000, text: `Text ${sequence}`, formatVersion: 2, content: [{ type: 'text', text: `Text ${sequence}` }], mentionLabels: [], author: { kind: 'local-operator' }, delivery: { kind: 'requested', recipients: [state === 'queued' ? { state, recipientSessionId: 'captain-a' } : { state, recipientSessionId: 'captain-a', claimedAt: 2000 }] } }
}
function page(team = 'a', entries: readonly PublicChatV3Message[] = [], more = false, revision = 4): PublicChatV3HistoryResponse {
  return { schemaVersion: 3, binding: { rootSessionId: `captain-${team}`, teamId: team }, teamRevision: revision, observedAt: 2000,
    entries, totalCount: entries.length, returnedCount: entries.length, limit: 50, hasEarlier: false, hasMore: more,
    appendEligibility: { state: 'available' }, imageAvailability: { state: 'available', imageLimits: { maxImageBytes: 20_971_520, maxImagesPerMessage: 20, maxMessageImageBytes: 209_715_200, maxImagePixels: 64_000_000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } }, limits: { maxSegments: 256, maxTextBytes: 4096, maxMessages: 1000, maxBytes: 100000 },
    ...(entries[0] === undefined ? {} : { firstSequence: entries[0].sequence, lastSequence: entries.at(-1)!.sequence }),
  }
}
async function fixture(requestId = () => 'original-id') {
  const databaseName = crypto.randomUUID(), drafts = () => browserDraftStore(draftContext, databaseName)
  const storage = new Map<string, string>()
  const port = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const client = {
    directory: vi.fn(async (request: DirectoryRequest, _signal?: AbortSignal) => directoryPage(request.target.teamId)),
    requestResult: vi.fn(async (): Promise<PublicChatRequestResultResponse> => ({ schemaVersion: 1 as const, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 20, state: 'not-found' as const })),
    historyV3: vi.fn(async (request: PublicChatV3HistoryRequest) => page(request.target.teamId)),
    appendV3: vi.fn(async (request: PublicChatV3AppendRequest) => ({ ...page(request.target.teamId), message: message(1), replayed: false })),
    requestResultV3: vi.fn(async (_request: unknown, _signal?: AbortSignal): Promise<PublicChatV3RequestResultResponse> => ({ ...page(), state: 'not-found' as const })),
    requestResultV2: vi.fn(async (): Promise<import('../src/rpc/public-rpc-contract.js').PublicChatV2RequestResultResponse> => ({ schemaVersion: 2, binding: page().binding, teamRevision: 4, observedAt: 20, state: 'not-found' })),
    appendV2: vi.fn(async (): Promise<import('../src/rpc/public-rpc-contract.js').PublicChatV2AppendResponse> => ({ schemaVersion: 2, binding: page().binding, teamRevision: 4, observedAt: 20, replayed: false, message: { ...message(1), formatVersion: 2, content: [{ type: 'text', text: 'legacy v2' }], author: { kind: 'local-operator' }, delivery: { kind: 'not-requested' } } })),
    image: vi.fn(async (): Promise<import('../src/rpc/public-rpc-contract.js').PublicChatV3ImageResponse> => ({ ...page(), messageId: 'message-1', imageId: 'image-1', image: { mediaType: 'image/png', data: 'YWJj', bytes: 3, width: 1, height: 1 } })),
  }
  const controller = new PublicChatController(client, 'http://host:3094', port, requestId, await drafts(), async (_blob, image) => ({ ...image, status: 'ready', width: 1, height: 1 }))
  return { controller, client, port, storage, drafts }
}
async function ready(controller: PublicChatController, state = dashboard()): Promise<void> {
  controller.bind(state); await vi.waitFor(() => { expect(controller.getSnapshot().loading).toBe(false); expect(controller.getSnapshot().draftStatus).not.toBe('loading') }, { timeout: 5000 })
}

describe('public conversation view owner', () => {
  it('keeps the Team directory and history visible across member navigation while fencing the unverified viewer', async () => {
    const f = await fixture()
    f.client.historyV3.mockResolvedValue(page('a', [message(1)]))
    const beforeDashboard = dashboard()
    const data = beforeDashboard.data!
    const source = { ...beforeDashboard, data: { ...data, captainMembers: { ...data.captainMembers,
      members: [{ ...data.captainMembers.members[0]!, name: 'member-a', sessionId: 'member-viewer', phase: 'active' as const }],
    } } }
    await ready(f.controller, source)
    await waitFor(() => f.controller.getSnapshot().directory !== undefined)
    f.controller.edit('keep my draft')
    const before = f.controller.getSnapshot()
    f.client.historyV3.mockClear(); f.client.directory.mockClear()
    // Dashboard keeps the previous verified Team projection during its fresh
    // member-addressed read. That projection must not authorize the new viewer.
    f.controller.bind({ ...source, targetSessionId: 'member-viewer' })
    expect(f.controller.getSnapshot().directory).toBe(before.directory)
    expect(f.controller.getSnapshot().entries).toBe(before.entries)
    expect(f.controller.getSnapshot().draft.text).toBe('keep my draft')
    for (const phase of ['stale', 'reconnecting'] as const) {
      f.controller.bind({ ...source, phase, targetSessionId: 'member-viewer' })
      expect(f.controller.getSnapshot().directory).toBe(before.directory)
      expect(f.controller.getSnapshot().entries).toBe(before.entries)
    }
    await f.controller.send(); await f.controller.refresh(); await f.controller.refreshDirectory()
    expect(f.client.appendV3).not.toHaveBeenCalled()
    expect(f.client.directory).not.toHaveBeenCalled()
    expect(f.client.historyV3).not.toHaveBeenCalled()
    let release!: (value: ReturnType<typeof directoryPage>) => void
    f.client.directory.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    f.controller.bind(dashboard('a', 4, 'member-viewer'))
    expect(f.controller.getSnapshot().selection?.viewer).toBe('member-viewer')
    expect(f.controller.getSnapshot().directory).toBe(before.directory)
    expect(f.controller.getSnapshot().entries).toBe(before.entries)
    await waitFor(() => release !== undefined)
    release(directoryPage('a', [directoryEntry('member-b')], 'fresh-member-view'))
    await waitFor(() => f.controller.getSnapshot().directory?.directoryRevision === 'fresh-member-view')
    expect(f.client.directory.mock.calls[0]?.[0].target.rootSessionId).toBe('member-viewer')
    const other = dashboard('b')
    f.controller.bind({ ...other, phase: 'reconnecting', pendingTeamId: 'b' })
    expect(f.controller.getSnapshot().directory).toBeUndefined()
    expect(f.controller.getSnapshot().entries).toEqual([])
    f.controller.dispose()
  })
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
    const f = await fixture()
    f.client.historyV3.mockResolvedValue({ ...page('a', [message(1)]), binding: { rootSessionId: 'root-1', teamId: 'team-1' } })
    const disconnect = f.controller.connect(dashboardController)
    dashboardController.open('root-1')
    await vi.waitFor(() => { expect(f.controller.getSnapshot().entries).toHaveLength(1); expect(f.controller.getSnapshot().draftStatus).toBe('ready') })
    f.controller.edit('original')
    f.client.appendV3.mockRejectedValueOnce(new Error('response lost'))
    await f.controller.send()
    f.controller.edit('next draft')
    const before = f.controller.getSnapshot()
    dashboardController.connectionReset()
    expect(dashboardController.getSnapshot().phase).toBe('stale')
    expect(f.controller.getSnapshot()).toMatchObject({ selection: before.selection, entries: before.entries, pending: true, draft: { text: 'next draft' } })
    await f.controller.send(); await f.controller.recover(); await f.controller.refresh()
    expect(f.client.appendV3).toHaveBeenCalledTimes(1)
    expect(f.client.requestResultV3).not.toHaveBeenCalled()
    expect(f.client.historyV3).toHaveBeenCalledTimes(1)
    schedule.fire()
    expect(dashboardController.getSnapshot().phase).toBe('reconnecting')
    expect(f.controller.getSnapshot().entries).toEqual(before.entries)
    await waitFor(() => dashboardController.getSnapshot().phase === 'ready')
    await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV3).toHaveBeenCalledTimes(3)
    expect(f.controller.getSnapshot()).toMatchObject({ pending: true, draft: { text: 'next draft' } })
    disconnect(); dashboardController.dispose()
  })
  it('restores an unknown operation after reload and retries not-found with its original ID and frozen viewer payload', async () => {
    const f = await fixture(); await ready(f.controller)
    f.client.appendV3.mockRejectedValueOnce(new Error('transport disconnected'))
    f.controller.edit('first'); await f.controller.send()
    const original = f.client.appendV3.mock.calls[0]![0]
    expect(f.controller.getSnapshot().pending).toBe(true)
    f.controller.edit('new draft'); f.controller.dispose()
    const restored = new PublicChatController(f.client, 'http://host:3094', f.port, () => 'WRONG-NEW-ID', (await f.drafts()))
    await ready(restored, dashboard('a', 4, 'different-viewer'))
    expect(restored.getSnapshot().draft.text).toBe('new draft')
    await restored.recover()
    expect(f.client.requestResultV3).toHaveBeenCalledWith({ schemaVersion: 3, target: original.target, requestId: 'original-id' }, expect.any(AbortSignal))
    expect(f.client.appendV3.mock.calls[1]![0]).toEqual(original)
    expect(restored.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'new draft' } })
    restored.dispose()
  })
  it('clears only the submitted Team draft version after switching to another Team', async () => {
    const f = await fixture(); await ready(f.controller)
    let resolve!: (value: Awaited<ReturnType<typeof f.client.appendV3>>) => void
    f.client.appendV3.mockImplementationOnce(() => new Promise(done => { resolve = done }))
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
    const f = await fixture(); await ready(f.controller)
    let resolve!: (value: Awaited<ReturnType<typeof f.client.appendV3>>) => void
    let reject!: (error: Error) => void
    f.client.appendV3.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
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
    const f = await fixture(() => `request-${++nextRequest}`); await ready(f.controller)
    f.client.appendV3.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_CAPACITY', 'public byte capacity reached'))
    f.controller.edit('long draft'); await f.controller.send()
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, sending: false, draft: { text: 'long draft' }, error: 'public byte capacity reached' })
    f.controller.edit('short'); await f.controller.send()
    expect(f.client.appendV3.mock.calls.map(([request]) => [request.requestId, request.content])).toEqual([['request-1', [{ type: 'text', text: 'long draft' }]], ['request-2', [{ type: 'text', text: 'short' }]]])
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: '' } })
    f.controller.dispose()
  })
  it('retains the original request on a decoded unavailable result that may follow a commit', async () => {
    const f = await fixture(); await ready(f.controller)
    f.client.appendV3.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_UNAVAILABLE', 'unknown storage outcome'))
    f.controller.edit('original'); await f.controller.send()
    const original = f.client.appendV3.mock.calls[0]![0]
    expect(f.controller.getSnapshot().pending).toBe(true)
    f.controller.edit('new draft'); await f.controller.send()
    expect(f.client.appendV3).toHaveBeenCalledTimes(1)
    await f.controller.recover()
    expect(f.client.appendV3.mock.calls[1]![0]).toEqual(original)
    expect(f.controller.getSnapshot().draft.text).toBe('new draft')
    f.controller.dispose()
  })
  it('isolates environments and fails closed while a different Team binding is loading', async () => {
    const f = await fixture(); await ready(f.controller)
    f.controller.edit('private draft')
    const other = new PublicChatController(f.client, 'http://host:3093', f.port, undefined, (await f.drafts()))
    await ready(other); expect(other.getSnapshot().draft.text).toBe('')
    f.controller.bind({ ...dashboard('b'), phase: 'reconnecting' })
    await f.controller.send()
    expect(f.controller.getSnapshot().selection).toBeUndefined()
    expect(f.client.appendV3).not.toHaveBeenCalled()
    other.dispose(); f.controller.dispose()
  })
  it.each(['not-managed', 'not-active', 'lineage-unavailable'] as const)('obeys server append eligibility %s', async reason => {
    const f = await fixture(); f.client.historyV3.mockResolvedValue({ ...page(), appendEligibility: { state: 'unavailable', reason } })
    await ready(f.controller); f.controller.edit('text'); await f.controller.send()
    expect(f.client.appendV3).not.toHaveBeenCalled(); f.controller.dispose()
  })
  it('rejects cross-Team responses and refreshes the delivery of an already visible old message', async () => {
    const f = await fixture(); f.client.historyV3.mockResolvedValueOnce(page('wrong'))
    await ready(f.controller)
    expect(f.controller.getSnapshot().history).toBeUndefined()
    expect(f.controller.getSnapshot().error).toMatch(/binding/)
    f.client.historyV3.mockResolvedValue(page('a', [message(1)]))
    await f.controller.refresh()
    f.client.historyV3.mockResolvedValue(page('a', [message(1, 'claimed')], false, 5))
    f.controller.bind(dashboard('a', 5)); await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV3.mock.calls.some(([request]) => request.afterSequence === 0)).toBe(true)
    expect(f.controller.getSnapshot().entries[0]?.delivery).toMatchObject({ kind: 'requested', recipients: [{ state: 'claimed' }] })
    f.controller.dispose()
  })
  it('loads one recent page, then advances from the last seen sequence without silently skipping a burst', async () => {
    const f = await fixture()
    f.client.historyV3.mockResolvedValueOnce({ ...page('a', [message(50)]), hasEarlier: true })
    await ready(f.controller)
    expect(f.client.historyV3).toHaveBeenCalledTimes(1)
    f.client.historyV3.mockImplementation(async request => request.afterSequence === 50 ? page('a', [message(51)], true, 5) : page('a', [message(50)], false, 5))
    f.controller.bind(dashboard('a', 5)); await waitFor(() => !f.controller.getSnapshot().loading)
    expect(f.client.historyV3.mock.calls[1]![0]).toMatchObject({ afterSequence: 50 })
    expect(f.controller.getSnapshot().history?.hasMore).toBe(true)
    expect(f.controller.getSnapshot().entries.map(entry => entry.sequence)).toEqual([50, 51])
    f.controller.dispose()
  })
  it.each([6, 126])('keeps messages before append receipt %i reachable through history pages', async appendedSequence => {
    const f = await fixture()
    let server = [message(1)]
    f.client.historyV3.mockImplementation(async request => {
      const eligible = server.filter(row => (request.afterSequence === undefined || row.sequence > request.afterSequence)
        && (request.beforeSequence === undefined || row.sequence < request.beforeSequence))
      const limit = request.limit ?? 50
      const entries = request.afterSequence === undefined ? eligible.slice(-limit) : eligible.slice(0, limit)
      return { ...page('a', entries), totalCount: server.length, limit,
        hasEarlier: entries[0] !== undefined && entries[0].sequence > 1,
        hasMore: entries.at(-1) !== undefined && entries.at(-1)!.sequence < server.length }
    })
    await ready(f.controller)
    f.client.appendV3.mockImplementationOnce(async () => {
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
    const f = await fixture()
    const controller = new PublicChatController(f.client, 'host', f.port, undefined, { ...(await f.drafts()), freeze: async () => { throw new Error('quota') } })
    await ready(controller); controller.edit('x'); await controller.send()
    expect(f.client.appendV3).not.toHaveBeenCalled()
    expect(controller.getSnapshot().draftStatus).toBe('unavailable')
    controller.dispose()
  })
})

it('blocks unconfirmed Chinese-adjacent mention text instead of dispatching to Captain', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.edit('请@同舟 核对这条文字。'); await f.controller.send()
  expect(f.client.appendV3).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().draft.text).toBe('请@同舟 核对这条文字。')
  f.controller.dispose()
})
it('submits new public text with structured v3 content', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.edit('new public text'); await f.controller.send()
  expect(f.client.appendV3.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 3, content: [{ type: 'text', text: 'new public text' }] })
  f.controller.dispose()
})

it('freezes pure and mixed image bytes with mentions and reply, then recovers the same request after reload', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.addImages([new File(['first image'], '一.png', { type: 'image/png' }), new File(['second image'], '二.png', { type: 'image/png' })])
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draft.images?.every(image => image.status === 'ready')).toBe(true); expect(f.controller.getSnapshot().draftStatus).toBe('ready') })
  f.controller.edit('@同舟'); f.controller.chooseMention(0, 3, 'member-a'); f.controller.reply('source-message')
  f.client.appendV3.mockRejectedValueOnce(new Error('ACK lost'))
  await f.controller.send()
  const original = f.client.appendV3.mock.calls[0]![0], imageIds = f.controller.getSnapshot().draft.images!.map(image => image.blobId)
  expect(original).toMatchObject({ schemaVersion: 3, replyTo: 'source-message', content: [{ type: 'mention', memberId: 'member-a' }, { type: 'image', data: btoa('first image'), name: '一.png' }, { type: 'image', data: btoa('second image'), name: '二.png' }] })
  f.controller.edit('new draft'); f.controller.reply('new-reply'); imageIds.forEach(id => f.controller.removeImage(id))
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draftStatus).toBe('ready') })
  f.controller.dispose()
  const restored = new PublicChatController(f.client, 'http://host:3094', f.port, () => 'wrong-id', (await f.drafts()))
  await ready(restored, dashboard('a', 4, 'different-viewer'))
  expect(restored.getSnapshot()).toMatchObject({ pending: true, draft: { text: 'new draft', replyTo: 'new-reply', images: [] } })
  expect(await restored.getSnapshot().draftBlobs[imageIds[0]!]!.text()).toBe('first image')
  await restored.recover()
  expect(f.client.appendV3.mock.calls[1]![0]).toEqual(original)
  expect(restored.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'new draft', replyTo: 'new-reply' }, draftBlobs: {} })
  restored.dispose()
})

it.each(['TEAM_PUBLIC_IMAGE_INVALID', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE'])('releases only the exact pending on definite append rejection %s while keeping the full image draft', async code => {
  let id = 0
  const f = await fixture(() => `image-${++id}`); await ready(f.controller)
  f.controller.addImages([new File(['image bytes'], '图.png', { type: 'image/png' })])
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draft.images?.[0]?.status).toBe('ready'); expect(f.controller.getSnapshot().draftStatus).toBe('ready') })
  f.client.appendV3.mockRejectedValueOnce(new PublicChatRpcError(code, 'private provider/storage detail'))
  await f.controller.send()
  const snapshot = f.controller.getSnapshot(), image = snapshot.draft.images![0]!
  expect(f.client.appendV3.mock.calls[0]?.[0].content).toEqual([{ type: 'image', mediaType: 'image/png', data: btoa('image bytes'), name: '图.png' }])
  expect(snapshot.pending).toBe(false)
  expect(snapshot.error).toBe(code === 'TEAM_PUBLIC_IMAGE_INVALID' ? 'public.imageRejected' : 'public.imageServiceUnavailable')
  expect(await snapshot.draftBlobs[image.blobId]!.text()).toBe('image bytes')
  f.controller.removeImage(image.blobId); f.controller.edit('corrected draft'); await f.controller.send()
  expect(f.client.appendV3.mock.calls.map(([request]) => request.requestId)).toEqual(['image-1', 'image-2'])
  expect(f.controller.getSnapshot().draft.text).toBe('')
  f.controller.dispose()
})

it('does not release a frozen operation when requestResult reports an image read error', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.addImages([new File(['retained'], '图.png', { type: 'image/png' })])
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draft.images?.[0]?.status).toBe('ready'); expect(f.controller.getSnapshot().draftStatus).toBe('ready') })
  f.client.appendV3.mockRejectedValueOnce(new Error('lost ACK')); await f.controller.send()
  const original = f.client.appendV3.mock.calls[0]![0]
  f.client.requestResultV3.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_IMAGE_UNAVAILABLE', 'read unavailable'))
  await f.controller.recover()
  expect(f.controller.getSnapshot().pending).toBe(true)
  expect(f.client.appendV3).toHaveBeenCalledTimes(1)
  await f.controller.recover()
  expect(f.client.appendV3.mock.calls[1]![0]).toEqual(original)
  f.controller.dispose()
})

it('keeps higher local edits after another page saves and requires explicit loading of the saved draft', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.edit('basis'); await vi.waitFor(() => { expect(f.controller.getSnapshot().draftStatus).toBe('ready') })
  const other = new PublicChatController(f.client, 'http://host:3094', f.port, undefined, (await f.drafts()))
  await ready(other)
  other.edit('other page saved'); await vi.waitFor(() => { expect(other.getSnapshot().draftStatus).toBe('ready') })
  f.controller.edit('local edit 1'); f.controller.edit('local edit 2')
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draftStatus).toBe('conflict') })
  expect(f.controller.getSnapshot().draft.text).toBe('local edit 2')
  await f.controller.send(); expect(f.client.appendV3).not.toHaveBeenCalled()
  expect((await (await f.drafts()).read('swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a']))).draft.text).toBe('other page saved')
  await f.controller.useStoredDraft()
  expect(f.controller.getSnapshot()).toMatchObject({ draftStatus: 'ready', draft: { text: 'other page saved' } })
  other.dispose(); f.controller.dispose()
})

it('preserves a v2 pending query version, request ID, target and content without silently upgrading it', async () => {
  const f = await fixture()
  const original = { schemaVersion: 2, target: { rootSessionId: 'old-viewer', teamId: 'a' }, requestId: 'old-v2', content: [{ type: 'text', text: 'original v2' }], replyTo: 'old-reply' }
  f.storage.set('swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a']), JSON.stringify({ draft: { text: 'newer draft', version: 5 }, pending: { captain: 'captain-a', version: 3, request: original } }))
  await ready(f.controller); await f.controller.recover()
  expect(f.client.requestResultV2).toHaveBeenCalledWith({ schemaVersion: 2, target: original.target, requestId: 'old-v2' }, expect.any(AbortSignal))
  expect(f.client.appendV2).toHaveBeenCalledWith(original, expect.any(AbortSignal))
  expect(f.client.appendV3).not.toHaveBeenCalled()
  expect(f.client.requestResultV3).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'newer draft' } })
  f.controller.dispose()
})

it('preserves typing during the atomic successful-send draft clear without a local revision collision', async () => {
  const f = await fixture(), store = (await f.drafts())
  let release!: () => void, settling = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = new PublicChatController(f.client, 'http://host:3094', f.port, undefined, { ...store, settle: async (...args) => { const value = await store.settle(...args); settling = true; await gate; return value } })
  await ready(controller); controller.edit('submitted'); const sending = controller.send()
  await vi.waitFor(() => { expect(settling).toBe(true) })
  controller.edit('typing during clear'); controller.reply('new-reply'); release(); await sending
  await vi.waitFor(() => { expect(controller.getSnapshot().draftStatus).toBe('ready') })
  expect(controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'typing during clear', replyTo: 'new-reply' } })
  controller.dispose(); f.controller.dispose()
})

it('keeps legacy pending and local edits when the first IndexedDB migration fails and is explicitly retried', async () => {
  const f = await fixture(); storeLegacy(f)
  const store = (await f.drafts()); let unavailable = true
  const controller = new PublicChatController(f.client, 'http://host:3094', f.port, undefined, { ...store, migrateLegacy: async (key, draft) => {
    if (unavailable) { unavailable = false; throw new Error('storage temporarily unavailable') }
    return store.migrateLegacy(key, draft)
  } })
  await ready(controller)
  expect(controller.getSnapshot()).toMatchObject({ draftStatus: 'unavailable', pending: true, draft: { text: 'legacy draft' } })
  controller.edit('local edit while unavailable')
  await controller.retryDraftStorage()
  expect(controller.getSnapshot()).toMatchObject({ draftStatus: 'ready', pending: true, draft: { text: 'local edit while unavailable' } })
  const saved = await (await f.drafts()).read('swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a']))
  expect(saved.pending?.request).toMatchObject({ schemaVersion: 1, requestId: 'legacy-id', text: 'legacy draft' })
  controller.dispose(); f.controller.dispose()
})

it('retains the actual legacy draft key as unconfirmed text', async () => {
  const f = await fixture(), key = 'swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a'])
  f.storage.set(key, JSON.stringify({ draft: { text: '请@同舟 核对这条文字。', version: 3 } }))
  await ready(f.controller); await f.controller.send()
  expect(f.controller.getSnapshot().draft).toMatchObject({ text: '请@同舟 核对这条文字。', tokens: [] })
  expect(f.client.appendV3).not.toHaveBeenCalled(); f.controller.dispose()
})
it('binds multiple same-name tokens to exact IDs and freezes their request through rename/reload', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.edit('请@同舟'); f.controller.chooseMention(1, 4, 'member-a')
  f.controller.edit(f.controller.getSnapshot().draft.text + ' 和@同舟'); f.controller.chooseMention(6, 9, 'member-b')
  f.client.appendV3.mockRejectedValueOnce(new Error('lost'))
  await f.controller.send()
  const original = f.client.appendV3.mock.calls[0]![0]
  expect(original.content).toEqual([{ type: 'text', text: '请' }, { type: 'mention', memberId: 'member-a' }, { type: 'text', text: ' 和' }, { type: 'mention', memberId: 'member-b' }])
  f.client.directory.mockResolvedValue(directoryPage('a', [directoryEntry('member-a', '改名'), directoryEntry('member-b')], 'v2'))
  await f.controller.refreshDirectory(); await f.controller.recover()
  expect(f.client.appendV3.mock.calls[1]![0]).toEqual(original); f.controller.dispose()
})
it('does not silently replace a removed selected identity with a same-name member', async () => {
  const f = await fixture(); await ready(f.controller)
  f.controller.edit('@同舟'); f.controller.chooseMention(0, 3, 'member-a')
  f.client.directory.mockResolvedValue(directoryPage('a', [directoryEntry('member-b')], 'v2')); await f.controller.refreshDirectory()
  await f.controller.send(); expect(f.client.appendV3).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().draft.tokens[0]?.memberId).toBe('member-a'); f.controller.dispose()
})
it('re-reads capability changes on Dashboard refresh even at unchanged Team revision', async () => {
  const f = await fixture(); await ready(f.controller)
  f.client.directory.mockResolvedValue(directoryPage('a', [{ ...directoryEntry(), model: { ...directoryEntry().model, model: 'new-model', imageInput: 'supported' } }], 'model-v2'))
  f.controller.bind(dashboard()); await waitFor(() => f.controller.getSnapshot().directory?.directoryRevision === 'model-v2')
  expect(f.controller.getSnapshot().directory?.entries[0]?.model.imageInput).toBe('supported'); f.controller.dispose()
})
it('discards mixed directory pages and restarts from page zero once', async () => {
  const f = await fixture(); const a = directoryPage('a', [directoryEntry()]), b = directoryPage('a', [directoryEntry('member-b')], 'new-generation')
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
function storeLegacy(f: Awaited<ReturnType<typeof fixture>>): void {
  f.storage.set('swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a']), JSON.stringify({ draft: { text: 'legacy draft', version: 5 }, pending: { captain: 'captain-a', version: 5, request: { schemaVersion: 1, target: { rootSessionId: 'original-viewer', teamId: 'a' }, requestId: 'legacy-id', text: 'legacy draft' } } }))
}
it('recovers the original ID after another page explicitly upgrades and commits its legacy pending as v3', async () => {
  const f = await fixture(); storeLegacy(f); await ready(f.controller)
  const other = new PublicChatController(f.client, 'http://host:3094', f.port, () => 'WRONG-NEW-ID', (await f.drafts()))
  try {
    await ready(other); await other.recover(); other.edit('explicitly upgraded on the other page')
    await other.upgradeLegacy()
    expect(f.client.appendV3).toHaveBeenCalledTimes(1)
    expect(other.getSnapshot().pending).toBe(false)
    expect(f.controller.getSnapshot().pending).toBe(true)
    const versionRequired = new PublicChatRpcError('SWARM_PUBLIC_VERSION_REQUIRED', 'Request is recorded as v3')
    f.client.requestResult.mockRejectedValueOnce(versionRequired)
    f.client.requestResultV2.mockRejectedValueOnce(versionRequired)
    f.client.requestResultV3.mockResolvedValueOnce({ ...page(), state: 'committed', message: message(1) })
    f.client.requestResultV3.mockClear()
    await f.controller.recover()
    expect(f.client.requestResultV3).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 3, target: { rootSessionId: 'original-viewer', teamId: 'a' }, requestId: 'legacy-id' }, expect.any(AbortSignal))
    expect(f.controller.getSnapshot()).toMatchObject({ pending: false, error: undefined, entries: [{ id: message(1).id }] })
    expect(f.client.appendV3).toHaveBeenCalledTimes(1)
    expect(f.client.appendV2).not.toHaveBeenCalled()
  } finally { other.dispose(); f.controller.dispose() }
})
it('requires explicit legacy upgrade and preserves the same ID/target through lost responses', async () => {
  const f = await fixture(() => 'WRONG-NEW-ID'); storeLegacy(f); await ready(f.controller)
  await f.controller.recover(); expect(f.controller.getSnapshot().legacyUpgrade).toBe(true); expect(f.client.appendV3).not.toHaveBeenCalled()
  f.controller.edit('upgraded content'); f.client.appendV3.mockRejectedValueOnce(new Error('lost'))
  await f.controller.upgradeLegacy()
  expect(f.client.appendV3.mock.calls[0]?.[0]).toMatchObject({ requestId: 'legacy-id', target: { rootSessionId: 'original-viewer', teamId: 'a' }, content: [{ type: 'text', text: 'upgraded content' }] })
  await f.controller.recover(); expect(f.client.appendV3.mock.calls[1]?.[0]).toEqual(f.client.appendV3.mock.calls[0]?.[0]); f.controller.dispose()
})
it('reads a late legacy commit without clearing the explicitly upgraded draft or appending twice', async () => {
  const f = await fixture(); storeLegacy(f); await ready(f.controller); await f.controller.recover(); f.controller.edit('upgraded content')
  f.client.requestResultV3.mockResolvedValue({ ...page(), state: 'committed', message: { ...message(1), formatVersion: 1 } })
  await f.controller.upgradeLegacy(); expect(f.client.appendV3).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'upgraded content' }, entries: [{ formatVersion: 1 }] }); f.controller.dispose()
})
it('handles a late v1 commit discovered by conflict after the v3 preflight read', async () => {
  const f = await fixture(); storeLegacy(f); await ready(f.controller); await f.controller.recover(); f.controller.edit('upgraded content')
  f.client.requestResultV3.mockResolvedValueOnce({ ...page(), state: 'not-found' }).mockResolvedValueOnce({ ...page(), state: 'committed', message: { ...message(1), formatVersion: 1 } })
  f.client.appendV3.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_REQUEST_CONFLICT', 'old request won'))
  await f.controller.upgradeLegacy(); expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'upgraded content' } }); f.controller.dispose()
})

it('retains an unknown operation on a decoded requestResult read rejection', async () => {
  const f = await fixture(); await ready(f.controller); f.controller.edit('original')
  f.client.appendV3.mockRejectedValueOnce(new Error('response lost')); await f.controller.send()
  f.client.requestResultV3.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_INVALID_REQUEST', 'query rejected'))
  await f.controller.recover(); expect(f.controller.getSnapshot().pending).toBe(true)
  f.controller.edit('new draft'); await f.controller.send(); expect(f.client.appendV3).toHaveBeenCalledTimes(1)
  await f.controller.recover(); expect(f.client.appendV3.mock.calls[1]?.[0]).toEqual(f.client.appendV3.mock.calls[0]?.[0]); f.controller.dispose()
})
it('retains a legacy request identity on read rejection, and on definite upgraded append rejection', async () => {
  const f = await fixture(); storeLegacy(f); await ready(f.controller)
  f.client.requestResult.mockRejectedValueOnce(new PublicChatRpcError('SWARM_RPC_INVALID_REQUEST', 'read rejected'))
  await f.controller.recover(); expect(f.controller.getSnapshot()).toMatchObject({ pending: true, legacyUpgrade: false })
  await f.controller.recover(); f.controller.edit('reviewed upgrade')
  f.client.appendV3.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_CAPACITY', 'capacity rejected'))
  await f.controller.upgradeLegacy(); expect(f.controller.getSnapshot()).toMatchObject({ pending: true, legacyUpgrade: true })
  f.controller.edit('short'); await f.controller.upgradeLegacy()
  expect(f.client.appendV3.mock.calls.map(([request]) => request.requestId)).toEqual(['legacy-id', 'legacy-id']); f.controller.dispose()
})

it.each([false, true])('preserves the upgraded draft when a rejected upgrade is followed by a legacy commit (reload=%s)', async reload => {
  const f = await fixture(); storeLegacy(f); await ready(f.controller); await f.controller.recover()
  f.controller.edit('upgraded draft after legacy not-found')
  f.client.appendV3.mockRejectedValueOnce(new PublicChatRpcError('TEAM_PUBLIC_CAPACITY', 'capacity rejected'))
  await f.controller.upgradeLegacy()
  const saved = await (await f.drafts()).read('swarm.public.v1:' + JSON.stringify(['http://host:3094', 'main', 'a']))
  expect(saved).toMatchObject({ draft: { version: 6 }, pending: { version: 5, legacyVersion: 5, upgradedLegacy: true, request: { schemaVersion: 1, requestId: 'legacy-id', text: 'legacy draft' } } })
  let controller = f.controller
  if (reload) {
    controller.dispose()
    controller = new PublicChatController(f.client, 'http://host:3094', f.port, () => 'WRONG-NEW-ID', (await f.drafts()))
    await ready(controller)
  }
  f.client.requestResult.mockResolvedValueOnce({ schemaVersion: 1, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 20, state: 'committed',
    message: { id: 'legacy-message', sequence: 1, createdAt: 10, text: 'legacy draft', author: { kind: 'local-operator' }, delivery: { state: 'queued', recipientSessionId: 'captain-a' } },
  })
  await controller.recover()
  expect(controller.getSnapshot()).toMatchObject({ pending: false, draft: { text: 'upgraded draft after legacy not-found' }, entries: [{ id: 'legacy-message', text: 'legacy draft', formatVersion: 1 }] })
  expect(f.client.appendV3.mock.calls.map(([request]) => request.requestId)).toEqual(['legacy-id'])
  controller.dispose()
})

it('coalesces same-binding dashboard refreshes while a healthy directory read is in flight', async () => {
  const f = await fixture()
  let resolve!: (value: ReturnType<typeof directoryPage>) => void
  f.client.directory.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  f.controller.bind(dashboard())
  await waitFor(() => f.client.directory.mock.calls.length === 1)
  for (let index = 0; index < 5; index++) f.controller.bind(dashboard())
  expect(f.client.directory).toHaveBeenCalledTimes(1)
  expect(f.client.directory.mock.calls[0]?.[1]?.aborted).toBe(false)
  resolve(directoryPage()); await waitFor(() => f.controller.getSnapshot().directory !== undefined)
  expect(f.controller.getSnapshot().directoryLoading).toBe(false)
  f.controller.dispose()
})

it('finishes a healthy read then performs one follow-up for an authoritative Team revision change', async () => {
  const f = await fixture(); let resolve!: (value: ReturnType<typeof directoryPage>) => void
  f.client.directory.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(directoryPage('a', [directoryEntry('member-b')], 'revision-5'))
  f.controller.bind(dashboard()); await waitFor(() => f.client.directory.mock.calls.length === 1)
  f.controller.bind(dashboard('a', 5)); f.controller.bind(dashboard('a', 5))
  expect(f.client.directory).toHaveBeenCalledTimes(1); expect(f.client.directory.mock.calls[0]?.[1]?.aborted).toBe(false)
  resolve(directoryPage()); await waitFor(() => f.controller.getSnapshot().directory?.directoryRevision === 'revision-5')
  expect(f.client.directory).toHaveBeenCalledTimes(2); expect(f.controller.getSnapshot().directoryLoading).toBe(false); f.controller.dispose()
})
it.each(['team', 'viewer'] as const)('cancels an old directory read immediately when the %s binding changes', async change => {
  const f = await fixture(); let resolve!: (value: ReturnType<typeof directoryPage>) => void
  f.client.directory.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  f.controller.bind(dashboard()); await waitFor(() => f.client.directory.mock.calls.length === 1)
  const signal = f.client.directory.mock.calls[0]?.[1]
  const team = change === 'team' ? 'b' : 'a'
  f.client.directory.mockResolvedValueOnce(directoryPage(team, [directoryEntry('new-scope')], 'new-binding'))
  f.controller.bind(dashboard(team, 4, change === 'viewer' ? 'other-viewer' : 'viewer'))
  expect(signal?.aborted).toBe(true)
  await waitFor(() => f.controller.getSnapshot().directory?.directoryRevision === 'new-binding')
  resolve(directoryPage()); await Promise.resolve()
  expect(f.controller.getSnapshot().directory?.entries.map(row => row.memberId)).toEqual(['new-scope']); f.controller.dispose()
})
