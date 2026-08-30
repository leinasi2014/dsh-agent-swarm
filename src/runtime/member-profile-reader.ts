/**
 * Read-only member composition profiles derived from official Session facts.
 *
 * The Team aggregate remains the authority for roster identity and phase.
 * Provider/model/preset/persona/tool declarations are inspected per member
 * from the child Session header and its own continuable descriptor suffix.
 * This reader never resumes a child, enumerates live subagents, caches a
 * profile, or writes/repairs either authority.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamMember, TeamState } from '../domain/types.js'
import { DEFAULT_TOOL_POLICY } from './permission-policy.js'
import { MEMBER_HIDDEN_TOOLS } from './prompts.js'

const MEMBER_INSPECTION_TIMEOUT_MS = 2_500
const PAGE_INSPECTION_TIMEOUT_MS = 8_000
const MAX_INSPECTION_CONCURRENCY = 4

/** The deny-excluded member-facing plugin tool surface: the plugin's declared
 *  member-visible allow surface minus the mandatory captain-only/hidden
 *  baseline, in stable surface order. The read-time callable-tools projection
 *  further excludes this member's own durable toolFilter denial. */
const MEMBER_VISIBLE_PLUGIN_SURFACE: readonly string[] = (DEFAULT_TOOL_POLICY.allow ?? [])
  .filter(tool => !(MEMBER_HIDDEN_TOOLS as readonly string[]).includes(tool))

type MemberProfileState = 'available' | 'pending' | 'unavailable' | 'invalid'

/** Fixed diagnostics deliberately disclose no backend error, path, or persona. */
type MemberProfileReason =
  | 'available'
  | 'provisioning'
  | 'startup_failed'
  | 'removed'
  | 'inspection_failed'
  | 'active_session_missing'
  | 'binding_invalid'
  | 'descriptor_invalid'
  | 'not_continuable'
  | 'tool_filter_invalid'

export interface MemberProfile {
  readonly name: string
  readonly role: string
  readonly phase: TeamMember['phase']
  readonly createdAt: number
  readonly profileState: MemberProfileState
  readonly profileReason: MemberProfileReason
  /** Existing Team recovery fence; descriptor.provider is verified against it. */
  readonly runtimeProvider: string
  readonly llmProvider?: string
  readonly model?: string
  readonly presetId?: string
  readonly personaConfigured?: boolean
  readonly deniedTools?: readonly string[]
  /** Declared roster Skills derivable from the member's durable authority. Bounded
   *  enumeration; empty means "none declared". Absent when no skills authority
   *  exists (fail-closed), never an empty or fabricated claim. */
  readonly skills?: readonly string[]
  /** Tools this member may call within the Team's member-facing plugin surface,
   *  derived from the member's durable toolFilter denial (deny-excluded). Present
   *  only on an `available` profile; a fail-closed row discloses no tool claim. */
  readonly callableTools?: readonly string[]
  /** Bounded growth/experience summary. Absent when no summary authority exists. */
  readonly growthSummary?: string
}

function pending(member: TeamMember): MemberProfile {
  return {
    name: member.name,
    role: member.role,
    phase: member.phase,
    createdAt: member.createdAt,
    profileState: 'pending',
    profileReason: 'provisioning',
    runtimeProvider: member.provider,
  }
}

function unavailable(member: TeamMember, profileReason: 'startup_failed' | 'removed' | 'inspection_failed'): MemberProfile {
  return {
    name: member.name,
    role: member.role,
    phase: member.phase,
    createdAt: member.createdAt,
    profileState: 'unavailable',
    profileReason,
    runtimeProvider: member.provider,
  }
}

function invalid(member: TeamMember, profileReason: Exclude<MemberProfileReason, 'available' | 'provisioning'>): MemberProfile {
  return {
    name: member.name,
    role: member.role,
    phase: member.phase,
    createdAt: member.createdAt,
    profileState: 'invalid',
    profileReason,
    runtimeProvider: member.provider,
  }
}

function missingSession(error: unknown): boolean {
  return error instanceof Error && /^session "[^"]+" not found$/.test(error.message)
}

async function mapBounded<T, U>(items: readonly T[], limit: number, map: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = []
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * Projects only a bounded requested roster page.  Inspection failures are
 * intentionally row-local: a slow, missing, or corrupt child cannot conceal
 * unrelated members or turn this read into a recovery operation.
 */
export class MemberProfileReader {
  constructor(private readonly ctx: Context) {}

  async listPage(
    team: TeamState,
    input: { phase?: TeamMember['phase']; cursor: number; limit: number },
    signal: AbortSignal,
  ): Promise<{ members: MemberProfile[]; nextCursor?: number }> {
    const filtered = team.members.filter(member => input.phase === undefined || member.phase === input.phase)
    const members = await this.list(team, filtered.slice(input.cursor, input.cursor + input.limit), signal)
    return { members, ...(input.cursor + input.limit < filtered.length ? { nextCursor: input.cursor + input.limit } : {}) }
  }

  async list(team: TeamState, members: readonly TeamMember[], signal: AbortSignal): Promise<MemberProfile[]> {
    const pageDeadline = AbortSignal.timeout(PAGE_INSPECTION_TIMEOUT_MS)
    const pageSignal = AbortSignal.any([signal, pageDeadline])
    try {
      const profiles = await mapBounded(members, MAX_INSPECTION_CONCURRENCY, async member =>
        await this.inspect(team, member, pageSignal))
      pageSignal.throwIfAborted()
      return profiles
    } catch (error) {
      if (signal.aborted) {
        throw new TeamDomainError('member profile read was aborted by the caller', 'TEAM_MEMBER_PROFILE_ABORTED', { cause: error })
      }
      if (pageDeadline.aborted) {
        throw new TeamDomainError('member profile read exceeded its bounded page deadline', 'TEAM_MEMBER_PROFILE_TIMEOUT', { cause: error })
      }
      throw error
    }
  }

  private async inspect(team: TeamState, member: TeamMember, pageSignal: AbortSignal): Promise<MemberProfile> {
    if (member.phase === 'provisioning') return pending(member)
    if (member.phase === 'failed') return unavailable(member, 'startup_failed')
    if (member.phase === 'removed') return unavailable(member, 'removed')
    const rowSignal = AbortSignal.any([pageSignal, AbortSignal.timeout(MEMBER_INSPECTION_TIMEOUT_MS)])
    let stored: Awaited<ReturnType<Context['sessionPersistence']['inspect']>>
    try {
      stored = await this.ctx.sessionPersistence.inspect(SessionId(member.sessionId), rowSignal)
    } catch (error) {
      // A caller or page-wide deadline has a tool-level outcome; it must not
      // disappear into a harmless-looking row result.
      if (pageSignal.aborted) throw error
      if (member.phase === 'active') {
        return invalid(member, missingSession(error) ? 'active_session_missing' : 'inspection_failed')
      }
      return unavailable(member, 'inspection_failed')
    }

    if (
      stored.meta.id !== member.sessionId
      || stored.meta.origin !== 'subagent'
      || stored.meta.parentSession !== team.captainSessionId
    ) {
      return invalid(member, 'binding_invalid')
    }

    const suffix = stored.events.slice(stored.meta.seedLength ?? 0)
    let descriptor: ReturnType<typeof foldSubagentDescriptor>
    try {
      descriptor = foldSubagentDescriptor(suffix)
    } catch {
      return invalid(member, 'descriptor_invalid')
    }
    if (descriptor?.mode !== 'continuable') return invalid(member, 'not_continuable')
    if (
      descriptor.label !== `agent-swarm:${team.id}:${member.name}`
      || descriptor.provider !== member.provider
    ) {
      return invalid(member, 'binding_invalid')
    }
    // Team members are provisioned through the deny-only policy. An allow
    // declaration is neither a safe effective-capability claim nor a valid
    // member profile, even though the generic official descriptor permits it.
    if (descriptor.toolFilter?.allow !== undefined) return invalid(member, 'tool_filter_invalid')

    const deny = descriptor.toolFilter?.deny
    // Callable tools = the member-facing plugin surface minus this member's own
    // durable deny restriction — a bounded, honest read of "tools not denied on
    // this member's surface". Official downstream guards remain authoritative.
    const callableTools = MEMBER_VISIBLE_PLUGIN_SURFACE.filter(
      tool => deny === undefined || !deny.includes(tool),
    )

    return {
      name: member.name,
      role: member.role,
      phase: member.phase,
      createdAt: member.createdAt,
      profileState: 'available',
      profileReason: 'available',
      runtimeProvider: member.provider,
      ...(descriptor.agentProvider === undefined ? {} : { llmProvider: descriptor.agentProvider }),
      ...(descriptor.agentModel === undefined ? {} : { model: descriptor.agentModel }),
      ...(stored.meta.agentPreset === undefined ? {} : { presetId: stored.meta.agentPreset }),
      personaConfigured: descriptor.persona !== undefined,
      ...(deny === undefined ? {} : { deniedTools: deny }),
      callableTools,
    }
  }
}
