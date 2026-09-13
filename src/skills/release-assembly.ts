/**
 * Assembly-side building blocks of the S2 release authority (cohesive split of
 * `release-authority.ts` for the 600-line source gate; no behavior lives on
 * this file beyond what the authority drives): the live member-assembly
 * record, the frozen-snapshot SkillProvider factory the authority registers
 * into each ASSIGNED member's own scoped layer, and the compact wire views
 * the assignment/approval faces return.
 *
 * Snapshot discipline: the provider serves EXACTLY the versions frozen when
 * the assembly was minted — never the live pin table — so a later Captain
 * re-pin can never hot-swap a held body or its provenance.
 *
 * @module dsh-agent-swarm/skills/release-assembly
 */
import type { SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { SkillsReleaseRecord } from '../storage/skills-management.js'

/** Frozen contract: the module-owned assembly provider name (the spec asserts
 * it from the public contract header; the governed surface stamps load
 * provenance only for definitions served by this provider). */
export const RELEASE_PROVIDER_NAME = 'agent_swarm_skills_release'

/** One live member assembly: the officially minted exact-Agent scope (whose
 * scoped context registers the provider INTO that Agent's own layer) plus the
 * exact provider disposer and the minted scope's idempotent disposal. */
export interface MemberAssembly {
  scope: string
  teamId: string
  disposeScope: () => Promise<void>
  providerDisposer: () => void
  control: SkillProviderControl | undefined
  /** How often THIS assembly actually served a pinned body into a request;
   * a nonzero count makes the live load held until the NEXT real attempt. */
  loads: { count: number }
  /** Task/attempt the most recent real load rode (attempt-boundary probe). */
  lastLoad: { taskId: string | undefined; attemptId: string | undefined } | undefined
  /** The immutable versions ACTUALLY EFFECTIVE in this assembly (name → the
   * verified release record captured at mint time). Body AND load provenance
   * both read this snapshot: a Captain re-pin can never hot-swap a held body
   * or mis-attribute it to a newer pin; the snapshot advances only when a new
   * assembly is minted (next real attempt / cold continuation). */
  pinned: ReadonlyMap<string, SkillsReleaseRecord>
}

/** The wire view of one live assignment (the assign tool's compact receipt). */
export interface SkillsAssignmentView {
  readonly scope: string
  readonly team_id: string
  readonly member_session_id: string
  readonly skill_name: string
  readonly version: string
  readonly release_manifest_hash: string
  readonly revision: number
  /** Present on a re-pin: the current assembly already LOADED a body, so it is
   * held (never hot-swapped) until the member's next cold continuation. */
  readonly loaded_held?: boolean
}

/** The provider serves EXACTLY the frozen snapshot of its assembly: the
 * versions actually effective when it was minted (loads counted per actual
 * delivery into a request — the held/advance probe). */
export function buildReleaseProvider(scope: string, teamId: string, pinned: ReadonlyMap<string, SkillsReleaseRecord>, loads: { count: number }): SkillProvider {
  return {
    name: RELEASE_PROVIDER_NAME,
    async list() {
      return [...pinned.values()].flatMap(release => [{
        name: release.name,
        description: `Approved release ${release.name}@${release.version} pinned by manifest ${release.manifestHash.slice(0, 12)}`,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime' as const,
        provider: RELEASE_PROVIDER_NAME,
        rank: 0,
        locator: JSON.stringify([scope, teamId, release.name, release.version]),
      }])
    },
    async get(candidate: { locator?: unknown; description?: string }): Promise<SkillDefinition | undefined> {
      if (typeof candidate.locator !== 'string') return undefined
      try {
        const [locatorScope, locatorTeam, name] = JSON.parse(candidate.locator) as string[]
        if (locatorScope !== scope || locatorTeam !== teamId) return undefined
        // The SNAPSHOT version wins even against a stale cached locator:
        // this assembly's effective body is exactly what it froze at mint.
        const release = pinned.get(name!)
        if (release === undefined) return undefined
        loads.count += 1
        return {
          name: release.name,
          description: candidate.description ?? `Approved release ${release.name}@${release.version}`,
          content: release.body,
          provider: RELEASE_PROVIDER_NAME,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime' as const,
        }
      } catch {
        return undefined
      }
    },
  }
}

/** Compact approval receipt (release identity is the manifest hash). */
export function releaseView(record: SkillsReleaseRecord): Record<string, unknown> {
  return {
    scope: record.scope, teamId: record.teamId, name: record.name, version: record.version,
    provider: record.provider, content_sha256: record.contentSha256, resources_sha256: record.resourcesSha256,
    manifest_hash: record.manifestHash,
  }
}

/** Compact assignment receipt; `loadedHeld` marks a re-pin whose body stays
 * frozen in the member's current assembly until the next real attempt or a
 * cold continuation. */
export function assignmentView(record: { scope: string; teamId: string; memberSessionId: string; name: string; version: string; releaseManifestHash: string; revision: number }, loadedHeld = false): SkillsAssignmentView {
  return {
    scope: record.scope, team_id: record.teamId, member_session_id: record.memberSessionId,
    skill_name: record.name, version: record.version, release_manifest_hash: record.releaseManifestHash,
    revision: record.revision,
    ...(loadedHeld ? { loaded_held: true } : {}),
  }
}
