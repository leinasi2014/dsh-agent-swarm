import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import {
  MAX_PIXEL_AVATAR_LENGTH,
  isSafePixelAvatarSvg,
  normalizeMemberIdentity,
  sanitizePixelAvatarSvg,
} from '../src/domain/identity-profile.js'
import { normalizeMemberName } from '../src/domain/team-domain-shared.js'
import { assertTeamState } from '../src/domain/state-validation.js'
import type { TeamState } from '../src/domain/types.js'
import { TeamId } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const PIXEL = '<svg viewBox="0 0 16 16">'
  + '<rect x="0" y="0" width="8" height="8" fill="#2a3"/>'
  + '<rect x="8" y="8" width="4" height="4" fill="#ff00aa"/>'
  + '<rect x="12" y="12" width="2" height="2" fill="currentColor" opacity="0.5"/>'
  + '</svg>'

describe('pixel avatar strict allowlist (security)', () => {
  it('accepts a real single-root rect-only pixel avatar (incl. N=8..32, #RGB/#RRGGBB/currentColor)', () => {
    expect(sanitizePixelAvatarSvg(PIXEL)).toBe(PIXEL)
    expect(isSafePixelAvatarSvg(PIXEL)).toBe(true)
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 32 32"><rect x="0" y="0" width="32" height="32" fill="#000"/></svg>')).toBe(true)
  })

  it('rejects scripts, event handlers, external links and foreign content', () => {
    const cases = [
      '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#fff" onload="x()"/></svg>',
      '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#fff" onmouseover="x()"/></svg>',
      '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#fff" href="http://x"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#fff"/></svg>',
      '<svg viewBox="0 0 16 16"><foreignObject><div /></foreignObject></svg>',
      '<svg viewBox="0 0 16 16"><style>rect{}</style></svg>',
      '<svg viewBox="0 0 16 16"><rect style="fill:#fff" x="0" y="0" width="2" height="2"/></svg>',
      '<svg viewBox="0 0 16 16"><rect xlink:href="#x" x="0" y="0" width="2" height="2" fill="#fff"/></svg>',
      '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="url(#grad)"/></svg>',
      '<svg viewBox="0 0 16 16"><animate attributeName="x" from="0" to="10"/></svg>',
      '<svg viewBox="0 0 16 16">&#x41;</svg>',
    ]
    for (const value of cases) {
      expect(isSafePixelAvatarSvg(value), value).toBe(false)
      expect(() => sanitizePixelAvatarSvg(value)).toThrowError(expect.objectContaining({ code: 'TEAM_MEMBER_AVATAR_UNSAFE' }))
    }
  })

  it('rejects non-rect elements and disallowed attributes outright', () => {
    const elements = ['g', 'path', 'circle', 'ellipse', 'line ', 'polyline', 'polygon', 'text', 'use', 'image', 'a ']
    for (const element of elements) {
      expect(isSafePixelAvatarSvg(`<svg viewBox="0 0 16 16"><${element.trim()} /></svg>`), element).toBe(false)
    }
    for (const attr of ['transform', 'id', 'class', 'stroke', 'rx', 'style', 'filter', 'mask']) {
      expect(isSafePixelAvatarSvg(`<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#fff" ${attr}="x"/></svg>`), attr).toBe(false)
    }
    // A non-self-closing rect (open tag) is rejected as well.
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#fff"></rect></svg>')).toBe(false)
  })

  it('rejects root width/height (only viewBox is allowlisted on the root)', () => {
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 16 16" width="64" height="64"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg width="64" viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>')).toBe(false)
  })

  it('rejects out-of-range viewBox, malformed shapes, overflow and overlong input', () => {
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 40 40"><rect x="0" y="0" width="2" height="2" fill="#fff"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 4 4"><rect x="0" y="0" width="2" height="2" fill="#fff"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 16 8"><rect x="0" y="0" width="2" height="2" fill="#fff"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg><rect x="0" y="0" width="2" height="2" fill="#fff"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<rect x="0" y="0" width="2" height="2" fill="#fff"/>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="rgb(1,2,3)"/></svg>')).toBe(false)
    expect(isSafePixelAvatarSvg('<svg viewBox="0 0 16 16"><rect x="0" y="0" width="2" height="2" fill="#12345"/></svg>')).toBe(false)
    // > 256 rects
    const overflow = '<svg viewBox="0 0 16 16">' + '<rect x="0" y="0" width="1" height="1" fill="#fff"/>'.repeat(257) + '</svg>'
    expect(isSafePixelAvatarSvg(overflow)).toBe(false)
    // > 16KB
    const big = '<svg viewBox="0 0 16 16">' + '<rect x="0" y="0" width="1" height="1" fill="#fff"/>'.repeat(1000) + '</svg>'
    expect([...big].length).toBeGreaterThan(MAX_PIXEL_AVATAR_LENGTH)
    expect(isSafePixelAvatarSvg(big)).toBe(false)
  })

  it('normalizes free-text identity with width bounds and rejects oversized fields', () => {
    expect(normalizeMemberIdentity({})).toEqual({})
    expect(normalizeMemberIdentity({ displayName: '  Pixel Painter  ', profession: 'artist', personality: 'calm' })).toEqual({
      displayName: 'Pixel Painter', profession: 'artist', personality: 'calm',
    })
    // Empty strings mean absent -> the read will report not_generated.
    expect(normalizeMemberIdentity({ displayName: '   ' })).toEqual({})
    expect(() => normalizeMemberIdentity({ personality: 'x'.repeat(1025) }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_MEMBER_IDENTITY_INVALID' }))
  })
})

describe('identity profile provisioning, persistence and compatibility', () => {
  let sandbox: string
  let scope: string
  let stack: StorageStack
  let domain: TeamDomain

  afterEach(async () => {
    if (stack !== undefined) await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function open() {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-identity-'))
    scope = join(sandbox, 'workspace')
    let tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick)
    domain = stack.port as TeamDomain
  }

  it('reserves personal identity for its member while letting the Captain recruit and update a profession', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Self-owned identity', 'Recruit expertise; members introduce themselves.')
    const personal = { displayName: '林墨', personality: '细致、耐心', biography: '擅长人物动机和对白。', pixelAvatarSvg: PIXEL }
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'writer', role: '剧本创作', sessionId: 'writer-session', provider: 'spawn', ...personal,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_PROFILE_OWNER_REQUIRED' })
    expect((await stack.store.list(scope))[0]?.members).toEqual([])
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'writer', role: '剧本创作', sessionId: 'writer-session', provider: 'spawn', profession: '编剧',
    })
    await domain.settleMember(scope, team.id, 'writer-session', { active: true })
    let current = (await stack.store.list(scope))[0]!
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', current.revision, 'writer', personal))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_AVATAR_PROFILE_REQUIRED' })
    expect((await stack.store.list(scope))[0]).toEqual(current)
    const { pixelAvatarSvg, ...introduction } = personal
    current = await domain.setMemberProfile(scope, team.id, 'writer-session', current.revision, 'writer', introduction)
    current = await domain.setMemberProfile(scope, team.id, 'writer-session', current.revision, 'writer', { pixelAvatarSvg })
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', current.revision, 'writer', { personality: '外向', pixelAvatarSvg }))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_AVATAR_PROFILE_REQUIRED' })
    for (const [field, value] of Object.entries(personal)) {
      await expect(domain.setMemberProfile(scope, team.id, 'captain-session', current.revision, 'writer', { [field]: value }))
        .rejects.toMatchObject({ code: 'TEAM_MEMBER_PROFILE_OWNER_REQUIRED' })
    }
    expect((await stack.store.list(scope))[0]).toEqual(current)
    const updated = await domain.setMemberProfile(scope, team.id, 'captain-session', current.revision, 'writer', { profession: '电影编剧' })
    expect(updated.members[0]).toMatchObject({ ...personal, profession: '电影编剧' })
  })

  it('persists a member-authored identity profile in the Team aggregate and reloads it', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Identity team', 'Verify persistence.')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'painter', role: 'artist', sessionId: 'member-painter', provider: 'spawn', profession: 'Avatar artist',
    })
    await domain.settleMember(scope, team.id, 'member-painter', { active: true })
    let current = (await stack.store.list(scope))[0]!
    current = await domain.setMemberProfile(scope, team.id, 'member-painter', current.revision, 'painter', {
      displayName: 'Pixel Painter', personality: 'Careful, meticulous',
      biography: 'Explains visual choices and checks the original reference.',
    })
    current = await domain.setMemberProfile(scope, team.id, 'member-painter', current.revision, 'painter', { pixelAvatarSvg: PIXEL })
    expect(current.members[0]!.pixelAvatarSvg).toBe(PIXEL)
    expect(current.members[0]!.displayName).toBe('Pixel Painter')

    // Reload the aggregate through a fresh store over the same storage root.
    await stack.close(); stack = undefined as unknown as StorageStack
    let tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick)
    domain = stack.port as TeamDomain
    const [reloaded] = await stack.store.list(scope)
    expect(reloaded).toBeDefined()
    const reloadedMember = reloaded!.members.find(candidate => candidate.sessionId === 'member-painter')
    expect(reloadedMember).toMatchObject({
      name: 'painter', displayName: 'Pixel Painter', profession: 'Avatar artist',
      personality: 'Careful, meticulous', pixelAvatarSvg: PIXEL,
      biography: 'Explains visual choices and checks the original reference.',
    })
  })

  it('keeps pre-feature members (no identity) byte-compatible and reports absent fields', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Legacy team', 'Verify compatibility.')
    const plain = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'legacy', role: 'writer', sessionId: 'member-legacy', provider: 'spawn',
    })
    expect(plain.pixelAvatarSvg).toBeUndefined()
    expect(plain.displayName).toBeUndefined()
    // The stored aggregate validates as TeamState with the identity fields absent.
    const [stored] = await stack.store.list(scope)
    expect(() => assertTeamState(stored, 'stored')).not.toThrow()
  })

  it('normalizes a bounded biography independently and preserves it on a biography-only Captain', async () => {
    expect(normalizeMemberIdentity({ biography: '  Reviews assumptions.  ' })).toEqual({ biography: 'Reviews assumptions.' })
    expect(normalizeMemberIdentity({ biography: '  ' })).toEqual({})
    expect(() => normalizeMemberIdentity({ biography: '😀'.repeat(1025) })).toThrowError(expect.objectContaining({ code: 'TEAM_MEMBER_IDENTITY_INVALID' }))
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Biography team', 'Verify identity.')
    const updated = await domain.setCaptainProfile(scope, team.id, 'captain-session', team.revision, { biography: 'Coordinates evidence-based reviews.' })
    expect(updated.captainProfile).toEqual({ biography: 'Coordinates evidence-based reviews.' })
    expect(() => assertTeamState(updated, 'biography-only Captain')).not.toThrow()
  })

  it('patches existing profiles with CAS while preserving member identity and unrelated fields', async () => {
    await open()
    let team = await domain.createTeam(scope, 'captain-session', 'Profile repair', 'Backfill legacy identities.')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'writer', role: 'writer', sessionId: 'writer-session', provider: 'spawn',
      profession: 'Screenwriter', assignedSkills: ['alpha'],
    })
    await domain.settleMember(scope, team.id, 'writer-session', { active: true })
    team = (await stack.store.list(scope))[0]!
    team = await domain.setMemberProfile(scope, team.id, 'writer-session', team.revision, 'writer', { displayName: 'Writer', personality: 'Patient', biography: 'Builds character motives.' })
    team = await domain.setMemberProfile(scope, team.id, 'writer-session', team.revision, 'writer', { pixelAvatarSvg: PIXEL })
    const member = team.members[0]!
    const updated = await domain.setMemberProfile(scope, team.id, 'writer-session', team.revision, 'writer', { biography: 'Develops dialogue.' })
    expect(updated.members[0]).toEqual({ ...member, biography: 'Develops dialogue.' })
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', team.revision, 'writer', { biography: 'stale' })).rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    await expect(domain.setMemberProfile(scope, team.id, 'unknown-session', updated.revision, 'writer', { biography: 'forged' })).rejects.toBeDefined()
    let captain = await domain.setCaptainProfile(scope, team.id, 'captain-session', updated.revision, { displayName: 'Lead', profession: 'Editor' })
    captain = await domain.setCaptainProfile(scope, team.id, 'captain-session', captain.revision, { biography: 'Checks coherence.' })
    expect(captain.captainProfile).toEqual({ displayName: 'Lead', profession: 'Editor', biography: 'Checks coherence.' })
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'))
    expect((await stack.store.list(scope))[0]?.members[0]).toEqual(updated.members[0])
  })

  it('rejects an unsafe pixel avatar at provisioning with no roster side effect', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Sec team', 'Verify rejection.')
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'evil', role: 'artist', sessionId: 'member-evil', provider: 'spawn',
      pixelAvatarSvg: '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_AVATAR_UNSAFE' })
    const [after] = await stack.store.list(scope)
    expect(after!.members.find(candidate => candidate.name === normalizeMemberName('evil'))).toBeUndefined()
  })

  it('lets an active member patch only its own profile, with CAS and no role or skill authority', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Self profile', 'Members complete their own public profiles.')
    for (const name of ['writer', 'reviewer']) {
      await domain.provisionMember(scope, team.id, 'captain-session', { name, role: name, sessionId: `${name}-session`, provider: 'spawn', assignedSkills: ['alpha'] })
      await domain.settleMember(scope, team.id, `${name}-session`, { active: true })
    }
    const before = (await stack.store.list(scope))[0]!
    const introduced = await domain.setMemberProfile(scope, team.id, 'writer-session', before.revision, 'writer', { displayName: '林墨', profession: '编剧', personality: '仔细', biography: '我负责人物动机。' })
    const updated = await domain.setMemberProfile(scope, team.id, 'writer-session', introduced.revision, 'writer', { pixelAvatarSvg: PIXEL })
    expect(updated.members[0]).toEqual({ ...before.members[0], displayName: '林墨', profession: '编剧', personality: '仔细', biography: '我负责人物动机。', pixelAvatarSvg: PIXEL })
    expect(updated.members[1]).toEqual(before.members[1])
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', updated.revision, 'reviewer', { biography: 'forged' })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    await expect(domain.setCaptainProfile(scope, team.id, 'writer-session', updated.revision, { biography: 'forged' })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', before.revision, 'writer', { biography: 'stale' })).rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', updated.revision, 'writer', { assignedSkills: ['new'] })).rejects.toMatchObject({ code: 'TEAM_MEMBER_IDENTITY_INVALID' })
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', updated.revision, 'writer', { pixelAvatarSvg: '<svg><script/></svg>' })).rejects.toMatchObject({ code: 'TEAM_MEMBER_AVATAR_UNSAFE' })
    expect((await stack.store.list(scope))[0]).toEqual(updated)
    const removed = await domain.removeMember(scope, team.id, 'captain-session', 'writer', 'test completed')
    const afterRemoval = (await stack.store.list(scope))[0]!
    expect(removed.member.phase).toBe('removed')
    await expect(domain.setMemberProfile(scope, team.id, 'writer-session', afterRemoval.revision, 'writer', { biography: 'removed' })).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'))
    expect((await stack.store.list(scope))[0]).toEqual(afterRemoval)
  })

  it('validates persisted identity fields via assertTeamState', () => {
    const base = {
      schemaVersion: 2,
      id: TeamId('team-aaaaaaaaaaaaaaaaaaaa'),
      revision: 1,
      name: 'T', description: 'D', captainSessionId: 'c', phase: 'active',
      members: [{
        name: 'm', role: 'r', sessionId: 's', provider: 'spawn', phase: 'active', createdAt: 1,
        displayName: 'D', profession: 'P', personality: 'Q', pixelAvatarSvg: PIXEL,
      }],
      tasks: [], attempts: [], messages: [], interactionEffects: [], memory: [],
      budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
      usageCursors: {}, nextTaskNumber: 1, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
    } as unknown as TeamState
    expect(() => assertTeamState(base, 'state')).not.toThrow()

    // A crafted unsafe stored pixel avatar is rejected by the persisted-state
    // validator (durable/state revalidation).
    const unsafeSvg = structuredClone(base)
    ;(unsafeSvg.members[0] as { pixelAvatarSvg: string }).pixelAvatarSvg = '<svg viewBox="0 0 16 16"><g/></svg>'
    expect(() => assertTeamState(unsafeSvg, 'unsafeSvg'))
      .toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
  })

  it('persisted identity text uses code-point limits (128 emoji PASS reload, 129 FAIL)', async () => {
    await open()
    const team = await domain.createTeam(scope, 'captain-session', 'Emoji team', 'Code-point length limits.')
    const display128 = '😀'.repeat(128)
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'emoji', role: 'writer', sessionId: 'member-emoji', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-emoji', { active: true })
    const current = (await stack.store.list(scope))[0]!
    const updated = await domain.setMemberProfile(scope, team.id, 'member-emoji', current.revision, 'emoji', { displayName: display128 })
    expect([...updated.members[0]!.displayName!].length).toBe(128)

    // Reload: the durable zod boundary (code-point capped, not UTF-16) accepts
    // 128 emoji even though they are 256 UTF-16 code units.
    await stack.close(); stack = undefined as unknown as StorageStack
    let tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick)
    domain = stack.port as TeamDomain
    const [reloaded] = await stack.store.list(scope)
    const reloadedMember = reloaded!.members.find(candidate => candidate.sessionId === 'member-emoji')
    expect(reloadedMember?.displayName).toBe(display128)

    // 129 emoji (129 code points) is rejected at admission ...
    await expect(domain.provisionMember(scope, reloaded!.id, 'captain-session', {
      name: 'emoji-129', role: 'writer', sessionId: 'member-emoji-129', provider: 'spawn',
      displayName: '😀'.repeat(129),
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_IDENTITY_INVALID' })

    // ... and a crafted 129-emoji persisted state is rejected by assertTeamState.
    const state128 = {
      schemaVersion: 2,
      id: reloaded!.id, revision: reloaded!.revision,
      name: reloaded!.name, description: reloaded!.description, captainSessionId: reloaded!.captainSessionId,
      phase: reloaded!.phase,
      members: [{ name: 'x', role: 'r', sessionId: 's9', provider: 'spawn', phase: 'active', createdAt: 1, displayName: display128 }],
      tasks: reloaded!.tasks, attempts: reloaded!.attempts, messages: reloaded!.messages,
      interactionEffects: reloaded!.interactionEffects, memory: reloaded!.memory,
      budget: reloaded!.budget, usageCursors: reloaded!.usageCursors,
      nextTaskNumber: reloaded!.nextTaskNumber, nextMemoryNumber: reloaded!.nextMemoryNumber,
      createdAt: reloaded!.createdAt, updatedAt: reloaded!.updatedAt,
    } as unknown as TeamState
    expect(() => assertTeamState(state128, 'state128')).not.toThrow()
    const state129 = structuredClone(state128)
    ;(state129.members[0] as { displayName: string }).displayName = '😀'.repeat(129)
    expect(() => assertTeamState(state129, 'state129'))
      .toThrowError(expect.objectContaining({ code: 'TEAM_STATE_CORRUPT' }))
  })
})
