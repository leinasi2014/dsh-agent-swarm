/**
 * S1 skills-management AUTHORIZATION-FENCE batch (task-1, attempt-1830b1d8).
 *
 * Both in-flight counterexamples run inside an explicit ENTERED/RELEASED
 * barrier on the REAL official source read
 * (`AgentSwarmRuntime.prototype.listTeamAggregates`, dynamically called by
 * the Skills plugin; the repository's own startup-recovery-exclusion.spec
 * wraps it the same way). The genuine read completes, the CALLER is then
 * paused before the module resumes — so the revocation / dispose provably
 * lands POST-IO, strictly before the official queued consumer/result
 * commits. Entry is proven by reading the DURABLE medium (row already
 * `investigating`); release lets the call run into the closed fence.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  captainSkillsTool,
  createSkillsTask,
  createSkillsTeam,
  disposeRestartComposition,
  mountSkillsComposition,
  mountSkillsModule,
  RESTART_SIGNAL,
  SKILLS_INVESTIGATE_TOOL,
  SKILLS_MANAGER_ROUTE,
  SkillsManagerScriptAdapter,
  skillsManagerModuleConfig,
  skillsModule,
  skillsTextChunks,
  skillsToolTurn,
} from './helpers/skills-management-composition.js'
import {
  installSkillsSourceReadBarrier,
  readConsumerRow,
  readRow,
  REQUEST_TOOL,
  skillsSandboxTracker,
  type SkillsReadBarrier,
} from './helpers/skills-management-support.js'

const tracker = skillsSandboxTracker('dsh-skills-fence-')
const freshSandbox = tracker.freshSandbox

/** Shared fixture: live module with one intake and a settled manager Session. */
async function setupInvestigatingFence(sandbox: string, requestId: string) {
  const managerAdapter = new SkillsManagerScriptAdapter()
  const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
  const { root, teamId } = await createSkillsTeam(mounted, sandbox)
  const scope = mounted.ctx.agentSwarm.scopeOf(root)
  await createSkillsTask(mounted.ctx, root, `${requestId}-task`, 'Work fact for the in-flight fence')
  await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
  const module = skillsModule(mounted.ctx)
  const handle = await module.ensureManager()
  const intake = await captainSkillsTool(mounted.ctx, root, `${requestId}-intake`, REQUEST_TOOL, {
    request_id: requestId, revision: 1, question: 'Fence me inside the real read window.',
  })
  expect(intake.ok).toBe(true)
  await module.flushWakes() // the default text wake settles the manager Session log
  expect(await readRow(sandbox, scope, teamId, requestId)).toMatchObject({ state: 'received' })
  return { mounted, module, handle, scope, teamId }
}

describe('S1 manager fences: in-flight authorization changes persist nothing', () => {
  it('a revocation landing AFTER the ACTIVITY snapshot read fences the consumer commit itself and moves no consumer bytes', async () => {
    const sandbox = await freshSandbox()
    const { mounted, module, handle, scope, teamId } = await setupInvestigatingFence(sandbox, 'mgr-activity-fence')
    let barrier: SkillsReadBarrier | undefined
    try {
      // Pause AFTER the 1st real aggregate read (the activity snapshot) returns.
      barrier = installSkillsSourceReadBarrier(scope, 1)
      barrier.arm()
      const inFlight = module.investigate('mgr-activity-fence', { agent: handle!.agent, signal: RESTART_SIGNAL })
      await barrier.entered
      // Entry proof from the DURABLE medium + baseline taken HERE: the flip
      // is committed, and whatever the call legally created BEFORE the
      // revocation (the ensureConsumer base row) is part of the baseline.
      expect(await readRow(sandbox, scope, teamId, 'mgr-activity-fence'),
        'the barrier is entered mid-investigation').toMatchObject({ state: 'investigating', managerSessionId: handle!.agent.id })
      const baseline = JSON.stringify(await readConsumerRow(sandbox, scope, teamId))

      module.revokeManagement('C:/revoked/other-scope', 'team-other')
      barrier.release()
      const failure = await inFlight.then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(failure, 'a post-IO revocation must reject the in-flight investigation').toBeDefined()
      expect([failure!.code ?? '', failure!.message].join(' ')).toContain('SKILLS_REVOKED')
      expect(await readRow(sandbox, scope, teamId, 'mgr-activity-fence'),
        'the fenced investigation persisted NO outcome').toMatchObject({ state: 'investigating', managerSessionId: handle!.agent.id })
      expect(JSON.stringify(await readConsumerRow(sandbox, scope, teamId)),
        'the fence at the consumer commit moved no byte past the legitimate baseline').toBe(baseline)
    } finally {
      barrier?.restore()
      await disposeRestartComposition(mounted)
    }
  }, 90_000)

  it('a revocation landing AFTER the EVIDENCE read rejects in the FINAL result update callback, after the legitimate batch landed', async () => {
    const sandbox = await freshSandbox()
    const { mounted, module, handle, scope, teamId } = await setupInvestigatingFence(sandbox, 'mgr-final-fence')
    let barrier: SkillsReadBarrier | undefined
    try {
      // Pause AFTER the 2nd real aggregate read (the evidence resolution),
      // so the consumer page commit ALREADY landed legitimately — this is
      // the only window that can prove the FINAL callback fence rather than
      // an earlier consumer-stage throw.
      barrier = installSkillsSourceReadBarrier(scope, 2)
      barrier.arm()
      const inFlight = module.investigate('mgr-final-fence', { agent: handle!.agent, signal: RESTART_SIGNAL })
      await barrier.entered
      const rowInside = await readRow(sandbox, scope, teamId, 'mgr-final-fence')
      expect(rowInside, 'still mid-investigation at the evidence barrier').toMatchObject({ state: 'investigating', managerSessionId: handle!.agent.id })
      const baseline = JSON.stringify(await readConsumerRow(sandbox, scope, teamId))
      expect(JSON.parse(baseline).pendingBatch, 'the legitimate batch landed before the revocation').toBeTruthy()

      module.revokeManagement('C:/revoked/other-scope', 'team-other')
      barrier.release()
      const failure = await inFlight.then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(failure, 'the FINAL update callback must reject a revoked investigation').toBeDefined()
      expect([failure!.code ?? '', failure!.message].join(' ')).toContain('SKILLS_REVOKED')
      const after = await readRow(sandbox, scope, teamId, 'mgr-final-fence')
      expect(after, 'the final callback persisted NO outcome past the flip').toMatchObject({ state: 'investigating', managerSessionId: handle!.agent.id })
      expect(after!.reason, 'no outcome reason may exist').toBeUndefined()
      expect(after!.result, 'no outcome result may exist').toBeUndefined()
      expect(JSON.stringify(await readConsumerRow(sandbox, scope, teamId)),
        'no consumer byte moved after the entered-barrier baseline').toBe(baseline)

      // Manifest shrink for the pair itself: entry and Consumer face denied.
      module.revokeManagement(scope, teamId)
      const deniedEntry = await module.investigate('mgr-final-fence', { agent: handle!.agent, signal: RESTART_SIGNAL })
        .then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect([deniedEntry?.code ?? '', deniedEntry?.message ?? ''].join(' ')).toContain('SKILLS_UNAUTHORIZED')
      const deniedSync = await module.syncWorkActivity(scope, teamId).then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect([deniedSync?.code ?? '', deniedSync?.message ?? ''].join(' ')).toContain('SKILLS_UNAUTHORIZED')
    } finally {
      barrier?.restore()
      await disposeRestartComposition(mounted)
    }
  }, 90_000)

  it('revocation durably retires still-live requests to an explicit unavailable, never a hang', async () => {
    const sandbox = await freshSandbox()
    // Text-only script: the wake settles WITHOUT investigating, leaving the
    // request durably `received` — the exact state revocation must retire.
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      const taskId = await createSkillsTask(mounted.ctx, root, 'retire-task', 'Work fact for the retirement case')
      const intake = await captainSkillsTool(mounted.ctx, root, 'retire-intake', REQUEST_TOOL, {
        request_id: 'mgr-retire-request', revision: 1,
        question: 'This request will lose its management authorization mid-flight.', task_id: taskId,
      })
      expect(intake.ok).toBe(true)
      await module.flushWakes()
      expect(await readRow(sandbox, scope, teamId, 'mgr-retire-request')).toMatchObject({ state: 'received' })

      module.revokeManagement(scope, teamId)
      await vi.waitFor(async () => {
        expect(await readRow(sandbox, scope, teamId, 'mgr-retire-request'))
          .toMatchObject({ state: 'unavailable', reason: 'authorization-revoked' })
      }, { timeout: 5_000 })
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 60_000)

  it('a crash AFTER the real source read (row durably investigating) is recovered cold on restart via the resumed SAME manager identity', async () => {
    const sandbox = await freshSandbox()
    const firstAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: firstAdapter })
    let barrier: SkillsReadBarrier | undefined
    let managerId = ''
    let teamId = ''
    let scope = ''
    try {
      const team = await createSkillsTeam(mounted, sandbox)
      teamId = team.teamId
      scope = mounted.ctx.agentSwarm.scopeOf(team.root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const moduleFiber = mounted.fibers.at(-1)!
      const module = skillsModule(mounted.ctx)
      const handle = await module.ensureManager()
      managerId = handle!.agent.id
      const taskId = await createSkillsTask(mounted.ctx, team.root, 'crash-task', 'Work fact for the investigating-crash case')
      const intake = await captainSkillsTool(mounted.ctx, team.root, 'crash-intake', REQUEST_TOOL, {
        request_id: 'mgr-crash-request', revision: 1, question: 'Interrupted mid-investigation.', task_id: taskId,
      })
      expect(intake.ok).toBe(true)
      await module.flushWakes() // the wake's text-only turn also persists the manager Session log

      // The barrier proves ENTRY mid-investigation from the durable medium;
      // the dispose then lands strictly after that entry — a genuine crash
      // shape, not a lucky queue order. The drain settles the in-flight
      // lane against the closed admission fence.
      barrier = installSkillsSourceReadBarrier(scope)
      barrier.arm()
      const settled = module.investigate('mgr-crash-request', { agent: handle!.agent, signal: RESTART_SIGNAL })
        .then(() => undefined, (error: unknown) => error as Error & { code?: string })
      await barrier.entered
      expect(await readRow(sandbox, scope, teamId, 'mgr-crash-request'),
        'the barrier is entered mid-investigation').toMatchObject({ state: 'investigating', managerSessionId: managerId })
      const crashing = Promise.all([settled, moduleFiber.dispose().catch(() => undefined)])
        .then(() => undefined, () => undefined)
      barrier.release()
      await crashing
      const failure = await settled
      expect(failure, 'the killed investigation must fail closed, not resolve').toBeDefined()
      expect([failure!.code ?? '', failure!.message].join(' ')).toMatch(/SKILLS_REVOKED|SKILLS_UNAUTHORIZED|SKILLS_MODULE_CLOSED|SKILLS_ADMISSION_CLOSED/)

      const crashed = await readRow(sandbox, scope, teamId, 'mgr-crash-request')
      expect(crashed, `the crash shape must leave an investigating row, got: ${JSON.stringify(crashed)}`)
        .toMatchObject({ state: 'investigating', managerSessionId: managerId })
    } finally {
      barrier?.restore()
      await disposeRestartComposition(mounted)
    }

    // Cold restart: recovery must take the INVESTIGATING record over on the
    // resumed SAME identity (a random new Session would be stuck BUSY forever).
    const secondAdapter = new SkillsManagerScriptAdapter()
    secondAdapter.append(
      skillsToolTurn('inv-crash', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-crash-request' }),
      skillsTextChunks('Took over the interrupted investigation.'),
    )
    const second = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: secondAdapter })
    try {
      const { teamId: sameTeam } = await createSkillsTeam(second, sandbox, true)
      expect(sameTeam).toBe(teamId)
      await mountSkillsModule(second.ctx, skillsManagerModuleConfig(scope, sameTeam), second.fibers)
      const module = skillsModule(second.ctx)
      await module.flushWakes()
      await vi.waitFor(async () => {
        expect(await readRow(sandbox, scope, sameTeam, 'mgr-crash-request'))
          .toMatchObject({ state: 'unavailable', reason: 'no_approved_version' })
      }, { timeout: 10_000 })
      expect(module.managerAgentId, 'the investigating holder identity is resumed, not replaced').toBe(managerId)
      for (const options of secondAdapter.managerRequests()) expect(options.sessionId).toBe(managerId)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 120_000)
})
