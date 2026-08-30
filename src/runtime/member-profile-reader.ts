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

const MEMBER_INSPECTION_TIMEOUT_MS = 2_500
const PAGE_INSPECTION_TIMEOUT_MS = 8_000
const MAX_INSPECTION_CONCURRENCY = 4
const MAX_PROJECTED_SKILLS = 64
const MAX_PROJECTED_SKILL_NAME = 128
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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

/** Latest durable Skill catalog published for this member Session.  The
 *  official catalog is replacement state: the newest valid structured source
 *  wins, including an explicit empty catalog.  Missing/invalid authority is
 *  omitted instead of being presented as "none". */
function catalogSkills(events: readonly unknown[]): readonly string[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event !== 'object' || event === null) continue
    const record = event as { type?: unknown; data?: { source?: unknown } }
    if (record.type !== 'user/message') continue
    const source = record.data?.source
    if (typeof source !== 'object' || source === null) continue
    const { kind, form, entries } = source as { kind?: unknown; form?: unknown; entries?: unknown }
    if (kind !== 'skill-catalog' || form !== 'catalog') continue
    if (!Array.isArray(entries)) continue
    const readableNames: string[] = []
    let readable = true
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        readable = false
        break
      }
      const { name, description } = entry as { name?: unknown; description?: unknown }
      if (typeof name !== 'string' || name === '' || typeof description !== 'string') {
        readable = false
        break
      }
      readableNames.push(name)
    }
    if (!readable) continue
    if (readableNames.length > MAX_PROJECTED_SKILLS) return undefined
    const seen = new Set<string>()
    for (const name of readableNames) {
      if (!SKILL_NAME.test(name) || name.length > MAX_PROJECTED_SKILL_NAME || seen.has(name)) return undefined
      seen.add(name)
    }
    return readableNames
  }
  return undefined
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
    // Issue #148: member provisioning now derives the official session label
    // from the readable Team name + displayName (falling back to the internal
    // name), so the binding check must match that label exactly.
    if (
      descriptor.label !== `${team.name} · ${member.displayName ?? member.name}`
      || descriptor.provider !== member.provider
    ) {
      return invalid(member, 'binding_invalid')
    }
    // Team members are provisioned through the deny-only policy. An allow
    // declaration is neither a safe effective-capability claim nor a valid
    // member profile, even though the generic official descriptor permits it.
    if (descriptor.toolFilter?.allow !== undefined) return invalid(member, 'tool_filter_invalid')

    const deny = descriptor.toolFilter?.deny
    const skills = catalogSkills(suffix)

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
      ...(skills === undefined ? {} : { skills }),
    }
  }
}
