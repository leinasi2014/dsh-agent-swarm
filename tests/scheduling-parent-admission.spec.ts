/** Assignment admission across real managed-Captain retirement and official reactivation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deliverSubagentPrompt, queueHostSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { expect, it, vi } from 'vitest'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { assignmentPrompt } from '../src/runtime/prompts.js'
import { disposeRestartComposition, mountRestartComposition } from './helpers/restart-real-composition.js'

const SIGNAL = new AbortController().signal
const ROOT = SessionId('admission-root'), CAPTAIN = SessionId('admission-captain'), MEMBER = SessionId('admission-member')
const ROUTE = { provider: 'admission-fixture', model: 'recording' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class AdmissionRecording extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private captainGate = deferred()
  private readonly assignmentGate = deferred()
  holdCaptain(): void { this.captainGate = deferred() }
  releaseCaptain(): void { this.captainGate.resolve() }
  releaseMember(): void { this.assignmentGate.resolve() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const assignment = options.sessionId === MEMBER && options.messages.some(message => message.role === 'user'
      && message.content.some(part => part.type === 'text' && part.text.includes('Team assignment')))
    if (options.sessionId === CAPTAIN || assignment) {
      const gate = assignment ? this.assignmentGate : this.captainGate
      const signal = options.signal
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { reject(signal?.reason) }
        if (signal?.aborted) { abort(); return }
        signal?.addEventListener('abort', abort, { once: true })
        void gate.promise.then(() => { signal?.removeEventListener('abort', abort); resolve() })
      })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded the instruction.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each(['reactivated', 'absent', 'wrong-lineage', 'wrong-scope', 'closing', 'cancelled'] as const)(
  'checks the current managed Captain after execution-root acquisition: %s', async condition => {
    const sandbox = await mkdtemp(join(tmpdir(), 'swarm-assignment-parent-'))
    const adapter = new AdmissionRecording()
    // Silence autonomous passes only; this test calls the unchanged real pass explicitly.
    // Agent/Session, continuation, persistence, domain, execution roots and admission stay real.
    const run = SchedulingPass.prototype.run
    const automatic = vi.spyOn(SchedulingPass.prototype, 'run').mockResolvedValue()
    const mounted = await mountRestartComposition(sandbox, 0, undefined, join(sandbox, 'roots'), ctx => {
      ctx.llm.registerAdapter([ROUTE.provider], adapter)
    })
    const { ctx } = mounted, domain = ctx.agentSwarm.domain
    const acquired = deferred(), proceed = deferred(), cancellation = new AbortController()
    let pass: SchedulingPass | undefined, operation: Promise<void> | undefined, closing = false
    try {
      const workspace = join(sandbox, 'workspace')
      const root = (await ctx.agents.create({ sessionId: ROOT, meta: { cwd: workspace }, agentOptions: ROUTE })).agent
      await ctx.subagents.startContinuable({ provider: 'spawn', childId: CAPTAIN, label: 'Managed Captain',
        request: { parent: root, prompt: [{ type: 'text', text: 'Coordinate this Team and await its assignments.' }], agentOptions: ROUTE, maxDepth: 2 }, signal: SIGNAL })
      const original = ctx.agents.get(CAPTAIN)!
      await vi.waitFor(() => expect(original.status).toBe('running'))
      const scope = condition === 'wrong-scope' ? join(sandbox, 'another-workspace') : workspace
      const team = await domain.createTeam(scope, CAPTAIN, 'Admission Team', 'Preserve reserved assignments across activation epochs.',
        undefined, `managed:${condition === 'wrong-lineage' ? 'another-root' : ROOT}:turn:1`)
      await domain.provisionMember(scope, team.id, CAPTAIN, { name: 'worker', role: 'Receive the assignment', sessionId: MEMBER, provider: 'spawn' })
      await ctx.subagents.startContinuable({ provider: 'spawn', childId: MEMBER, label: 'Assignment worker',
        request: { parent: original, prompt: [{ type: 'text', text: 'Join the Team and wait for assigned work.' }], agentOptions: ROUTE, maxDepth: 2 }, signal: SIGNAL })
      await domain.settleMember(scope, team.id, MEMBER, { active: true })
      await vi.waitFor(() => expect(ctx.agents.get(MEMBER)).toBeUndefined())
      const task = await domain.createTask(scope, team.id, CAPTAIN, { subject: 'One assignment', description: 'Keep the same reserved attempt.' })
      const claim = await domain.claimTask(scope, team.id, CAPTAIN, task.id, task.revision, MEMBER)
      const roots = ctx.agentSwarm.executionRoots.roots, acquire = roots.acquire.bind(roots)
      const expectedFrame = assignmentPrompt(team, claim.task, claim.attempt.id, roots.declarationPathFor(scope, team.id, task.id, claim.attempt.id))
      vi.spyOn(roots, 'acquire').mockImplementation(async (...args) => {
        const lease = await acquire(...args)
        acquired.resolve(); await proceed.promise
        return lease
      })
      const usage = new UsageAccountant(ctx, { domain: () => domain, isClosing: () => closing })
      pass = new SchedulingPass(ctx, {
        domain: () => domain, delivery: () => { throw new Error('This reserved assignment has no mailbox debt') }, usage: () => usage,
        schedulerProvider: () => 'unused', schedulerProviders: () => new Map([['unused', { select: () => [] }]]),
        duringProvider: async (_scope, _team, work) => await work(), strandedAfterMs: 0, idleSince: () => undefined,
        eventFaceActive: () => false, isClosing: () => closing, trackTeamChildren: () => {}, requestSchedule: () => {},
        executionRoots: () => roots, executionRootsEnabled: () => true,
        sweepExecutionRoots: async (teamScope, teamId) => { await ctx.agentSwarm.executionRoots.sweep(teamScope, teamId) },
      })
      operation = run.call(pass, scope, team.id, original, cancellation.signal)
      await acquired.promise
      let current: Agent | undefined = original
      if (condition === 'reactivated' || condition === 'absent') {
        adapter.releaseCaptain()
        await vi.waitFor(() => expect(ctx.agents.get(CAPTAIN)).toBeUndefined())
        current = undefined
        if (condition === 'reactivated') {
          adapter.holdCaptain()
          await queueHostSubagentPrompt(ctx.subagents, root, CAPTAIN,
            [{ type: 'text', text: 'Continue coordinating the existing reserved assignment.' }], { kind: 'user' }, SIGNAL)
          current = ctx.agents.get(CAPTAIN)!
          expect(current).toBeDefined(); expect(current).not.toBe(original)
          expect(current.session).not.toBe(original.session)
          expect(current.session.header.parentSession).toBe(ROOT)
        }
      }
      if (condition === 'closing') closing = true
      if (condition === 'cancelled') cancellation.abort(new Error('Cancelled after real execution-root acquisition'))
      const deliverer = ctx.subagents as unknown as HostPromptDeliverer
      const deliver = deliverer[deliverSubagentPrompt].bind(ctx.subagents)
      const admissions: Agent[] = []
      vi.spyOn(deliverer, deliverSubagentPrompt).mockImplementation((parent, childId, ...args) => {
        if (childId === MEMBER) admissions.push(parent)
        const accepted = deliver(parent, childId, ...args)
        // The official call has acquired its parent hold before this release.
        if (childId === MEMBER) adapter.releaseCaptain()
        return accepted
      })
      proceed.resolve()
      if (condition === 'cancelled') await expect(operation).rejects.toThrow('Cancelled after real execution-root acquisition')
      else await operation
      const after = (await domain.snapshot(scope, team.id, CAPTAIN)).team
      const attempt = after.attempts.find(candidate => candidate.id === claim.attempt.id)
      expect(after.tasks.find(candidate => candidate.id === task.id)).toMatchObject({ currentAttemptId: claim.attempt.id, ownerSessionId: MEMBER })
      expect(attempt).toMatchObject({ phase: 'running', assignmentPhase: condition === 'reactivated' ? 'delivered' : 'reserved' })
      expect(admissions.map(parent => ({ id: parent.id, current: parent === current })))
        .toEqual(condition === 'reactivated' ? [{ id: CAPTAIN, current: true }] : [])
      const stored = await readPersistedSession(ctx.sessionPersistence, MEMBER, SIGNAL)
      const frames = stored.events.filter(event => event.type === 'user/message'
        && event.data.content.some(part => part.type === 'text' && part.text.includes('Team assignment')))
      expect(frames).toHaveLength(condition === 'reactivated' ? 1 : 0)
      if (condition === 'reactivated') {
        expect(frames[0]).toMatchObject({ type: 'user/message', data: {
          source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, content: [{ type: 'text', text: expectedFrame }],
        } })
        expect(adapter.requests.some(request => request.sessionId === MEMBER && request.messages.some(message => message.role === 'user'
          && message.content.some(part => part.type === 'text' && part.text.includes('Team assignment'))))).toBe(true)
      } else {
        expect(roots.leaseOf(scope, team.id, task.id, claim.attempt.id)).toBeDefined()
        if (condition === 'absent') expect(ctx.agents.get(CAPTAIN)).toBeUndefined()
      }
      if (condition === 'absent') {
        // The existing scheduler retries its reserved debt after a real input
        // reactivates the Captain; no zero-input activation or recovery loop.
        adapter.holdCaptain()
        await queueHostSubagentPrompt(ctx.subagents, root, CAPTAIN,
          [{ type: 'text', text: 'Resume the same pending assignment after the pause.' }], { kind: 'user' }, SIGNAL)
        current = ctx.agents.get(CAPTAIN)!
        expect(current === original).toBe(false)
        await run.call(pass, scope, team.id, current)
        const recovered = (await domain.snapshot(scope, team.id, CAPTAIN)).team
        expect(recovered.tasks.find(candidate => candidate.id === task.id)).toMatchObject({ currentAttemptId: claim.attempt.id })
        expect(recovered.attempts.find(candidate => candidate.id === claim.attempt.id)).toMatchObject({ phase: 'running', assignmentPhase: 'delivered' })
        expect(admissions.map(parent => ({ id: parent.id, current: parent === current }))).toEqual([{ id: CAPTAIN, current: true }])
        // A further normal pass only folds the claimed checkpoint, without admission.
        await run.call(pass, scope, team.id, current)
        expect(admissions).toHaveLength(1)
        const persisted = await readPersistedSession(ctx.sessionPersistence, MEMBER, SIGNAL)
        const recoveredFrames = persisted.events.filter(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text'
          && part.text.includes(`Attempt capability: ${claim.attempt.id}`)))
        expect(recoveredFrames).toHaveLength(1)
        expect(recoveredFrames[0]).toMatchObject({ type: 'user/message', data: {
          source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, content: [{ type: 'text', text: expectedFrame }],
        } })
      }
      await usage.wait()
    } finally {
      proceed.resolve(); adapter.releaseCaptain(); adapter.releaseMember()
      await operation?.catch(() => {})
      pass?.dispose(); automatic.mockRestore(); vi.restoreAllMocks()
      await disposeRestartComposition(mounted)
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 20_000,
)
