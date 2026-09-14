/**
 * RED→GREEN regression for the member-profile CAS scope (3096 evidence).
 * A member row without a verifiable own profile version keeps the exact
 * global-revision CAS; the member's first save at the exact current revision
 * establishes the version. From then on saving one's OWN identity profile
 * must not collide with unrelated Team activity (another member's profile
 * save, an announcement, task/mail traffic) that advances the global Team
 * revision. The genuine protection that must survive is the compare-and-swap
 * against CONCURRENT changes of THIS member's own profile: once the profile
 * itself moved past the revision the caller read, the stale save must still
 * fail loud with TEAM_REVISION_CONFLICT carrying expected vs current and a
 * recovery path — across a real reopen too.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamState } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const PIXEL = '<svg viewBox="0 0 16 16">'
  + '<rect x="0" y="0" width="8" height="8" fill="#2a3"/>'
  + '<rect x="8" y="8" width="4" height="4" fill="#ff00aa"/>'
  + '</svg>'

describe('member profile save decoupled from unrelated Team activity', () => {
  let sandbox: string
  let scope: string
  let stack: StorageStack
  let domain: TeamDomain

  afterEach(async () => {
    if (stack !== undefined) await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function open() {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-decouple-'))
    scope = join(sandbox, 'workspace')
    let tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick)
    domain = stack.port as TeamDomain
  }

  async function teamWithTwoMembers(name: string): Promise<TeamState> {
    const team = await domain.createTeam(scope, 'captain-session', name, 'Verify profile CAS scope.')
    for (const member of ['writer', 'reviewer']) {
      await domain.provisionMember(scope, team.id, 'captain-session', {
        name: member, role: member, sessionId: `${member}-session`, provider: 'spawn',
      })
      await domain.settleMember(scope, team.id, `${member}-session`, { active: true })
    }
    return (await stack.store.list(scope))[0]!
  }

  it('the second step of the two-step profile→avatar save survives unrelated Team activity', async () => {
    await open()
    const team = await teamWithTwoMembers('Two-step save under churn')

    // Step 1: writer reads the current revision once and saves its text
    // fields. The four text fields are all present before the avatar step —
    // as in the real recruitment flow (Captain recruits WITH a profession) —
    // because assertAvatarProfile deliberately gates a standalone avatar save
    // on a complete profile (pinned by member-identity-profile.spec).
    const observed = (await stack.store.list(scope))[0]!
    const introduced = await domain.setMemberProfile(scope, team.id, 'writer-session', observed.revision, 'writer', {
      displayName: '林墨', profession: '编剧', personality: '细致、耐心', biography: '我负责人物动机。',
    })

    // Unrelated Team activity: reviewer completes its OWN profile and the
    // Captain publishes an announcement. Neither touches writer's fields, but
    // both advance the global Team revision past `introduced.revision`.
    const afterWriter = (await stack.store.list(scope))[0]!
    await domain.setMemberProfile(scope, team.id, 'reviewer-session', afterWriter.revision, 'reviewer', { biography: 'Reviewer note.' })
    const afterReviewer = (await stack.store.list(scope))[0]!
    await domain.publishAnnouncement(scope, team.id, 'captain-session', afterReviewer.revision, 'Milestone reached.')
    const drifted = (await stack.store.list(scope))[0]!
    expect(drifted.revision).toBeGreaterThan(introduced.revision)

    // Step 2: writer saves the avatar with the revision from ITS OWN last
    // read-back. Its profile never moved, so this must succeed despite drift.
    const completed = await domain.setMemberProfile(scope, team.id, 'writer-session', introduced.revision, 'writer', { pixelAvatarSvg: PIXEL })
    const writer = completed.members.find(member => member.name === 'writer')!
    expect(writer.pixelAvatarSvg).toBe(PIXEL)
    expect(writer.displayName).toBe('林墨')
    expect(writer.biography).toBe('我负责人物动机。')

    // Durable: a fresh store over the same root reloads the identical member
    // row (the profile-window marker must survive the zod durable boundary).
    await stack.close(); stack = undefined as unknown as StorageStack
    let tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick)
    domain = stack.port as TeamDomain
    const [reloaded] = await stack.store.list(scope)
    expect(reloaded!.members.find(member => member.name === 'writer')).toEqual(writer)
  })

  it('a stale save still conflicts when THIS member profile changed after the caller read it', async () => {
    await open()
    const team = await teamWithTwoMembers('Concurrent profile guard')
    const before = (await stack.store.list(scope))[0]!

    // The Captain concurrently patches writer's profession — a real change to
    // THIS member's profile — after writer read `before.revision`.
    await domain.setMemberProfile(scope, team.id, 'captain-session', before.revision, 'writer', { profession: '电影编剧' })
    const winner = (await stack.store.list(scope))[0]!

    // writer's in-flight save at the now-stale revision must fail loud and
    // write NOTHING: the profile keeps exactly the winner's value, and the
    // loser's own field never lands.
    const failure = await domain
      .setMemberProfile(scope, team.id, 'writer-session', before.revision, 'writer', { personality: '外向' })
      .then(() => { throw new Error('expected TEAM_REVISION_CONFLICT') }, error => error)
    expect(failure).toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    expect(failure.message).toContain(`expected ${before.revision}, current ${winner.revision}`)
    expect(failure.message).toContain('nothing was written')
    expect((await stack.store.list(scope))[0]).toEqual(winner)

    const writer = winner.members.find(member => member.name === 'writer')!
    expect(writer.profession).toBe('电影编剧')
    expect(writer.personality).toBeUndefined()
    expect(writer.profileChangedAtRevision).toBeTypeOf('number')

    // Recoverable: re-reading the fresh revision lets the loser land its own
    // remaining field next to the winner's patch.
    const recovered = await domain.setMemberProfile(scope, team.id, 'writer-session', winner.revision, 'writer', { personality: '外向' })
    const finalWriter = recovered.members.find(member => member.name === 'writer')!
    expect(finalWriter).toMatchObject({ profession: '电影编剧', personality: '外向' })
  })

  it('keeps the exact-revision CAS on a marker-less legacy row until the member establishes its own version', async () => {
    await open()
    const team = await teamWithTwoMembers('Legacy row compatibility')
    const observed = (await stack.store.list(scope))[0]!
    await domain.setMemberProfile(scope, team.id, 'writer-session', observed.revision, 'writer', {
      displayName: '老架构', profession: '资深', biography: '升级前写入的资料。',
    })
    const stamped = (await stack.store.list(scope))[0]!

    // Rebuild the same aggregate as a legacy row: the profile exists but its
    // change history predates this protocol, so the persisted record carries
    // NO version marker — its own-version history is UNKNOWN.
    const legacy = structuredClone(stamped)
    delete (legacy.members.find(member => member.name === 'writer') as { profileChangedAtRevision?: number }).profileChangedAtRevision
    await stack.close(); stack = undefined as unknown as StorageStack
    let tick = 1_000
    stack = await openStorageStack(join(sandbox, 'legacy-storage'), () => tick)
    domain = stack.port as TeamDomain
    await stack.store.importAggregate(scope, legacy)
    const beforeLegacy = (await stack.store.list(scope))[0]!

    // Without a verifiable own version there is NO fail-open: a stale
    // observation is rejected outright and the existing profile values stand.
    const stale = await domain.setMemberProfile(scope, team.id, 'writer-session', beforeLegacy.revision - 1, 'writer', { biography: '陈旧覆盖' })
      .then(() => { throw new Error('expected TEAM_REVISION_CONFLICT') }, error => error)
    expect(stale).toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    expect((await stack.store.list(scope))[0]).toEqual(beforeLegacy)
    expect(beforeLegacy.members.find(member => member.name === 'writer')?.biography).toBe('升级前写入的资料。')

    // The member's first save at the EXACT current revision establishes the
    // verifiable own version (the marker is stamped at the committing revision).
    const established = await domain.setMemberProfile(scope, team.id, 'writer-session', beforeLegacy.revision, 'writer', { personality: '沉稳' })
    const writerEstablished = established.members.find(member => member.name === 'writer')!
    expect(writerEstablished.profileChangedAtRevision).toBe(established.revision)
    expect(writerEstablished.biography).toBe('升级前写入的资料。')

    // From the established version on, unrelated Team activity does not
    // conflict: reviewer completes its own profile and the Captain announces.
    await domain.setMemberProfile(scope, team.id, 'reviewer-session', established.revision, 'reviewer', { biography: 'Reviewer note.' })
    const afterReviewer = (await stack.store.list(scope))[0]!
    await domain.publishAnnouncement(scope, team.id, 'captain-session', afterReviewer.revision, 'Legacy repair done.')
    const drifted = (await stack.store.list(scope))[0]!
    expect(drifted.revision).toBeGreaterThan(established.revision)
    const completed = await domain.setMemberProfile(scope, team.id, 'writer-session', established.revision, 'writer', { pixelAvatarSvg: PIXEL })
    expect(completed.members.find(member => member.name === 'writer')?.pixelAvatarSvg).toBe(PIXEL)

    // Real reopen: the established version and profile survive the durable
    // boundary, and the window still protects after the reload.
    const persisted = (await stack.store.list(scope))[0]!
    await stack.close(); stack = undefined as unknown as StorageStack
    stack = await openStorageStack(join(sandbox, 'legacy-storage'), () => tick)
    domain = stack.port as TeamDomain
    expect((await stack.store.list(scope))[0]).toEqual(persisted)
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', persisted.revision - 1, 'writer', { personality: '过期的旧观察' }))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
  })

  it('refuses profile writes for rotated Sessions, other Teams, removed members and a closed runtime', async () => {
    await open()
    const team = await teamWithTwoMembers('Boundary refusals')
    const other = await domain.createTeam(scope, 'other-captain', 'Other team', 'Cross-team write must be refused.')

    // Rotated Session: the failed employee is recovered under a new Session;
    // the superseded Session loses write authority immediately.
    await domain.settleMember(scope, team.id, 'reviewer-session', { active: false, error: 'provisioning failed' })
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'reviewer', role: 'reviewer', sessionId: 'reviewer-session-2', provider: 'spawn', retryOf: 'reviewer-session',
    })
    await domain.settleMember(scope, team.id, 'reviewer-session-2', { active: true })
    await expect(domain.setMemberProfile(scope, team.id, 'reviewer-session', (await stack.store.list(scope))[0]!.revision, 'reviewer', { biography: '旧Session' }))
      .rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    // Cross-Team: a real member of one Team cannot write into another Team.
    await expect(domain.setMemberProfile(scope, other.id, 'writer-session', other.revision, 'writer', { biography: '跨队伪造' }))
      .rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    // Peer forgery stays role-refused and never learns the revision.
    const peer = await domain.setMemberProfile(scope, team.id, 'writer-session', (await stack.store.list(scope))[0]!.revision, 'reviewer', { biography: 'peer forged' })
      .then(() => { throw new Error('expected rejection') }, error => error)
    expect(peer).toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    expect(peer.message).not.toContain('current')

    // Removed member: terminal roster row, no further writes under any revision.
    await domain.removeMember(scope, team.id, 'captain-session', 'writer', 'test completed')
    const afterRemoval = (await stack.store.list(scope))[0]!
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', afterRemoval.revision, 'writer', { biography: 'removed' }))
      .rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })

    // Closed runtime: the durable store refuses every write after close.
    await stack.close()
    stack = undefined as unknown as StorageStack
    await expect(domain.setMemberProfile(scope, team.id, 'reviewer-session-2', afterRemoval.revision, 'reviewer', { biography: '关闭后' }))
      .rejects.toMatchObject({ code: 'TEAM_STORE_CLOSED' })
  })
})
