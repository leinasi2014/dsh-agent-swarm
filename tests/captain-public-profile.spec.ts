import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { assertTeamState } from '../src/domain/state-validation.js'
import { MAX_CAPTAIN_ANNOUNCEMENTS } from '../src/domain/identity-profile.js'
import { CAPTAIN_ONLY_TOOLS } from '../src/runtime/prompts.js'
import { memberToolDeny } from '../src/runtime/tool-policy.js'
import { TeamId, type TeamAnnouncement, type TeamState } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const PIXEL = '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>'

describe('Captain public profile + announcements (permission, CAS, persistence, safety)', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  afterEach(async () => {
    if (stack !== undefined) await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function open() {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-captain-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  }

  it('enforces Captain-only writes for profile and announcements', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Perm team', 'deny members')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker', role: 'worker', sessionId: 'member-w', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-w', { active: true })

    await expect(domain.setCaptainProfile(scope, team.id, 'member-w', team.revision, { displayName: 'Hacker' }))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    await expect(domain.publishAnnouncement(scope, team.id, 'member-w', team.revision, 'hi'))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    // Captain succeeds (fetch live revision; member activation advanced it).
    const live = await domain.snapshot(scope, team.id, 'captain-session')
    const profiled = await domain.setCaptainProfile(scope, team.id, 'captain-session', live.team.revision, { displayName: 'Cap' })
    expect(profiled.captainProfile?.displayName).toBe('Cap')
    await expect(domain.publishAnnouncement(scope, team.id, 'captain-session', profiled.revision, 'hi')).resolves.toBeDefined()
  })

  it('persists the Captain profile (additive, byte-compatible absence) and requires non-empty', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Profile team', 'persist')
    const updated = await domain.setCaptainProfile(scope, team.id, 'captain-session', team.revision, {
      displayName: 'Cap', profession: 'Coordinator', personality: 'Steady', pixelAvatarSvg: PIXEL,
    })
    expect(updated.captainProfile).toMatchObject({ displayName: 'Cap', profession: 'Coordinator', pixelAvatarSvg: PIXEL })
    expect(updated.revision).toBe(team.revision + 1)

    // Reload through a fresh store: profile + absence compatibility survive.
    await stack.close(); stack = undefined as unknown as StorageStack
    let t2 = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => t2++)
    domain = stack.port as TeamDomain
    const [reloaded] = await stack.store.list(scope)
    expect(reloaded!.captainProfile?.displayName).toBe('Cap')
    expect(reloaded!.captainProfile?.pixelAvatarSvg).toBe(PIXEL)

    // An all-absent / whitespace profile is rejected (must carry at least one field).
    await expect(domain.setCaptainProfile(scope, reloaded!.id, 'captain-session', reloaded!.revision, {}))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_PROFILE_INVALID' })
    await expect(domain.setCaptainProfile(scope, reloaded!.id, 'captain-session', reloaded!.revision, { displayName: '   ' }))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_PROFILE_INVALID' })
  })

  it('rejects an unsafe Captain avatar and code-point-overlong text', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Sec team', 'reject')
    let r = team.revision
    await expect(domain.setCaptainProfile(scope, team.id, 'captain-session', r, {
      pixelAvatarSvg: '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_AVATAR_UNSAFE' })
    await expect(domain.setCaptainProfile(scope, team.id, 'captain-session', r, {
      personality: 'x'.repeat(1025),
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_IDENTITY_INVALID' })
    // 128 emoji displayName persists; 129 is rejected (code-point parity with members).
    const ok128 = await domain.setCaptainProfile(scope, team.id, 'captain-session', r, { displayName: '😀'.repeat(128) })
    r = ok128.revision
    await expect(domain.setCaptainProfile(scope, team.id, 'captain-session', r, { displayName: '😀'.repeat(129) }))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_IDENTITY_INVALID' })
  })

  it('CAS-fences concurrent set_captain_profile on expected_revision', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'CAS team', 'profile cas')
    // Same stale revision loses.
    await expect(domain.setCaptainProfile(scope, team.id, 'captain-session', team.revision + 1, { displayName: 'A' }))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    const winner = await domain.setCaptainProfile(scope, team.id, 'captain-session', team.revision, { displayName: 'Winner' })
    expect(winner.captainProfile?.displayName).toBe('Winner')
    // A second writer racing from the now-stale original revision fails.
    await expect(domain.setCaptainProfile(scope, team.id, 'captain-session', team.revision, { displayName: 'Loser' }))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
  })

  it('publishes announcements with expected_revision CAS, bounding and restart persistence', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Ann team', 'announce')
    let revision = team.revision

    // Wrong expected revision fails loud (CAS); a sub-1 revision is invalid input.
    await expect(domain.publishAnnouncement(scope, team.id, 'captain-session', revision + 1, 'future'))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    await expect(domain.publishAnnouncement(scope, team.id, 'captain-session', 0, 'invalid-axis'))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })

    // Correct CAS appends and bumps revision atomically.
    const first = await domain.publishAnnouncement(scope, team.id, 'captain-session', revision, 'First.')
    expect(first.announcement.text).toBe('First.')
    expect(first.team.revision).toBe(revision + 1)
    revision = first.team.revision
    const second = await domain.publishAnnouncement(scope, team.id, 'captain-session', revision, 'Second.')
    expect(second.team.announcements).toHaveLength(2)
    expect(second.team.revision).toBe(revision + 1)

    // Empty / overlong text rejected before commit.
    await expect(domain.publishAnnouncement(scope, team.id, 'captain-session', second.team.revision, '   '))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_ANNOUNCEMENT_INVALID' })
    await expect(domain.publishAnnouncement(scope, team.id, 'captain-session', second.team.revision, 'x'.repeat(4097)))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_ANNOUNCEMENT_INVALID' })

    // Reload: announcements survive restart. Use a monotonic (never-reset) clock so
    // subsequent publishes keep non-decreasing createdAt after the restart.
    await stack.close(); stack = undefined as unknown as StorageStack
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    const [reloaded] = await stack.store.list(scope)
    expect(reloaded!.announcements?.map((a: TeamAnnouncement) => a.text)).toEqual(['First.', 'Second.'])

    // Announcement list is bounded: fill to the limit, then the next must fail.
    const existing = (reloaded!.announcements ?? []).length
    let r = reloaded!.revision
    for (let i = 0; i < MAX_CAPTAIN_ANNOUNCEMENTS - existing; i += 1) {
      await domain.publishAnnouncement(scope, reloaded!.id, 'captain-session', r, `bulk-${i}`)
      r += 1
    }
    await expect(domain.publishAnnouncement(scope, reloaded!.id, 'captain-session', r, 'overflow'))
      .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_ANNOUNCEMENT_LIMIT' })
  })

  it('rejects crafted captainProfile/announcement state via assertTeamState', () => {
    const base = {
      schemaVersion: 2,
      id: TeamId('team-aaaaaaaaaaaaaaaaaaaa'),
      revision: 3,
      name: 'T', description: 'D', captainSessionId: 'c', phase: 'active',
      members: [],
      captainProfile: { displayName: 'Cap' },
      announcements: [
        { id: 'ann-00000000-0000-0000-0000-000000000001', text: 'First.', createdAt: 100 },
        { id: 'ann-00000000-0000-0000-0000-000000000002', text: 'Second.', createdAt: 200 },
      ],
      tasks: [], attempts: [], messages: [], interactionEffects: [], memory: [],
      budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
      usageCursors: {}, nextTaskNumber: 1, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
    } as unknown as TeamState
    expect(() => assertTeamState(base, 'ok')).not.toThrow()

    const clone = (): TeamState => structuredClone(base) as TeamState
    // Empty / non-object captainProfile rejected.
    const emptyProfile = clone() as { captainProfile: unknown }
    emptyProfile.captainProfile = {}
    expect(() => assertTeamState(emptyProfile, 'emptyProfile')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
    const strProfile = clone() as { captainProfile: unknown }
    strProfile.captainProfile = 'not-an-object'
    expect(() => assertTeamState(strProfile, 'strProfile')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))

    // Malformed announcement id, duplicate id, untrimmed text, non-decreasing createdAt.
    const mutable = (state: TeamState): Array<{ id: string; text: string; createdAt: number }> =>
      state.announcements as unknown as Array<{ id: string; text: string; createdAt: number }>
    const badId = clone(); mutable(badId)[1]!.id = 'x'
    expect(() => assertTeamState(badId, 'badId')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
    const dup = clone(); mutable(dup)[1]!.id = mutable(dup)[0]!.id
    expect(() => assertTeamState(dup, 'dup')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
    const untrimmed = clone(); mutable(untrimmed)[0]!.text = '  padded  '
    expect(() => assertTeamState(untrimmed, 'untrimmed')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
    const unordered = clone(); mutable(unordered)[1]!.createdAt = 50
    expect(() => assertTeamState(unordered, 'unordered')).toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
  })

  it('is surfaced on the Captain-only and delegated-member tool deny surfaces', () => {
    expect(CAPTAIN_ONLY_TOOLS).toContain('agent_swarm_set_captain_profile')
    expect(CAPTAIN_ONLY_TOOLS).toContain('agent_swarm_publish_announcement')
    const deny = memberToolDeny([])
    expect(deny).toContain('agent_swarm_set_captain_profile')
    expect(deny).toContain('agent_swarm_publish_announcement')
  })
})
