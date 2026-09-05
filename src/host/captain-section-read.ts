import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isSafePixelAvatarSvg, MAX_CAPTAIN_ANNOUNCEMENTS } from '../domain/identity-profile.js'
import type { TeamState, TeamMember } from '../domain/types.js'
import { MemberProfileReader, type MemberProfile } from '../runtime/member-profile-reader.js'
import type { SwarmReadCaptainSectionRequest, SwarmReadRpcValue, SwarmReadCaptainMembersV1, SwarmReadCaptainMemberRowV1, SwarmReadCaptainAnnouncementsV1 } from '../rpc/read-rpc-contract.js'

/** Projection of a Team already admitted by the Host target authority. */
export async function readCaptainSection(ctx: Context, team: TeamState, request: SwarmReadCaptainSectionRequest): Promise<SwarmReadRpcValue> {
    const observedAt = Date.now()
    switch (request.method) {
      case 'captainMembers': {
        // Row-local composition (captainMembers.composition.v1): the shared
        // MemberProfileReader inspects each verified member's own durable
        // Session descriptor (never resumes, never reads private memory) and
        // fails a single missing/corrupt row CLOSED into an explicit
        // state/reason without affecting the other rows. Output order matches
        // the authoritative roster order exactly.
        const reader = new MemberProfileReader(ctx)
        const profiles = await reader.list(team, team.members, new AbortController().signal)
        const members: SwarmReadCaptainMembersV1['members'] = team.members.map((member, index) => ({
          name: member.name,
          role: member.role,
          phase: member.phase,
          createdAt: member.createdAt,
          ...(member.displayName === undefined
            ? {}
            : { displayName: member.displayName }),
          ...(member.profession === undefined
            ? {}
            : { profession: member.profession }),
          ...(member.personality === undefined
            ? {}
            : { personality: member.personality }),
          // A generated avatar is re-allowlisted at read time: a tampered or
          // unsafe stored svg is downgraded to not_generated and never carries
          // an `svg` on the read contract.
          avatar: member.pixelAvatarSvg !== undefined && isSafePixelAvatarSvg(member.pixelAvatarSvg)
            ? { state: 'generated', svg: member.pixelAvatarSvg }
            : { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: member.displayName === undefined && member.profession === undefined && member.personality === undefined
            ? { state: 'not_generated', reason: 'identity_backend_not_implemented' }
            : { state: 'generated' },
          composition: memberCompositionOf(profiles[index], member),
          // Member-detail overlay fields retain separate authorities: Skills
          // come from the member's latest durable catalog, tools only from the
          // exact live scoped registry, and growth from retained Team history.
          ...(profiles[index]?.skills === undefined ? {} : { skills: [...profiles[index].skills] }),
          // Issue #184 A5: distinguish the member-assigned subset from the
          // Session-visible catalog `skills`; an explicit empty subset is a
          // declared narrowing, not an inheritance of the Team allow-list.
          ...(member.assignedSkills === undefined ? {} : { assignedSkills: [...member.assignedSkills] }),
          ...callableToolsOf(ctx, team, member),
          ...growthSummaryOf(team, member.sessionId),
          ...currentActivityOf(team, member.sessionId),
          ...recentOutcomeOf(team, member.sessionId),
          // Non-sensitive growth availability — constant literal enum only; no content
          // (private memory is never read nor projected beyond this availability marker).
          growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
        }))
        return {
          schemaVersion: 1,
          binding: { rootSessionId: team.captainSessionId, teamId: team.id },
          // Issue #184 A5: the immutable Team eligibility policy, distinct from the
          // Session-visible catalog and the per-member assigned subset.
          ...(team.allowedSkills === undefined ? {} : { teamAllowedSkills: [...team.allowedSkills] }),
          members, observedAt,
        }
      }
      case 'captainAnnouncements': {
        // Real bounded projection of the Team's public announcements; an empty
        // Team has an honest empty list (never fabricated entries).
        const entries: SwarmReadCaptainAnnouncementsV1['entries'] = (team.announcements ?? [])
          .slice(0, MAX_CAPTAIN_ANNOUNCEMENTS)
          .map(announcement => ({ id: announcement.id, text: announcement.text, createdAt: announcement.createdAt }))
        return {
          schemaVersion: 1,
          binding: { rootSessionId: team.captainSessionId, teamId: team.id },
          state: 'available',
          entries,
          observedAt,
        }
      }
      case 'captainDiagnostics': {
        return {
          schemaVersion: 1,
          binding: { rootSessionId: team.captainSessionId, teamId: team.id },
          diagnostics: {
            revision: team.revision,
            phase: team.phase,
            taskCount: team.tasks.length,
            attemptCount: team.attempts.length,
            memberCount: team.members.length,
            backend: 'team-domain',
          },
          observedAt,
        }
      }
    }
}

function memberCompositionOf(profile: MemberProfile | undefined, member: TeamMember): SwarmReadCaptainMemberRowV1['composition'] {
  const state = profile?.profileState ?? 'invalid'
  const reason = profile?.profileReason ?? 'inspection_failed'
  const runtimeProvider = profile?.runtimeProvider ?? member.provider
  // The provider name is the recovery fence disclosed on any non-`available` row; keep it in-bounds.
  const fence = (candidate: string): string => boundedString(candidate, 128) ? candidate : (boundedString(member.provider, 128) ? member.provider : 'unknown')
  if (profile === undefined || profile.name !== member.name) {
    return { state: 'invalid', reason: 'inspection_failed', runtimeProvider: fence(runtimeProvider) }
  }
  const bounded = (value: unknown): value is string => boundedString(value, 128)
  const deniedTools = profile.deniedTools === undefined ? undefined : [...profile.deniedTools]
  const inBounds =
    (profile.llmProvider === undefined || bounded(profile.llmProvider)) &&
    (profile.model === undefined || bounded(profile.model)) &&
    (profile.presetId === undefined || bounded(profile.presetId)) &&
    (deniedTools === undefined || deniedTools.every(entry => bounded(entry))) &&
    bounded(runtimeProvider)
  if (!inBounds) {
    return { state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: fence(runtimeProvider) }
  }
  return {
    state,
    reason,
    runtimeProvider,
    ...(profile.llmProvider === undefined ? {} : { llmProvider: profile.llmProvider }),
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.presetId === undefined ? {} : { presetId: profile.presetId }),
    ...(profile.personaConfigured === undefined ? {} : { personaConfigured: profile.personaConfigured }),
    ...(profile.deniedTools === undefined ? {} : { deniedTools: [...profile.deniedTools] }),
  }
}

const MEMBER_ACTIVITY_STATUSES = new Set(['pending', 'in_progress', 'submitted', 'verifying'] as const)

/** Current work is derived from the authoritative Team task board.  Pending
 *  work follows the fenced target; claimed work follows the owner. */
function currentActivityOf(team: TeamState, memberSessionId: string): Pick<SwarmReadCaptainMemberRowV1, 'currentActivity'> | Record<string, never> {
  const task = team.tasks
    .filter(candidate => MEMBER_ACTIVITY_STATUSES.has(candidate.status as 'pending' | 'in_progress' | 'submitted' | 'verifying'))
    .filter(candidate => candidate.status === 'pending'
      ? candidate.targetMemberSessionId === memberSessionId
      : candidate.ownerSessionId === memberSessionId)
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]
  return task === undefined
    ? {}
    : { currentActivity: { taskId: task.id, subject: task.subject, status: task.status as 'pending' | 'in_progress' | 'submitted' | 'verifying' } }
}

/** Latest accepted/rejected attempt for the member; output/evidence content is
 *  deliberately excluded from this bounded public summary. */
function recentOutcomeOf(team: TeamState, memberSessionId: string): Pick<SwarmReadCaptainMemberRowV1, 'recentOutcome'> | Record<string, never> {
  const attempt = team.attempts
    .filter(candidate => candidate.memberSessionId === memberSessionId && (candidate.phase === 'accepted' || candidate.phase === 'rejected'))
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]
  return attempt === undefined
    ? {}
    : { recentOutcome: { taskId: attempt.taskId, phase: attempt.phase as 'accepted' | 'rejected', at: attempt.updatedAt } }
}

/** Model-visible tool surface for the exact live member.  A settled/cold
 *  Session has no scoped registry instance, so its tools remain honestly
 *  absent rather than being guessed from preset or descriptor policy. */
function callableToolsOf(ctx: Context, team: TeamState, member: TeamMember): Pick<SwarmReadCaptainMemberRowV1, 'callableTools'> | Record<string, never> {
  const live = ctx.agents.get(SessionId(member.sessionId))
  if (live === undefined || live.id !== member.sessionId || live.session.header.parentSession !== team.captainSessionId) return {}
  try {
    const names = ctx.tools.schemas(live).map(schema => schema.name).toSorted()
    if (names.length > 128 || names.some(name => !boundedString(name, 128)) || new Set(names).size !== names.length) return {}
    return { callableTools: names }
  } catch {
    return {}
  }
}

/** Bounded Team stores retain attempts, not lifetime career history.  The
 *  public wording names that limitation and never reads member-private memory. */
function growthSummaryOf(team: TeamState, memberSessionId: string): Pick<SwarmReadCaptainMemberRowV1, 'growthSummary'> {
  const accepted = new Set(
    team.attempts
      .filter(attempt => attempt.memberSessionId === memberSessionId && attempt.phase === 'accepted')
      .map(attempt => attempt.taskId),
  ).size
  const rejected = team.attempts.filter(
    attempt => attempt.memberSessionId === memberSessionId && attempt.phase === 'rejected',
  ).length
  return { growthSummary: `Retained history: ${accepted} accepted task${accepted === 1 ? '' : 's'} · ${rejected} rejected attempt${rejected === 1 ? '' : 's'}` }
}

function boundedString(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && [...value].length <= length
}
