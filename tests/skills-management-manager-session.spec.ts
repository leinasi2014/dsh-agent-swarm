/**
 * S1 skills-management SESSION-DURABILITY batch (task-1, attempt-1830b1d8).
 *
 * The manager identity is a DURABLE binding: across a real module-fiber
 * uninstall and full remount the SAME Session is resumed (with its current
 * authorized route — the official resume does NOT restore routing from the
 * old header), an interrupted `received` request is recovered by the
 * module's own bounded startup pass, and close-through-a-stalled-turn
 * releases exactly the module-owned handle. Identity facts are captured
 * BEFORE teardown and read back from the official registry / durable
 * medium after remount — never by forcing a closed store to answer.
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  captainSkillsTool,
  createSkillsTask,
  createSkillsTeam,
  disposeRestartComposition,
  mountSkillsComposition,
  mountSkillsModule,
  SKILLS_INVESTIGATE_TOOL,
  SKILLS_MANAGER_ROUTE,
  SkillsManagerScriptAdapter,
  skillsManagerModuleConfig,
  skillsModule,
  skillsStalledToolTurn,
  skillsTextChunks,
  skillsToolTurn,
} from './helpers/skills-management-composition.js'
import {
  failureFields,
  readRow,
  REQUEST_TOOL,
  skillsSandboxTracker,
  STATUS_TOOL,
} from './helpers/skills-management-support.js'

const tracker = skillsSandboxTracker('dsh-skills-session-')
const freshSandbox = tracker.freshSandbox

describe('S1 manager session: durable identity across uninstall, recovery, and stalled close', () => {
  it('survives a real plugin-fiber uninstall: drains, releases ONLY the module handle, and the durable receipt reads back after a full remount on the SAME identity', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    let unloadManagerId = ''
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const moduleFiber = mounted.fibers.at(-1)
      expect(moduleFiber, 'the skills plugin must own a real disposable fiber').toBeDefined()
      const module = skillsModule(mounted.ctx)
      const taskId = await createSkillsTask(mounted.ctx, root, 'unload-task-create', 'Work fact for the uninstall drain case')
      managerAdapter.append(
        skillsToolTurn('inv-u', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-unload-request' }),
        skillsTextChunks('U settled.'),
      )
      const intake = await captainSkillsTool(mounted.ctx, root, 'unload-intake', REQUEST_TOOL, {
        request_id: 'mgr-unload-request', revision: 1,
        question: 'Drain me fully before unload.', task_id: taskId,
      })
      expect(intake.ok).toBe(true)
      await module.flushWakes()
      unloadManagerId = module.managerAgentId
      expect(mounted.ctx.agents.get(SessionId(unloadManagerId)), 'the dedicated manager must be live after real processing').toBeDefined()

      // The OFFICIAL fiber disposer runs the whole teardown (module.close +
      // domain.close inside), not just an internal close call.
      await moduleFiber!.dispose()

      // Admission closed → official dispose → drains done → ONLY the module's
      // own handle released. Business Agents are never touched.
      expect(mounted.ctx.agents.get(SessionId(unloadManagerId)), 'module unload must release the module-owned manager handle').toBeUndefined()
      expect(mounted.ctx.agents.get(root.id), 'business Agents survive the module unload').toBeDefined()

      const refused = await captainSkillsTool(mounted.ctx, root, 'unload-refused', REQUEST_TOOL, {
        request_id: 'mgr-after-unload', revision: 1, question: 'Must be refused after admission closed.',
      })
      expect(refused.ok, 'intake after uninstall must fail closed').toBe(false)
      expect(/SKILLS_ADMISSION_CLOSED|SKILLS_MODULE_CLOSED|UNKNOWN_TOOL/.test(failureFields(refused)),
        `post-unload intake must name its fence, got: ${failureFields(refused)}`).toBe(true)
    } finally {
      await disposeRestartComposition(mounted)
    }

    // A FULL remount (new Context over the same durable roots) reads the
    // receipt back with zero model calls, on the SAME durable manager id.
    const restartAdapter = new SkillsManagerScriptAdapter()
    const second = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: restartAdapter })
    try {
      const { root, teamId } = await createSkillsTeam(second, sandbox, true)
      const scope = second.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(second.ctx, skillsManagerModuleConfig(scope, teamId), second.fibers)
      const module = skillsModule(second.ctx)
      expect(module.managerAgentId, 'the durable binding keeps the manager Session identity across uninstall/remount').toBe(unloadManagerId)
      const status = await captainSkillsTool(second.ctx, root, 'reload-status', STATUS_TOOL, { request_id: 'mgr-unload-request' })
      expect(status.ok, `the durable receipt must read back after remount, got: ${failureFields(status)}`).toBe(true)
      expect(status.value).toMatchObject({ request_id: 'mgr-unload-request', revision: 1, state: 'unavailable', reason: 'no_approved_version' })
      expect(restartAdapter.requests, 'a zero-model status query must not touch the manager route').toHaveLength(0)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 90_000)

  it('the module owner itself recovers an interrupted request on restart, resuming the SAME manager identity WITH ITS AUTHORIZED ROUTE', async () => {
    const sandbox = await freshSandbox()
    const firstAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: firstAdapter })
    let managerId = ''
    let teamId = ''
    let scope = ''
    try {
      const team = await createSkillsTeam(mounted, sandbox)
      teamId = team.teamId
      scope = mounted.ctx.agentSwarm.scopeOf(team.root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      const taskId = await createSkillsTask(mounted.ctx, team.root, 'rec-task', 'Work fact for the restart recovery case')

      // One fully processed request persists the manager Session log...
      firstAdapter.append(
        skillsToolTurn('inv-c1', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-recovered-1' }),
        skillsTextChunks('First one done.'),
      )
      const done = await captainSkillsTool(mounted.ctx, team.root, 'rec-intake-1', REQUEST_TOOL, {
        request_id: 'mgr-recovered-1', revision: 1, question: 'Already settled before the crash.', task_id: taskId,
      })
      expect(done.ok).toBe(true)
      await module.flushWakes()
      expect(await readRow(sandbox, scope, teamId, 'mgr-recovered-1')).toMatchObject({ state: 'unavailable' })
      managerId = module.managerAgentId

      // ...while a second one is left durably `received` (interrupted lifetime).
      const pending = await captainSkillsTool(mounted.ctx, team.root, 'rec-intake-2', REQUEST_TOOL, {
        request_id: 'mgr-recovered-2', revision: 1, question: 'This one was interrupted mid-flight.', task_id: taskId,
      })
      expect(pending.ok).toBe(true)
      await module.flushWakes()
      expect(await readRow(sandbox, scope, teamId, 'mgr-recovered-2')).toMatchObject({ state: 'received' })
    } finally {
      await disposeRestartComposition(mounted)
    }

    // Fresh lifetime over the same roots: the scripted recovery turn is
    // queued BEFORE the mount, because the module's own startup pass may
    // re-wake the request as part of mounting.
    const secondAdapter = new SkillsManagerScriptAdapter()
    secondAdapter.append(
      skillsToolTurn('inv-c2', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-recovered-2' }),
      skillsTextChunks('Recovered and settled.'),
    )
    const second = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: secondAdapter })
    try {
      const { teamId: sameTeam } = await createSkillsTeam(second, sandbox, true)
      expect(sameTeam, 'the same durable Team comes back').toBe(teamId)
      await mountSkillsModule(second.ctx, skillsManagerModuleConfig(scope, sameTeam), second.fibers)
      const module = skillsModule(second.ctx)
      await module.flushWakes()
      // The resumed handle exists BEFORE any outcome assertion: recovery
      // resumed the SAME Session with the current authorized route.
      const resumed = second.ctx.agents.get(SessionId(managerId))
      expect(resumed, 'the resumed manager is live under the SAME Session id').toBeDefined()
      await vi.waitFor(async () => {
        expect(await readRow(sandbox, scope, sameTeam, 'mgr-recovered-2'))
          .toMatchObject({ state: 'unavailable', reason: 'no_approved_version' })
      }, { timeout: 10_000 })
      expect(module.managerAgentId, 'recovery resumes the DURABLE manager identity, never a random new Session').toBe(managerId)
      const recoveryTurns = secondAdapter.managerRequests()
      expect(recoveryTurns.length, 'the recovered request really reached the manager model').toBeGreaterThanOrEqual(2)
      for (const options of recoveryTurns) {
        expect(options.sessionId, 'every recovered turn runs on the resumed Session identity').toBe(managerId)
        expect(options.provider, 'the resumed route comes from the CURRENT authorized config, not from nothing').toBe(SKILLS_MANAGER_ROUTE.provider)
        expect(options.model, 'the recovered turns ride the authorized model').toBe(SKILLS_MANAGER_ROUTE.model)
      }
    } finally {
      await disposeRestartComposition(second)
    }
  }, 90_000)

  it('closing mid model-turn: stalled turn dies through the official dispose, the late handle never publishes, and close is one memoized promise', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    let openGate!: () => void
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
      const moduleFiber = mounted.fibers.at(-1)!
      const module = skillsModule(mounted.ctx)
      const gate = new Promise<void>(resolve => { openGate = resolve })
      managerAdapter.append(skillsStalledToolTurn('inv-close', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-close-request' }, gate))
      const taskId = await createSkillsTask(mounted.ctx, root, 'close-task', 'Work fact for the stalled-close case')
      const intake = await captainSkillsTool(mounted.ctx, root, 'close-intake', REQUEST_TOOL, {
        request_id: 'mgr-close-request', revision: 1, question: 'Close happens while my model turn is mid-flight.', task_id: taskId,
      })
      expect(intake.ok).toBe(true)
      await vi.waitFor(() => expect(managerAdapter.requests.length, 'the manager model turn is genuinely in flight').toBe(1), { timeout: 5_000 })
      // IDENTITY FIRST: the store is closed after close() and no longer
      // answers — capture the id while live, verify release through the
      // official registry, and the durable binding only after remounting.
      const managerId = module.managerAgentId
      expect(mounted.ctx.agents.get(SessionId(managerId))).toBeDefined()

      // ONE memoized close promise, started WHILE the turn is stalled.
      const closeA = module.close()
      expect(module.close(), 'close must be memoized to one promise').toBe(closeA)

      // The stalled generator only ends when the gate opens; the official
      // dispose path still must settle (cancel first, then drains).
      setTimeout(openGate, 100)
      await closeA

      expect(mounted.ctx.agents.get(SessionId(managerId)), 'the module-owned handle is released even when the turn was mid-flight').toBeUndefined()
      expect(mounted.ctx.agents.get(root.id), 'business Agents are never stopped by module close').toBeDefined()
      const row = await readRow(sandbox, scope, teamId, 'mgr-close-request')
      expect(row, 'the request stays durable through a mid-turn close').toMatchObject({ requestId: 'mgr-close-request', revision: 1 })

      // The official fiber disposer settles on the SAME closed state.
      await moduleFiber.dispose()
    } finally {
      openGate?.()
      await disposeRestartComposition(mounted)
    }
  }, 60_000)
})
