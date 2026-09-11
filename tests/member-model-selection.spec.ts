import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as ClientConnection from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
/**
 * Issue #233 RED: an active Team participant selects its own model in place.
 * The durable authority stays the target Session's model/selection events plus
 * the official projection; the Team aggregate only supplies identity and the
 * startup install roster. Written RED-first: production is untouched, so every
 * `[RED]` case below must fail until agent_swarm_set_member_model exists.
 *
 * Harness notes (reviewed against root's first two runs): a managed dedicated
 * Captain owns recruitment and the subagent surface requires the exact live
 * parent, so every captain/member operation runs inside the installed Core
 * lease overlay `ctx.subagents.withContinuableChild(parent, childId, signal,
 * cb)` (same capability the product uses at message-delivery.ts:279 and
 * goal-runtime-surface.ts:238). No stale Agent pointer survives a lease
 * callback; only session ids and the always-live Main root cross phases. The
 * seeded case reuses its existing root instead of creating ROOT twice.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Attachments from '@deepseek-ai/dsh-attachment'
import Typert from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ReasoningEffortId, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { TeamId } from '../src/domain/types.js'
import {
  mountRestartComposition as mount, disposeRestartComposition as dispose,
  restartTool as tool, RESTART_SIGNAL as SIGNAL, type RestartMounted,
} from './helpers/restart-real-composition.js'

const ROOT = SessionId('member-selection-root')
const ROUTE = { provider: 'member-route-provider', model: 'member-route-model', reasoningEffort: ReasoningEffortId('max') }
const NEXT = { provider: 'member-selected-provider', model: 'member-selected-model', reasoningEffort: ReasoningEffortId('high') }
const NEW_TOOL = 'agent_swarm_set_member_model'

/** No image IO is part of this text-only Controller composition. */
class TextOnlyAttachments extends Attachments {
  override readonly imageLimits = { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: [] }
  override async validateImage(): Promise<never> { throw new Error('unexpected image validation') }
  override async saveImage(): Promise<never> { throw new Error('unexpected image write') }
  override async readImage(): Promise<never> { throw new Error('unexpected image read') }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: [
      { id: ReasoningEffortId('max'), name: 'Max' }, { id: ReasoningEffortId('high'), name: 'High' },
    ], ...(model === NEXT.model ? { defaultEffort: ReasoningEffortId('high') } : {}) } }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Understood.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The member's own first turn emits the self-selection tool call; that same
 * request must complete normally and only the next request may route to the
 * new model. The not-cancelled guard only inspects an earlier request of the
 * very same session, never an unrelated or absent one. */
class MemberSwitchAdapter extends RecordingAdapter {
  switched = false
  captainId: string | null = null
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== ROOT && this.captainId !== null && options.sessionId !== this.captainId && !this.switched) {
      this.switched = true
      this.requests.push(options)
      const id = ToolCallId('member-select-own-model')
      const args = JSON.stringify({ llm_provider: NEXT.provider, model: NEXT.model, reasoning_effort: NEXT.reasoningEffort })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: NEW_TOOL, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: NEW_TOOL, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const prior = this.requests.filter(request => request.sessionId === options.sessionId).at(-1)
    if (prior !== undefined) expect(prior.signal?.aborted).toBe(false)
    yield* super.stream(options)
  }
}

async function installHost(ctx: Context, fibers: Fiber[], sandbox: string, adapter: RecordingAdapter) {
  ctx.llm.registerAdapter([ROUTE.provider, NEXT.provider, 'wrong-default'], adapter)
  const preset = join(sandbox, 'presets', 'model-route')
  await mkdir(preset, { recursive: true })
  const persona = join(preset, 'persona.mjs')
  await writeFile(persona, 'export const inject = ["systemPrompt"]; export function apply(ctx) { ctx.systemPrompt.section({ name: "deployment:persona", order: 0, text: "Route {{model}} via {{provider}}." }) }')
  await writeFile(join(preset, 'agent.cordis.yml'), `- id: persona\n  name: ${JSON.stringify(pathToFileURL(persona).href)}\n`)
  ctx.baseUrl = pathToFileURL(sandbox).href + '/'
  fibers.push(await ctx.plugin(Loader))
  ctx.loader.builtins.include = Include
  fibers.push(await ctx.plugin(AgentPresets, {
    default: 'model-route', roots: [{ path: join(sandbox, 'presets'), trust: 'user' }], includeUserRoot: false, includeShippedRoot: false,
  }))
  fibers.push(await ctx.plugin(AgentDefaultModel, { provider: 'wrong-default', model: 'must-not-be-used' }))
  fibers.push(await ctx.plugin(TextOnlyAttachments))
  fibers.push(await ctx.plugin(Typert))
  fibers.push(await ctx.plugin(WorkspaceRegistry))
  fibers.push(await ctx.plugin(CredentialsLocal, { path: join(sandbox, 'credentials.yaml'), dshHome: sandbox, watch: false }))
  fibers.push(await ctx.plugin(ClientConnection))
  fibers.push(await ctx.plugin(Commands))
  fibers.push(await ctx.plugin(FileUploads))
  fibers.push(await ctx.plugin(SessionController, { nativeOpen: false }))
}

/** Reuse an existing ROOT (the seeded case pre-creates it) or create it once. */
async function ensureRoot(first: RestartMounted, sandbox: string, route: { provider: string; model: string; reasoningEffort?: string }) {
  const existing = first.ctx.agents.get(ROOT)
  if (existing !== undefined) return existing
  return await first.ctx.agentLoop.create(ROOT, route, { cwd: join(sandbox, 'workspace') })
}

/** Setup turns must not end in error; agents without any turn are fine. */
function expectCompletedTurns(...agents: readonly { session: { snapshotEvents(): Array<{ type: string; data: { reason?: unknown } }> } }[]): void {
  for (const agent of agents) {
    const last = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
    if (last !== undefined) expect(last.data.reason).toEqual({ kind: 'completed' })
  }
}

interface LeasedTeam {
  readonly root: Agent
  readonly captain: Agent
  readonly member: Agent
  readonly teamId: string
  readonly captainId: SessionId
  readonly memberId: SessionId
}

/** Managed Team plus one explicitly routed member. The real captain recruits
 * inside a Core lease on itself and the member is leased from that captain, so
 * every captain/member operation in `run` sees exact live agents. Only ids and
 * the always-live Main root escape the leases. `primeRootTurn` gives the Main
 * one real initial user turn (the canonical persisted request/header the
 * recovery contract reads); cold-restart cases use it. */
async function withRecruitedTeam(first: RestartMounted, sandbox: string, memberRoute: { provider: string; model: string; reasoningEffort?: string }, run: (team: LeasedTeam) => Promise<void>, options: { rootRoute?: { provider: string; model: string; reasoningEffort?: string }; onCaptain?: (captainId: string) => void; primeRootTurn?: boolean } = {}): Promise<void> {
  const root = await ensureRoot(first, sandbox, options.rootRoute ?? ROUTE)
  if (options.primeRootTurn === true) {
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the Team.' }] }))
    await root.whenIdle()
  }
  const created = await tool(first.ctx, root, 'member-model-create', 'agent_swarm_create_managed', { name: 'Member model', description: 'Recruit one member and keep it recoverable.' })
  expect(created.isError, JSON.stringify(created.error)).toBe(false)
  const teamId = (created.value as { team_id: string }).team_id
  const captainId = SessionId((created.value as { captain_session_id: string }).captain_session_id)
  options.onCaptain?.(String(captainId))
  await first.ctx.subagents.withContinuableChild(root, captainId, SIGNAL, async (captain, captainLease) => {
    const recruited = await tool(first.ctx, captain, 'member-model-recruit', 'agent_swarm_add_member', {
      name: 'worker', role: 'Switch the model in place.',
      llm_provider: memberRoute.provider, model: memberRoute.model,
      ...(memberRoute.reasoningEffort === undefined ? {} : { reasoning_effort: memberRoute.reasoningEffort }),
    })
    expect(recruited.isError, JSON.stringify(recruited.error)).toBe(false)
    const memberId = SessionId((recruited.value as { session_id: string }).session_id)
    await first.ctx.subagents.withContinuableChild(captain, memberId, captainLease, async member => {
      await member.whenIdle()
      expectCompletedTurns(root, captain)
      await run({ root, captain, member, teamId, captainId, memberId })
    })
  })
}

// [RED] The new self-selection tool does not exist, so the member's tool call
// errors, no model/selection is appended and the follow-up request keeps the
// creation route. Must turn green only with the #233 implementation.
it('switches a member through a real tool call for the next request without cancelling the current request', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-member-selection-'))
  const adapter = new MemberSwitchAdapter()
  const first = await mount(sandbox, 0, undefined, undefined, (ctx, fibers) => installHost(ctx, fibers, sandbox, adapter))
  try {
    await withRecruitedTeam(first, sandbox, ROUTE, async ({ root, captain, member, teamId, memberId }) => {
      const scope = first.ctx.agentSwarm.scopeOf(root)
      const teamRevision = (await first.ctx.agentSwarm.domain.snapshot(scope, TeamId(teamId), captain.id)).team.revision
      await member.whenIdle()
      const requests = adapter.requests.filter(request => request.sessionId === memberId)
      expect(requests).toHaveLength(2)
      expect(requests[0]).toMatchObject(ROUTE)
      expect(requests[1]).toMatchObject(NEXT)
      await first.ctx.sessionPersistence.flush()
      const persisted = await readPersistedSession(first.ctx.sessionPersistence, memberId, SIGNAL)
      expect(persisted.events.slice(persisted.inheritedEventCount ?? 0).filter(event => event.type === 'model/selection'))
        .toMatchObject([{ data: NEXT }])
      expect(persisted.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
      // The Team aggregate is identity only: no durable member route override.
      const after = await first.ctx.agentSwarm.domain.snapshot(scope, TeamId(teamId), captain.id)
      expect(after.team.revision).toBe(teamRevision)
      expect(after.team.members.find(row => row.sessionId === memberId)?.phase).toBe('active')
      // Directory reflects the session's own selection, not a Team write.
      const directory = await first.ctx.agentSwarm.directory.read(scope, TeamId(teamId), {}, SIGNAL)
      expect(directory.entries.find(entry => entry.memberId === memberId)?.model).toMatchObject({ provider: NEXT.provider, model: NEXT.model })
      expectCompletedTurns(root, captain)
    }, { onCaptain: captainId => { adapter.captainId = captainId } })
  } finally {
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

// [RED for the participant surface] A non-participant (the parent Main Brain)
// must be denied the participant tool. The legacy Captain-only tool stays
// unreachable for members through the Team tool policy fail-closed denial —
// asserted by its exact message so an unknown-tool miss can never satisfy it.
// Post-implementation the Captain may use the new tool for its own session,
// which also proves the tool is registered rather than missing.
it('denies non-participant self-selection and keeps the Captain-only tool boundary', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-member-selection-authority-'))
  const adapter = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined, (ctx, fibers) => installHost(ctx, fibers, sandbox, adapter))
  try {
    await withRecruitedTeam(first, sandbox, ROUTE, async ({ root, captain, member }) => {
      expect((await tool(first.ctx, root, 'root-must-not-select-member-model', NEW_TOOL, { llm_provider: NEXT.provider, model: NEXT.model })).isError).toBe(true)
      const memberOldTool = await tool(first.ctx, member, 'member-must-not-use-captain-tool', 'agent_swarm_set_captain_model', { llm_provider: NEXT.provider, model: NEXT.model })
      expect(memberOldTool.isError).toBe(true)
      // The Team tool policy fail-closes the captain-only tool before the
      // runtime is reached; that exact denial — not an unknown-tool miss — is
      // the preserved old boundary for members.
      const denial = JSON.stringify(memberOldTool.error)
      expect(denial).toContain('denied by the Team tool policy (fail closed)')
      expect(denial).toContain('agent_swarm_set_captain_model')
      expect(denial).not.toContain('UNKNOWN_TOOL')
      expect(member.session.ownEvents().filter(event => event.type === 'model/selection')).toEqual([])
      const captainSelected = await tool(first.ctx, captain, 'captain-self-select', NEW_TOOL, { llm_provider: NEXT.provider, model: NEXT.model })
      expect(captainSelected.isError, JSON.stringify(captainSelected.error)).toBe(false)
      expect(captain.session.ownEvents().at(-1)).toMatchObject({ type: 'model/selection', data: { provider: NEXT.provider, model: NEXT.model } })
    })
  } finally {
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

// [RED] Cold continuation must restore the member's own selection through the
// official projection before the first post-restart request, without a second
// plugin recovery path and without touching the Team aggregate.
it.each(['pending', 'consumed', 'default'] as const)('restores the %s member selection before the first real cold-continuation request', async mode => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-member-cold-model-'))
  const adapter = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined, (ctx, fibers) => installHost(ctx, fibers, sandbox, adapter))
  let firstDisposed = false
  let second: RestartMounted | undefined
  try {
    let captainId = SessionId(''), memberId = SessionId(''), debtTaskId = '', teamId = ''
    await withRecruitedTeam(first, sandbox, ROUTE, async ({ root, captain, member, teamId: id }) => {
      captainId = captain.id; memberId = member.id; teamId = id
      // Cold-recovery business preconditions (fixture-only, mirrors the
      // existing root-model cold contract): the primed Main turn establishes
      // the canonical persisted request/header the recovery reads. The
      // unfinished task debt is created at the END of this callback so the
      // revision-observation window below stays isolated from the async
      // scheduling/notice writes that task creation triggers.
      const scope = first.ctx.agentSwarm.scopeOf(root)
      const teamRevision = (await first.ctx.agentSwarm.domain.snapshot(scope, TeamId(teamId), captain.id)).team.revision
      const args = { llm_provider: NEXT.provider, model: NEXT.model, ...(mode === 'default' ? {} : { reasoning_effort: NEXT.reasoningEffort }) }
      const selected = await tool(first.ctx, member, 'cold-member-select', NEW_TOOL, args)
      expect(selected.isError, JSON.stringify(selected.error)).toBe(false)
      expect((await first.ctx.agentSwarm.domain.snapshot(scope, TeamId(teamId), captain.id)).team.revision).toBe(teamRevision)
      if (mode !== 'pending') {
        await first.ctx.subagents.sendMessage(captain, memberId, [{ type: 'text', text: 'Use the selected model now.' }], { signal: SIGNAL })
        await vi.waitFor(() => expect(adapter.requests.filter(request => request.sessionId === memberId)).toHaveLength(2), { timeout: 10_000 })
        // Prove the live second request actually routed to the selection
        // before reading anything persisted; if this ever reads the old
        // route the product broke, not the observation.
        expect(adapter.requests.filter(request => request.sessionId === memberId)[1]).toMatchObject(NEXT)
        await member.whenIdle()
        await first.ctx.sessionPersistence.flush()
        const stored = await readPersistedSession(first.ctx.sessionPersistence, memberId, SIGNAL)
        expect(stored.events.filter(event => event.type === 'request/header').at(-1)?.data.header.config).toMatchObject(NEXT)
        if (mode === 'default') {
          expect(stored.events.filter(event => event.type === 'request/header').at(-1)?.data.header.adapterDefaults?.reasoningEffort).toBe(true)
          expect(stored.events.filter(event => event.type === 'model/selection').at(-1)?.data.reasoningEffort).toBeUndefined()
        }
      }
      // The unfinished task is the restart precondition, created only after
      // the isolated model-selection observation window above has closed and
      // still inside the captain lease (real Team debt for recovery).
      const debt = await tool(first.ctx, captain, 'cold-debt-task', 'agent_swarm_create_task', { subject: 'Unfinished', description: 'Keep the Team recoverable across restart.' })
      expect(debt.isError, JSON.stringify(debt.error)).toBe(false)
      debtTaskId = (debt.value as { task_id: string }).task_id
      // Branch fidelity (fixture quality): after the debt creation, the three
      // cold modes must still reach the restart in genuinely different
      // inbound states. Official projection semantics (installed controller
      // model-selection-projection :26-43, sameSelection :57-61): lastUsed
      // carries the adapter-resolved reasoningEffort, and sameSelection
      // compares it strictly — so a default-intent selection (no effort key)
      // never equals a resolved one and stays pending, correctly re-using
      // the model default on every continuation.
      const selection = first.ctx.sessionProjections.stateOf(member.session, 'modelSelection')
      if (mode === 'pending') {
        expect(selection?.pending).toMatchObject(NEXT)
        expect(selection?.lastUsed).toMatchObject(ROUTE)
      } else if (mode === 'consumed') {
        expect(selection?.pending).toBeNull()
        expect(selection?.lastUsed).toMatchObject(NEXT)
      } else {
        expect(selection?.pending).toEqual({ provider: NEXT.provider, model: NEXT.model })
        expect(selection?.lastUsed).toMatchObject(NEXT)
      }
    }, { primeRootTurn: true })
    await dispose(first); firstDisposed = true
    const afterRestart = new RecordingAdapter()
    second = await mount(sandbox, 0, undefined, undefined, (ctx, fibers) => {
      expect(firstDisposed).toBe(true)
      expect(ctx.agents.get(memberId)).toBeUndefined()
      return installHost(ctx, fibers, sandbox, afterRestart)
    })
    // Wait for real recovery evidence with real matchers, then take the
    // recovered root from the registry; the Captain continues once by
    // recovery. Wake the cold member through real child mail, leased so the
    // captain stays the exact live parent for the send.
    await vi.waitFor(() => expect(second!.ctx.agents.get(ROOT)).toBeDefined(), { timeout: 10_000 })
    const root = second.ctx.agents.get(ROOT)!
    // The unfinished task survived the restart: the Team was worth
    // recovering and still carries its in-development debt.
    const reloaded = (await second.ctx.agentSwarm.listTeamAggregates(second.ctx.agentSwarm.scopeOf(root))).find(team => team.id === teamId)!
    expect(reloaded.tasks.some(task => task.id === debtTaskId)).toBe(true)
    await vi.waitFor(() => expect(afterRestart.requests.some(request => request.sessionId === captainId)).toBe(true), { timeout: 10_000 })
    await second.ctx.subagents.withContinuableChild(root, captainId, SIGNAL, async captain => {
      await captain.whenIdle()
      await second.ctx.subagents.sendMessage(captain, memberId, [{ type: 'text', text: 'Continue after restart.' }], { signal: SIGNAL })
    })
    await vi.waitFor(() => expect(afterRestart.requests.some(request => request.sessionId === memberId)).toBe(true), { timeout: 10_000 })
    expect(afterRestart.requests.find(request => request.sessionId === memberId)).toMatchObject(NEXT)
    const resumedMember = second.ctx.agents.get(memberId)
    if (resumedMember !== undefined) await resumedMember.whenIdle()
    await second.ctx.sessionPersistence.flush()
    const persisted = await readPersistedSession(second.ctx.sessionPersistence, memberId, SIGNAL)
    expect(persisted.events.slice(persisted.inheritedEventCount ?? 0).filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(persisted.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
  } finally {
    if (!firstDisposed) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

// [PIN] Seeded children contain the parent's selection history; a member
// without its own model/selection must keep the explicit creation route. This
// holds today and must survive the new install roster. The case pre-creates
// its own root with the parent selection and the helper must reuse it.
it('does not let inherited parent selection replace an explicitly routed member', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-member-inherited-selection-'))
  const adapter = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
    await installHost(ctx, fibers, sandbox, adapter)
    const spawn = ctx.subagents.getProvider('spawn')!
    ctx.subagents.registerProvider({
      name: 'seeded', capabilities: spawn.capabilities, inheritsParentContext: true,
      start: request => spawn.start(request),
      prepareContinuable: async request => ({ seed: request.parent.session.snapshotEvents() }),
    })
  }, { memberProvider: 'seeded' })
  try {
    const root = await first.ctx.agentLoop.create(ROOT, NEXT, { cwd: join(sandbox, 'workspace') })
    root.session.append('model/selection', NEXT)
    await first.ctx.sessions.flush(root.session)
    let memberId = SessionId('')
    await withRecruitedTeam(first, sandbox, ROUTE, async ({ member }) => { memberId = member.id })
    await vi.waitFor(() => expect(adapter.requests.some(request => request.sessionId === memberId)))
    expect(adapter.requests.find(request => request.sessionId === memberId)).toMatchObject(ROUTE)
    const stored = await readPersistedSession(first.ctx.sessionPersistence, memberId, SIGNAL)
    expect(stored.events.some(event => event.type === 'model/selection')).toBe(true)
    expect(stored.events.slice(stored.inheritedEventCount ?? 0).some(event => event.type === 'model/selection')).toBe(false)
  } finally {
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
