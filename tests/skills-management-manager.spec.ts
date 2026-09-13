/**
 * S1 skills-management manager CORE batch (task-1, attempt-1830b1d8).
 *
 * The dedicated manager must be REAL: one module-owned Agent Handle on its
 * OWN model route (never the Team/Captain default), scoped to only its
 * official investigate Consumer under the official `restrict({ allow: [] })`,
 * actually reading authorized work facts and durably persisting the result.
 * The turn cycle runs through the real AgentLoop: the scripted manager turn
 * emits a real `skills_management_investigate` tool call whose execution does
 * the durable read+write — completing at all proves the single-entry Team
 * lock never self-deadlocks. A GLOBAL tool registered AFTER the manager
 * exists must stay unexecutable by the manager while business Agents keep
 * their permissions. Authorization fences live in
 * skills-management-manager-fences.spec.ts; session durability in
 * skills-management-manager-session.spec.ts; batch acknowledgement in
 * skills-management-ack.spec.ts.
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  captainSkillsTool,
  createSkillsTask,
  createSkillsTeam,
  disposeRestartComposition,
  liveSkillsAgent,
  mountSkillsComposition,
  mountSkillsModule,
  registerSkillsLateGlobalTool,
  RESTART_SIGNAL,
  SKILLS_CAPTAIN_ROUTE,
  SKILLS_INVESTIGATE_TOOL,
  SKILLS_LATE_GLOBAL_TOOL,
  SKILLS_MANAGER_ROUTE,
  SKILLS_ROOT,
  skillsAdapter,
  SkillsHeldChildAdapter,
  SkillsManagerScriptAdapter,
  skillsManagerModuleConfig,
  skillsModule,
  skillsTextChunks,
  skillsToolTurn,
} from './helpers/skills-management-composition.js'
import {
  failureFields,
  readConsumerRow,
  readRow,
  REQUEST_TOOL,
  skillsSandboxTracker,
  STATUS_TOOL,
  toolNames,
} from './helpers/skills-management-support.js'

const tracker = skillsSandboxTracker('dsh-skills-mgr-')
const freshSandbox = tracker.freshSandbox

/** Read the REAL official tool-result block the live loop delivered for the
 *  inv-s1 call out of the GenerateOptions history — matched EXACTLY by the
 *  ToolResultBlock toolCallId (never fuzzy JSON content), never a
 *  hand-assembled result, never private thoughts. */
function captureInvS1ToolResult(options: GenerateOptions): { present: boolean; isError: unknown; summary: string } {
  const blocks = options.messages.flatMap(message =>
    Array.isArray((message as { content?: unknown }).content) ? (message as { content: unknown[] }).content : [],
  )
  const hit = blocks.find(block =>
    typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'tool-result'
    && String((block as { toolCallId?: unknown }).toolCallId) === 'inv-s1')
  if (hit === undefined) return { present: false, isError: undefined, summary: 'no tool-result block with toolCallId inv-s1 in the delivered history' }
  const record = hit as Record<string, unknown>
  return {
    present: true,
    isError: record.isError ?? undefined,
    summary: JSON.stringify(hit).slice(0, 2_000),
  }
}

describe('S1 manager core: real processing, real evidence, legal supplement', () => {
  it('drives one real investigate turn, persists the result, and stays tool-restricted (restrict({allow:[]}) + late-global counterexample)', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)

      const handle = await module.ensureManager()
      expect(handle, 'a configured manager route must produce one dedicated Agent Handle').toBeDefined()

      // The counterexample tool is registered GLOBALLY only AFTER the manager
      // Session already exists — the official empty-allow restriction must keep
      // filtering it out continuously (enumerate-then-deny would leak this).
      registerSkillsLateGlobalTool(mounted.ctx)

      const taskId = await createSkillsTask(mounted.ctx, root, 'mgr-task-create', 'Stabilize Windows JSON rename durability')
      expect(managerAdapter.requests, 'creating the manager must not itself call the model').toHaveLength(0)

      managerAdapter.append(
        skillsToolTurn('inv-a', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-task-request' }),
        skillsTextChunks('A investigated.'),
        skillsToolTurn('inv-b', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-external-request' }),
        skillsTextChunks('B investigated.'),
      )

      const captainRouteBefore = skillsAdapter(mounted).requests.length

      const intakeA = await captainSkillsTool(mounted.ctx, root, 'mgr-intake-a', REQUEST_TOOL, {
        request_id: 'mgr-task-request', revision: 1,
        question: 'Is there an approved release covering the durable-rename fix?',
        task_id: taskId,
      })
      expect(intakeA.ok, `intake A must be accepted, got: ${failureFields(intakeA)}`).toBe(true)
      expect(intakeA.value).toMatchObject({ request_id: 'mgr-task-request', received: true })
      await module.flushWakes()

      // Minimal S1 has no release authority: the manager must read the real
      // work facts and durably answer `unavailable / no_approved_version` —
      // never a fake available, never a silent stall.
      const rowA = await readRow(sandbox, scope, teamId, 'mgr-task-request')
      expect(rowA, 'the manager outcome must be durable').toBeTruthy()
      expect(rowA).toMatchObject({ state: 'unavailable', reason: 'no_approved_version', managerSessionId: handle!.agent.id })
      const resultA = rowA!.result as { sourceRevision?: number; activityCursorSequence?: number }
      expect(resultA.sourceRevision, 'the source Team revision must be bound into the result').toBeTypeOf('number')
      expect(resultA.activityCursorSequence, 'the authorized activity page must have been consumed (cursor advanced)').toBeGreaterThan(0)

      const intakeB = await captainSkillsTool(mounted.ctx, root, 'mgr-intake-b', REQUEST_TOOL, {
        request_id: 'mgr-external-request', revision: 1,
        question: 'Does the referenced external artifact prove the original working version?',
        task_id: taskId,
        evidence_refs: [`file:C:/evidence/renames.ts#sha256:${'0'.repeat(64)}`],
      })
      expect(intakeB.ok, `intake B must be accepted, got: ${failureFields(intakeB)}`).toBe(true)
      await module.flushWakes()

      // A Captain-supplied path/hash grants NO file permission and proves no
      // historical version: the ref is explicitly unprovable, never read.
      const rowB = await readRow(sandbox, scope, teamId, 'mgr-external-request')
      expect(rowB).toMatchObject({ state: 'needs_evidence', reason: 'evidence-insufficient' })
      const statesB = (rowB!.result as { evidenceStates: { ref: string; state: string; detail?: string }[] }).evidenceStates
      expect(statesB.some(entry => entry.ref === 'C:/evidence/renames.ts' && entry.state === 'needs_evidence' && entry.detail === 'external-version-unprovable'),
        `external evidence must be explicitly unprovable, got: ${JSON.stringify(statesB)}`).toBe(true)

      // REAL manager model requests on the manager route only.
      const managerRequests = managerAdapter.managerRequests()
      expect(managerRequests.length, 'one tool-call turn + one settling turn per request').toBeGreaterThanOrEqual(4)
      for (const options of managerRequests) {
        expect(options.provider, 'the manager request must ride its OWN provider route').toBe(SKILLS_MANAGER_ROUTE.provider)
        expect(options.model, 'the manager request must ride its OWN model').toBe(SKILLS_MANAGER_ROUTE.model)
        expect(options.sessionId).toBe(handle!.agent.id)
        const names = toolNames(options.tools)
        expect(names, 'the scoped investigate Consumer stays visible to the manager').toContain(SKILLS_INVESTIGATE_TOOL)
        expect(names, 'a late-registered GLOBAL tool must never surface to the manager').not.toContain(SKILLS_LATE_GLOBAL_TOOL)
        expect(names.filter(name => name.startsWith('agent_swarm')), 'Team-facing tools must stay filtered for the manager').toHaveLength(0)
      }
      expect(skillsAdapter(mounted).requests.length, 'manager processing must not touch the Captain route').toBe(captainRouteBefore)

      // Scope surface: the manager Session itself sees only the investigate tool.
      const visible = Array.from(mounted.ctx.tools.schemas(handle!.agent)).map(schema => schema.name)
      expect(visible).toContain(SKILLS_INVESTIGATE_TOOL)
      expect(visible).not.toContain(SKILLS_LATE_GLOBAL_TOOL)
      expect(visible.filter(name => name.startsWith('agent_swarm'))).toHaveLength(0)

      // Late-registered global tool: unexecutable BY THE MANAGER...
      const lateAsManager = await captainSkillsTool(mounted.ctx, handle!.agent, 'late-mgr', SKILLS_LATE_GLOBAL_TOOL, {})
      expect(lateAsManager.ok, 'the manager must not execute a late-registered global tool').toBe(false)
      expect(/UNKNOWN_TOOL|unknown tool/.test(failureFields(lateAsManager)),
        `late global tool must surface as unknown for the manager, got: ${failureFields(lateAsManager)}`).toBe(true)
      // ...while business Agents keep their global permissions untouched.
      const lateAsCaptain = await captainSkillsTool(mounted.ctx, root, 'late-captain', SKILLS_LATE_GLOBAL_TOOL, {})
      expect(lateAsCaptain.ok, 'global permissions must remain untouched for business Agents').toBe(true)
      expect(lateAsCaptain.value).toBe('late-global-ok')

      // The durable outcome is readable through the Captain storage face.
      const status = await captainSkillsTool(mounted.ctx, root, 'mgr-status-a', STATUS_TOOL, { request_id: 'mgr-task-request' })
      expect(status.ok).toBe(true)
      expect(status.value).toMatchObject({ request_id: 'mgr-task-request', state: 'unavailable', reason: 'no_approved_version' })
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 60_000)

  it('supplements needs_evidence at revision+1 while the old round still has an observable late completion window', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    const releaseGates: (() => void)[] = []
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      const taskId = await createSkillsTask(mounted.ctx, root, 'supp-task', 'Real work fact for the supplement')

      // (1) The REAL manager processes rev1 into a durable needs_evidence.
      // Official AgentLoop dispatches tools only AFTER exhausting the stream,
      // so the old round's late completion window is a SEPARATE follow-up
      // turn stalled at its head — durable needs_evidence first, stall after,
      // with no cursor/queue fakery anywhere.
      const gate1 = new Promise<void>(resolve => releaseGates.push(resolve))
      const gate2 = new Promise<void>(resolve => releaseGates.push(resolve))
      // OBSERVATION: FUNCTION turns are evaluated the instant the NEXT real
      // stream is requested — the entered flags are never pre-set, and the
      // captured GenerateOptions carries the real history, including the
      // official inv-s1 tool-result the loop delivered (requirement: gate
      // entry is proven by the adapter actually being asked, and a tool
      // error becomes distinguishable from an unsettled investigation).
      const signals = { gate1Entered: false, gate2Entered: false }
      let invS1ToolResult: { present: boolean; isError: unknown; summary: string } | undefined
      managerAdapter.append(
        skillsToolTurn('inv-s1', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-supp-request' }),
        (options: GenerateOptions) => {
          signals.gate1Entered = true
          invS1ToolResult = captureInvS1ToolResult(options)
          return [{ gate: gate1 }, ...skillsTextChunks('Old round completes late.')]
        },
        () => {
          signals.gate2Entered = true
          return [{ gate: gate2 }, ...skillsToolTurn('inv-s2', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-supp-request' })]
        },
        skillsTextChunks('New revision settled.'),
      )
      const first = await captainSkillsTool(mounted.ctx, root, 'supp-intake-1', REQUEST_TOOL, {
        request_id: 'mgr-supp-request', revision: 1,
        question: 'Prove the old behavior from this external artifact.', task_id: taskId,
        evidence_refs: [`file:C:/evidence/old.ts#sha256:${'0'.repeat(64)}`],
      })
      expect(first.ok).toBe(true)
      // ONE original 8s window — no second waiting stage. The durable
      // needs_evidence, the real gate1 entry, and the delivered inv-s1
      // tool-result (exact toolCallId, no error) must all settle inside the
      // SAME budget that existed before.
      try {
        await vi.waitFor(async () => {
          expect(await readRow(sandbox, scope, teamId, 'mgr-supp-request')).toMatchObject({ revision: 1, state: 'needs_evidence' })
          expect(signals.gate1Entered, 'the old round really reached its late completion stream').toBe(true)
          expect(invS1ToolResult?.present, 'the delivered history carries the inv-s1 official tool-result').toBe(true)
          expect(invS1ToolResult?.isError ?? false, `rev1 investigate must not tool-error, got: ${invS1ToolResult?.summary}`).toBe(false)
        }, { timeout: 8_000 })
      } catch (error) {
        // Same-run evidence, then the ORIGINAL assertion failure stands:
        // swallowed nothing, no retry, no budget change.
        let consumerSummary: string
        try {
          const consumer = await readConsumerRow(sandbox, scope, teamId)
          consumerSummary = consumer === undefined ? 'missing' : JSON.stringify(consumer).slice(0, 1_500)
        } catch (readError) {
          consumerSummary = `read-error: ${String(readError)}`
        }
        console.error('[supplement-diagnostic] ' + JSON.stringify({
          managerStreamsRequested: managerAdapter.requests.length,
          gate1Entered: signals.gate1Entered,
          gate2Entered: signals.gate2Entered,
          invS1ToolResult: invS1ToolResult ?? 'not-observed: the gate1 stream was never requested, so no tool-result was captured yet (absence of capture is NOT absence of an official result)',
          consumerRow: consumerSummary,
        }) + '\nNOTE: a consumer pendingBatch/baseline only locates the consumer commit OR LATER; the final fence can still fail after it.')
        throw error
      }
      const rowRev1 = await readRow(sandbox, scope, teamId, 'mgr-supp-request')
      expect(rowRev1!.managerSessionId, 'rev1 processing ownership is recorded').toBe(module.managerAgentId)

      // (2) LEGAL supplement entry (docs04 §7.2 @ cced2c18): same requestId,
      // strictly revision+1, submitted while the old round has not completed
      // (wake1 is stalled mid-turn). The new revision must NOT inherit the
      // previous round's processing attribution (docs04 §L202).
      const second = await captainSkillsTool(mounted.ctx, root, 'supp-intake-2', REQUEST_TOOL, {
        request_id: 'mgr-supp-request', revision: 2,
        question: 'Re-check using the authorized Team work facts only.', task_id: taskId,
      })
      expect(second.ok, `the revision+1 supplement must be accepted, got: ${failureFields(second)}`).toBe(true)
      expect(second.value).toMatchObject({ revision: 2, replayed: false, state: 'received' })
      const freshRev = await readRow(sandbox, scope, teamId, 'mgr-supp-request')
      expect(freshRev, 'the supplement is durable').toBeTruthy()
      expect(freshRev!.managerSessionId ?? undefined, 'a new revision never keeps the old round attribution').toBeUndefined()

      // (3) Release both stalls. The late old round finishes AFTER revision 2
      // is durable and can never resurrect revision 1 or its payload evidence;
      // the rev2 investigation then runs through the same real manager turn.
      releaseGates[0]!()
      // gate2's flag is set ONLY when the adapter is asked for the next real
      // manager stream — the honest instant where the revision-2 round has
      // reached its tool turn but NOT dispatched it. Only now is the
      // received/unattributed window proven, not merely possibly true.
      await vi.waitFor(() => {
        expect(signals.gate2Entered, 'the revision-2 round reached its undispatched tool turn').toBe(true)
      }, { timeout: 8_000 })
      const mid = await readRow(sandbox, scope, teamId, 'mgr-supp-request')
      expect(mid, 'rev2 stays received while its tool turn is undispatched').toMatchObject({ revision: 2, state: 'received' })
      expect(mid!.managerSessionId ?? undefined, 'still unattributed while the new round has not dispatched').toBeUndefined()
      releaseGates[1]!()
      await module.flushWakes()
      const row = await readRow(sandbox, scope, teamId, 'mgr-supp-request')
      expect(row, `the supplement must have been investigated, got: ${JSON.stringify(row)}`).toMatchObject({ revision: 2, state: 'unavailable', reason: 'no_approved_version' })
      const states = (row!.result as { evidenceStates: { ref: string }[] }).evidenceStates
      expect(states.some(entry => entry.ref.includes('old.ts')),
        `rev1's external ref must never resurface under rev2, got: ${JSON.stringify(states)}`).toBe(false)

      // A superseded round invoked again through the public service face is
      // refused outright — terminal rev1 state cannot be rewritten late.
      const managerAgent = mounted.ctx.agents.get(SessionId(module.managerAgentId))
      expect(managerAgent, 'the manager Session stays live through the supplement').toBeDefined()
      const staleWriter = await module.investigate('mgr-supp-request', { agent: managerAgent!, signal: RESTART_SIGNAL })
        .then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(staleWriter, 'a superseded terminal request must refuse re-investigation').toBeDefined()
      expect([staleWriter!.code ?? '', staleWriter!.message].join(' ')).toContain('SKILLS_REQUEST_STALE')

      // Same-revision replay/conflict rules still hold on the new revision.
      const replay = await captainSkillsTool(mounted.ctx, root, 'supp-replay', REQUEST_TOOL, {
        request_id: 'mgr-supp-request', revision: 2,
        question: 'Re-check using the authorized Team work facts only.', task_id: taskId,
      })
      expect(replay.ok).toBe(true)
      expect(replay.value).toMatchObject({ revision: 2, replayed: true })
      const clash = await captainSkillsTool(mounted.ctx, root, 'supp-clash', REQUEST_TOOL, {
        request_id: 'mgr-supp-request', revision: 2,
        question: 'A different payload must conflict at the same revision.', task_id: taskId,
      })
      expect(clash.ok).toBe(false)
      expect(failureFields(clash)).toContain('SKILLS_REQUEST_CONFLICT')
      // An OLD revision intake is refused outright (read back the CURRENT durable revision only).
      const staleRev = await captainSkillsTool(mounted.ctx, root, 'supp-stale', REQUEST_TOOL, {
        request_id: 'mgr-supp-request', revision: 1,
        question: 'Prove the old behavior from this external artifact.', task_id: taskId,
        evidence_refs: [`file:C:/evidence/old.ts#sha256:${'0'.repeat(64)}`],
      })
      expect(staleRev.ok).toBe(false)
      expect(failureFields(staleRev)).toContain('SKILLS_REQUEST_STALE')
    } finally {
      // RELEASE the gates FIRST: cleanup must never wait on a stalled
      // generator, even on a failure path.
      for (const release of releaseGates) release()
      await disposeRestartComposition(mounted)
    }
  }, 60_000)

  it('reads evidence from the EXACT retained attempt projection: real submitted evidence proves, a fabricated ref does not', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    // The member is a real child Agent: the official settlement lifecycle
    // disposes a child whose turn finishes with nothing pending. Its boot
    // turn is HELD at a cancellable gate so the claim+submit run inside the
    // member's genuinely live official window (no clone, no substitute).
    const childAdapter = new SkillsHeldChildAdapter(String(SKILLS_ROOT))
    const mounted = await mountSkillsComposition(sandbox, {
      [SKILLS_CAPTAIN_ROUTE.provider]: childAdapter,
      [SKILLS_MANAGER_ROUTE.provider]: managerAdapter,
    })
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      const taskId = await createSkillsTask(mounted.ctx, root, 'evid-task', 'Task whose real attempt becomes the evidence ground truth')
      const added = await captainSkillsTool(mounted.ctx, root, 'evid-add-member', 'agent_swarm_add_member', {
        name: 'skills-evidence-worker', role: 'worker',
      })
      expect(added.ok, `add_member must succeed, got: ${failureFields(added)}`).toBe(true)
      await vi.waitFor(() => expect(childAdapter.gateEntered, 'the member boot turn is inside the held live window').toBeGreaterThan(0), { timeout: 5_000 })
      const member = await liveSkillsAgent(mounted.ctx, (added.value as { session_id: string }).session_id)
      expect({
        live: mounted.ctx.agents.get(member.id) !== undefined,
        sameInstance: mounted.ctx.agents.get(member.id) === member,
        sameSession: mounted.ctx.sessions.get(member.id) === member.session,
      }, `the member Session ${member.id} must be the exact live instance for the claim window`)
        .toMatchObject({ live: true, sameInstance: true, sameSession: true })

      // A REAL attempt with REAL submitted evidence through the official
      // faces — claim carries the task's CURRENT expected revision exactly.
      const preTeams = await mounted.ctx.agentSwarm.listTeamAggregates(scope)
      const preTask = preTeams.find(team => team.id === teamId)?.tasks.find(candidate => candidate.id === taskId)
      expect(preTask, 'the official task row is readable').toBeTruthy()
      const claimed = await captainSkillsTool(mounted.ctx, mounted.ctx.agents.get(member.id)!, 'evid-claim', 'agent_swarm_claim_task', {
        task_id: taskId, expected_revision: preTask!.revision,
      })
      expect(claimed.ok, `member claim must succeed, got: ${failureFields(claimed)}`).toBe(true)
      const teams = await mounted.ctx.agentSwarm.listTeamAggregates(scope)
      const attempt = teams.find(team => team.id === teamId)?.attempts.find(candidate => candidate.taskId === taskId)
      expect(attempt, 'the claim produced a retained attempt').toBeTruthy()
      // submit_task also requires the task's CURRENT revision — read it from
      // the aggregate AFTER the claim mutation (claim advanced it), never the
      // pre-claim value.
      const postClaimTask = teams.find(team => team.id === teamId)?.tasks.find(candidate => candidate.id === taskId)
      expect(postClaimTask, 'the claimed task row is readable').toBeTruthy()
      expect(postClaimTask!.revision, 'the claim advanced the task revision').toBeGreaterThanOrEqual(preTask!.revision)
      const realRef = 'evidence:skills-management/windows-rename-fix#run-1'
      const submitted = await captainSkillsTool(mounted.ctx, mounted.ctx.agents.get(member.id)!, 'evid-submit', 'agent_swarm_submit_task', {
        task_id: taskId, attempt_id: attempt!.id, expected_revision: postClaimTask!.revision,
        output: 'Delivered under the frozen acceptance criteria.',
        evidence: [realRef],
      })
      expect(submitted.ok, `member submit must succeed, got: ${failureFields(submitted)}`).toBe(true)

      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      managerAdapter.append(
        skillsToolTurn('inv-evid-1', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-evid-mixed' }),
        skillsTextChunks('Mixed refs seen.'),
        skillsToolTurn('inv-evid-2', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-evid-real' }),
        skillsTextChunks('Real ref proven.'),
      )

      // A fabricated ref alongside the real one: precise projection read,
      // never ID-existence rubber-stamping.
      const mixed = await captainSkillsTool(mounted.ctx, root, 'evid-intake-mixed', REQUEST_TOOL, {
        request_id: 'mgr-evid-mixed', revision: 1,
        question: 'Do these refs hold against the retained attempt?',
        task_id: taskId, attempt_id: attempt!.id,
        evidence_refs: [realRef, 'evidence:fabricated-ref#run-999'],
      })
      expect(mixed.ok).toBe(true)
      await module.flushWakes()
      const mixedRow = await readRow(sandbox, scope, teamId, 'mgr-evid-mixed')
      expect(mixedRow, `the mixed request must have been investigated, got: ${JSON.stringify(mixedRow)}`).toMatchObject({ state: 'needs_evidence' })
      const mixedStates = (mixedRow!.result as { evidenceStates: { ref: string; state: string; detail?: string }[] }).evidenceStates
      expect(mixedStates.some(entry => entry.ref === realRef && entry.state === 'proven'),
        `the submitted ref must PROVEN from the retained attempt evidence, got: ${JSON.stringify(mixedStates)}`).toBe(true)
      expect(mixedStates.some(entry => entry.ref === 'evidence:fabricated-ref#run-999' && entry.state === 'needs_evidence'),
        `a ref absent from the retained evidence must NEVER pass, got: ${JSON.stringify(mixedStates)}`).toBe(true)

      // Only proven refs: the request may advance to the S1 terminal answer.
      const clean = await captainSkillsTool(mounted.ctx, root, 'evid-intake-clean', REQUEST_TOOL, {
        request_id: 'mgr-evid-real', revision: 1,
        question: 'The retained attempt evidence alone — what can S1 answer?',
        task_id: taskId, attempt_id: attempt!.id,
        evidence_refs: [realRef],
      })
      expect(clean.ok).toBe(true)
      await module.flushWakes()
      const cleanRow = await readRow(sandbox, scope, teamId, 'mgr-evid-real')
      expect(cleanRow, `the clean request must have been investigated, got: ${JSON.stringify(cleanRow)}`).toMatchObject({ state: 'unavailable', reason: 'no_approved_version' })
      const cleanStates = (cleanRow!.result as { evidenceStates: { ref: string; state: string }[] }).evidenceStates
      expect(cleanStates.every(entry => entry.state === 'proven'),
        `all refs must be proven, got: ${JSON.stringify(cleanStates)}`).toBe(true)
      expect(cleanRow!.result as { sourceRevision?: number }).toHaveProperty('sourceRevision')
    } finally {
      childAdapter.releaseAll()
      await disposeRestartComposition(mounted)
    }
  }, 60_000)
})
