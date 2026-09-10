import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { WorkRequestController, type WorkDraftPersistence } from '../src/client/work-request-controller.js'
import { WorkRpcError } from '../src/client/work-rpc-client.js'
import type { WorkActivityResponse, WorkSubmitRequest, WorkSubmitResponse, WorkRequestResultResponse, WorkActivityRequest } from '../src/rpc/work-rpc-contract.js'
import { TeamDashboardController, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { goodFetch, ManualSchedule, waitFor } from './helpers/dashboard-controller.js'
import { browserWorkDraftStore } from './helpers/work-draft-browser.js'

let browser: Browser, context: BrowserContext, base: TeamDashboardState
beforeAll(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true }); context = await browser.newContext()
  const owner = new TeamDashboardController(new SwarmReadClient(goodFetch([])), new ManualSchedule())
  owner.open('root-1'); await waitFor(() => owner.getSnapshot().phase === 'ready'); base = owner.getSnapshot(); owner.dispose()
}, 30_000)
afterAll(async () => { await browser?.close() }, 30_000)
function dashboard(team = 'a', viewer = 'main', revision = 4): TeamDashboardState {
  const data = base.data!
  return { ...base, targetSessionId: viewer, data: { ...data,
    teams: { ...data.teams, binding: { rootSessionId: viewer, mainSessionId: 'main' } },
    projection: { ...data.projection, binding: { rootSessionId: `captain-${team}`, teamId: team }, team: { ...data.projection.team, id: team, revision } },
  } }
}
function page(team = 'a', afterSequence = 0, entries: WorkActivityResponse['entries'] = []): WorkActivityResponse {
  return { schemaVersion: 1, binding: { rootSessionId: `captain-${team}`, teamId: team }, teamRevision: 4, observedAt: 20,
    teamId: team, afterSequence, retainedFromSequence: 1, throughSequence: entries.at(-1)?.sequence ?? afterSequence, entries, hasMore: false, referencedRequests: [],
    limits: { maxDescriptionChars: 8192, maxAcceptanceCriteriaChars: 4096, maxRequests: 256, maxActivityEntries: 1024 }, submitEligibility: { state: 'available' } }
}
function committed(request: WorkSubmitRequest): WorkSubmitResponse {
  return { schemaVersion: 1, binding: request.target, teamRevision: 5, observedAt: 20, replayed: false,
    request: { id: `work-${request.requestId}`, requestId: request.requestId, origin: { kind: 'local-operator' }, description: request.description,
      ...(request.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: request.acceptanceCriteria }), revision: 1, createdAt: 10 } }
}
function fixture(id = () => 'stable-id', storage?: WorkDraftPersistence) {
  const name = crypto.randomUUID(), drafts = () => browserWorkDraftStore(context, name)
  const client = {
    submit: vi.fn(async (request: WorkSubmitRequest, _signal?: AbortSignal) => committed(request)),
    requestResult: vi.fn(async (request: { target: WorkSubmitRequest['target'] }, _signal?: AbortSignal): Promise<WorkRequestResultResponse> => ({ schemaVersion: 1, binding: request.target, teamRevision: 4, observedAt: 20, state: 'not-found' })),
    activity: vi.fn(async (request: WorkActivityRequest, _signal?: AbortSignal) => page(request.target.teamId, request.afterSequence)),
  }
  const controller = new WorkRequestController(client, 'host', storage ?? drafts(), id)
  return { controller, client, drafts }
}
async function ready(controller: WorkRequestController, state = dashboard()): Promise<void> {
  controller.bind(state)
  await vi.waitFor(() => { expect(controller.getSnapshot().loading).toBe(false); expect(controller.getSnapshot().draftStatus).toBe('ready') }, { timeout: 10_000 })
}
function latch<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => { resolve(value) } } }

it('freezes before dispatch, addresses the real Captain and keeps a newer draft after the original result', async () => {
  const f = fixture(), gate = latch<WorkSubmitResponse>()
  f.client.submit.mockImplementationOnce(() => gate.promise)
  await ready(f.controller, dashboard('a', 'member-viewer'))
  f.controller.edit('description', 'Original'); f.controller.edit('acceptanceCriteria', 'Actual evidence')
  const sending = f.controller.send(); await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(1))
  const request = f.client.submit.mock.calls[0]![0]
  expect(request).toEqual({ schemaVersion: 1, target: { rootSessionId: 'captain-a', teamId: 'a' }, requestId: 'stable-id', description: 'Original', acceptanceCriteria: 'Actual evidence' })
  expect((await f.drafts().read(f.controller.getSnapshot().selection!.key)).pending?.request).toEqual(request)
  await f.controller.send(); expect(f.client.submit).toHaveBeenCalledTimes(1)
  f.controller.edit('description', 'Newer draft'); gate.resolve(committed(request)); await sending
  expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { description: 'Newer draft' }, lastSubmitted: { id: 'work-stable-id' } })
  f.controller.dispose()
})
it('restores an unknown outcome after reload and retries with its original id and payload', async () => {
  const f = fixture(); f.client.submit.mockRejectedValueOnce(new Error('ACK lost'))
  await ready(f.controller); f.controller.edit('description', 'Frozen'); await f.controller.send()
  expect(f.controller.getSnapshot().pending).toBe(true); f.controller.dispose()
  const restored = new WorkRequestController(f.client, 'host', f.drafts(), () => 'must-not-replace')
  await ready(restored); restored.edit('description', 'Future work'); await restored.recover()
  expect(f.client.submit.mock.calls.map(([request]) => [request.requestId, request.description])).toEqual([['stable-id', 'Frozen'], ['stable-id', 'Frozen']])
  expect(restored.getSnapshot()).toMatchObject({ pending: false, draft: { description: 'Future work' } })
  restored.dispose()
})
it('settles Team A after switching to B without clearing B or missing the A result on member navigation', async () => {
  const f = fixture(), gate = latch<WorkSubmitResponse>()
  f.client.submit.mockImplementationOnce(() => gate.promise)
  await ready(f.controller); f.controller.edit('description', 'A request'); const pending = f.controller.send()
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(1))
  await ready(f.controller, dashboard('b')); f.controller.edit('description', 'B draft')
  gate.resolve(committed(f.client.submit.mock.calls[0]![0])); await pending
  expect(f.controller.getSnapshot().draft.description).toBe('B draft')
  await ready(f.controller, dashboard('a', 'captain-a'))
  expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { description: '' }, lastSubmitted: { id: 'work-stable-id' } })
  f.controller.dispose()
})
it('does not submit if the real draft store fails before freeze and keeps local content recoverable', async () => {
  const store = browserWorkDraftStore(context, crypto.randomUUID()), freeze = vi.spyOn(store, 'freeze').mockRejectedValueOnce(new Error('Storage unavailable'))
  const f = fixture(undefined, store)
  await ready(f.controller); f.controller.edit('description', 'Kept'); await f.controller.send()
  expect(f.client.submit).not.toHaveBeenCalled(); expect(f.controller.getSnapshot()).toMatchObject({ draftStatus: 'unavailable', draft: { description: 'Kept' } })
  freeze.mockRestore(); await f.controller.retryDraftStorage(); await f.controller.send()
  expect(f.client.submit).toHaveBeenCalledTimes(1); f.controller.dispose()
})
it('keeps request-result failures and conflicts unknown but releases only a definite submit capacity rejection', async () => {
  const f = fixture()
  f.client.submit.mockRejectedValueOnce(new WorkRpcError('TEAM_WORK_REQUEST_CAPACITY', 'Full'))
  await ready(f.controller); f.controller.edit('description', 'Kept'); await f.controller.send()
  expect(f.controller.getSnapshot()).toMatchObject({ pending: false, draft: { description: 'Kept' } })
  f.client.submit.mockRejectedValueOnce(new Error('Lost response')); await f.controller.send()
  f.client.requestResult.mockRejectedValueOnce(new WorkRpcError('TEAM_INPUT_INVALID', 'Read failed')); await f.controller.recover()
  expect(f.controller.getSnapshot().pending).toBe(true)
  f.client.submit.mockRejectedValueOnce(new WorkRpcError('TEAM_WORK_REQUEST_CONFLICT', 'Conflict')); await f.controller.recover()
  expect(f.controller.getSnapshot().pending).toBe(true); f.controller.dispose()
})
it('uses activity pages alone for its cursor and retains truthful range and request details', async () => {
  const f = fixture(), origin = { kind: 'local-operator' as const }
  const first = { id: 'e-50', sequence: 50, kind: 'request-proposed' as const, occurredAt: 10, actor: origin, workRequestId: 'work-original' }
  const request = { ...committed({ schemaVersion: 1, target: { rootSessionId: 'captain-a', teamId: 'a' }, requestId: 'original', description: 'Source' }).request, id: 'work-original' }
  f.client.activity.mockResolvedValueOnce({ ...page('a', 0, [first]), retainedFromSequence: 50, throughSequence: 52, hasMore: true, referencedRequests: [request] })
  await ready(f.controller); f.controller.edit('description', 'Another proposal'); await f.controller.send()
  await vi.waitFor(() => expect(f.client.activity).toHaveBeenCalledTimes(2))
  expect(f.client.activity.mock.calls[1]![0].afterSequence).toBe(50)
  expect(f.controller.getSnapshot().entries).toEqual([first])
  expect(f.controller.getSnapshot().referencedRequests).toEqual([request])
  f.controller.dispose()
})
it('keeps same-Team disconnected content and blocks RPC until the dashboard proves the viewer again', async () => {
  const f = fixture(), state = dashboard()
  await ready(f.controller, state); f.controller.edit('description', 'Keep me')
  await vi.waitFor(() => expect(f.controller.getSnapshot().draftStatus).toBe('ready'))
  f.client.activity.mockClear()
  f.controller.bind({ ...state, phase: 'stale' }); await f.controller.send(); await f.controller.refresh()
  expect(f.controller.getSnapshot()).toMatchObject({ verified: false, draft: { description: 'Keep me' } })
  expect(f.client.submit).not.toHaveBeenCalled(); expect(f.client.activity).not.toHaveBeenCalled()
  f.controller.bind({ ...state, phase: 'stale', pendingTeamId: 'b' })
  expect(f.controller.getSnapshot().selection).toBeUndefined()
  await ready(f.controller, state); expect(f.controller.getSnapshot().draft.description).toBe('Keep me')
  f.controller.dispose()
})
it('does not turn a replaced Captain into authority over an earlier unknown operation', async () => {
  const f = fixture(); f.client.submit.mockRejectedValueOnce(new Error('Lost response'))
  await ready(f.controller); f.controller.edit('description', 'Old Captain'); await f.controller.send()
  const state = dashboard()
  f.controller.bind({ ...state, data: { ...state.data!, projection: { ...state.data!.projection, binding: { rootSessionId: 'new-captain', teamId: 'a' } } } })
  await f.controller.recover()
  expect(f.client.requestResult).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().pending).toBe(true)
  f.controller.dispose()
})
it('subscribes to the existing dashboard owner and coalesces refreshes without adding a timer', async () => {
  const f = fixture(), listeners = new Set<() => void>(); let state = dashboard()
  const timer = vi.spyOn(globalThis, 'setInterval')
  const off = f.controller.connect({ getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  await vi.waitFor(() => expect(f.controller.getSnapshot().draftStatus).toBe('ready'))
  const read = latch<WorkActivityResponse>(); f.client.activity.mockImplementationOnce(() => read.promise)
  state = dashboard(); for (const listener of listeners) listener()
  for (const listener of listeners) listener()
  expect(f.client.activity).toHaveBeenCalledTimes(2)
  read.resolve(page()); await vi.waitFor(() => expect(f.controller.getSnapshot().loading).toBe(false))
  expect(timer).not.toHaveBeenCalled(); timer.mockRestore(); off(); expect(listeners.size).toBe(0)
})

it('clears a failed activity read after a successful refresh of the same scope without changing its draft', async () => {
  const f = fixture()
  try {
    await ready(f.controller); f.controller.edit('description', 'Keep this proposal')
    await vi.waitFor(() => expect(f.controller.getSnapshot().draftStatus).toBe('ready'))
    const selection = f.controller.getSnapshot().selection
    f.client.activity.mockRejectedValueOnce(new Error('Temporary network loss'))
    await f.controller.refresh()
    expect(f.controller.getSnapshot()).toMatchObject({ loading: false, error: 'Temporary network loss', selection })
    await f.controller.refresh()
    expect(f.controller.getSnapshot()).toMatchObject({ loading: false, error: undefined, selection, draft: { description: 'Keep this proposal' } })
    expect(f.client.submit).not.toHaveBeenCalled()
  } finally { f.controller.dispose() }
})
