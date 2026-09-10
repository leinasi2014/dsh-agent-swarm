import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { GoalController } from '../src/client/goal-controller.js'
import { GoalRpcError } from '../src/client/goal-rpc-client.js'
import type { GoalReadResponse, GoalReadRequest, GoalSaveRequest, GoalControlRequest, GoalOperationResponse, GoalRequestResultRequest, GoalRequestResultResponse } from '../src/rpc/goal-rpc-contract.js'
import { TeamDashboardController, type TeamDashboardState } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import { goodFetch, ManualSchedule, waitFor } from './helpers/dashboard-controller.js'
import { browserGoalDrafts } from './goal-browser-draft.js'

let browser: Browser, context: BrowserContext, base: TeamDashboardState
beforeAll(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true }); context = await browser.newContext()
  const owner = new TeamDashboardController(new SwarmReadClient(goodFetch([])), new ManualSchedule())
  owner.open('root-1'); await waitFor(() => owner.getSnapshot().phase === 'ready'); base = owner.getSnapshot(); owner.dispose()
}, 30_000)
afterAll(async () => { await browser?.close() }, 30_000)
function dashboard(team = 'a', viewer = 'main'): TeamDashboardState {
  const data = base.data!
  return { ...base, targetSessionId: viewer, data: { ...data, teams: { ...data.teams, binding: { rootSessionId: viewer, mainSessionId: 'main' } },
    projection: { ...data.projection, binding: { rootSessionId: `captain-${team}`, teamId: team }, team: { ...data.projection.team, id: team, revision: 4 } } } }
}
function readResponse(team = 'a'): GoalReadResponse {
  return { schemaVersion: 1, binding: { rootSessionId: `captain-${team}`, teamId: team }, teamRevision: 4, observedAt: 10,
    snapshot: { text: 'Current goal', budget: { usedTokens: 20, usedRequests: 1, usedRetries: 0 }, remainingActiveTasks: 2, remainingActiveAttempts: 1, eligibility: { state: 'available' } } }
}
function committed(request: GoalSaveRequest | GoalControlRequest): GoalOperationResponse {
  const response = readResponse(request.target.teamId), revision = request.expectedLifecycleRevision + 1
  const goal = 'goal' in request ? request.goal : { text: response.snapshot.text, acceptanceCriteria: '', constraints: '', mode: 'finite' as const }
  return { ...response, teamRevision: 5, observedAt: 20, operationRevision: revision, replayed: false,
    snapshot: { ...response.snapshot, text: goal.text, lifecycle: { schemaVersion: 1, revision, goalRevision: 1, acceptanceCriteria: goal.acceptanceCriteria, constraints: goal.constraints,
      mode: goal.mode, phase: 'draft', resultSequence: 0, coordinatedResultSequence: 0, coordinatedGoalRevision: 0 } } }
}
async function fixture(name = crypto.randomUUID()) {
  const client = { read: vi.fn(async (request: GoalReadRequest) => readResponse(request.target.teamId)),
    save: vi.fn(async (request: GoalSaveRequest) => committed(request)), control: vi.fn(async (request: GoalControlRequest) => committed(request)),
    requestResult: vi.fn(async (request: GoalRequestResultRequest): Promise<GoalRequestResultResponse> => ({ ...readResponse(request.target.teamId), state: 'not-found' })) }
  const store = await browserGoalDrafts(context, name), controller = new GoalController(client, 'host', store, () => 'original-id')
  return { client, controller, store, name }
}
async function ready(controller: GoalController, state = dashboard()): Promise<void> {
  controller.bind(state); await vi.waitFor(() => { expect(controller.getSnapshot().draftStatus).toBe('ready'); expect(controller.getSnapshot().loading).toBe(false) })
}
function latch<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => { resolve(value) } } }

it('settles the original operation while keeping a newer authoritative coordination and editor baseline', async () => {
  const f = await fixture(), gate = latch<GoalOperationResponse>()
  f.client.save.mockImplementationOnce(() => gate.promise)
  await ready(f.controller); f.controller.beginEdit(); f.controller.edit('text', 'Saved goal')
  const operation = f.controller.save(true); await vi.waitFor(() => expect(f.client.save).toHaveBeenCalledOnce())
  const request = f.client.save.mock.calls[0]![0], original = committed(request)
  const newer: GoalReadResponse = { ...original, teamRevision: 7, observedAt: 40, snapshot: { ...original.snapshot,
    lifecycle: { ...original.snapshot.lifecycle!, revision: 3, phase: 'running', coordinatedGoalRevision: 1 } } }
  f.client.read.mockResolvedValue(newer); await f.controller.refresh()
  gate.resolve(original); await operation
  expect(f.controller.getSnapshot()).toMatchObject({ response: { teamRevision: 7, snapshot: { lifecycle: { revision: 3, phase: 'running' } } },
    outcome: { state: 'committed', operationRevision: 1 }, draft: { baseLifecycleRevision: 3 } })
  f.controller.dispose()
}, 30_000)

it('freezes before dispatch and preserves future edits and another Team on a late commit', async () => {
  const f = await fixture(), gate = latch<GoalOperationResponse>()
  f.client.save.mockImplementationOnce(() => gate.promise)
  await ready(f.controller); f.controller.beginEdit(); f.controller.edit('text', 'A saved goal')
  const operation = f.controller.save(true); await vi.waitFor(() => expect(f.client.save).toHaveBeenCalledOnce())
  const request = f.client.save.mock.calls[0]![0], scope = f.controller.getSnapshot().selection!.key
  expect((await f.store.read(scope)).pending?.request).toEqual(request)
  f.controller.edit('text', 'A later edit')
  await ready(f.controller, dashboard('b')); f.controller.beginEdit(); f.controller.edit('text', 'B draft')
  gate.resolve(committed(request)); await operation
  expect(f.controller.getSnapshot().draft.text).toBe('B draft')
  await ready(f.controller, dashboard('a', 'member-a'))
  expect(f.controller.getSnapshot()).toMatchObject({ draft: { text: 'A later edit' }, pending: undefined, outcome: { state: 'committed', operationRevision: 1 } })
  f.controller.dispose()
}, 30_000)
it('recovers after reload using the original revision and payload without rebasing a newer draft', async () => {
  const f = await fixture(); f.client.save.mockRejectedValueOnce(new Error('ACK lost'))
  await ready(f.controller); f.controller.beginEdit(); f.controller.edit('text', 'Frozen'); await f.controller.save(false)
  const request = f.client.save.mock.calls[0]![0]
  expect(f.controller.getSnapshot().pending?.request).toEqual(request); f.controller.dispose()
  const restored = new GoalController(f.client, 'host', await browserGoalDrafts(context, f.name), () => 'must-not-replace')
  await ready(restored); restored.edit('text', 'Future goal'); await restored.recover()
  expect(f.client.save.mock.calls.map(([input]) => input)).toEqual([request, request])
  expect(restored.getSnapshot()).toMatchObject({ draft: { text: 'Future goal' }, pending: undefined })
  restored.dispose()
}, 30_000)
it('marks expired recovery explicitly and never re-executes it or substitutes a new revision', async () => {
  const f = await fixture(); f.client.save.mockRejectedValueOnce(new Error('ACK lost'))
  await ready(f.controller); f.controller.beginEdit(); f.controller.edit('text', 'Unconfirmed'); await f.controller.save(false)
  f.client.requestResult.mockResolvedValueOnce({ ...readResponse(), state: 'expired' })
  await f.controller.recover()
  expect(f.client.save).toHaveBeenCalledTimes(1)
  expect(f.controller.getSnapshot()).toMatchObject({ pending: undefined, outcome: { state: 'expired' }, draft: { text: 'Unconfirmed' } })
  expect((await f.store.read(f.controller.getSnapshot().selection!.key)).outcome?.state).toBe('expired')
  f.controller.dispose()
}, 30_000)
it('keeps after-commit failures unknown, but preserves the draft and releases known precommit rejection', async () => {
  const f = await fixture()
  await ready(f.controller); f.controller.beginEdit(); f.controller.edit('text', 'Kept')
  f.client.save.mockRejectedValueOnce(new GoalRpcError('TEAM_GOAL_STALE_REVISION', 'Changed')); await f.controller.save(false)
  expect(f.controller.getSnapshot()).toMatchObject({ pending: undefined, draft: { text: 'Kept' } })
  f.client.save.mockRejectedValueOnce(new GoalRpcError('TEAM_AFTER_COMMIT_FAILED', 'Delivery')); await f.controller.save(false)
  expect(f.controller.getSnapshot().pending).toBeDefined(); f.controller.dispose()
}, 30_000)
it('uses only the dashboard refresh owner, retains same-Team drafts while stale and rejects a late old-Team read', async () => {
  const f = await fixture(), gate = latch<GoalReadResponse>(), selected = dashboard()
  await ready(f.controller, selected)
  const before = f.client.read.mock.calls.length; f.controller.bind(selected)
  expect(f.client.read).toHaveBeenCalledTimes(before)
  f.controller.beginEdit(); f.controller.edit('text', 'Retained')
  f.controller.bind({ ...selected, phase: 'stale' })
  expect(f.controller.getSnapshot()).toMatchObject({ verified: false, draft: { text: 'Retained' } })
  await f.controller.save(false); expect(f.client.save).not.toHaveBeenCalled()
  f.client.read.mockImplementationOnce(() => gate.promise); f.controller.bind(dashboard())
  await ready(f.controller, dashboard('b')); gate.resolve({ ...readResponse(), snapshot: { ...readResponse().snapshot, text: 'Wrong late A' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.controller.getSnapshot().response?.binding.teamId).toBe('b')
  expect(f.controller.getSnapshot().response?.snapshot.text).not.toBe('Wrong late A')
  f.controller.dispose()
}, 30_000)
