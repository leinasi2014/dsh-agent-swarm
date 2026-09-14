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
  /** Set when a cold re-mint recovered from the member's canonical Session
   * that THIS very attempt already loaded a body: the frozen version is held
   * across the cold continuation (the same attempt never changes bodies);
   * only a moved attempt advances to the current durable pin. */
  attemptFreeze: { taskId: string; attemptId: string } | undefined
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

/** One canonical load fact: the provenance the governed surface durably wrote
 * into the member's OWN Session at the exact real load — either the
 * `skill-invocation` user-message source or the tool/result
 * `<release_provenance>` block. */
export interface CanonicalLoadFact {
  readonly name: string
  readonly version: string
  readonly manifestHash: string
  readonly taskId: string
  readonly attemptId: string
}

const PROVENANCE_BLOCK = /<release_provenance>(\{[\s\S]*?\})<\/release_provenance>/g

function loadFactFrom(value: unknown, teamId: string, memberSessionId: string, taskId: string, attemptId: string): CanonicalLoadFact | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  // Replaying an old log must never outlive authorization: the fact must name
  // THIS member Session and this exact Team/task/attempt. Pin/membership/
  // allow-list re-verification stays with the caller (only pinned names adopt
  // the frozen version).
  if (record.teamId !== teamId || record.memberSessionId !== memberSessionId) return undefined
  if (record.taskId !== taskId || record.attemptId !== attemptId) return undefined
  const { name, version, manifestHash } = record
  if (typeof name !== 'string' || typeof version !== 'string' || typeof manifestHash !== 'string') return undefined
  return { name, version, manifestHash, taskId, attemptId }
}

/** Provenance text of a SUCCESSFUL `tool-result` block lives in the block's
 * own nested `content` text parts (mirroring the durable request shape the
 * spec's loadProof reads). */
function textOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    const part = block as { type?: unknown; text?: unknown; content?: unknown }
    if (part?.type === 'text' && typeof part.text === 'string') return [part.text]
    return textOf(part?.content)
  })
}

interface CanonicalEvent {
  readonly type?: unknown
  readonly data?: unknown
}

/** Scan the RESUMED member Session (official `snapshotEvents()`) for bodies
 * ACTUALLY loaded inside one exact attempt. Official event shapes differ per
 * type: `tool/call` carries `data.name/callId/arguments` (no message);
 * `user/message` IS `data` (gesture provenance at `data.source.release`);
 * `tool/result` carries `data.message` (role `user`, `source.kind='tool'`).
 * A tool load counts ONLY when paired: the result's `source.callId` and each
 * successful `tool-result` block's `toolCallId` must match a real `skill`
 * `tool/call` — never another tool returning look-alike XML. Newest fact per
 * name wins; undefined when the log records none for this attempt (caller
 * then keeps durable pins). Reads only; grants no other authority. */
export function attemptLoadFacts(session: { snapshotEvents: () => readonly unknown[] }, teamId: string, memberSessionId: string, taskId: string, attemptId: string): Map<string, CanonicalLoadFact> | undefined {
  const facts = new Map<string, CanonicalLoadFact>()
  // Skill calls awaiting their result. Parallel tool calls under one turn
  // mean the durable callId (not the step index) is the precise pairing key:
  // a result is credited ONLY to a prior `tool/call` of the governed `skill`
  // tool with that exact id, never to another tool returning look-alike XML.
  const openSkillCalls = new Set<string>()
  for (const raw of session.snapshotEvents()) {
    const event = raw as CanonicalEvent
    if (event.type === 'tool/call') {
      const call = event.data as { name?: unknown; callId?: unknown } | undefined
      if (call?.name === 'skill' && typeof call.callId === 'string') openSkillCalls.add(call.callId)
      continue
    }
    if (event.type === 'user/message') {
      const gesture = event.data as { source?: { kind?: unknown; release?: unknown } } | undefined
      if (gesture?.source?.kind === 'skill-invocation') {
        const fact = loadFactFrom(gesture.source.release, teamId, memberSessionId, taskId, attemptId)
        if (fact !== undefined) facts.set(fact.name, fact)
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: unknown } | undefined)?.message as
      { role?: unknown; source?: { kind?: unknown; callId?: unknown }; content?: unknown } | undefined
    if (message === undefined || message.role !== 'user') continue
    const source = message.source
    if (source?.kind !== 'tool' || typeof source.callId !== 'string' || !openSkillCalls.has(source.callId)) continue
    openSkillCalls.delete(source.callId)
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const part = block as { type?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown }
      if (part?.type !== 'tool-result' || part.toolCallId !== source.callId || part.isError !== false) continue
      for (const text of textOf(part.content)) {
        for (const match of text.matchAll(PROVENANCE_BLOCK)) {
          try {
            const fact = loadFactFrom(JSON.parse(match[1]!), teamId, memberSessionId, taskId, attemptId)
            if (fact !== undefined) facts.set(fact.name, fact)
          } catch { /* a malformed provenance block is not a load fact */ }
        }
      }
    }
  }
  return facts.size > 0 ? facts : undefined
}
