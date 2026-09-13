/** Public composition proof for independent approval and version changes. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalJson } from '../src/storage/skills-management.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import {
  captainSkillsTool, createSkillsTeam, disposeRestartComposition,
  mountSkillsComposition, mountSkillsModule, SKILLS_MANAGER_ROUTE,
  skillsManagerModuleConfig, skillsModule, SkillsManagerScriptAdapter,
  skillsTextChunks, skillsToolTurn, skillsUnitFile,
  type RestartMounted,
} from './helpers/skills-management-composition.js'
import { failureFields, REQUEST_TOOL, skillsSandboxTracker, toolNames } from './helpers/skills-management-support.js'
import {
  MEMBER_ROUTE, RELEASE_PROVIDER, claimCurrentTask, createS2Task,
  expectSkillInRequest, gesture, liveTaskMember, requestBodies,
} from './helpers/skills-management-release.js'

const { freshSandbox } = skillsSandboxTracker('dsh-skills-revision-')
const NAME = 'alpha-fix'
const PROVIDER = 'revision-raw-source'
const RAW = 'Unassigned raw source: rename after flushing.'
const V1 = 'Approved version one: journal then rename.'
const V2 = 'Approved version two: replay the journal before rename.'
const ASSIGN = 'agent_swarm_skills_assign'
const PROPOSE = 'agent_swarm_skills_propose'
const REVIEW = 'agent_swarm_skills_review'
const CANDIDATES = 'agent_swarm_skills_candidates'
const sha = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')
const emptyResources = sha(canonicalJson([]))

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function setup() {
  const sandbox = await freshSandbox()
  const memberAdapter = new SkillsManagerScriptAdapter()
  const managerAdapter = new SkillsManagerScriptAdapter()
  const mounted = await mountSkillsComposition(sandbox, {
    [MEMBER_ROUTE.provider]: memberAdapter,
    [SKILLS_MANAGER_ROUTE.provider]: managerAdapter,
  }, { allowedSkills: [NAME], skillCatalog: { providerName: PROVIDER, entries: [
    { name: NAME, description: 'Rename durability.', content: RAW },
  ] } })
  const { root, teamId } = await createSkillsTeam(mounted, sandbox)
  const scope = mounted.ctx.agentSwarm.scopeOf(root)
  return { sandbox, mounted, root, teamId, scope, memberAdapter, managerAdapter }
}
type Fixture = Awaited<ReturnType<typeof setup>>

async function table(f: Fixture, name: string): Promise<Record<string, Record<string, unknown>>> {
  const unit = JSON.parse(await readFile(skillsUnitFile(f.sandbox), 'utf8')) as { tables: Record<string, Record<string, Record<string, unknown>>> }
  return unit.tables[name] ?? {}
}

async function approve(f: Fixture, version: string, body: string) {
  return await skillsModule(f.mounted.ctx).releases.approveRelease({
    scope: f.scope, teamId: f.teamId, skillName: NAME, version, body,
    provider: PROVIDER, locator: 'fixture:rename', contentSha256: sha(body),
    resourcesSha256: emptyResources, applicability: 'Rename durability',
    verification: 'Deterministic composition validation', approvedBy: 'trusted-host-fixture',
  })
}

async function assign(f: Fixture, member: Agent, version: string, revision: number) {
  return await captainSkillsTool(f.mounted.ctx, f.root, `assign-${version}-${revision}`, ASSIGN, {
    skill_name: NAME, version, member: member.id, expected_revision: revision,
  })
}

async function currentAttempt(f: Fixture, taskId: string): Promise<string> {
  const team = (await f.mounted.ctx.agentSwarm.listTeamAggregates(f.scope)).find(row => row.id === f.teamId)
  const task = team?.tasks.find(row => row.id === taskId)
  expect(task?.currentAttemptId, 'the official claimed task has an attempt').toBeTruthy()
  return String(task!.currentAttemptId)
}

async function acceptTask(f: Fixture, taskId: string): Promise<void> {
  const team = (await f.mounted.ctx.agentSwarm.listTeamAggregates(f.scope)).find(row => row.id === f.teamId)
  const task = team!.tasks.find(row => row.id === taskId)!
  const accepted = await captainSkillsTool(f.mounted.ctx, f.root, `accept-${taskId}`, 'agent_swarm_review_task', {
    task_id: taskId, attempt_id: task.currentAttemptId, expected_revision: task.revision,
    decision: 'accept', diagnostic: 'The exact retained delivery and its loading proof were checked.',
  })
  expect(accepted.ok, failureFields(accepted)).toBe(true)
  expect(accepted.value).toMatchObject({ status: 'completed' })
}

async function loadedRequest(adapter: SkillsManagerScriptAdapter, callId: string): Promise<GenerateOptions> {
  return await vi.waitFor(() => {
    const found = adapter.requests.find(request => request.messages.some(message => message.content.some(
      block => block.type === 'tool-result' && block.toolCallId === callId,
    )))
    expect(found, `the actual model request contains tool result ${callId}`).toBeTruthy()
    return found!
  }, { timeout: 5_000 })
}

async function loadProof(f: Fixture, member: Agent, callId: string, body: string, version: string, taskId: string, attemptId: string) {
  const request = await loadedRequest(f.memberAdapter, callId)
  await expectSkillInRequest(f.mounted, member, request, { name: NAME, provider: RELEASE_PROVIDER, content: body }, callId)
  const release = (await table(f, 'releases'))[JSON.stringify([f.scope, f.teamId, NAME, version])]!
  const result = request.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === callId)
  if (result?.type !== 'tool-result') throw new Error(`missing load ${callId}`)
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  const match = /<release_provenance>([\s\S]*?)<\/release_provenance>/.exec(text)
  expect(match, 'the loaded result carries its actual release attribution').toBeTruthy()
  const provenance = JSON.parse(match![1]!) as Record<string, unknown>
  expect(provenance).toMatchObject({
    name: NAME, version, memberSessionId: String(member.id), teamId: f.teamId,
    taskId, attemptId, manifestHash: release.manifestHash, contentSha256: sha(body),
  })
  return { callId, taskId, attemptId, version, manifestHash: String(release.manifestHash), contentSha256: sha(body) }
}

/** Hold the first real cold request before it can emit a skill call. This
 * leaves a legal window to claim the new task, then load inside that attempt. */
async function wake(f: Fixture, childId: string, callId: string, releasePrevious?: () => void) {
  const ready = gate(), finish = gate()
  const start = f.memberAdapter.requests.length
  f.memberAdapter.append(
    [{ gate: ready.promise }, ...skillsToolTurn(callId, 'skill', { name: NAME })],
    [{ gate: finish.promise }, ...skillsTextChunks(`Finished ${callId}.`)],
  )
  await f.mounted.ctx.subagents.sendMessage(f.root, SessionId(childId), [
    { type: 'text', text: `Continue the next task; load the rename protocol. Marker ${callId}.` },
  ], { signal: new AbortController().signal })
  releasePrevious?.()
  await vi.waitFor(() => {
    expect(requestBodies(f.memberAdapter.requests.slice(start))).toContain(callId)
    expect(f.mounted.ctx.agents.get(SessionId(childId))?.status).toBe('running')
  }, { timeout: 5_000 })
  return { member: f.mounted.ctx.agents.get(SessionId(childId))!, ready, finish }
}

async function cold(mounted: RestartMounted, member: Agent): Promise<void> {
  await member.whenIdle()
  await vi.waitFor(() => expect(mounted.ctx.agents.get(member.id), 'the official settled Activation releases naturally').toBeUndefined(), { timeout: 5_000 })
}

describe('Skills independent revisions and official continuation', () => {
  it('P0: a real manager proposes a never-loaded body; a different Captain reads and approves it before an actual assigned load', async () => {
    const f = await setup()
    const initial = await liveTaskMember(f.mounted, f.root, 'proposal-worker', [NAME], f.memberAdapter)
    const finish = gate()
    try {
      const evidenceRef = 'evidence:skills-revision#new-body-gap'
      const evidenceTask = await createS2Task(f.mounted.ctx, f.root, 'proposal-evidence', 'Observed rename gap')
      const submitEvidence = await claimCurrentTask(f.mounted, initial.member, f.scope, f.teamId, evidenceTask, 'proposal-evidence', evidenceRef)
      await submitEvidence()
      await acceptTask(f, evidenceTask)
      await mountSkillsModule(f.mounted.ctx, skillsManagerModuleConfig(f.scope, f.teamId), f.mounted.fibers)
      const module = skillsModule(f.mounted.ctx)
      await approve(f, '8.0.0', 'An already approved base that this candidate revises.')
      const fresh = 'A never-published and never-loaded candidate: flush journal then rename.'
      const candidate = { request_id: 'new-body-request', skill_name: NAME, version: '9.0.0', base_version: '8.0.0', provider: PROVIDER,
        locator: 'fixture:new-body', body: fresh, applicability: 'The observed gap', verification: 'Captured deterministic validation' }
      f.managerAdapter.append(
        skillsToolTurn('manager-investigate', 'skills_management_investigate', { request_id: 'new-body-request' }),
        skillsToolTurn('manager-propose', PROPOSE, candidate),
        skillsToolTurn('manager-clash', PROPOSE, { ...candidate, body: 'A conflicting replacement body.' }),
        skillsToolTurn('manager-missing-base', PROPOSE, { ...candidate, version: '9.1.0', base_version: 'missing-base' }),
        skillsToolTurn('manager-self-approve', REVIEW, { skill_name: NAME, version: '9.0.0', decision: 'approve' }),
        skillsToolTurn('manager-forged-approve', REVIEW, { skill_name: NAME, version: '9.0.0', decision: 'approve', approved_by: String(f.root.id) }),
        skillsTextChunks('Candidate awaits independent review.'),
      )
      const requested = await captainSkillsTool(f.mounted.ctx, f.root, 'new-body-request', REQUEST_TOOL, {
        request_id: 'new-body-request', revision: 1, question: 'Propose a reusable skill for the observed gap.',
        task_id: evidenceTask, evidence_refs: [evidenceRef],
      })
      expect(requested.ok, failureFields(requested)).toBe(true)
      await module.flushWakes()
      expect(f.managerAdapter.requests.length).toBeGreaterThan(0)
      expect(toolNames(f.managerAdapter.requests[0]!.tools), 'the actual manager request exposes the scoped proposal tool').toContain(PROPOSE)
      expect(toolNames(f.managerAdapter.requests[0]!.tools), 'the author has no review tool').not.toContain(REVIEW)
      const captured = (await table(f, 'candidates'))[JSON.stringify([f.scope, f.teamId, NAME, '9.0.0'])]!
      expect(captured).toMatchObject({ body: fresh, status: 'pending', baseVersion: '8.0.0', requestId: 'new-body-request', contentSha256: sha(fresh), authorSessionId: module.managerAgentId })
      expect(module.managerAgentId).not.toBe(String(f.root.id))
      expect(Object.keys(await table(f, 'releases')), 'self approval by omission or forged label left only the pre-existing base').toEqual([JSON.stringify([f.scope, f.teamId, NAME, '8.0.0'])])
      expect(Object.keys(await table(f, 'candidates')), 'a missing base cannot capture a derived candidate').toHaveLength(1)
      for (const id of ['manager-clash', 'manager-missing-base', 'manager-self-approve', 'manager-forged-approve']) {
        const request = await loadedRequest(f.managerAdapter, id)
        expect(request.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === id)).toMatchObject({ isError: true })
      }
      const early = await assign(f, initial.member, '9.0.0', 0)
      expect(early.ok).toBe(false)
      expect(failureFields(early)).toContain('RELEASE_NOT_FOUND')
      const listed = await captainSkillsTool(f.mounted.ctx, f.root, 'read-candidate', CANDIDATES, { pending_only: true })
      expect(listed.ok, failureFields(listed)).toBe(true)
      expect(listed.value).toMatchObject({ candidates: [ { skill_name: NAME, version: '9.0.0', body: fresh,
        content_sha256: sha(fresh), base_version: '8.0.0', author_session_id: module.managerAgentId, request_id: 'new-body-request', candidate_hash: captured.candidateHash } ] })
      const denied = await captainSkillsTool(f.mounted.ctx, initial.member, 'member-review', REVIEW, { skill_name: NAME, version: '9.0.0', decision: 'approve' })
      expect(denied.ok).toBe(false)
      const reviewed = await captainSkillsTool(f.mounted.ctx, f.root, 'captain-review', REVIEW, { skill_name: NAME, version: '9.0.0', decision: 'approve' })
      expect(reviewed.ok, failureFields(reviewed)).toBe(true)
      expect(reviewed.value).toMatchObject({ skill_name: NAME, version: '9.0.0', status: 'approved', author_session_id: module.managerAgentId })
      const row = (await table(f, 'releases'))[JSON.stringify([f.scope, f.teamId, NAME, '9.0.0'])]!
      expect(row).toMatchObject({ body: fresh, approvedBy: String(f.root.id), authorSessionId: module.managerAgentId })
      const rejectApproved = await captainSkillsTool(f.mounted.ctx, f.root, 'reject-approved', REVIEW, { skill_name: NAME, version: '9.0.0', decision: 'reject' })
      expect(rejectApproved.ok, 'an approved release cannot be contradicted by a later rejection').toBe(false)
      const replay = await captainSkillsTool(f.mounted.ctx, f.root, 'review-replay', REVIEW, { skill_name: NAME, version: '9.0.0', decision: 'approve' })
      expect(replay.ok, failureFields(replay)).toBe(true)
      expect((await table(f, 'releases'))[JSON.stringify([f.scope, f.teamId, NAME, '9.0.0'])]).toEqual(row)
      const taskId = await createS2Task(f.mounted.ctx, f.root, 'candidate-use', 'Use independently approved candidate')
      const submit = await claimCurrentTask(f.mounted, initial.member, f.scope, f.teamId, taskId, 'candidate-use', 'evidence:skills-revision#candidate-use')
      const attemptId = await currentAttempt(f, taskId)
      const assigned = await assign(f, initial.member, '9.0.0', 0)
      expect(assigned.ok, failureFields(assigned)).toBe(true)
      f.memberAdapter.append(skillsToolTurn('approved-new-load', 'skill', { name: NAME }), [{ gate: finish.promise }, ...skillsTextChunks('Loaded.')])
      await gesture(initial.member, f.memberAdapter, 'Use /alpha-fix and load it through the skill tool.', false, initial.releaseReady)
      await loadProof(f, initial.member, 'approved-new-load', fresh, '9.0.0', taskId, attemptId)
      await submit()
      await acceptTask(f, taskId)
    } finally {
      finish.release()
      await initial.disposeMember()
      await disposeRestartComposition(f.mounted)
    }
  }, 45_000)

  it('P1: a different release occupying the same version cannot approve or impersonate the captured candidate', async () => {
    const f = await setup()
    const initial = await liveTaskMember(f.mounted, f.root, 'collision-worker', [NAME], f.memberAdapter)
    try {
      const taskId = await createS2Task(f.mounted.ctx, f.root, 'collision-task', 'A gap requiring a new candidate')
      const evidenceRef = 'evidence:skills-revision#collision'
      const submit = await claimCurrentTask(f.mounted, initial.member, f.scope, f.teamId, taskId, 'collision', evidenceRef)
      await submit()
      await acceptTask(f, taskId)
      await mountSkillsModule(f.mounted.ctx, skillsManagerModuleConfig(f.scope, f.teamId), f.mounted.fibers)
      f.managerAdapter.append(
        skillsToolTurn('collision-investigate', 'skills_management_investigate', { request_id: 'collision-request' }),
        skillsToolTurn('collision-propose', PROPOSE, {
          request_id: 'collision-request', skill_name: NAME, version: '7.0.0', provider: PROVIDER,
          locator: 'fixture:collision', body: 'The manager captured THIS candidate body.',
          applicability: 'The new request', verification: 'Candidate-specific validation',
        }), skillsTextChunks('The capture awaits independent approval.'),
      )
      const request = await captainSkillsTool(f.mounted.ctx, f.root, 'collision-request', REQUEST_TOOL, {
        request_id: 'collision-request', revision: 1, question: 'Propose a new candidate for this gap.',
        task_id: taskId, evidence_refs: [evidenceRef],
      })
      expect(request.ok, failureFields(request)).toBe(true)
      await skillsModule(f.mounted.ctx).flushWakes()
      const key = JSON.stringify([f.scope, f.teamId, NAME, '7.0.0'])
      expect((await table(f, 'candidates'))[key]).toMatchObject({ status: 'pending', body: 'The manager captured THIS candidate body.' })
      // The trusted external management face can race the Captain review;
      // an unrelated approved body is a different fact despite the same slot.
      await approve(f, '7.0.0', 'A DIFFERENT body independently supplied by the Host.')
      const before = (await table(f, 'releases'))[key]!
      const listed = await captainSkillsTool(f.mounted.ctx, f.root, 'collision-read', CANDIDATES, {})
      expect(listed.ok, failureFields(listed)).toBe(true)
      expect(listed.value, 'slot occupancy is not approval of this specific capture').toMatchObject({ candidates: [{
        version: '7.0.0', status: 'pending', body: 'The manager captured THIS candidate body.',
      }] })
      const reviewed = await captainSkillsTool(f.mounted.ctx, f.root, 'collision-review', REVIEW, { skill_name: NAME, version: '7.0.0', decision: 'approve' })
      expect(reviewed.ok, 'a different immutable manifest must conflict, not replay approval').toBe(false)
      expect(failureFields(reviewed)).toContain('CONFLICT')
      const rejected = await captainSkillsTool(f.mounted.ctx, f.root, 'collision-reject', REVIEW, { skill_name: NAME, version: '7.0.0', decision: 'reject' })
      expect(rejected.ok, 'rejecting this unapproved candidate preserves the other approved release').toBe(true)
      expect((await table(f, 'candidates'))[key]).toMatchObject({ status: 'rejected' })
      expect((await table(f, 'releases'))[key]).toEqual(before)
    } finally {
      await initial.disposeMember()
      await disposeRestartComposition(f.mounted)
    }
  }, 30_000)

  it('R1: v1 is held during a re-pin; official next attempts really load v2 then rollback v1, with separate durable attribution', async () => {
    const f = await setup()
    const initial = await liveTaskMember(f.mounted, f.root, 'version-worker', [NAME], f.memberAdapter)
    const reload = gate(), finishA = gate()
    const held: { ready: ReturnType<typeof gate>; finish: ReturnType<typeof gate> }[] = []
    try {
      await mountSkillsModule(f.mounted.ctx, skillsManagerModuleConfig(f.scope, f.teamId), f.mounted.fibers)
      await approve(f, '1.0.0', V1)
      await approve(f, '2.0.0', V2)
      const taskA = await createS2Task(f.mounted.ctx, f.root, 'task-a', 'Version one attempt')
      const submitA = await claimCurrentTask(f.mounted, initial.member, f.scope, f.teamId, taskA, 'attempt-a', 'evidence:skills-revision#a')
      const attemptA = await currentAttempt(f, taskA)
      const a = await assign(f, initial.member, '1.0.0', 0)
      expect(a.ok, failureFields(a)).toBe(true)
      f.memberAdapter.append(
        skillsToolTurn('load-a', 'skill', { name: NAME }),
        [{ gate: reload.promise }, ...skillsToolTurn('load-a-held', 'skill', { name: NAME })],
        [{ gate: finishA.promise }, ...skillsTextChunks('Attempt A complete.')],
      )
      const requestStart = f.memberAdapter.requests.length
      await gesture(initial.member, f.memberAdapter, 'Use /alpha-fix and load the protocol.', false, initial.releaseReady)
      const proofs = [await loadProof(f, initial.member, 'load-a', V1, '1.0.0', taskA, attemptA)]
      await expectSkillInRequest(f.mounted, initial.member, f.memberAdapter.requests[requestStart]!, { name: NAME, provider: RELEASE_PROVIDER, content: V1 })
      const moved = await assign(f, initial.member, '2.0.0', 1)
      expect(moved.ok, failureFields(moved)).toBe(true)
      expect(moved.value).toMatchObject({ version: '2.0.0', revision: 2, loaded_held: true })
      reload.release()
      proofs.push(await loadProof(f, initial.member, 'load-a-held', V1, '1.0.0', taskA, attemptA))
      expect(requestBodies(f.memberAdapter.requests)).not.toContain(V2)
      const stale = await assign(f, initial.member, '1.0.0', 1)
      expect(stale.ok).toBe(false)
      expect(failureFields(stale)).toContain('STALE')
      await submitA()
      await acceptTask(f, taskA)
      finishA.release()
      await cold(f.mounted, initial.member)

      const taskB = await createS2Task(f.mounted.ctx, f.root, 'task-b', 'Version two attempt')
      const b = await wake(f, String(initial.member.id), 'load-b')
      held.push(b)
      const submitB = await claimCurrentTask(f.mounted, b.member, f.scope, f.teamId, taskB, 'attempt-b', 'evidence:skills-revision#b')
      const attemptB = await currentAttempt(f, taskB)
      b.ready.release()
      proofs.push(await loadProof(f, b.member, 'load-b', V2, '2.0.0', taskB, attemptB))
      await submitB()
      await acceptTask(f, taskB)
      b.finish.release()
      await cold(f.mounted, b.member)
      const rollback = await assign(f, b.member, '1.0.0', 2)
      expect(rollback.ok, failureFields(rollback)).toBe(true)
      expect(rollback.value).toMatchObject({ version: '1.0.0', revision: 3 })

      const taskC = await createS2Task(f.mounted.ctx, f.root, 'task-c', 'Rollback attempt')
      const c = await wake(f, String(initial.member.id), 'load-c')
      held.push(c)
      const submitC = await claimCurrentTask(f.mounted, c.member, f.scope, f.teamId, taskC, 'attempt-c', 'evidence:skills-revision#c')
      const attemptC = await currentAttempt(f, taskC)
      c.ready.release()
      proofs.push(await loadProof(f, c.member, 'load-c', V1, '1.0.0', taskC, attemptC))
      expect(new Set([attemptA, attemptB, attemptC]).size, 'these are three real independently claimed attempts').toBe(3)
      await vi.waitFor(async () => {
        const persisted = await readPersistedSession(f.mounted.ctx.sessionPersistence, initial.member.id)
        for (const proof of proofs) {
          const event = persisted.events.find(entry => {
            if (entry.type !== 'tool/result') return false
            const data = entry.data as { message?: { source?: { callId?: string } } }
            return data.message?.source?.callId === proof.callId
          })
          expect(event, `canonical tool result ${proof.callId} is retained`).toBeTruthy()
          const record = JSON.stringify(event!.data)
          for (const value of [String(initial.member.id), f.teamId, NAME, proof.taskId, proof.attemptId, proof.version, proof.manifestHash, proof.contentSha256]) expect(record).toContain(value)
        }
      }, { timeout: 5_000 })
      await submitC()
      await acceptTask(f, taskC)
      const team = (await f.mounted.ctx.agentSwarm.listTeamAggregates(f.scope)).find(row => row.id === f.teamId)
      expect(team?.allowedSkills).toEqual([NAME])
    } finally {
      reload.release(); finishA.release()
      for (const phase of held) { phase.ready.release(); phase.finish.release() }
      await initial.disposeMember()
      await disposeRestartComposition(f.mounted)
    }
  }, 45_000)

  it('R3 same Activation: the next accepted-and-claimed task switches the pinned version without forcing a cold resume', async () => {
    const f = await setup()
    const initial = await liveTaskMember(f.mounted, f.root, 'continuous-worker', [NAME], f.memberAdapter)
    const finishA = gate()
    let next: Awaited<ReturnType<typeof wake>> | undefined
    try {
      await mountSkillsModule(f.mounted.ctx, skillsManagerModuleConfig(f.scope, f.teamId), f.mounted.fibers)
      await approve(f, '1.0.0', V1)
      await approve(f, '2.0.0', V2)
      const taskA = await createS2Task(f.mounted.ctx, f.root, 'live-task-a', 'First continuous task')
      const submitA = await claimCurrentTask(f.mounted, initial.member, f.scope, f.teamId, taskA, 'live-a', 'evidence:skills-revision#live-a')
      const attemptA = await currentAttempt(f, taskA)
      const first = await assign(f, initial.member, '1.0.0', 0)
      expect(first.ok, failureFields(first)).toBe(true)
      f.memberAdapter.append(skillsToolTurn('live-load-a', 'skill', { name: NAME }), [{ gate: finishA.promise }, ...skillsTextChunks('First task ready for review.')])
      await gesture(initial.member, f.memberAdapter, 'Use /alpha-fix and load the protocol.', false, initial.releaseReady)
      await loadProof(f, initial.member, 'live-load-a', V1, '1.0.0', taskA, attemptA)
      const moved = await assign(f, initial.member, '2.0.0', 1)
      expect(moved.ok, failureFields(moved)).toBe(true)
      expect(moved.value).toMatchObject({ loaded_held: true })
      await submitA()
      await acceptTask(f, taskA)
      const taskB = await createS2Task(f.mounted.ctx, f.root, 'live-task-b', 'Next continuous task')
      const submitB = await claimCurrentTask(f.mounted, initial.member, f.scope, f.teamId, taskB, 'live-b', 'evidence:skills-revision#live-b')
      const attemptB = await currentAttempt(f, taskB)
      expect(attemptB).not.toBe(attemptA)
      // Queue the continuation before the prior finish gate opens: the
      // existing official owner has a next turn and stays the SAME Agent.
      next = await wake(f, String(initial.member.id), 'live-load-b', finishA.release)
      expect(next.member, 'the new task uses the same live Agent object').toBe(initial.member)
      next.ready.release()
      await loadProof(f, next.member, 'live-load-b', V2, '2.0.0', taskB, attemptB)
      await submitB()
      await acceptTask(f, taskB)
    } finally {
      finishA.release(); next?.ready.release(); next?.finish.release()
      await initial.disposeMember()
      await disposeRestartComposition(f.mounted)
    }
  }, 30_000)

  it('R2 control: an unassigned member keeps the raw source through an official cold continuation', async () => {
    const f = await setup()
    const initial = await liveTaskMember(f.mounted, f.root, 'unassigned-worker', [NAME], f.memberAdapter)
    const finish = gate()
    let resumed: Awaited<ReturnType<typeof wake>> | undefined
    try {
      await mountSkillsModule(f.mounted.ctx, skillsManagerModuleConfig(f.scope, f.teamId), f.mounted.fibers)
      await approve(f, '1.0.0', V1)
      f.memberAdapter.append(skillsToolTurn('raw-live', 'skill', { name: NAME }), [{ gate: finish.promise }, ...skillsTextChunks('Raw source used.')])
      await gesture(initial.member, f.memberAdapter, 'Use /alpha-fix and load the protocol.', false, initial.releaseReady)
      await expectSkillInRequest(f.mounted, initial.member, await loadedRequest(f.memberAdapter, 'raw-live'), { name: NAME, provider: PROVIDER, content: RAW }, 'raw-live')
      finish.release()
      await cold(f.mounted, initial.member)
      resumed = await wake(f, String(initial.member.id), 'raw-cold')
      resumed.ready.release()
      await expectSkillInRequest(f.mounted, resumed.member, await loadedRequest(f.memberAdapter, 'raw-cold'), { name: NAME, provider: PROVIDER, content: RAW }, 'raw-cold')
      expect(requestBodies(f.memberAdapter.requests)).not.toContain(V1)
      expect(Object.keys(await table(f, 'assignments'))).toHaveLength(0)
    } finally {
      finish.release(); resumed?.ready.release(); resumed?.finish.release()
      await initial.disposeMember()
      await disposeRestartComposition(f.mounted)
    }
  }, 30_000)
})
