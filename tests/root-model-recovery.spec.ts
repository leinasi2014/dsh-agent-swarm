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
import { LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { ManagedActivationRecovery } from '../src/runtime/managed-activation-recovery.js'
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
    ] } }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Mailbox received.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
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
