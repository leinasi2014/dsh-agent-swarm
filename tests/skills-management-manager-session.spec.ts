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
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
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

/** One settled+persisted manager Session, prepared by a full first life. */
async function persistSettledManagerSession(sandbox: string, tag: string) {
  const adapter = new SkillsManagerScriptAdapter()
  const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: adapter })
  try {
    const { root, teamId } = await createSkillsTeam(mounted, sandbox)
    const scope = mounted.ctx.agentSwarm.scopeOf(root)
    await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)
    const module = skillsModule(mounted.ctx)
    const taskId = await createSkillsTask(mounted.ctx, root, `${tag}-task`, 'Work fact persisted before the reopen')
    adapter.append(
      skillsToolTurn(`inv-${tag}`, SKILLS_INVESTIGATE_TOOL, { request_id: `${tag}-settled` }),
      skillsTextChunks('Settled on the durable manager Session.'),
    )
    const settled = await captainSkillsTool(mounted.ctx, root, `${tag}-intake`, REQUEST_TOOL, {
      request_id: `${tag}-settled`, revision: 1, question: 'Persist a settled manager Session log.', task_id: taskId,
    })
    expect(settled.ok).toBe(true)
    await module.flushWakes()
    const managerId = module.managerAgentId
    expect(managerId, 'the settled manager Session must be durable before the reopen').not.toBe('')
    return { teamId, scope, managerId }
  } finally {
    await disposeRestartComposition(mounted)
  }
}

/** Reopen the composition over existing roots (or create a fresh Team). */
async function openModuleOnTeam(
  sandbox: string,
  team: { scope: string; teamId: string } | undefined,
  afterMount: (mounted: Awaited<ReturnType<typeof mountSkillsComposition>>) => void = () => {},
) {
  const adapter = new SkillsManagerScriptAdapter()
  const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: adapter })
  try {
    let target = team
    let root: Awaited<ReturnType<typeof createSkillsTeam>>['root']
    if (target === undefined) {
      const created = await createSkillsTeam(mounted, sandbox)
      root = created.root
      target = { scope: mounted.ctx.agentSwarm.scopeOf(created.root), teamId: created.teamId }
    } else {
      root = (await createSkillsTeam(mounted, sandbox, true)).root
    }
    afterMount(mounted)
    await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(target.scope, target.teamId), mounted.fibers)
    return { mounted, module: skillsModule(mounted.ctx), adapter, root, ...target }
  } catch (error) {
    await disposeRestartComposition(mounted)
    throw error
  }
}

/** The window primitives: entered/gate plus the two-argument setup wrapper
 *  that pauses INSIDE the real setup — after the production setup body ran
 *  for real, before the official factory executes its commit. */
function makeWindowHarness() {
  let entered!: () => void
  const enteredP = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const state = { identity: '', handleReturned: false }
  const wrapSetup = (setup: AgentSetup | undefined): AgentSetup => async (agentCtx, agent) => {
    if (setup === undefined) throw new Error('the manager open must carry the production setup')
    const prepared = await setup(agentCtx, agent)
    state.handleReturned = false // still pre-commit: nothing can be published yet
    entered()
    await gate
    return prepared
  }
  const releaseAll = () => release()
  return { enteredP, entered, release, releaseAll, state, wrapSetup }
}

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

  it('true missing: a setup-cancelled first create keeps the binding durable with NO persisted Session; the cold reopen ORGANICALLY hits the official not-found and recreates under the same id', async () => {
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
      const originalCreate = mounted.ctx.agents.create.bind(mounted.ctx.agents)
      vi.spyOn(mounted.ctx.agents, 'create').mockImplementation(async options => {
        managerId = String(options.sessionId)
        const productionSetup = options.setup
        if (productionSetup === undefined) throw new Error('the manager create must carry the production setup')
        // The REAL official create runs; its setup cancels only AFTER the
        // production setup body executed — the identity never reaches its
        // commit, so the Session is never persisted while the binding is.
        return await originalCreate({
          ...options,
          setup: async (agentCtx, agent) => {
            await productionSetup(agentCtx, agent)
            throw new Error('injected setup cancellation before the manager commit')
          },
        })
      })
      try {
        await expect(module.ensureManager()).rejects.toThrow()
        expect(module.managerAgentId, 'the binding is durable even though the Session never existed').toBe(managerId)
        expect(mounted.ctx.agents.get(SessionId(managerId)), 'a cancelled create leaves no resident manager').toBeUndefined()
        await expect(mounted.ctx.sessionPersistence.open(SessionId(managerId), 'read'))
          .rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
        expect(firstAdapter.requests, 'a cancelled create never reached the manager model').toHaveLength(0)
      } finally {
        vi.restoreAllMocks()
      }
    } finally {
      await disposeRestartComposition(mounted)
    }

    // COLD REOPEN with ZERO mocks: the official resume meets the genuinely
    // absent Session and raises its OWN not-found class; only that class may
    // drive the same-id REAL create fallback.
    const opened = await openModuleOnTeam(sandbox, { scope, teamId })
    try {
      const taskId = await createSkillsTask(opened.mounted.ctx, opened.root, 'b1-missing-kick-task', 'Request that re-wakes the manager on reopen')
      const intake = await captainSkillsTool(opened.mounted.ctx, opened.root, 'b1-missing-kick', REQUEST_TOOL, {
        request_id: 'b1-missing-kick', revision: 1, question: 'Reopen drives the organic not-found recovery.', task_id: taskId,
      })
      expect(intake.ok).toBe(true)
      await opened.module.flushWakes()
      expect(opened.module.managerAgentId, 'the fallback recreates under the SAME durable identity').toBe(managerId)
      expect(opened.mounted.ctx.agents.get(SessionId(managerId)), 'the recreated manager is officially live').toBeDefined()
      expect(opened.adapter.requests.length, 'the recreated manager really ran its model turn').toBeGreaterThanOrEqual(1)
      const row = await readRow(sandbox, scope, teamId, 'b1-missing-kick')
      expect(row!.state, 'an organic not-found recovery must not mark the request failed').not.toBe('failed')
    } finally {
      await disposeRestartComposition(opened.mounted)
    }
  }, 90_000)

  it.each([
    { kind: 'corruption' },
    { kind: 'read-failure' },
  ] as const)('resume failure $kind propagates explicitly: no same-id create fallback, no resurrection, named in the durable failure', async ({ kind }) => {
    const sandbox = await freshSandbox()
    const { teamId, scope, managerId } = await persistSettledManagerSession(sandbox, `b1-${kind}`)
    const injected = kind === 'corruption'
      ? new SessionPersistenceCorruptionError('injected validation failure for the QA contrast', { cause: new Error('bit flip') })
      : new Error('injected disk read failure for the QA contrast')
    const resumeSessionIds: string[] = []
    let createCalls = 0
    // REOPEN over the same roots. The official resume is the exact public
    // seam where each durable condition surfaces with its own class; the
    // module may only treat SessionPersistenceNotFoundError as "never
    // persisted" (agent-loop index.ts:496 precedent) — corruption or a plain
    // read failure must propagate explicitly, never trigger the fallback.
    const opened = await openModuleOnTeam(sandbox, { scope, teamId }, mounted => {
      const originalCreate = mounted.ctx.agents.create.bind(mounted.ctx.agents)
      vi.spyOn(mounted.ctx.agents, 'resume').mockImplementation(async options => {
        resumeSessionIds.push(String(options.resumeSessionId))
        throw injected
      })
      vi.spyOn(mounted.ctx.agents, 'create').mockImplementation(async options => {
        createCalls += 1
        return await originalCreate(options)
      })
    })
    try {
      const taskId = await createSkillsTask(opened.mounted.ctx, opened.root, `b1-${kind}-kick-task`, 'Request that re-wakes the manager on reopen')
      const intake = await captainSkillsTool(opened.mounted.ctx, opened.root, `b1-${kind}-kick`, REQUEST_TOOL, {
        request_id: `b1-${kind}-kick`, revision: 1, question: 'Reopen drives the resume classification.', task_id: taskId,
      })
      expect(intake.ok).toBe(true)
      await opened.module.flushWakes()

      expect(resumeSessionIds, 'reopen drives the official resume first, on the bound identity').toContain(managerId)
      expect(createCalls, `${kind} must NEVER fold into the same-id create fallback`).toBe(0)
      expect(opened.mounted.ctx.agents.get(SessionId(managerId)), `${kind} does not resurrect a manager`).toBeUndefined()
      const row = await readRow(sandbox, scope, teamId, `b1-${kind}-kick`)
      expect(row!.state, `${kind} propagates explicitly as a wake failure`).toBe('failed')
      expect(String(row!.reason), 'the durable failure names the exact injected condition').toContain(kind === 'corruption'
        ? 'SessionPersistenceCorruptionError'
        : 'injected disk read failure')
    } finally {
      vi.restoreAllMocks()
      await disposeRestartComposition(opened.mounted)
    }
  }, 90_000)

  it.each([
    { entry: 'create' },
    { entry: 'resume' },
  ] as const)('window A [$entry open]: close lands INSIDE the real setup after its body ran, before the commit — the open rolls back, nothing publishes, no model turn', async ({ entry }) => {
    const sandbox = await freshSandbox()
    const tag = `win-a-${entry}`
    let team: { scope: string; teamId: string } | undefined
    if (entry === 'resume') {
      const settled = await persistSettledManagerSession(sandbox, tag)
      team = { scope: settled.scope, teamId: settled.teamId }
    }
    const h = makeWindowHarness()
    const opened = await openModuleOnTeam(sandbox, team, mounted => {
      if (entry === 'create') {
        const originalCreate = mounted.ctx.agents.create.bind(mounted.ctx.agents)
        vi.spyOn(mounted.ctx.agents, 'create').mockImplementation(async options => {
          h.state.identity = String(options.sessionId)
          const handle = await originalCreate({ ...options, setup: h.wrapSetup(options.setup) })
          h.state.handleReturned = true
          return handle
        })
      } else {
        const originalResume = mounted.ctx.agents.resume.bind(mounted.ctx.agents)
        vi.spyOn(mounted.ctx.agents, 'resume').mockImplementation(async options => {
          h.state.identity = String(options.resumeSessionId)
          const handle = await originalResume({ ...options, setup: h.wrapSetup(options.setup) })
          h.state.handleReturned = true
          return handle
        })
      }
    })
    const { mounted, module, adapter } = opened
    try {
      const opening = module.ensureManager()
      await h.enteredP
      const identity = h.state.identity // captured BEFORE close — a closed store getter is never consulted later
      const closing = module.close()
      h.release()
      const failure = await opening.then(() => undefined, (error: unknown) => error as Error & { code?: string })
      await closing
      expect(failure, 'an open whose setup meets the closed admission must fail closed').toBeDefined()
      // Fail-closed either way: the official signal cancels the call, or the
      // setup-commit boundary itself refuses the closed admission/generation.
      expect([failure!.code ?? '', failure!.name, failure!.message].join(' '))
        .toMatch(/SKILLS_ADMISSION_CLOSED|AbortError|abort/i)
      expect(h.state.handleReturned, `window A (${entry}): the official open never returned a handle`).toBe(false)
      expect(mounted.ctx.agents.get(SessionId(identity)), 'the rolled-back open leaves no resident manager').toBeUndefined()
      await expect(module.ensureManager(), 'the closed module refuses a reopen through the public face').resolves.toBeUndefined()
      expect(adapter.requests, 'window A never reached the manager model').toHaveLength(0)
    } finally {
      vi.restoreAllMocks()
      h.releaseAll()
      await disposeRestartComposition(mounted)
    }
  }, 90_000)

  it.each([
    { entry: 'create' },
    { entry: 'resume' },
  ] as const)('window B [$entry open]: the official open RETURNED its handle and close lands pre-publication — close stays pending until the real dispose settles, then the registry is clean', async ({ entry }) => {
    const sandbox = await freshSandbox()
    const tag = `win-b-${entry}`
    let team: { scope: string; teamId: string } | undefined
    if (entry === 'resume') {
      const settled = await persistSettledManagerSession(sandbox, tag)
      team = { scope: settled.scope, teamId: settled.teamId }
    }
    let entered!: () => void
    const enteredP = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let holdDispose!: () => void
    const hold = new Promise<void>(resolve => { holdDispose = resolve })
    let disposeStarted!: () => void
    const startedP = new Promise<void>(resolve => { disposeStarted = resolve })
    const state = { identity: '', handleReturned: false }
    const opened = await openModuleOnTeam(sandbox, team, mounted => {
      if (entry === 'create') {
        const originalCreate = mounted.ctx.agents.create.bind(mounted.ctx.agents)
        vi.spyOn(mounted.ctx.agents, 'create').mockImplementation(async options => {
          const handle = await originalCreate(options) // the REAL official open completes...
          state.identity = String(handle.agent.id)
          state.handleReturned = true
          instrument(handle)
          entered()
          await gate // ...but the module has NOT published it yet
          return handle
        })
      } else {
        const originalResume = mounted.ctx.agents.resume.bind(mounted.ctx.agents)
        vi.spyOn(mounted.ctx.agents, 'resume').mockImplementation(async options => {
          const handle = await originalResume(options)
          state.identity = String(options.resumeSessionId)
          state.handleReturned = true
          instrument(handle)
          entered()
          await gate
          return handle
        })
      }
      // Make the late handle's REAL disposal observable and holdable, so the
      // test can prove close remains pending until that disposal settles —
      // not merely that dispose was called.
      function instrument(handle: Awaited<ReturnType<typeof mounted.ctx.agents.create>>) {
        const originalDispose = handle.dispose.bind(handle)
        vi.spyOn(handle, 'dispose').mockImplementation(async () => {
          disposeStarted()
          await hold
          await originalDispose()
        })
      }
    })
    const { mounted, module } = opened
    try {
      const opening = module.ensureManager()
      await enteredP
      const identity = state.identity // captured BEFORE close
      expect(state.handleReturned, `window B (${entry}): the official open really returned its handle`).toBe(true)
      expect(mounted.ctx.agents.get(SessionId(identity)), 'the returned Session is officially live pre-publication').toBeDefined()

      const closing = module.close()
      let closeSettled = false
      void closing.then(() => { closeSettled = true })
      release()
      await startedP // the guard released the late handle...
      await new Promise(resolve => setTimeout(resolve, 50)) // ...its REAL dispose is still held
      expect(closeSettled, 'close must NOT complete while the module-owned late handle is still disposing').toBe(false)
      holdDispose()
      await closing // close completion now includes the settled disposal
      expect(mounted.ctx.agents.get(SessionId(identity)), 'after close completion the late handle is really gone from the registry').toBeUndefined()
      const failure = await opening.then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(failure, 'the late open must fail closed against the closed admission').toBeDefined()
      expect([failure!.code ?? '', failure!.message].join(' ')).toContain('SKILLS_ADMISSION_CLOSED')
      await expect(module.ensureManager(), 'the closed module refuses a reopen through the public face').resolves.toBeUndefined()
      expect(mounted.ctx.agents.get(opened.root.id), 'business Agents are untouched by the raced open').toBeDefined()
    } finally {
      vi.restoreAllMocks()
      holdDispose?.()
      release?.()
      await disposeRestartComposition(mounted)
    }
  }, 90_000)
})
