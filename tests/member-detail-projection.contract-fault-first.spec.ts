/**
 * Fault-first contract tests for the Workbench V3 "member detail" public
 * read projection.
 *
 * The member-detail panel consumes two real read contracts:
 *   - `captainMembers` identity/profile row (name, role/profession,
 *     personality, pixel avatar, growth) — the Team aggregate authority plus
 *     the member's own continuity descriptor.
 *   - the host `snapshot` projection (roster/tasks/attempts) from which the
 *     current task + status and the most recent outcome are derived.
 *
 * Contract target fields (the member-detail surface):
 *   1. 姓名 (name)                    -> row.name / displayName
 *   2. 职位/职业 (role / profession)   -> row.role, row.profession?
 *   3. 性格 (personality)             -> row.personality?
 *   4. 像素 SVG 头像 (pixel avatar)   -> row.avatar.{state,svg}
 *   5. Skills                         -> row.growth.skills      [RED: not delivered]
 *   6. 可调用工具 (callable tools)     -> row.skills/callableTools [RED: not delivered]
 *   7. 当前任务及状态 (current task)  -> snapshot tasks/attempts derived
 *   8. 最近 outcome (recent outcome)  -> snapshot attempts derived
 *   9. 成长/经验摘要 (growth summary)  -> row.growthSummary       [RED: not delivered]
 *
 * These tests are written BEFORE the missing detail fields exist: every
 * TARGET_* group asserts a contract the frozen schema does not yet admit, so
 * the suite is RED against the unchanged implementation, and each assertion
 * goes green only when the member-detail read actually ships that field.
 * The fail-closed pin (a member row with no identity-card profile) stays a
 * green honesty guard: missing/abnormal asset data must degrade to explicit
 * "not generated / not available" markers, never crash the projection.
 *
 * Only public read-contract types and the frozen artifact are referenced; no
 * product code is modified and no evidence/documentation is registered here.
 */
import { describe, expect, it } from 'vitest'
import {
  assertSwarmReadRpcValue,
  SWARM_READ_RPC_CONTRACT_V1,
  SWARM_READ_RPC_FIXTURES_V1,
} from '../src/rpc/read-rpc-artifact.js'
import type {
  SwarmReadAssetStatusV1,
  SwarmReadCaptainMemberRowV1,
} from '../src/rpc/read-rpc-contract.js'

/** The member-detail read fields the frozen `captainMemberRow` schema does NOT
 *  admit today; their absence is exactly what makes the suite red. */
const MISSING_MEMBER_DETAIL_ROW_FIELDS = ['skills', 'callableTools', 'growthSummary'] as const

const growth = { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' }
const notGeneratedAvatar = { state: 'not_generated', reason: 'avatar_backend_not_implemented' } as const
const notGeneratedIdentity = { state: 'not_generated', reason: 'identity_backend_not_implemented' } as const
const generatedAvatar = { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' } as const

/** The full member-detail contract surface, typed against the real read types.
 *  `skills`/`callableTools`/`growthSummary` are the not-yet-delivered targets;
 *  `currentActivity`/`recentOutcome` derive from the frozen snapshot. */
interface MemberDetailContract {
  readonly name: string
  readonly role: string
  readonly profession?: string
  readonly personality?: string
  readonly avatar: SwarmReadAssetStatusV1
  readonly skills: readonly string[]
  readonly callableTools: readonly string[]
  readonly growthSummary?: string
  readonly currentActivity?: { readonly taskId: string; readonly subject: string; readonly status: 'pending' | 'in_progress' | 'submitted' | 'verifying' }
  readonly recentOutcome?: { readonly taskId: string; readonly phase: 'accepted' | 'rejected'; readonly at: number }
}

function memberRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'worker', role: 'writer', phase: 'active', createdAt: 1,
    avatar: notGeneratedAvatar, identityCard: notGeneratedIdentity, growth,
    composition: { state: 'available', reason: 'available', runtimeProvider: 'spawn', personaConfigured: true },
    ...over,
  }
}

function captainMembersValue(members: readonly unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    binding: { rootSessionId: 'root-session', teamId: 'team-r2' },
    members,
    observedAt: 1_700_000_000_200,
  }
}

describe('member-detail projection: shipped base-field contract (green pin)', () => {
  it('declares a typed member-detail view whose existence/type/empty rules are stable', () => {
    // Existence + type of every already-shipped target field on the real row type.
    const row: Pick<SwarmReadCaptainMemberRowV1, 'name' | 'role' | 'phase' | 'createdAt'> &
      Partial<Pick<SwarmReadCaptainMemberRowV1, 'profession' | 'personality' | 'displayName'>> &
      Pick<SwarmReadCaptainMemberRowV1, 'avatar' | 'identityCard' | 'composition' | 'growth'> =
      SWARM_READ_RPC_FIXTURES_V1.values.captainMembers.members[1] as never as SwarmReadCaptainMemberRowV1
    expect(typeof row.name).toBe('string')
    expect(typeof row.role).toBe('string')
    // profession / personality are optional and present only on a generated identity card.
    expect(typeof row.profession).toBe('string')
    expect(typeof row.personality).toBe('string')
    // avatar is a typed asset status; a generated avatar carries a string svg.
    const avatar = row.avatar
    expect(avatar.state).toBe('generated')
    expect(typeof avatar.svg).toBe('string')
  })

  it('pins the empty behavior: a not-generated profile must carry no svg/profile fields', () => {
    // The fail-closed baseline (fixture 'worker' row) is a valid member detail:
    // name/role always present, identity card not generated => no profession/
    // personality/avatar svg, growth is the constant not_implemented enum.
    const row = SWARM_READ_RPC_FIXTURES_V1.values.captainMembers.members[0] as never as SwarmReadCaptainMemberRowV1
    expect(row.name).toBe('worker')
    expect(row.identityCard.state).toBe('not_generated')
    expect(row.profession).toBeUndefined()
    expect(row.personality).toBeUndefined()
    expect(row.avatar.state).toBe('not_generated')
    expect(row.avatar.svg).toBeUndefined()
    expect(row.growth.skills).toBe('not_implemented')
    // And the whole fail-closed value still passes the frozen browser contract.
    expect(() => assertSwarmReadRpcValue('captainMembers', SWARM_READ_RPC_FIXTURES_V1.values.captainMembers as never)).not.toThrow()
  })

  it('pins the current-task and recent-outcome wire primitives the detail derives from', () => {
    // The frozen snapshot already carries the task subject/status/owner/currentAttempt
    // and attempt memberName/phase/updatedAt that the member-detail overlay consumes.
    const snapshot = SWARM_READ_RPC_CONTRACT_V1.schemas.values.snapshot as unknown as {
      required: readonly string[]; properties: { roster: object; tasks: { items: { properties: Record<string, unknown> } }; attempts: { items: { properties: Record<string, unknown> } } };
    }
    const task = snapshot.properties.tasks.items.properties
    const attempt = snapshot.properties.attempts.items.properties
    // current task + status
    expect(task.subject).toBeDefined()
    expect(task.status).toBeDefined()
    expect(task.ownerName).toBeDefined()
    expect(task.currentAttemptId).toBeDefined()
    // recent outcome (terminal attempt phase + timestamp)
    expect(attempt.phase).toBeDefined()
    expect(attempt.memberName).toBeDefined()
    expect(attempt.updatedAt).toBeDefined()
  })
})

describe('member-detail projection: not-yet-delivered field contract (fault-first, RED)', () => {
  it('requires the frozen captainMemberRow schema to admit skills/callableTools/growthSummary', () => {
    const rowSchema = SWARM_READ_RPC_CONTRACT_V1.schemas.values.captainMembers as unknown as {
      properties: { members: { items: { properties: Record<string, unknown> } } };
    }
    const rowProperties = rowSchema.properties.members.items.properties
    for (const field of MISSING_MEMBER_DETAIL_ROW_FIELDS) {
      expect(rowProperties, `captainMemberRow must deliver "${field}"`).toHaveProperty(field)
    }
  })

  it('accepts a member-detail row carrying the full target field contract', () => {
    const detail: MemberDetailContract = {
      name: 'worker', role: 'writer',
      profession: 'Story writer', personality: 'Careful and steady',
      avatar: generatedAvatar,
      skills: ['rust-console-writer', 'scenario-auditor'],
      callableTools: ['agent_swarm_list_tasks', 'agent_swarm_send_message'],
      growthSummary: 'Grew from provisioning to a shared-task owner in this sprint.',
      currentActivity: { taskId: 'task-1', subject: 'Ship member detail', status: 'in_progress' },
      recentOutcome: { taskId: 'task-0', phase: 'accepted', at: 1_700_000_000_000 },
    }
    const payload = captainMembersValue([memberRow({
      ...detail,
      displayName: 'Worker',
      // A shipped profile (profession/personality/displayName) is only coherent
      // with a `generated` identity card — strict honesty, no avatar bypass.
      identityCard: { state: 'generated' as const },
    })])
    // Today the frozen schema does not admit skills/callableTools/growthSummary and
    // the avatar must be generated-with-svg only when generated — so shipping the
    // full member-detail field set must be a contract-visible change, not silent.
    expect(() => assertSwarmReadRpcValue('captainMembers', payload as never), 'member-detail row must be a valid captainMembers value').not.toThrow()
  })

  it('pins the type/empty rules for the missing skill/tool/growth fields', () => {
    // skills / callableTools are bounded string enumerations: empty array means
    // "declared none", and the growth/experience summary is a bounded free-text
    // summary — all must be representable as a valid member-detail row.
    const payload = captainMembersValue([memberRow({ skills: [], callableTools: [], growthSummary: '' })])
    expect(() => assertSwarmReadRpcValue('captainMembers', payload as never)).not.toThrow()
  })
})

describe('member-detail projection: failure paths fail closed, never crash', () => {
  it('keeps a member with NO identity-card profile a valid, honest fail-closed detail', () => {
    // Missing asset data (no captainMembers profile) must not crash the read:
    // the row carries only authoritative roster identity + a not_generated avatar
    // and the constant not_implemented growth enum — the overlay renders explicit
    // "not available yet" markers instead of fabricating a profile/skill/tool claim.
    const payload = captainMembersValue([memberRow({})])
    expect(() => assertSwarmReadRpcValue('captainMembers', payload as never)).not.toThrow()
  })

  it('rejects abnormal/contradictory detail data loudly instead of propagating it', () => {
    // A skills/callableTools field must not silently accept a non-list placeholder
    // (the old `not_implemented` string leaked into the enumeration) or a row that
    // carries profile fields while its identityCard is not_generated.
    const leaks: Array<[string, Record<string, unknown>]> = [
      ['skills-as-placeholder-string', { skills: 'not_implemented' }],
      ['callableTools-not-a-list', { callableTools: 'agent_swarm_list_tasks' }],
      ['profile-without-generated-identity-card', { personality: 'Careful', identityCard: notGeneratedIdentity }],
    ]
    for (const [label, leak] of leaks) {
      expect(() => assertSwarmReadRpcValue('captainMembers', captainMembersValue([memberRow(leak)]) as never), label).toThrow()
    }
  })

  it('rejects an unsafe generated avatar instead of letting the projection render it', () => {
    // A generated avatar must carry a strictly allowlisted pixel SVG; a markup
    // that tries to smuggle script/href must be rejected loudly so the projection
    // never renders raw markup and the client falls back to its deterministic grid.
    const unsafe = 'generated' as const
    for (const svg of ['<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>', '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3" href="javascript:void(0)"/></svg>']) {
      expect(() => assertSwarmReadRpcValue('captainMembers', captainMembersValue([memberRow({ avatar: { state: unsafe, svg } })]) as never)).toThrow()
    }
  })
})
