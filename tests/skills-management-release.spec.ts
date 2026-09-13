/**
 * S2 first slice: an approved IMMUTABLE release (REAL captured body) ->
 * Captain authorized assignment to the current legal task/attempt member ->
 * the member's NEXT real official requests assemble the approved body
 * (effective assembly; loaded through BOTH official paths), and the next
 * legal Captain request answers with the attributed available version.
 * assigned / assembly-adopted / answer are read back as THREE SEPARATE
 * facts and `availableVersion` is never claimed as the effective proof —
 * the REAL assigned-member and unassigned-control requests are (docs04 §release/assign,
 * docs07 §5 assignSkill/assignmentStatus).
 *
 * P1/P2 are CONFIRMATION controls on the REAL official composition (swarm +
 * TeamSkillSurface + SkillRegistry + dsh-tool-skill through
 * `mountSkillsComposition`): both official body paths deliver the source
 * body INTO real LLM GenerateOptions requests, and the Team allow-list
 * bounds entry at the membership gate, the tool and the gesture.
 *
 * R1-R3 exercise the typed release face through the real composition:
 *   R1 approved release (real body + REAL digest) -> Captain CAS assignment
 *      -> both official load paths put the PINNED body into the member's
 *      actual GenerateOptions requests, attributed to the assembly provider
 *      and cross-checked against the release digest -> next intake naming
 *      the skill durably answers `available` + `availableVersion`.
 *   R2 unassigned / unnamed never adopt (S1 terminal answer stands); the
 *      manifest is immutable; a ghost member cannot be assigned.
 *   R3 the unassigned teammate loads a genuinely drifted source while the
 *      assigned current attempt loads the pinned release through both paths.
 *      Canonical history is retained; the fixture never demands an in-attempt
 *      switch from an already loaded different body. Off-list loads, invalid
 *      digests and replacement of the pinned assignment are refused.
 *
 * Frozen RED/GREEN contract (binding on the implementation):
 *  - host management face `module.releases.approveRelease(input)` (NOT a
 *    model tool; the Host management manifest is the granting boundary in
 *    this first-slice fixture — `approvedBy` is a recorded principal label;
 *    this suite proves immutability/digest binding, NOT a full independent
 *    author workflow, which belongs to later slices). The input CAPTURES
 *    the exact `body` text; `contentSha256` MUST equal the SHA-256 of the
 *    body UTF-8 (an entry-time `digest-mismatch` refuses any digest bound
 *    to different text); this slice approves ONLY the explicit EMPTY
 *    resources tree — `resourcesSha256` must equal the SHA-256 of
 *    `canonicalJson([])` (computed, never accepted as an arbitrary value).
 *  - unit table `releases`, key JSON [scope,teamId,skillName,version]:
 *    { schemaVersion:1, scope, teamId, name, version, provider, locator,
 *      body, contentSha256, resourcesSha256, applicability, verification,
 *      approvedBy, approvedAt, manifestHash, createdAt, updatedAt }.
 *    Immutability: the same key with the same manifest replays; a differing
 *    manifest conflicts loudly (`SKILLS_RELEASE_CONFLICT`).
 *  - unit table `assignments`, key JSON [scope,teamId,memberSessionId,skillName]:
 *    { schemaVersion:1, scope, teamId, memberSessionId, name, version,
 *      releaseManifestHash, assignedBy, revision, assignedAt, updatedAt } —
 *    CAS by `expected_revision` (0 = create-first), identical content
 *    replays, a stale revision conflicts. An in-flight version swap is
 *    REFUSED (`SKILLS_ASSIGNMENT_REASSIGN_UNSUPPORTED`): an already loaded
 *    attempt can never have its body silently replaced.
 *  - Captain model tool `agent_swarm_skills_assign`
 *    { skill_name, version, member, expected_revision? } refuses names
 *    outside an EXPLICIT Team allow-list (`not-team-allowed`), non-members
 *    (`SKILLS_MEMBER_NOT_FOUND`) and cold Sessions (`SKILLS_MEMBER_NOT_LIVE`),
 *    durably writing nothing.
 *  - ASSEMBLY (the effective mechanism): a committed assignment registers
 *    the module-owned provider `agent_swarm_skills_release` into the
 *    ASSIGNED MEMBER'S OWN layer, minted with the public exact-Agent scope
 *    under the optional injected SkillRegistry Context, bound
 *    to exactly that scope+Team+member. BOTH official load paths (skill tool
 *    result and /name gesture injection) read with `scope: agent`, so only
 *    that member's real requests resolve the PINNED release body — a
 *    same-named drifted source can never enter the assigned member's
 *    requests, and a teammate WITHOUT the assignment keeps resolving the raw
 *    source (leak counterexample asserted in R3).
 *  - adoption at investigation is the available-version ANSWER (never the
 *    effective claim): payload names a skill + proven evidence + the task's
 *    durable owner has an assignment pinning an existing release whose
 *    manifestHash matches + an explicit Team allow-list contains the name +
 *    the OWNER-SCOPED registry winner digest equals the release digest (fail
 *    closed). Adopted => `available` + result.availableVersion { name,
 *    version }, no reason; otherwise the S1 terminal answer stands unchanged.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/storage/skills-management.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import type { SkillsManagementModule } from '../src/skills/module.js'
import {
  captainSkillsTool,
  createSkillsTeam,
  disposeRestartComposition,
  mountSkillsComposition,
  mountSkillsModule,
  SKILLS_INVESTIGATE_TOOL,
  SKILLS_MANAGER_ROUTE,
  skillsManagerModuleConfig,
  skillsModule,
  SkillsManagerScriptAdapter,
  skillsTextChunks,
  skillsToolTurn,
  skillsUnitFile,
  type SkillsCatalogEntry,
} from './helpers/skills-management-composition.js'
import { failureFields, readRow, REQUEST_TOOL, skillsSandboxTracker } from './helpers/skills-management-support.js'
import { MEMBER_ROUTE, RELEASE_PROVIDER, claimCurrentTask, createS2Task, expectSkillInRequest, gesture, liveScriptedMember, liveTaskMember, requestBodies } from './helpers/skills-management-release.js'

const tracker = skillsSandboxTracker('dsh-skills-rel-')
const freshSandbox = tracker.freshSandbox

const MEMBER2_ROUTE = { provider: 's2-member2-fixture', model: 's2-member-model' }
const PROVIDER = 's2-fixture-provider'
const ALPHA_FIX = 'alpha-fix'
const ALPHA_FIX_BODY = 'S2 approved release body v1: durable JSON rename protocol.'
const ALPHA_FIX_RESOURCES = { kind: 'directory' as const, path: 'C:/skills/alpha-fix' }
const BETA_FIX = 'beta-fix'
const BETA_FIX_BODY_V1 = 'Beta source body v1 — approved against exactly this text.'
const BETA_FIX_BODY_V2 = 'Beta source body v2 — drifted at the source after the approval.'
const BETA_FIX_BODY_V3 = 'Beta release body v3 — approved later, must NOT replace the in-flight pinned body.'
const GAMMA_FIX = 'gamma-fix'
const GAMMA_FIX_BODY = 'Gamma body — never on this Team allow-list.'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const EMPTY_RESOURCES_SHA256 = sha256(canonicalJson([]))

const ASSIGN_TOOL = 'agent_swarm_skills_assign'

/** Frozen-contract durable reads of the GREEN tables. */
async function readUnitTable(sandbox: string, table: string): Promise<Record<string, Record<string, unknown>>> {
  const unit = JSON.parse(await readFile(skillsUnitFile(sandbox), 'utf8')) as { tables?: Record<string, Record<string, Record<string, unknown>> | undefined> }
  return unit.tables?.[table] ?? {}
}
async function readReleaseRow(sandbox: string, scope: string, teamId: string, skillName: string, version: string): Promise<Record<string, unknown> | undefined> {
  return (await readUnitTable(sandbox, 'releases'))[JSON.stringify([scope, teamId, skillName, version])]
}
async function readAssignmentRow(sandbox: string, scope: string, teamId: string, memberSessionId: string, skillName: string): Promise<Record<string, unknown> | undefined> {
  return (await readUnitTable(sandbox, 'assignments'))[JSON.stringify([scope, teamId, memberSessionId, skillName])]
}

/** Typed approved-release face from the real module. */
function releaseSurfaceOf(module: SkillsManagementModule) {
  return module.releases
}

const CATALOG: SkillsCatalogEntry[] = [
  { name: ALPHA_FIX, description: 'Durable rename protocol.', content: ALPHA_FIX_BODY, resourceBase: ALPHA_FIX_RESOURCES },
  { name: BETA_FIX, description: 'Beta protocol.', content: BETA_FIX_BODY_V1 },
  { name: GAMMA_FIX, description: 'Gamma protocol.', content: GAMMA_FIX_BODY },
]

/** Real S2 vertical: official composition with the Team allow-list + the
 *  catalog SkillProvider, one scripted adapter for the manager route and one
 *  for the resumed member route. */
async function mountS2(sandbox: string, allowedSkills: readonly string[]) {
  const memberAdapter = new SkillsManagerScriptAdapter()
  const member2Adapter = new SkillsManagerScriptAdapter()
  const managerAdapter = new SkillsManagerScriptAdapter()
  const entries = CATALOG.map(entry => ({ ...entry }))
  const mounted = await mountSkillsComposition(sandbox, {
    [MEMBER_ROUTE.provider]: memberAdapter,
    [MEMBER2_ROUTE.provider]: member2Adapter,
    [SKILLS_MANAGER_ROUTE.provider]: managerAdapter,
  }, { allowedSkills, skillCatalog: { providerName: PROVIDER, entries } })
  const { root, teamId } = await createSkillsTeam(mounted, sandbox)
  const scope = mounted.ctx.agentSwarm.scopeOf(root)
  return { mounted, root, teamId, scope, memberAdapter, member2Adapter, managerAdapter, entries }
}

const approveBase = {
  version: '1.0.0',
  locator: 'fixture:s2-fixture-provider',
  applicability: 'Windows JSON rename durability work',
  verification: 's2-run deterministic validation',
  approvedBy: 's2-host-management-principal',
}

describe('S2 approved release: assignment-driven assembly, real requests, attributed answer', () => {
  it('P1 CONTROL: the governed member receives the skill body INSIDE real LLM requests through BOTH official paths (tool result and /name invocation)', async () => {
    const sandbox = await freshSandbox()
    const { mounted, root, memberAdapter } = await mountS2(sandbox, [ALPHA_FIX])
    const { member, disposeMember } = await liveScriptedMember(mounted, root, 's2p1-worker', [ALPHA_FIX])
    try {
      // Gesture path: the injected body must ride the ACTUAL model request.
      memberAdapter.append(skillsTextChunks('Used the gesture.'))
      await gesture(member, memberAdapter, 'Use /alpha-fix now.')
      const gestureRequest = memberAdapter.requests[0]
      expect(gestureRequest, 'the gesture turn really requested the model').toBeTruthy()
      const gestureJson = JSON.stringify(gestureRequest!.messages)
      expect(gestureJson, 'the real request carries the injected body').toContain(ALPHA_FIX_BODY)
      expect(gestureJson).toContain('skill-invocation')
      await expectSkillInRequest(mounted, member, gestureRequest!, { name: ALPHA_FIX, provider: PROVIDER, content: ALPHA_FIX_BODY })

      // Tool path: the official loop dispatches the governed skill tool and
      // the NEXT real request carries the tool-result with exact identity.
      memberAdapter.append(
        skillsToolTurn('s2p1-skill', 'skill', { name: ALPHA_FIX }),
        skillsTextChunks('Loaded via the tool.'),
      )
      await gesture(member, memberAdapter, 'Now load it through the skill tool.')
      const afterTool = memberAdapter.requests.at(-1)
      expect(afterTool, 'the post-tool-result turn really requested the model').toBeTruthy()
      const toolJson = JSON.stringify(afterTool!.messages)
      expect(toolJson).toContain('"tool-result"')
      expect(toolJson).toContain(ALPHA_FIX_BODY)
      await expectSkillInRequest(mounted, member, afterTool!, { name: ALPHA_FIX, provider: PROVIDER, content: ALPHA_FIX_BODY }, 's2p1-skill')
      expect(toolJson).toContain(ALPHA_FIX_RESOURCES.path)
    } finally {
      await disposeMember()
      await disposeRestartComposition(mounted)
    }
  }, 90_000)

  it('P2 CONTROL: the allow-list gates at the official ENTRY — membership refuses off-list, and an off-list body never enters any real request (tool or gesture)', async () => {
    const sandbox = await freshSandbox()
    const { mounted, root, memberAdapter } = await mountS2(sandbox, [ALPHA_FIX])
    // Official membership entry: a member cannot even be ASSIGNED off-list.
    const refused = await captainSkillsTool(mounted.ctx, root, 's2p2-offlist-add', 'agent_swarm_add_member', {
      name: 's2p2-offlist', role: 'worker', skills: [BETA_FIX],
    })
    expect(refused.ok, 'off-allow-list member assignment must be refused at the official gate').toBe(false)
    expect(failureFields(refused), `refusal must name the allow-list, got: ${failureFields(refused)}`).toContain('allow-list')

    const { member, disposeMember } = await liveScriptedMember(mounted, root, 's2p2-worker', [ALPHA_FIX])
    try {
      // Tool path off-list: denied, and no result ever reaches a request.
      memberAdapter.append(skillsToolTurn('s2p2-skill-beta', 'skill', { name: BETA_FIX }), skillsTextChunks('Denied.'))
      await gesture(member, memberAdapter, 'Load beta-fix through the skill tool.')
      // Gesture path off-list: nothing injects either.
      memberAdapter.append(skillsTextChunks('Gesture refused.'))
      await gesture(member, memberAdapter, 'Use /beta-fix now.')
      const all = requestBodies(memberAdapter.requests)
      expect(all, 'the off-list body never entered any real request').not.toContain(BETA_FIX_BODY_V1)
      expect(all, 'the denial itself is observable to the model').toContain('not allowed')
    } finally {
      await disposeMember()
      await disposeRestartComposition(mounted)
    }
  }, 90_000)

  it('R1: approved immutable release (real captured body + real digest) + Captain CAS assignment -> the pinned body enters BOTH member load paths attributed to the assembly (cross-checked against the release digest); the next intake answers available + availableVersion', async () => {
    const sandbox = await freshSandbox()
    const { mounted, root, teamId, scope, memberAdapter, managerAdapter } = await mountS2(sandbox, [ALPHA_FIX])
    const taskId = await createS2Task(mounted.ctx, root, 's2r1-task', 'Task whose real attempt grounds the adoption')
    const { member, disposeMember, releaseReady } = await liveTaskMember(mounted, root, 's2r1-worker', [ALPHA_FIX], memberAdapter)
    const realRef = 'evidence:skills-management/s2-adoption#run-1'
    let releaseFinish = () => {}
    const finishGate = new Promise<void>(resolve => { releaseFinish = resolve })
    try {
      const submitTask = await claimCurrentTask(mounted, member, scope, teamId, taskId, 's2r1', realRef)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      managerAdapter.append(
        skillsToolTurn('inv-s2r1', SKILLS_INVESTIGATE_TOOL, { request_id: 's2r1-request' }),
        skillsTextChunks('s2r1 settled.'),
      )

      // FACT 1 — assigned: the host management face captures the REAL body
      // and its REAL digest; the Captain CAS-assigns it to the task owner.
      const releases = releaseSurfaceOf(module)
      expect(typeof releases?.approveRelease, 'GREEN target: module-owned approved-release host management face').toBe('function')
      const approved = await releases.approveRelease({
        ...approveBase, scope, teamId, skillName: ALPHA_FIX,
        provider: PROVIDER, body: ALPHA_FIX_BODY,
        contentSha256: sha256(ALPHA_FIX_BODY), resourcesSha256: EMPTY_RESOURCES_SHA256,
      })
      expect(approved).toMatchObject({ scope, teamId, name: ALPHA_FIX, version: '1.0.0' })
      const releaseRow = await readReleaseRow(sandbox, scope, teamId, ALPHA_FIX, '1.0.0')
      expect(releaseRow, 'the approved release is durable BEFORE any receipt').toMatchObject({
        name: ALPHA_FIX, version: '1.0.0', provider: PROVIDER, body: ALPHA_FIX_BODY,
        contentSha256: sha256(ALPHA_FIX_BODY), resourcesSha256: EMPTY_RESOURCES_SHA256,
      })
      const manifestHash = releaseRow!.manifestHash as string
      expect(manifestHash).toMatch(/^[0-9a-f]{64}$/)
      const selfAssigned = await captainSkillsTool(mounted.ctx, member, 's2r1-self-assign', ASSIGN_TOOL, {
        skill_name: ALPHA_FIX, version: '1.0.0', member: member.id,
      })
      expect(selfAssigned.ok, 'the member cannot grant its own release assignment').toBe(false)
      expect(await readAssignmentRow(sandbox, scope, teamId, member.id, ALPHA_FIX)).toBeUndefined()
      const assigned = await captainSkillsTool(mounted.ctx, root, 's2r1-assign', ASSIGN_TOOL, {
        skill_name: ALPHA_FIX, version: '1.0.0', member: member.id, expected_revision: 0,
      })
      expect(assigned.ok, `Captain assignment must be accepted, got: ${failureFields(assigned)}`).toBe(true)
      expect(assigned.value).toMatchObject({ member_session_id: member.id, skill_name: ALPHA_FIX, version: '1.0.0', revision: 1, release_manifest_hash: manifestHash })
      const assignmentRow = await readAssignmentRow(sandbox, scope, teamId, member.id, ALPHA_FIX)
      expect(assignmentRow, 'the assignment is a durable separate fact pinning the manifest').toMatchObject({
        memberSessionId: member.id, name: ALPHA_FIX, version: '1.0.0', releaseManifestHash: manifestHash,
      })

      // FACT 2 — assembly really adopted the assignment: BOTH official paths
      // put the PINNED body INTO the member's real GenerateOptions requests,
      // attributed to the module assembly provider with the exact digest.
      const requestStart = memberAdapter.requests.length
      memberAdapter.append(
        skillsToolTurn('s2r1-skill', 'skill', { name: ALPHA_FIX }),
        [{ gate: finishGate }, ...skillsTextChunks('Both paths loaded; evidence submitted.')],
      )
      // Keep this one real turn open until its actual loading evidence is
      // submitted. A completed, unsubmitted turn legitimately releases the
      // official task attempt; the test must not invent a resident attempt.
      await gesture(member, memberAdapter, 'Use /alpha-fix and load it with the skill tool.', false, releaseReady)
      await vi.waitFor(() => expect(requestBodies(memberAdapter.requests.slice(requestStart))).toContain('s2r1-skill'), { timeout: 5_000 })
      await vi.waitFor(() => expect(memberAdapter.requests.at(-1)!.messages.flatMap(message => message.content)
        .some(block => block.type === 'tool-result' && block.toolCallId === 's2r1-skill')).toBe(true), { timeout: 5_000 })
      const releaseGestureRequest = memberAdapter.requests[requestStart]!
      await expectSkillInRequest(mounted, member, releaseGestureRequest, { name: ALPHA_FIX, provider: RELEASE_PROVIDER, content: ALPHA_FIX_BODY })
      await expectSkillInRequest(mounted, member, memberAdapter.requests.at(-1)!, { name: ALPHA_FIX, provider: RELEASE_PROVIDER, content: ALPHA_FIX_BODY }, 's2r1-skill')
      const loaded = requestBodies(memberAdapter.requests)
      expect(loaded, 'the pinned body entered the real requests').toContain(ALPHA_FIX_BODY)
      expect(sha256(ALPHA_FIX_BODY), 'the request body is exactly what the release manifest pins').toBe(releaseRow!.contentSha256 as string)

      // Read the actual member log BEFORE any request/status answer. Each
      // loaded message must have a retained attribution tied to that exact
      // invocation/result, not merely to the current assignment list.
      const invocation = releaseGestureRequest.messages.find(message => {
        const source = message.source as { kind?: string; name?: string } | undefined
        return source?.kind === 'skill-invocation' && source.name === ALPHA_FIX
      })
      if (invocation?.id === undefined) throw new Error('the actual gesture request has no canonical invocation message id')
      const invocationId = invocation.id
      const currentTask = (await mounted.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)?.tasks.find(task => task.id === taskId)
      if (currentTask?.currentAttemptId === undefined) throw new Error('the loading attempt is no longer current')
      const binding = [String(member.id), teamId, taskId, currentTask.currentAttemptId, ALPHA_FIX, '1.0.0', manifestHash]
      await vi.waitFor(async () => {
        const persisted = await readPersistedSession(mounted.ctx.sessionPersistence, member.id)
        const records = persisted.events.map(event => JSON.stringify(event.data))
        for (const ref of [invocationId, 's2r1-skill']) {
          expect(records.some(record => [...binding, ref].every(value => record.includes(value))), `the member's durable log must attribute actual load ${ref} before any availability answer`).toBe(true)
        }
      }, { timeout: 5_000 })

      // FACT 3 — the available-version ANSWER (not the effective claim; the
      // before/after requests above carry that proof): naming the skill on a
      // proven, owned, assigned request adopts durably.
      await submitTask()
      const intake = await captainSkillsTool(mounted.ctx, root, 's2r1-intake', REQUEST_TOOL, {
        request_id: 's2r1-request', revision: 1,
        question: 'Which approved release covers the proven rename fix?',
        task_id: taskId, evidence_refs: [realRef], skill_name: ALPHA_FIX,
      })
      expect(intake.ok, `the adoption intake must be accepted, got: ${failureFields(intake)}`).toBe(true)
      await module.flushWakes()
      const row = await readRow(sandbox, scope, teamId, 's2r1-request')
      expect(row, `the assigned release must have been adopted, got: ${JSON.stringify(row)}`).toMatchObject({
        state: 'available', revision: 1,
        result: { availableVersion: { name: ALPHA_FIX, version: '1.0.0' } },
      })
      expect(row!.reason ?? undefined, 'an adopted answer carries no failure reason').toBeUndefined()
    } finally {
      releaseFinish()
      await disposeMember()
      await disposeRestartComposition(mounted)
    }
  }, 120_000)

  it('R2: no assignment or no named skill never adopts (S1 terminal answer stands); the approved manifest is immutable; a ghost member cannot be assigned', async () => {
    const sandbox = await freshSandbox()
    const { mounted, root, teamId, scope, managerAdapter } = await mountS2(sandbox, [ALPHA_FIX])
    const taskId = await createS2Task(mounted.ctx, root, 's2r2-task', 'Task grounding the unassigned control')
    try {
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      managerAdapter.append(
        skillsToolTurn('inv-s2r2a', SKILLS_INVESTIGATE_TOOL, { request_id: 's2r2-named' }),
        skillsTextChunks('named settled.'),
        skillsToolTurn('inv-s2r2b', SKILLS_INVESTIGATE_TOOL, { request_id: 's2r2-unnamed' }),
        skillsTextChunks('unnamed settled.'),
      )
      const releases = releaseSurfaceOf(module)
      expect(typeof releases?.approveRelease, 'GREEN target: module-owned approved-release host management face').toBe('function')
      const base = {
        ...approveBase, scope, teamId, skillName: ALPHA_FIX, provider: PROVIDER,
        body: ALPHA_FIX_BODY, contentSha256: sha256(ALPHA_FIX_BODY), resourcesSha256: EMPTY_RESOURCES_SHA256,
      }
      await releases.approveRelease(base)
      const mutated = await releases.approveRelease({ ...base, body: 'mutated body text', contentSha256: sha256('mutated body text') }).then(
        () => undefined,
        (error: unknown) => error as Error,
      )
      expect(mutated, 'the same version with another internally valid manifest must conflict').toMatchObject({ code: 'SKILLS_RELEASE_CONFLICT' })

      const named = await captainSkillsTool(mounted.ctx, root, 's2r2-intake-named', REQUEST_TOOL, {
        request_id: 's2r2-named', revision: 1,
        question: 'Approved but nobody is assigned — what may I use?',
        task_id: taskId, skill_name: ALPHA_FIX,
      })
      expect(named.ok).toBe(true)
      const unnamed = await captainSkillsTool(mounted.ctx, root, 's2r2-intake-unnamed', REQUEST_TOOL, {
        request_id: 's2r2-unnamed', revision: 1,
        question: 'The S1 face stays exactly as accepted.', task_id: taskId,
      })
      expect(unnamed.ok).toBe(true)
      await module.flushWakes()
      for (const requestId of ['s2r2-named', 's2r2-unnamed']) {
        const row = await readRow(sandbox, scope, teamId, requestId)
        expect(row, `unassigned/unamed adoption must never fire, got: ${JSON.stringify(row)}`).toMatchObject({ state: 'unavailable', reason: 'no_approved_version' })
        expect((row!.result as { availableVersion?: unknown }).availableVersion ?? undefined, 'no attribution without a real assignment').toBeUndefined()
      }

      const ghost = await captainSkillsTool(mounted.ctx, root, 's2r2-assign-ghost', ASSIGN_TOOL, {
        skill_name: ALPHA_FIX, version: '1.0.0', member: 'ghost-session-not-in-team', expected_revision: 0,
      })
      expect(ghost.ok, 'assignment to a non-member must be refused').toBe(false)
      expect(await readAssignmentRow(sandbox, scope, teamId, 'ghost-session-not-in-team', ALPHA_FIX), 'a refused assignment leaves no durable row').toBeUndefined()
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 90_000)

  it('R3: a drifted source stays visible to an unassigned teammate; a Captain re-pin preserves the loaded attempt body and historical availability', async () => {
    const sandbox = await freshSandbox()
    const { mounted, root, teamId, scope, memberAdapter, member2Adapter, managerAdapter, entries } = await mountS2(sandbox, [ALPHA_FIX, BETA_FIX])
    const betaTask = await createS2Task(mounted.ctx, root, 's2r3-beta-task', 'Task grounding the assembly-flows-from-assignment proof')
    const gammaTask = await createS2Task(mounted.ctx, root, 's2r3-gamma-task', 'Task grounding the allow-list counterexample')
    const { member, disposeMember, releaseReady } = await liveTaskMember(mounted, root, 's2r3-worker', [ALPHA_FIX, BETA_FIX], memberAdapter)
    // A teammate who is on the allow-list but NOT assigned beta-fix: the
    // assembly must never leak into this member's scoped requests.
    const { member: teammate, disposeMember: disposeTeammate } = await liveScriptedMember(mounted, root, 's2r3-teammate', [ALPHA_FIX, BETA_FIX], MEMBER2_ROUTE)
    let releaseReload = () => {}
    let releaseFinish = () => {}
    const reloadGate = new Promise<void>(resolve => { releaseReload = resolve })
    const finishGate = new Promise<void>(resolve => { releaseFinish = resolve })
    try {
      const submitBeta = await claimCurrentTask(mounted, member, scope, teamId, betaTask, 's2r3-beta', 'evidence:skills-management/s2-assembly#beta')
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      managerAdapter.append(
        skillsToolTurn('inv-s2r3a', SKILLS_INVESTIGATE_TOOL, { request_id: 's2r3-beta' }),
        skillsTextChunks('beta settled.'),
        skillsToolTurn('inv-s2r3b', SKILLS_INVESTIGATE_TOOL, { request_id: 's2r3-gamma' }),
        skillsTextChunks('gamma settled.'),
      )
      const releases = releaseSurfaceOf(module)
      expect(typeof releases?.approveRelease, 'GREEN target: module-owned approved-release host management face').toBe('function')

      // Entry-time digest binding: a contentSha256 over DIFFERENT text is
      // refused — no digest may bind text that is not the captured body.
      const forged = await releases.approveRelease({
        ...approveBase, scope, teamId, skillName: BETA_FIX, provider: PROVIDER,
        body: BETA_FIX_BODY_V1, contentSha256: sha256('different text entirely'), resourcesSha256: EMPTY_RESOURCES_SHA256,
      }).then(() => undefined, (error: unknown) => error as Error)
      expect(forged, 'a digest not matching the captured body must be refused at entry').toBeDefined()
      expect(String(forged?.message)).toContain('digest')
      const forgedResources = await releases.approveRelease({
        ...approveBase, scope, teamId, skillName: BETA_FIX, provider: PROVIDER,
        body: BETA_FIX_BODY_V1, contentSha256: sha256(BETA_FIX_BODY_V1), resourcesSha256: sha256('some non-empty resources tree'),
      }).then(() => undefined, (error: unknown) => error as Error)
      expect(forgedResources, 'only the canonical EMPTY resources tree is approvable in this slice').toBeDefined()
      expect(String(forgedResources?.message)).toContain('resources')

      await releases.approveRelease({
        ...approveBase, scope, teamId, skillName: BETA_FIX, provider: PROVIDER,
        body: BETA_FIX_BODY_V1, contentSha256: sha256(BETA_FIX_BODY_V1), resourcesSha256: EMPTY_RESOURCES_SHA256,
      })
      await releases.approveRelease({
        ...approveBase, scope, teamId, skillName: GAMMA_FIX, provider: PROVIDER,
        body: GAMMA_FIX_BODY, contentSha256: sha256(GAMMA_FIX_BODY), resourcesSha256: EMPTY_RESOURCES_SHA256,
      })

      // REAL source drift BEFORE the assignment: the source serves v2.
      entries.find(entry => entry.name === BETA_FIX)!.content = BETA_FIX_BODY_V2

      // The unassigned control proves actual source drift without first loading
      // another body into the current attempt that is about to receive v1.
      member2Adapter.append(skillsToolTurn('s2r3-skill-beta-pre', 'skill', { name: BETA_FIX }), skillsTextChunks('Loaded the source.'))
      await gesture(teammate, member2Adapter, 'Load beta-fix via the skill tool.')
      const before = JSON.stringify(member2Adapter.requests.at(-1)!.messages)
      expect(before, 'without an assignment the raw source body is what loads').toContain(BETA_FIX_BODY_V2)
      await expectSkillInRequest(mounted, teammate, member2Adapter.requests.at(-1)!, { name: BETA_FIX, provider: PROVIDER, content: BETA_FIX_BODY_V2 }, 's2r3-skill-beta-pre')

      // The Captain assignment is the ONLY thing that changes next.
      const assignedRequestStart = memberAdapter.requests.length
      const betaAssign = await captainSkillsTool(mounted.ctx, root, 's2r3-assign-beta', ASSIGN_TOOL, {
        skill_name: BETA_FIX, version: '1.0.0', member: member.id, expected_revision: 0,
      })
      expect(betaAssign.ok, `beta assignment must be accepted, got: ${failureFields(betaAssign)}`).toBe(true)
      const gammaAssign = await captainSkillsTool(mounted.ctx, root, 's2r3-assign-gamma', ASSIGN_TOOL, {
        skill_name: GAMMA_FIX, version: '1.0.0', member: member.id, expected_revision: 0,
      })
      expect(gammaAssign.ok, 'off-allow-list assignment must be refused').toBe(false)
      expect(failureFields(gammaAssign), `refusal must name the allow-list, got: ${failureFields(gammaAssign)}`).toContain('not-team-allowed')
      expect(await readAssignmentRow(sandbox, scope, teamId, member.id, GAMMA_FIX), 'the refused assignment durably wrote nothing').toBeUndefined()

      // The UNASSIGNED teammate loads the same name: the member-scoped
      // assembly must not reach this Session — the raw source body only.
      member2Adapter.append(skillsToolTurn('s2r3-skill-beta-teammate', 'skill', { name: BETA_FIX }), skillsTextChunks('Loaded the raw source.'))
      await gesture(teammate, member2Adapter, 'Load beta-fix via the skill tool.')
      const teammateJson = JSON.stringify(member2Adapter.requests.at(-1)!.messages)
      expect(teammateJson, 'the teammate resolves the raw source body').toContain(BETA_FIX_BODY_V2)
      expect(teammateJson, 'the assigned release body never leaks to an unassigned teammate').not.toContain(BETA_FIX_BODY_V1)
      await expectSkillInRequest(mounted, teammate, member2Adapter.requests.at(-1)!, { name: BETA_FIX, provider: PROVIDER, content: BETA_FIX_BODY_V2 }, 's2r3-skill-beta-teammate')

      // AFTER the assignment BOTH official paths assemble the PINNED body;
      // the drifted v2 source body can NEVER enter a real request.
      memberAdapter.append(
        skillsToolTurn('s2r3-skill-beta-post', 'skill', { name: BETA_FIX }),
        [{ gate: reloadGate }, ...skillsToolTurn('s2r3-skill-beta-again', 'skill', { name: BETA_FIX })],
        skillsToolTurn('s2r3-skill-gamma', 'skill', { name: GAMMA_FIX }),
        [{ gate: finishGate }, ...skillsTextChunks('Pinned release evidence submitted.')],
      )
      await gesture(member, memberAdapter, 'Use /beta-fix and load it with the skill tool.', false, releaseReady)
      await vi.waitFor(() => expect(memberAdapter.requests.at(-1)!.messages.flatMap(message => message.content)
        .some(block => block.type === 'tool-result' && block.toolCallId === 's2r3-skill-beta-post')).toBe(true), { timeout: 5_000 })
      await expectSkillInRequest(mounted, member, memberAdapter.requests[assignedRequestStart]!, { name: BETA_FIX, provider: RELEASE_PROVIDER, content: BETA_FIX_BODY_V1 })
      await expectSkillInRequest(mounted, member, memberAdapter.requests.at(-1)!, { name: BETA_FIX, provider: RELEASE_PROVIDER, content: BETA_FIX_BODY_V1 }, 's2r3-skill-beta-post')
      // Select requests by the actual assignment boundary; retain canonical
      // history and never assume fixed positions for claim/notification turns.
      const allRequests = requestBodies(memberAdapter.requests)
      const postAssignment = requestBodies(memberAdapter.requests.slice(assignedRequestStart))
      expect(allRequests, 'the pinned body now rides the real requests through both paths').toContain(BETA_FIX_BODY_V1)
      expect(postAssignment, 'the drifted source body never enters any post-assignment request').not.toContain(BETA_FIX_BODY_V2)

      // Captain selection moves the durable next-version pin while the
      // already-loaded attempt retains its effective body and attribution.
      await releases.approveRelease({
        ...approveBase, scope, teamId, skillName: BETA_FIX, version: '2.0.0', provider: PROVIDER,
        body: BETA_FIX_BODY_V3, contentSha256: sha256(BETA_FIX_BODY_V3), resourcesSha256: EMPTY_RESOURCES_SHA256,
      })
      const swapped = await captainSkillsTool(mounted.ctx, root, 's2r3-reassign', ASSIGN_TOOL, {
        skill_name: BETA_FIX, version: '2.0.0', member: member.id, expected_revision: 1,
      })
      expect(swapped.ok, failureFields(swapped)).toBe(true)
      expect(swapped.value).toMatchObject({ version: '2.0.0', revision: 2, loaded_held: true })
      expect(await readAssignmentRow(sandbox, scope, teamId, member.id, BETA_FIX), 'the authorized next-version pin is durable').toMatchObject({ version: '2.0.0', revision: 2, releaseManifestHash: expect.any(String) })
      releaseReload()
      await vi.waitFor(() => expect(memberAdapter.requests.at(-1)!.messages.flatMap(message => message.content)
        .some(block => block.type === 'tool-result' && block.toolCallId === 's2r3-skill-beta-again')).toBe(true), { timeout: 5_000 })
      const stillPinned = JSON.stringify(memberAdapter.requests.at(-1)!.messages)
      expect(stillPinned).toContain(BETA_FIX_BODY_V1)
      expect(stillPinned, 'the future v2 body never enters this loaded attempt').not.toContain(BETA_FIX_BODY_V3)
      await expectSkillInRequest(mounted, member, memberAdapter.requests.at(-1)!, { name: BETA_FIX, provider: RELEASE_PROVIDER, content: BETA_FIX_BODY_V1 }, 's2r3-skill-beta-again')
      await vi.waitFor(() => expect(memberAdapter.requests.at(-1)!.messages.flatMap(message => message.content)
        .some(block => block.type === 'tool-result' && block.toolCallId === 's2r3-skill-gamma')).toBe(true), { timeout: 5_000 })

      // The answer layer (not the effective claim) follows the assembly.
      await submitBeta()
      const betaIntake = await captainSkillsTool(mounted.ctx, root, 's2r3-intake-beta', REQUEST_TOOL, {
        request_id: 's2r3-beta', revision: 1,
        question: 'Which approved beta-fix version is assembled for the task owner?',
        task_id: betaTask, evidence_refs: ['evidence:skills-management/s2-assembly#beta'], skill_name: BETA_FIX,
      })
      expect(betaIntake.ok).toBe(true)
      const gammaIntake = await captainSkillsTool(mounted.ctx, root, 's2r3-intake-gamma', REQUEST_TOOL, {
        request_id: 's2r3-gamma', revision: 1,
        question: 'Approved for this Team but never on its allow-list — may I use it?',
        task_id: gammaTask, skill_name: GAMMA_FIX,
      })
      expect(gammaIntake.ok).toBe(true)
      await module.flushWakes()
      const betaRow = await readRow(sandbox, scope, teamId, 's2r3-beta')
      expect(betaRow, `the assigned release must answer available, got: ${JSON.stringify(betaRow)}`).toMatchObject({
        state: 'available', result: { availableVersion: { name: BETA_FIX, version: '1.0.0' } },
      })
      const gammaRow = await readRow(sandbox, scope, teamId, 's2r3-gamma')
      expect(gammaRow, `an off-allow-list skill must never answer available, got: ${JSON.stringify(gammaRow)}`).toMatchObject({ state: 'unavailable', reason: 'no_approved_version' })
      expect((gammaRow!.result as { availableVersion?: unknown }).availableVersion ?? undefined, 'an off-list skill must never surface availableVersion').toBeUndefined()

      // Official load entry also refuses gamma for the member: the off-list
      // body never enters a real request through the tool path either.
      const gammaTurn = JSON.stringify(memberAdapter.requests.at(-1)!.messages)
      expect(gammaTurn, 'the off-list gamma body never entered a real request').not.toContain(GAMMA_FIX_BODY)
      expect(gammaTurn).toContain('not allowed')
      await module.close()
      expect(await mounted.ctx.skills.get(BETA_FIX, { scope: member }), 'closing Skills removes its member-scoped release provider').toMatchObject({ provider: PROVIDER, content: BETA_FIX_BODY_V2 })
      expect(mounted.ctx.agents.get(member.id), 'module close preserves the business Agent').toBe(member)
    } finally {
      releaseReload()
      releaseFinish()
      await disposeTeammate()
      await disposeMember()
      await disposeRestartComposition(mounted)
    }
  }, 180_000)
})
