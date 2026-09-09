import { sidebarHarness } from './helpers/sidebar-harness.js'
import { describe, expect, it, vi } from 'vitest'
import { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { SwarmReadClient, type SwarmFetch } from '../src/client/read-client.js'
import type { SwarmReadRpcRequest } from '../src/rpc/read-rpc-contract.js'
import { TeamDashboardSurfaceCoordinator } from '../src/client/team-dashboard-surface-coordinator.js'
vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

import { CURSOR, binding, tasks, attempts, interactions, snapshot, teams, announcements, captainDiagnostics, captainMembers, ManualSchedule, success, requestOf, goodFetch, waitFor } from './helpers/dashboard-controller.js'

describe('TeamDashboardController', () => {
  it('keeps the verified Team visible while switching between its Chats, but clears it for an unrelated Session', async () => {
    const normal = goodFetch([])
    let release: (() => void) | undefined
    let delayedSignal: AbortSignal | null | undefined
    const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
      const request = requestOf(init)
      if (request.method === 'teams' && request.target.rootSessionId === 'member-1') {
        delayedSignal = init?.signal
        await new Promise<void>(resolve => { release = resolve })
      }
      if (request.method === 'captainMembers') return success({ ...captainMembers, members: [{ ...captainMembers.members[0], sessionId: 'member-1' }] })
      return await normal(input, init)
    }), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const verified = controller.getSnapshot().data
    controller.open('member-1')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', targetSessionId: 'member-1' })
    expect(controller.getSnapshot().data).toBe(verified)
    await waitFor(() => release !== undefined)
    controller.open('root-1')
    expect(controller.getSnapshot().data).toBe(verified)
    expect(delayedSignal?.aborted).toBe(true)
    release!()
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(controller.getSnapshot().targetSessionId).toBe('root-1')
    controller.open('unrelated-root')
    expect(controller.getSnapshot().data).toBeUndefined()
    expect(controller.getSnapshot().phase).toBe('loading')
    controller.dispose()
  })

  it('selects a fresh child Chat’s own Team, keeps explicit card selection, and cancels a pending switch back (#225)', async () => {
    const normal = goodFetch([])
    let currentTeamId = 'team-2'
    let delayBeta = false
    let releaseBeta: (() => void) | undefined
    let betaSignal: AbortSignal | null | undefined
    const directory = (rootSessionId: string) => ['team-1', 'team-2'].map(teamId => ({ ...teams.teams[0]!, teamId, name: teamId,
      endpoints: {
        members: { method: 'captainMembers', target: { rootSessionId, teamId } },
        announcements: { method: 'captainAnnouncements', target: { rootSessionId, teamId } },
        diagnostics: { method: 'captainDiagnostics', target: { rootSessionId, teamId } },
      },
    }))
    const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
      const req = requestOf(init)
      if (req.method === 'teams') return success({ ...teams, binding: { rootSessionId: req.target.rootSessionId, mainSessionId: 'main', currentTeamId }, teams: directory(req.target.rootSessionId) })
      if (req.method === 'binding' && req.target.teamId === 'team-2' && delayBeta) {
        betaSignal = init?.signal
        await new Promise<void>(resolve => { releaseBeta = resolve })
      }
      const response = await normal(input, init)
      const envelope = await response.json() as { value: Record<string, unknown> }
      if (req.method !== 'capabilities' && req.method !== 'page') {
        const value = { ...envelope.value, binding: { rootSessionId: 'root-1', teamId: req.target.teamId } }
        if (req.method === 'binding' || req.method === 'snapshot') Object.assign(value, { team: { ...binding.team, id: req.target.teamId } })
        return success(value)
      }
      return success(envelope.value)
    }), new ManualSchedule())
    controller.open('member-2')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-2')
    controller.selectTeam('team-1')
    await waitFor(() => controller.getSnapshot().data?.projection.binding.teamId === 'team-1')
    controller.refresh()
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-1')
    delayBeta = true
    controller.selectTeam('team-2')
    await waitFor(() => releaseBeta !== undefined)
    controller.selectTeam('team-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(betaSignal?.aborted).toBe(true)
    releaseBeta!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-1')
    delayBeta = false
    currentTeamId = 'team-2'
    controller.open('captain-2')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(controller.getSnapshot().data?.projection.binding.teamId).toBe('team-2')
    controller.dispose()
  })

  it('re-proves main Chat ownership and rejects changed or superseded lineage before navigation (#225)', async () => {
    const normal = goodFetch([])
    let mainSessionId = 'main'
    let paused = false
    let release: (() => void) | undefined
    const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
      const req = requestOf(init)
      if (req.method !== 'teams') return await normal(input, init)
      if (paused) await new Promise<void>(resolve => { release = resolve })
      return success({ ...teams, binding: { rootSessionId: req.target.rootSessionId, mainSessionId } })
    }), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const opened = vi.fn()
    await controller.openMainChat(opened)
    expect(opened.mock.calls[0]?.[0]).toBe('main')
    mainSessionId = 'different-main'
    await expect(controller.openMainChat(opened)).rejects.toThrow('binding changed')
    expect(opened).toHaveBeenCalledOnce()
    mainSessionId = 'main'
    paused = true
    const handoff = controller.openMainChat(opened)
    const rejected = expect(handoff).rejects.toThrow()
    await waitFor(() => release !== undefined)
    controller.close()
    release!()
    await rejected
    expect(opened).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('re-proves member identity before navigation and keeps the panel alive (#221)', async () => {
    const schedule = new ManualSchedule()
    const normal = goodFetch([])
    let removed = false
    const controller = new TeamDashboardController(new SwarmReadClient(async (input, init) => {
      if (requestOf(init).method === 'captainMembers') return success({ ...captainMembers, members: [{ ...captainMembers.members[0], ...(removed ? {} : { sessionId: 'member-1' }) }] })
      return await normal(input, init)
    }), schedule)
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const opened: string[] = []
    await controller.openMemberChat('worker', 'member-1', async (captain, member) => { opened.push(captain, member) })
    expect(opened).toEqual(['root-1', 'member-1'])
    expect(controller.getSnapshot().open).toBe(true)
    expect(schedule.pending.size).toBe(1)
    removed = true
    await expect(controller.openMemberChat('worker', 'member-1', async () => { opened.push('wrong') })).rejects.toThrow('Member Session')
    expect(opened).toEqual(['root-1', 'member-1'])
    expect(controller.getSnapshot().data).toBeDefined()
    expect(schedule.pending.size).toBe(1)
    controller.dispose()
  })

  it('stays inert until open and loads every strict page without issuing a write', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const schedule = new ManualSchedule()
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen)), schedule)
    expect(seen).toEqual([])

    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')

    const state = controller.getSnapshot()
    expect(state.data?.projection.tasks).toHaveLength(51)
    expect(state.data?.projection.attempts).toEqual(attempts)
    expect(state.data?.projection.pendingInteractions).toEqual(interactions)
    expect(seen.map(request => request.method)).toEqual([
      'capabilities', 'teams', 'binding', 'snapshot', 'captainAnnouncements', 'captainDiagnostics', 'captainMembers', 'page', 'page', 'page', 'page',
    ])
    expect(seen.every(request => ['capabilities', 'binding', 'snapshot', 'teams', 'captainAnnouncements', 'captainDiagnostics', 'captainMembers', 'page'].includes(request.method))).toBe(true)
    expect(schedule.pending.size).toBe(1)
    controller.dispose()
  })

  it('keeps Main Brain as the RPC target after resolving a dedicated Captain binding', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const mainRoot = 'main-brain-1'
    const captainRoot = 'captain-1'
    const normal = goodFetch([])
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      seen.push(request)
      if (request.method === 'binding') {
        return success({ ...binding, binding: { rootSessionId: captainRoot, teamId: 'team-1' } })
      }
      if (request.method === 'snapshot') {
        return success({ ...snapshot, binding: { rootSessionId: captainRoot, teamId: 'team-1' } })
      }
      if (request.method === 'teams') {
        const team = teams.teams[0]
        return success({
          ...teams,
          binding: { rootSessionId: mainRoot },
          teams: [{
            ...team,
            captainSessionId: captainRoot,
            endpoints: {
              members: { ...team.endpoints.members, target: { rootSessionId: mainRoot, teamId: 'team-1' } },
              announcements: { ...team.endpoints.announcements, target: { rootSessionId: mainRoot, teamId: 'team-1' } },
              diagnostics: { ...team.endpoints.diagnostics, target: { rootSessionId: mainRoot, teamId: 'team-1' } },
            },
          }],
        })
      }
      if (request.method === 'captainAnnouncements') {
        return success({ ...announcements, binding: { rootSessionId: captainRoot, teamId: 'team-1' } })
      }
      if (request.method === 'captainDiagnostics') {
        return success({ ...captainDiagnostics, binding: { rootSessionId: captainRoot, teamId: 'team-1' } })
      }
      if (request.method === 'captainMembers') {
        return success({ ...captainMembers, binding: { rootSessionId: captainRoot, teamId: 'team-1' } })
      }
      return await normal(input, init)
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open(mainRoot)
    await waitFor(() => ['ready', 'error'].includes(controller.getSnapshot().phase))

    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready' })
    expect(controller.getSnapshot().data?.projection.binding.rootSessionId).toBe(captainRoot)
    for (const request of seen) {
      if (request.method === 'capabilities') continue
      expect(request.target.rootSessionId).toBe(mainRoot)
    }
    controller.dispose()
  })

  it('publishes the Captain profile generated on the teams read to the very next poll (issue #175)', async () => {
    // Issue #175: after set_captain_profile, an OPEN dashboard must surface the generated
    // identity on the next 5s poll — a full page reload must not be required. The poll path
    // re-issues the `teams` RPC (readComplete) and publishes its fresh descriptor; this test
    // pins that not_generated→generated on the second teams read is published unconditionally,
    // independently of the projection cursor (the profile is aggregate enrichment, not part of
    // the host snapshot projection).
    const seen: SwarmReadRpcRequest[] = []
    let teamsReads = 0
    const normal = goodFetch(seen)
    const profiledTeam = {
      ...teams.teams[0],
      displayName: '玄机',
      profession: '队长',
      avatar: { state: 'generated', svg: '<svg viewBox="0 0 8 8"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
      identityCard: { state: 'generated' },
    } as const
    const schedule = new ManualSchedule()
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      if (request.method !== 'teams') return normal(input, init)
      teamsReads += 1
      return success(teamsReads === 1
        ? teams
        : { ...teams, teams: [profiledTeam] })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), schedule)
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const first = controller.getSnapshot()
    expect(first.data?.teams.teams[0]?.identityCard.state).toBe('not_generated')

    expect(schedule.pending.size).toBe(1)
    schedule.fire() // the next poll: the host now serves the generated Captain profile
    await waitFor(() => controller.getSnapshot().data !== undefined
      && controller.getSnapshot().data !== first.data)
    const second = controller.getSnapshot()
    expect(second.phase).toBe('ready')
    expect(teamsReads).toBeGreaterThanOrEqual(2)
    expect(second.data?.teams.teams[0]?.identityCard.state).toBe('generated')
    expect(second.data?.teams.teams[0]?.displayName).toBe('玄机')
    controller.dispose()
  })

  it('discards a mixed-cursor aggregate and restarts once from a fresh snapshot', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen, { driftFirstTaskPage: true })), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(seen.filter(request => request.method === 'snapshot')).toHaveLength(2)
    expect(controller.getSnapshot().data?.projection.tasks).toHaveLength(51)
    controller.dispose()
  })

  it('rejects a stable row id repeated across otherwise canonical pages', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      const response = await normal(input, init)
      if (request.method !== 'page' || request.page.kind !== 'tasks' || request.page.offset !== 50) return response
      const envelope = await response.json() as { value: Record<string, unknown> }
      return success({ ...envelope.value, entries: [tasks[0]] })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'error')
    expect(controller.getSnapshot().error?.code).toBe('SWARM_UI_PAGE_INVALID')
    controller.dispose()
  })

  it('rejects a page total that exceeds or drifts from the frozen snapshot ceiling', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      const response = await normal(input, init)
      if (request.method !== 'page' || request.page.kind !== 'tasks' || request.page.offset !== 0) return response
      const envelope = await response.json() as { value: Record<string, unknown> }
      return success({ ...envelope.value, visibleTotal: 101, authoritativeTotal: 101, nextOffset: 50 })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'error')
    expect(controller.getSnapshot().error?.code).toBe('SWARM_UI_PAGE_INVALID')
    controller.dispose()
  })

  it('keeps the last complete projection stale after a reconnect failure', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const schedule = new ManualSchedule()
    let fail = false
    const fetcher: SwarmFetch = async (input, init) => {
      if (fail) throw new Error('offline')
      return goodFetch(seen)(input, init)
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), schedule)
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    fail = true
    controller.connectionReset()
    schedule.fire()
    await waitFor(() => controller.getSnapshot().phase === 'stale')
    expect(controller.getSnapshot().data?.projection.team.id).toBe('team-1')
    expect(controller.getSnapshot().error?.code).toBe('SWARM_UI_READ_FAILED')
    controller.dispose()
  })

  it('aborts an admitted read when the panel closes', async () => {
    let aborted = false
    const fetcher: SwarmFetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await Promise.resolve()
    controller.close()
    await waitFor(() => aborted)
    expect(controller.getSnapshot()).toEqual({ open: false, phase: 'closed' })
    controller.dispose()
  })

  it('keeps an honest not_generated Captain identity a ready panel, distinct from a target-not-live failure (issue #175 acceptance 2)', async () => {
    // Semantic separation: an un-generated Captain identity card is NOT an error — the panel
    // reaches `ready` and the UI renders the explicit profile-incomplete markers
    // (TeamDashboardContent: profileIncomplete / profileNotGenerated), while a Captain Session
    // creation/liveness failure is a `stale`/`error` phase carrying the exact RPC code
    // (SWARM_RPC_TARGET_NOT_LIVE). The two must never blur into one another.
    const seen: SwarmReadRpcRequest[] = []
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen)), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getSnapshot().data?.teams.teams[0]?.identityCard).toEqual({
      state: 'not_generated', reason: 'identity_backend_not_implemented',
    })
    controller.dispose()

    // The failure face: a dead Captain target surfaces the authoritative error code as
    // a stale panel — never as a fabricated "not_generated" identity row.
    let fail = false
    const normal = goodFetch([])
    const failingFetcher: SwarmFetch = async (input, init) => {
      if (fail) {
        return new Response(JSON.stringify({
          schemaVersion: 1, ok: false,
          error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'Target root Session is not live' },
        }), { status: 404 })
      }
      return normal(input, init)
    }
    const schedule = new ManualSchedule()
    const failing = new TeamDashboardController(new SwarmReadClient(failingFetcher), schedule)
    failing.open('root-1')
    await waitFor(() => failing.getSnapshot().phase === 'ready')
    fail = true
    schedule.fire()
    await waitFor(() => failing.getSnapshot().phase === 'stale')
    expect(failing.getSnapshot().error?.code).toBe('SWARM_RPC_TARGET_NOT_LIVE')
    failing.dispose()
  })

  it('drives a role>256 roster to ready, not the SWARM_UI_READ_FAILED fallback, and never truncates the authoritative role', async () => {
    const longRole = '开发 writer（仅负责本 P0）：修复 SWARM_UI_READ_FAILED。在受管 lane p0-swarm-ui-read-v2（pnpm isolation open，owner terra-p0）内实施：契约一致（role 上限有界提升并同步 CONTRACT_DIGEST）'.repeat(6)
    expect(longRole.length).toBeGreaterThan(256)
    const longRoleSnapshot = {
      ...snapshot,
      roster: [{ name: 'worker', role: longRole, phase: 'active', createdAt: 1_700_000_000_000 }],
    }
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      if (request.method === 'snapshot') return success(longRoleSnapshot)
      if (request.method !== 'page') return normal(input, init)
      const rows = request.page.kind === 'tasks' ? tasks : request.page.kind === 'attempts' ? attempts : interactions
      const offset = request.page.offset ?? 0
      const limit = request.page.limit ?? 50
      const entries = rows.slice(offset, offset + limit)
      const nextOffset = offset + entries.length < rows.length ? offset + entries.length : undefined
      return success({
        kind: request.page.kind, entries, offset, limit,
        visibleTotal: rows.length, authoritativeTotal: rows.length,
        ...(nextOffset === undefined ? {} : { nextOffset }),
        projectionTruncated: false, cursor: CURSOR, changed: false, resyncRequired: false,
        observedAt: 1_700_000_006_000,
      })
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const state = controller.getSnapshot()
    // No fallback to the generic read-failed signal and no swallowed error.
    expect(state.phase).toBe('ready')
    expect(state.error).toBeUndefined()
    // The authoritative role reaches the consumer un-truncated.
    expect(state.data?.projection.roster[0]?.role).toBe(longRole)
    controller.dispose()
  })

  it('revalidates the exact binding immediately before official Captain navigation', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const controller = new TeamDashboardController(new SwarmReadClient(goodFetch(seen)), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const opened: string[] = []
    await controller.openCaptainChat(rootSessionId => { opened.push(rootSessionId) })
    expect(opened).toEqual(['root-1'])
    expect(seen.at(-1)?.method).toBe('binding')
    expect(controller.getSnapshot().phase).toBe('ready')
    controller.dispose()
  })

  it.each(['close', 'hidden'] as const)('cancels a delayed Captain handoff on %s while continuing Team discovery (#225)', async action => {
    let delay = false
    let entered = false
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const normal = goodFetch([])
    const fetcher: SwarmFetch = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as SwarmReadRpcRequest
      if (delay && request.method === 'binding') { entered = true; await gate }
      return normal(url, init)
    }
    const schedule = new ManualSchedule()
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), schedule)
    let entry: object | undefined
    const slots = { entries: () => entry === undefined ? [] : [entry], entriesOfSlot: () => entry === undefined ? [] : [entry],
      register: () => { entry = {}; return () => { entry = undefined } }, onEntryError: () => () => {}, subscribe: () => () => {} }
    const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current: 'root-1', byId: { 'root-1': {} } }), subscribe: () => () => {} } }
    const coordinator = new TeamDashboardSurfaceCoordinator({ slots, sessions, controller, locale: { getLocale: () => ({ active: 'en' }) }, anchorRef: { current: null } } as never)
    const dispose = coordinator.mount()
    const sidebar = sidebarHarness(coordinator, () => 'root-1')
    coordinator.bindSidebar(sidebar.sidebar)
    try {
      await waitFor(() => controller.getSnapshot().phase === 'ready')
      delay = true
      const navigation = coordinator.openCaptainChat().then(() => 'navigated', () => 'cancelled')
      await waitFor(() => entered)
      if (action === 'close') coordinator.closeAndRestoreFocus()
      else sidebar.hide()
      delay = false; release()
      expect(await navigation).toBe('cancelled')
      expect(schedule.pending.size).toBe(1)
      schedule.fire()
      await waitFor(() => controller.getSnapshot().phase === 'ready')
      expect(sessions.open).not.toHaveBeenCalled()
      expect(coordinator.getSnapshot().mode).toBe('inactive')
    } finally { release(); dispose() }
  })

  it('loads a captainless draft as ready and rejects a fake Captain Chat handoff', async () => {
    const seen: SwarmReadRpcRequest[] = []
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      if (request.method === 'teams') return success({ ...teams, teams: teams.teams.map(row => ({ ...row, phase: 'staged', captainSessionId: '' })) })
      if (request.method === 'binding') return success({ ...binding, team: { ...binding.team, phase: 'staged' } })
      if (request.method === 'snapshot') return success({ ...snapshot, team: { ...snapshot.team, phase: 'staged' },
        roster: [], tasks: [], attempts: [], pendingInteractions: [], totals: { roster: 0, tasks: 0, attempts: 0, pendingInteractions: 0 } })
      if (request.method === 'captainMembers') return success({ ...captainMembers, members: [] })
      if (request.method === 'captainDiagnostics') return success({ ...captainDiagnostics,
        diagnostics: { ...captainDiagnostics.diagnostics, phase: 'staged', taskCount: 0, attemptCount: 0, memberCount: 0 } })
      if (request.method === 'page') return success({ kind: request.page.kind, entries: [], offset: 0, limit: request.page.limit ?? 50,
        visibleTotal: 0, authoritativeTotal: 0, projectionTruncated: false, cursor: CURSOR, changed: false, resyncRequired: false, observedAt: snapshot.observedAt })
      return normal(input, init)
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    const opened: string[] = []
    await expect(controller.openCaptainChat(id => { opened.push(id) })).rejects.toThrow('until a Captain Session is created')
    expect(opened).toEqual([])
    expect(controller.getSnapshot().phase).toBe('ready')
    controller.dispose()
  })

  it('fails closed when the Captain binding changes before handoff', async () => {
    const seen: SwarmReadRpcRequest[] = []
    let handoff = false
    const normal = goodFetch(seen)
    const fetcher: SwarmFetch = async (input, init) => {
      const request = requestOf(init)
      if (handoff && request.method === 'binding') {
        return success({
          ...binding,
          binding: { rootSessionId: 'root-1', teamId: 'team-2' },
          team: { ...binding.team, id: 'team-2', name: 'Other Team' },
        })
      }
      return normal(input, init)
    }
    const controller = new TeamDashboardController(new SwarmReadClient(fetcher), new ManualSchedule())
    controller.open('root-1')
    await waitFor(() => controller.getSnapshot().phase === 'ready')
    handoff = true
    const opened: string[] = []
    await expect(controller.openCaptainChat(rootSessionId => { opened.push(rootSessionId) })).rejects.toThrow('changed')
    expect(opened).toEqual([])
    expect(controller.getSnapshot().phase).toBe('stale')
    controller.dispose()
  })
})
