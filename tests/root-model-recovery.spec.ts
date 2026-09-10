import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as ClientConnection from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
/** Real cold-root request routing through Host-owned and headless recovery. */
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
import { LlmAdapter, ReasoningEffortId, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { ManagedActivationRecovery } from '../src/runtime/managed-activation-recovery.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { TeamId } from '../src/domain/types.js'
import {
  mountRestartComposition as mount, disposeRestartComposition as dispose,
  restartTool as tool, RESTART_SIGNAL as SIGNAL, type RestartMounted,
} from './helpers/restart-real-composition.js'

const ROOT = SessionId('model-recovery-root')
const ROUTE = { provider: 'persisted-provider', model: 'persisted-model', reasoningEffort: ReasoningEffortId('max') }
const NEXT = { provider: 'selected-provider', model: 'selected-model', reasoningEffort: ReasoningEffortId('high') }

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
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Mailbox received.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class CaptainSwitchAdapter extends RecordingAdapter {
  switched = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== ROOT && !this.switched) {
      this.switched = true
      this.requests.push(options)
      const id = ToolCallId('captain-select-own-model')
      const args = JSON.stringify({ llm_provider: NEXT.provider, model: NEXT.model, reasoning_effort: NEXT.reasoningEffort })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_set_captain_model', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_set_captain_model', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    expect(this.requests[0]?.signal?.aborted).toBe(false)
    yield* super.stream(options)
  }
}

class HeldCaptainAdapter extends RecordingAdapter {
  held?: GenerateOptions
  release!: () => void
  private readonly gate = new Promise<void>(resolve => { this.release = resolve })
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== ROOT && this.held === undefined) {
      this.held = options
      await this.gate
    }
    yield* super.stream(options)
  }
}

async function installHost(ctx: Context, fibers: Fiber[], sandbox: string, controller: boolean, adapter: RecordingAdapter) {
  ctx.llm.registerAdapter([ROUTE.provider, NEXT.provider, 'wrong-default'], adapter)
  const preset = join(sandbox, 'presets', 'model-route')
  await mkdir(preset, { recursive: true })
  const persona = join(preset, 'persona.mjs')
  await writeFile(persona, 'export const inject = ["systemPrompt"]; export function apply(ctx) { ctx.systemPrompt.section({ name: "deployment:persona", order: 0, text: "Root model {{model}} via {{provider}}." }) }')
  await writeFile(join(preset, 'agent.cordis.yml'), `- id: persona\n  name: ${JSON.stringify(pathToFileURL(persona).href)}\n`)
  ctx.baseUrl = pathToFileURL(sandbox).href + '/'
  fibers.push(await ctx.plugin(Loader))
  ctx.loader.builtins.include = Include
  // A standing preset contribution exercises the official strict renderer,
  // including the same deployment:persona slot and variables as standard.
  fibers.push(await ctx.plugin(AgentPresets, {
    default: 'model-route', roots: [{ path: join(sandbox, 'presets'), trust: 'user' }], includeUserRoot: false, includeShippedRoot: false,
  }))
  if (!controller) return
  fibers.push(await ctx.plugin(AgentDefaultModel, { provider: 'wrong-default', model: 'must-not-be-used' }))
  fibers.push(await ctx.plugin(TextOnlyAttachments))
  fibers.push(await ctx.plugin(Typert))
  fibers.push(await ctx.plugin(WorkspaceRegistry))
  fibers.push(await ctx.plugin(CredentialsLocal, { path: join(sandbox, 'credentials.yaml'), dshHome: sandbox, watch: false }))
  fibers.push(await ctx.plugin(ClientConnection))
  fibers.push(await ctx.plugin(Commands))
  fibers.push(await ctx.plugin(FileUploads))
  expect(ctx.get('fileUploads')).toBeDefined()
  fibers.push(await ctx.plugin(SessionController, { nativeOpen: false }))
  expect(ctx.get('sessionController')).toBeDefined()
}

async function seed(sandbox: string, options: { pending?: boolean } = {}) {
  const adapter = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, options.pending === true, adapter))
  try {
    const root = (await first.ctx.agents.create({
      sessionId: ROOT, agentOptions: ROUTE,
      meta: { cwd: join(sandbox, 'workspace'), agentPreset: 'model-route' },
      setup: async ctx => { await first.ctx.agentPresets.mount(ctx, 'model-route') },
    })).agent
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the Team.' }] }))
    await root.whenIdle()
    expect(root.session.requestHeader()?.config).toMatchObject(ROUTE)
    const result = await tool(first.ctx, root, 'model-create', 'agent_swarm_create_managed', { name: 'Restore root route', description: 'Wake the original coordinator after restart.' })
    expect(result.isError, JSON.stringify(result.error)).toBe(false)
    const { team_id: teamId, captain_session_id: captainId } = result.value as { team_id: string; captain_session_id: string }
    const captain = first.ctx.agents.get(SessionId(captainId))!
    await captain.whenIdle()
    const task = await tool(first.ctx, captain, 'model-task', 'agent_swarm_create_task', { subject: 'Unfinished', description: 'Remain recoverable without recruiting a member.' })
    expect(task.isError).toBe(false)
    if (options.pending) await first.ctx.sessionController.selectModel({ sessionId: ROOT, ...NEXT })
    return { teamId, captainId, scope: first.ctx.agentSwarm.scopeOf(root) }
  } finally { await dispose(first) }
}

it('switches a Captain through a real tool call for the next request without cancelling the current request', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-captain-selection-'))
  const adapter = new CaptainSwitchAdapter()
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, true, adapter))
  try {
    const root = await first.ctx.agentLoop.create(ROOT, ROUTE, { cwd: join(sandbox, 'workspace') })
    const created = await tool(first.ctx, root, 'self-model-create', 'agent_swarm_create_managed', { name: 'Self model', description: 'Select the requested model and finish.' })
    expect(created.isError, JSON.stringify(created.error)).toBe(false)
    const captainId = SessionId((created.value as { captain_session_id: string }).captain_session_id)
    // Admission includes the real model-selection tool's durable flushes. Wait
    // for this Captain's second request, then its official turn completion.
    await vi.waitFor(() => expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(2), { timeout: 10_000 })
    await first.ctx.agents.get(captainId)?.whenIdle()
    const requests = adapter.requests.filter(request => request.sessionId === captainId)
    expect(requests[0]).toMatchObject(ROUTE)
    expect(requests[1]).toMatchObject(NEXT)
    await first.ctx.sessionPersistence.flush()
    const persisted = await readPersistedSession(first.ctx.sessionPersistence, captainId, SIGNAL)
    expect(persisted.events.slice(persisted.inheritedEventCount ?? 0).filter(event => event.type === 'model/selection'))
      .toMatchObject([{ data: NEXT }])
    expect(persisted.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
  } finally {
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it('leaves legacy root model ownership with the Host and denies member self-selection', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-captain-selection-authority-'))
  const adapter = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, true, adapter))
  try {
    const root = await first.ctx.agentLoop.create(ROOT, ROUTE, { cwd: join(sandbox, 'workspace') })
    expect((await tool(first.ctx, root, 'legacy-create', 'agent_swarm_create', { name: 'Legacy owner', description: 'Retain Host model authority.' })).isError).toBe(false)
    await first.ctx.sessionController.selectModel({ sessionId: ROOT, ...ROUTE })
    const before = root.session.ownEvents().filter(event => event.type === 'model/selection')
    await expect(first.ctx.agentSwarm.captainModels.select({ agent: root, signal: SIGNAL }, {
      llmProvider: NEXT.provider, model: NEXT.model,
    })).rejects.toMatchObject({ code: 'TEAM_DEDICATED_CAPTAIN_REQUIRED' })
    expect(root.session.ownEvents().filter(event => event.type === 'model/selection')).toEqual(before)
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the Host selection.' }] }))
    await root.whenIdle()
    expect(adapter.requests.find(request => request.sessionId === ROOT)).toMatchObject(ROUTE)
    const recruited = await tool(first.ctx, root, 'selection-member', 'agent_swarm_add_member', { name: 'worker', role: 'Check the route boundary.' })
    expect(recruited.isError).toBe(false)
    const member = first.ctx.agents.get(SessionId((recruited.value as { session_id: string }).session_id))!
    await expect(first.ctx.agentSwarm.captainModels.select({ agent: member, signal: SIGNAL }, {
      llmProvider: NEXT.provider, model: NEXT.model,
    })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    expect(member.session.ownEvents().some(event => event.type === 'model/selection')).toBe(false)
  } finally {
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.each(['pending', 'consumed', 'default'] as const)('restores the %s Captain selection before the first real cold-continuation request', async mode => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-captain-cold-model-'))
  const adapter = new HeldCaptainAdapter()
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, true, adapter))
  let firstDisposed = false
  let second: RestartMounted | undefined
  try {
    const root = await first.ctx.agentLoop.create(ROOT, ROUTE, { cwd: join(sandbox, 'workspace') })
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare.' }] }))
    await root.whenIdle()
    const created = await tool(first.ctx, root, 'cold-model-create', 'agent_swarm_create_managed', { name: 'Cold model', description: 'Retain the selected Captain route.' })
    expect(created.isError).toBe(false)
    const captainId = SessionId((created.value as { captain_session_id: string }).captain_session_id)
    await vi.waitFor(() => expect(adapter.held?.sessionId).toBe(captainId), { timeout: 10_000 })
    const captain = first.ctx.agents.get(captainId)!
    const task = await tool(first.ctx, captain, 'cold-model-task', 'agent_swarm_create_task', { subject: 'Unfinished', description: 'Continue after restart.' })
    expect(task.isError).toBe(false)
    const teamId = TeamId((created.value as { team_id: string }).team_id)
    const scope = first.ctx.agentSwarm.scopeOf(root)
    const beforeDirectory = await first.ctx.agentSwarm.directory.read(scope, teamId, {}, SIGNAL)
    expect(beforeDirectory.entries[0]?.model).toMatchObject({ provider: ROUTE.provider, model: ROUTE.model })
    const teamRevision = (await first.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.revision
    const args = { llm_provider: NEXT.provider, model: NEXT.model, ...(mode === 'default' ? {} : { reasoning_effort: NEXT.reasoningEffort }) }
    const beforeRoot = root.session.ownEvents().filter(event => event.type === 'model/selection')
    expect((await tool(first.ctx, root, 'root-must-not-select', 'agent_swarm_set_captain_model', args)).isError).toBe(true)
    expect(root.session.ownEvents().filter(event => event.type === 'model/selection')).toEqual(beforeRoot)
    expect((await tool(first.ctx, captain, 'captain-unsupported-effort', 'agent_swarm_set_captain_model', { ...args, reasoning_effort: 'unsupported' })).isError).toBe(true)
    expect(captain.session.ownEvents().filter(event => event.type === 'model/selection')).toEqual([])
    const selected = await tool(first.ctx, captain, 'cold-model-select', 'agent_swarm_set_captain_model', args)
    expect(selected.isError, JSON.stringify(selected.error)).toBe(false)
    const selectedDirectory = await first.ctx.agentSwarm.directory.read(scope, teamId, {}, SIGNAL)
    expect(selectedDirectory.entries[0]?.model).toMatchObject({ provider: NEXT.provider, model: NEXT.model })
    expect(selectedDirectory.directoryRevision).not.toBe(beforeDirectory.directoryRevision)
    expect((await first.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.revision).toBe(teamRevision)
    expect(adapter.held?.signal?.aborted).toBe(false)
    adapter.release()
    await captain.whenIdle()
    expect(first.ctx.sessionProjections.stateOf(captain.session, 'modelSelection')?.pending).toMatchObject({ provider: NEXT.provider, model: NEXT.model })
    if (mode !== 'pending') {
      await first.ctx.subagents.sendMessage(root, captainId, [{ type: 'text', text: 'Use the selected model now.' }], { signal: SIGNAL })
      await vi.waitFor(() => expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(2), { timeout: 10_000 })
      const resumed = first.ctx.agents.get(captainId)
      if (resumed !== undefined) await resumed.whenIdle()
      const stored = await readPersistedSession(first.ctx.sessionPersistence, captainId, SIGNAL)
      expect(stored.events.filter(event => event.type === 'request/header').at(-1)?.data.header.config).toMatchObject(NEXT)
      if (mode === 'default') {
        expect(stored.events.filter(event => event.type === 'request/header').at(-1)?.data.header.adapterDefaults?.reasoningEffort).toBe(true)
        expect(stored.events.filter(event => event.type === 'model/selection').at(-1)?.data.reasoningEffort).toBeUndefined()
      }
    }
    await dispose(first); firstDisposed = true
    const afterRestart = new RecordingAdapter()
    second = await mount(sandbox, 0, undefined, undefined,
      (ctx, fibers) => {
        expect(firstDisposed).toBe(true)
        expect(ctx.agents.get(captainId)).toBeUndefined()
        return installHost(ctx, fibers, sandbox, true, afterRestart)
      })
    await vi.waitFor(() => expect(afterRestart.requests.filter(request => request.sessionId === captainId)).toHaveLength(1), { timeout: 10_000 })
    await second.ctx.agents.get(captainId)?.whenIdle()
    expect(afterRestart.requests.find(request => request.sessionId === captainId)).toMatchObject(NEXT)
    await second.ctx.sessionPersistence.flush()
    const persisted = await readPersistedSession(second.ctx.sessionPersistence, captainId, SIGNAL)
    expect(persisted.events.slice(persisted.inheritedEventCount ?? 0).filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(persisted.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
  } finally {
    adapter.release()
    if (!firstDisposed) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it('does not let inherited parent selection replace an explicitly routed new Captain', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-captain-inherited-selection-'))
  const adapter = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
    await installHost(ctx, fibers, sandbox, true, adapter)
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
    const created = await tool(first.ctx, root, 'inherit-model-create', 'agent_swarm_create_managed', {
      name: 'Explicit child', description: 'Use the declared child route.', captain_llm_provider: ROUTE.provider,
      captain_model: ROUTE.model, captain_reasoning_effort: ROUTE.reasoningEffort,
    })
    expect(created.isError).toBe(false)
    const captainId = SessionId((created.value as { captain_session_id: string }).captain_session_id)
    await vi.waitFor(() => expect(adapter.requests.filter(request => request.sessionId === captainId)).toHaveLength(1))
    expect(adapter.requests.find(request => request.sessionId === captainId)).toMatchObject(ROUTE)
    const stored = await readPersistedSession(first.ctx.sessionPersistence, captainId, SIGNAL)
    expect(stored.events.some(event => event.type === 'model/selection')).toBe(true)
    expect(stored.events.slice(stored.inheritedEventCount ?? 0).some(event => event.type === 'model/selection')).toBe(false)
  } finally {
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.each([false, true])('retains a staged Captain route across approval failure and a full store reload (approval override=%s)', async override => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-staged-captain-route-'))
  const before = new RecordingAdapter()
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, true, before), { captainLlmProvider: 'wrong-default', captainModel: 'configured' })
  let second: RestartMounted | undefined
  let firstDisposed = false
  const after = new HeldCaptainAdapter()
  try {
    const root = await first.ctx.agentLoop.create(ROOT, ROUTE, { cwd: join(sandbox, 'workspace') })
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Stage a Team.' }] }))
    await root.whenIdle()
    const staged = await tool(first.ctx, root, 'staged-route', 'agent_swarm_create_managed', { stage: true, name: 'Staged route', description: 'Retain creation and approval selection.',
      captain_llm_provider: NEXT.provider, captain_model: NEXT.model, captain_reasoning_effort: NEXT.reasoningEffort })
    expect(staged.isError).toBe(false)
    const teamId = TeamId((staged.value as { team_id: string }).team_id)
    const plan = await tool(first.ctx, root, 'staged-plan-route', 'agent_swarm_set_plan', { team_id: teamId, expected_revision: 1,
      members: [{ name: 'worker', role: 'Implement', llm_provider: ROUTE.provider, model: ROUTE.model, reasoning_effort: 'max' }],
      tasks: [{ key: 'work', subject: 'Work', description: 'Complete after recovery.', target_member_name: 'worker' }] })
    expect(plan.isError).toBe(false)
    const failStart = vi.spyOn(first.ctx.subagents, 'startContinuable').mockRejectedValueOnce(new Error('injected failure after durable approval'))
    const approved = await tool(first.ctx, root, 'approve-route', 'agent_swarm_approve_plan', { team_id: teamId, expected_revision: 2,
      ...(override ? { llm_provider: ROUTE.provider, model: ROUTE.model, reasoning_effort: ROUTE.reasoningEffort } : {}) })
    failStart.mockRestore()
    expect(approved.isError).toBe(true)
    const expected = override ? ROUTE : NEXT
    const scope = first.ctx.agentSwarm.scopeOf(root)
    const committed = (await first.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)!
    expect(committed).toMatchObject({ phase: 'active', captainRoute: { llmProvider: expected.provider, model: expected.model, reasoningEffort: expected.reasoningEffort } })
    expect(committed.members).toEqual([])
    await dispose(first); firstDisposed = true
    second = await mount(sandbox, 0, undefined, undefined,
      (ctx, fibers) => installHost(ctx, fibers, sandbox, true, after), { captainLlmProvider: 'wrong-default', captainModel: 'changed-after-restart' })
    const reloaded = (await second.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)!
    expect(reloaded.captainRoute).toEqual(committed.captainRoute)
    await second.ctx.agentSwarm.recoverApprovedTeam(scope, reloaded)
    await vi.waitFor(() => expect(after.held?.sessionId).toBe(committed.captainSessionId))
    expect(after.held).toMatchObject(expected)
    const recovered = (await second.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)!
    expect(recovered.members).toHaveLength(1)
    const memberId = recovered.members[0]!.sessionId
    await vi.waitFor(() => expect(after.requests.find(request => request.sessionId === memberId)).toMatchObject(ROUTE))
    after.release()
  } finally {
    after.release()
    if (!firstDisposed) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('retains a direct creation route when the process loses the Team commit receipt before provisioning', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-direct-captain-route-'))
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, true, new RecordingAdapter()))
  let firstDisposed = false
  let second: RestartMounted | undefined
  const after = new HeldCaptainAdapter()
  try {
    const root = await first.ctx.agentLoop.create(ROOT, ROUTE, { cwd: join(sandbox, 'workspace') })
    const domain = first.ctx.agentSwarm.domain
    const create = domain.createTeam.bind(domain)
    const lostReceipt = vi.spyOn(domain, 'createTeam').mockImplementationOnce(async (...args) => {
      await create(...args)
      throw new Error('injected lost receipt after durable Team creation')
    })
    const result = await tool(first.ctx, root, 'direct-crash-route', 'agent_swarm_create_managed', { name: 'Direct route', description: 'Survive the commit-to-spawn gap.',
      captain_llm_provider: NEXT.provider, captain_model: NEXT.model, captain_reasoning_effort: NEXT.reasoningEffort })
    lostReceipt.mockRestore()
    expect(result.isError).toBe(true)
    const scope = first.ctx.agentSwarm.scopeOf(root)
    const team = (await first.ctx.agentSwarm.listTeamAggregates(scope))[0]!
    expect(team).toMatchObject({ phase: 'active', captainRoute: { llmProvider: NEXT.provider, model: NEXT.model, reasoningEffort: NEXT.reasoningEffort } })
    expect(first.ctx.agents.get(SessionId(team.captainSessionId))).toBeUndefined()
    await dispose(first); firstDisposed = true
    second = await mount(sandbox, 0, undefined, undefined,
      (ctx, fibers) => installHost(ctx, fibers, sandbox, true, after), { captainLlmProvider: 'wrong-default', captainModel: 'changed-after-restart' })
    const reloaded = (await second.ctx.agentSwarm.listTeamAggregates(scope))[0]!
    await second.ctx.agentSwarm.recoverApprovedTeam(scope, reloaded)
    await vi.waitFor(() => expect(after.held?.sessionId).toBe(team.captainSessionId))
    expect(after.held).toMatchObject(NEXT)
  } finally {
    after.release()
    if (!firstDisposed) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('does not append a model selection when cancellation arrives during final Captain authorization', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-captain-model-cancel-'))
  const adapter = new HeldCaptainAdapter()
  const first = await mount(sandbox, 0, undefined, undefined,
    (ctx, fibers) => installHost(ctx, fibers, sandbox, true, adapter))
  try {
    const root = await first.ctx.agentLoop.create(ROOT, ROUTE, { cwd: join(sandbox, 'workspace') })
    const created = await tool(first.ctx, root, 'cancel-model-create', 'agent_swarm_create_managed', { name: 'Cancel selection', description: 'Preserve the route on cancellation.' })
    const id = SessionId((created.value as { captain_session_id: string }).captain_session_id)
    await vi.waitFor(() => expect(adapter.held?.sessionId).toBe(id))
    const captain = first.ctx.agents.get(id)!
    const domain = first.ctx.agentSwarm.domain
    const requireMembership = domain.requireMembership.bind(domain)
    let calls = 0, reached = false
    let release!: () => void
    const authorizationGate = new Promise<void>(resolve => { release = resolve })
    const guarded = vi.spyOn(domain, 'requireMembership').mockImplementation(async (...args) => {
      const value = await requireMembership(...args)
      if (++calls === 2) { reached = true; await authorizationGate }
      return value
    })
    const abort = new AbortController()
    const selected = first.ctx.agentSwarm.captainModels.select({ agent: captain, signal: abort.signal }, { llmProvider: NEXT.provider, model: NEXT.model })
    await vi.waitFor(() => expect(reached).toBe(true))
    abort.abort(new Error('cancel final model commit')); release()
    await expect(selected).rejects.toThrow('cancel final model commit')
    guarded.mockRestore()
    expect(captain.session.ownEvents().some(event => event.type === 'model/selection')).toBe(false)
  } finally {
    adapter.release()
    await dispose(first)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.each([
  { controller: false, pending: false },
  { controller: true, pending: false },
  { controller: true, pending: true },
])('restores a real root request after a Captain mailbox wakeup (%j)', async options => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-root-model-226-'))
  let second: RestartMounted | undefined
  try {
    const seeded = await seed(sandbox, options)
    const adapter = new RecordingAdapter()
    second = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
      expect(ctx.agents.roots()).toEqual([])
      await installHost(ctx, fibers, sandbox, options.controller, adapter)
    })
    const root = second.ctx.agents.get(ROOT)!
    const captain = second.ctx.agents.get(SessionId(seeded.captainId))!
    await captain.whenIdle()
    // Real official child-to-parent mail, not a manual root resume or an
    // injected request/header. The persisted first turn is the route source.
    await second.ctx.subagents.sendMessage(captain, ROOT, [{ type: 'text', text: 'Captain report after restart.' }], { signal: SIGNAL })
    await root.whenIdle()
    const expected = options.pending ? NEXT : ROUTE
    expect(root.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
    const requests = adapter.requests.filter(request => request.sessionId === ROOT)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject(expected)
    const system = requests[0]?.messages.filter(message => message.role === 'system').flatMap(message => message.content).map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(system).toContain(`Root model ${expected.model} via ${expected.provider}.`)
    expect(system).not.toContain('{{model}}')
    expect(root.session.requestHeader()?.config).toMatchObject(expected)
    await second.fibers.at(-1)!.dispose()
    // Controller-owned roots survive plugin unload; only the headless handle
    // created by the plugin belongs to its disposal list.
    expect(second.ctx.agents.get(ROOT)).toBe(options.controller ? root : undefined)
  } finally {
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.each(['missing route', 'unsupported selection'] as const)('fails headless recovery explicitly for %s', async fault => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-root-route-missing-226-'))
  let second: RestartMounted | undefined
  try {
    await seed(sandbox, { pending: fault === 'unsupported selection' })
    const failure = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
      await installHost(ctx, fibers, sandbox, false, new RecordingAdapter())
      if (fault === 'missing route') {
        // Fault the public read handle: recovery must reject a prefix
        // without canonical route evidence before publishing a root.
        const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
        vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args)
          if (args[0] === ROOT && args[1] === 'read') {
            const read = handle.read.bind(handle)
            vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
              const stored = await read(...readArgs)
              return { ...stored, events: stored.events.filter(event => event.type !== 'request/header') }
            })
          }
          return handle
        })
      }
    })
      .then(mounted => { second = mounted; return undefined }, error => error)
    expect(failure).toMatchObject({ code: 'TEAM_PARENT_REATTACH_FAILED' })
    expect(failure.message).toContain(fault === 'missing route' ? 'persisted model route' : 'modelSelection projection')
  } finally {
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('leaves an already live shared root and its model binding with its existing owner', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-root-live-owner-226-'))
  let second: RestartMounted | undefined
  try {
    await seed(sandbox)
    second = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
      await installHost(ctx, fibers, sandbox, true, new RecordingAdapter())
      const found = await ctx.sessionController.resolveAgent(ROOT)
      expect('agent' in found).toBe(true)
      vi.spyOn(ctx.sessionController, 'resolveAgent')
    })
    const root = second.ctx.agents.get(ROOT)!
    expect(second.ctx.sessionController.resolveAgent).not.toHaveBeenCalled()
    await second.fibers.at(-1)!.dispose()
    expect(second.ctx.agents.get(ROOT)).toBe(root)
  } finally {
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function gate() {
  let open!: () => void
  const waiting = new Promise<void>(resolve => { open = resolve })
  return { waiting, open }
}

it('cancels plugin recovery while a shared Controller resolution finishes under its own owner', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-root-cancel-owner-226-'))
  let second: RestartMounted | undefined
  let recovery: ManagedActivationRecovery | undefined
  const entered = gate(), release = gate(), resolved = gate()
  try {
    const seeded = await seed(sandbox)
    let restoreListing!: () => void
    second = await mount(sandbox, 0, undefined, undefined, async (ctx, fibers) => {
      await installHost(ctx, fibers, sandbox, true, new RecordingAdapter())
      // Prevent the plugin's automatic pass only for this lifecycle test; the
      // same recovery collaborator below owns the controlled cancellation.
      const listing = vi.spyOn(ctx.sessionPersistence, 'list').mockResolvedValue([])
      restoreListing = () => listing.mockRestore()
    })
    restoreListing()
    const ctx = second.ctx
    expect(ctx.agents.roots()).toEqual([])
    const original = ctx.sessionController.resolveAgent.bind(ctx.sessionController)
    vi.spyOn(ctx.sessionController, 'resolveAgent').mockImplementation(async id => {
      entered.open()
      await release.waiting
      try { return await original(id) } finally { resolved.open() }
    })
    const trackChild = vi.fn()
    recovery = new ManagedActivationRecovery(ctx, {
      teams: scope => ctx.agentSwarm.listTeamAggregates(scope), trackChild,
    })
    const started = recovery.run()
    await entered.waiting
    recovery.close()
    await expect(started).rejects.toThrow('managed activation recovery disposed')
    expect(trackChild).not.toHaveBeenCalled()
    release.open()
    await resolved.waiting
    const root = ctx.agents.get(ROOT)!
    expect(root).toBeDefined()
    expect(ctx.agents.get(SessionId(seeded.captainId))).toBeUndefined()
    await recovery.disposeRoots()
    await second.fibers.at(-1)!.dispose()
    expect(ctx.agents.get(ROOT)).toBe(root)
  } finally {
    release.open()
    recovery?.close()
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
