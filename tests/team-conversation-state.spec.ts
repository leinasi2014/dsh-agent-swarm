import { describe, expect, it } from 'vitest'
import { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../src/client/read-client.js'
import type { SwarmReadRpcRequest } from '../src/rpc/read-rpc-contract.js'
import { binding, teams, ManualSchedule, success, requestOf, goodFetch, waitFor } from './helpers/dashboard-controller.js'
import { dashboard, message, page, fixture, ready } from './helpers/public-chat-controller-fixture.js'

describe('Main Conversation entry and retained reading state', () => {
  it('re-reads an earlier window after a personal Session detour before restoring history or send eligibility', async () => {
    const f = await fixture(), rows = Array.from({ length: 120 }, (_, index) => message(index + 1))
    let block = false, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.client.historyV3.mockImplementation(async request => {
      if (block) await gate
      const eligible = rows.filter(row => (request.afterSequence === undefined || row.sequence > request.afterSequence)
        && (request.beforeSequence === undefined || row.sequence < request.beforeSequence))
      const entries = request.afterSequence === undefined ? eligible.slice(-(request.limit ?? 50)) : eligible.slice(0, request.limit ?? 50)
      return { ...page(request.target.teamId, entries), totalCount: rows.length,
        hasEarlier: (entries[0]?.sequence ?? 1) > 1, hasMore: (entries.at(-1)?.sequence ?? 120) < 120 }
    })
    try {
      await ready(f.controller); await f.controller.earlier()
      expect(f.controller.getSnapshot().entries[0]?.id).toBe('message-21')
      f.controller.edit('return draft')
      await ready(f.controller, dashboard('a', 4, 'member-viewer'))
      f.controller.bind({ open: true, targetSessionId: 'viewer', phase: 'loading' })
      block = true; f.controller.bind(dashboard())
      expect(f.controller.getSnapshot().entries).toEqual([])
      expect(f.controller.getSnapshot().history).toBeUndefined()
      await f.controller.send(); expect(f.client.appendV3).not.toHaveBeenCalled()
      release(); await waitFor(() => !f.controller.getSnapshot().loading)
      expect(f.controller.getSnapshot().entries[0]?.id, 'return must restore the earlier page, not replace it with the last 50 messages').toBe('message-21')
      expect(f.controller.getSnapshot().entries).toHaveLength(100)
      expect(f.controller.getSnapshot().draft.text).toBe('return draft')
      expect(f.controller.getSnapshot().history?.appendEligibility.state).toBe('available')
      await f.controller.latest()
      expect(f.controller.getSnapshot().entries[0]?.id).toBe('message-71')
    } finally { release(); f.controller.dispose() }
  })
  it('requires a multi-Team Main choice and remembers it only for that exact Main', async () => {
    const calls: SwarmReadRpcRequest[] = [], normal = goodFetch(calls)
    const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
      const request = requestOf(init)
      if (request.method === 'teams') return success({ ...teams, binding: { rootSessionId: request.target.rootSessionId, mainSessionId: request.target.rootSessionId }, teams: ['team-1', 'team-2'].map(teamId => ({ ...teams.teams[0]!, teamId, name: teamId, endpoints: { members: { method: 'captainMembers', target: { rootSessionId: request.target.rootSessionId, teamId } }, announcements: { method: 'captainAnnouncements', target: { rootSessionId: request.target.rootSessionId, teamId } }, diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: request.target.rootSessionId, teamId } } } })) })
      const response = await normal(input, init), envelope = await response.json() as { value: Record<string, unknown> }
      if (request.method !== 'capabilities' && request.method !== 'page') return success({ ...envelope.value, binding: { rootSessionId: 'root-1', teamId: request.target.teamId },
        ...(request.method === 'binding' || request.method === 'snapshot' ? { team: { ...binding.team, id: request.target.teamId } } : {}) })
      return success(envelope.value)
    }), new ManualSchedule())
    try {
      controller.open('main-a'); await waitFor(() => controller.getSnapshot().phase === 'ready')
      expect(controller.getSnapshot().choices?.teams).toHaveLength(2)
      expect(controller.getSnapshot().data).toBeUndefined()
      expect(calls.some(call => call.method === 'binding')).toBe(false)
      controller.selectTeam('team-2'); await waitFor(() => controller.getSnapshot().phase === 'ready')
      expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-2')
      controller.open('main-b'); await waitFor(() => controller.getSnapshot().phase === 'ready')
      expect(controller.getSnapshot().choices?.teams).toHaveLength(2)
      controller.selectTeam('team-1'); await waitFor(() => controller.getSnapshot().phase === 'ready')
      controller.open('main-a'); await waitFor(() => controller.getSnapshot().phase === 'ready')
      expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-2')
      controller.open('main-b'); await waitFor(() => controller.getSnapshot().phase === 'ready')
      expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-1')
    } finally { controller.dispose() }
  })
})
