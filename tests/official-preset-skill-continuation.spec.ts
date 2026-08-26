/**
 * Real official composition proof: a Team member joins the Captain's live
 * preset generation and ordinary filesystem skills on both its fresh turn and
 * an explicit cold wakeup.  The plugin stores neither a preset nor a skill
 * selection: official session/subagent/skill seams remain authoritative.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { resolveSessionPreset, standingMountFor } from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const CAPTAIN = SessionId('preset-skill-captain')
const GENERATION_TWO_SESSION = SessionId('preset-generation-two')
const PRESET_ID = 'captain-proof'
const GENERATION_ONE_MARKER = 'CAPTAIN_PRESET_MARKER: generation-1'
const GENERATION_TWO_MARKER = 'CAPTAIN_PRESET_MARKER: generation-2 (new sessions only)'
const SKILL_NAME = 'proof-skill'
const SKILL_DESCRIPTION = 'A canonical filesystem skill for the composition proof.'
const SKILL_BODY = 'CANONICAL SKILL BODY: use the official skill tool.'
const SIGNAL = new AbortController().signal

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Captures requests by exact session; only explicitly named Team children are held. */
class ProofAdapter extends LlmAdapter {
  private readonly requestsBySession = new Map<string, GenerateOptions[]>()
  private readonly heldSessions = new Set<string>()
  private releaseMembers!: () => void
  private readonly memberGate = new Promise<void>(resolve => { this.releaseMembers = resolve })

  requestsFor(sessionId: string): readonly GenerateOptions[] {
    return this.requestsBySession.get(sessionId) ?? []
  }

  hold(sessionId: string): void { this.heldSessions.add(sessionId) }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  release(): void { this.releaseMembers() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new Error('proof adapter requires every observed request to carry its SessionId')
    const requests = this.requestsBySession.get(sessionId) ?? []
    requests.push(options)
    this.requestsBySession.set(sessionId, requests)
    if (this.heldSessions.has(sessionId)) await this.memberGate
    for (const chunk of response('Official composition checkpoint.')) yield chunk
  }
}

interface Mounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
}

function composition(plugin: string, root: string, marker: string, generation: string): string {
  return [
    '- id: captain-proof-marker',
    `  name: ${JSON.stringify(pathToFileURL(plugin).href)}`,
    '  config:',
    `    marker: ${JSON.stringify(marker)}`,
    `    generation: ${JSON.stringify(generation)}`,
    '- id: skill-filesystem',
    '  name: "@deepseek-ai/dsh-skill-filesystem"',
    '  config:',
    `    dshHome: ${JSON.stringify(join(root, '.dsh'))}`,
    `    agentsHome: ${JSON.stringify(join(root, '.agents'))}`,
    '    watch: false',
    '- id: tool-skill',
    '  name: "@deepseek-ai/dsh-tool-skill"',
    '',
  ].join('\n')
}

async function writeFixture(root: string): Promise<{ workspace: string; compositionPath: string }> {
  const presetRoot = join(root, 'presets')
  const presetDir = join(presetRoot, PRESET_ID)
  const plugin = join(root, 'captain-proof-plugin.mjs')
  const workspace = join(root, 'workspace')
  await mkdir(presetDir, { recursive: true })
  await mkdir(join(workspace, '.git'), { recursive: true })
  await mkdir(join(workspace, '.dsh', 'skills', SKILL_NAME), { recursive: true })
  await writeFile(plugin, [
    "export const name = 'captain-proof-plugin'",
    "export const inject = ['systemPrompt']",
    'export function apply(ctx, config) {',
    "  ctx.effect(() => ctx.systemPrompt.section({ name: `captain-proof-marker-${config.generation}`, order: 10, text: config.marker }))",
    '}',
    '',
  ].join('\n'))
  const compositionPath = join(presetDir, 'agent.cordis.yml')
  await writeFile(compositionPath, composition(plugin, root, GENERATION_ONE_MARKER, 'one'))
  await writeFile(join(workspace, '.dsh', 'skills', SKILL_NAME, 'SKILL.md'), [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    '---',
    '',
    SKILL_BODY,
    '',
  ].join('\n'))
  return { workspace, compositionPath }
}

async function mount(root: string): Promise<Mounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  ctx.baseUrl = pathToFileURL(root).href + '/'
  fibers.push(await ctx.plugin(Loader))
  ctx.loader.builtins.include = Include
  // Keep every official service fiber owned by this exact Context: Context A
  // must fully release SQLite, storage and composed registrations before B.
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions', 'sessions.db') }))
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(root, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  // The host owns only the registry. Filesystem discovery and the model-facing
  // tool are rows of the Captain's preset composition, never root services.
  fibers.push(await ctx.plugin(SkillRegistry))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentPresets, {
    default: PRESET_ID,
    roots: [{ path: join(root, 'presets'), trust: 'user' }],
    includeUserRoot: false,
  }))
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs: 0 }))
  return { ctx, fibers }
}

async function dispose(mounted: Mounted): Promise<void> {
  for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
}

async function call(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

function expectedSkillSchema() {
  return {
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name from the available skills list.' },
      },
      required: ['name'],
    },
  }
}

function expectedCatalogText(): string {
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    `- \`${SKILL_NAME}\`: ${SKILL_DESCRIPTION}`,
    '</available_skills>',
    '',
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>',
  ].join('\n')
}

async function assertGeneratedComposition(ctx: Context, member: Agent, request: GenerateOptions, marker: string): Promise<void> {
  expect(request.sessionId).toBe(member.id)
  const directAssembly = await ctx.systemPrompt.assemble(assembleContextFor(member))
  expect(request.system).toBe(renderPrompt(directAssembly))
  expect(request.system).toContain(marker)
  expect(request.system).not.toContain(marker === GENERATION_ONE_MARKER ? GENERATION_TWO_MARKER : GENERATION_ONE_MARKER)
  expect(request.tools?.filter(tool => tool.name === 'skill')).toEqual([expectedSkillSchema()])
  // AgentSwarm's own Team tools are host registrations. The official skill
  // tool exists only in the composed generation, so the root cannot resolve it.
  expect(ctx.tools.get('skill')).toBeUndefined()
  expect(ctx.tools.schemas().some(tool => tool.name === 'skill')).toBe(false)
  const catalog = member.session.events.find(event => event.type === 'user/message'
    && (event.data as { source?: { kind?: string } }).source?.kind === 'skill-catalog')
  const catalogData = catalog === undefined
    ? undefined
    : (catalog.data as unknown as { source: unknown; content: unknown })
  expect(catalog).toBeDefined()
  expect(catalogData?.source).toEqual({
    kind: 'skill-catalog', form: 'catalog', entries: [{ name: SKILL_NAME, description: SKILL_DESCRIPTION }],
  })
  expect(catalogData?.content).toEqual([{ type: 'text', text: expectedCatalogText() }])
}

async function assertOfficialSkill(ctx: Context, member: Agent, callId: string): Promise<void> {
  const loaded = await call(ctx, member, callId, 'skill', { name: SKILL_NAME })
  expect(loaded.isError).toBe(false)
  const expected = {
    name: SKILL_NAME,
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: expect.any(String) },
    content: SKILL_BODY,
  }
  expect(loaded.value).toEqual(expected)
  const first = loaded.content[0]
  expect(first).toEqual({
    type: 'text',
    text: renderSkillContent(loaded.value as {
      name: string; provider: string; resourceBase: { kind: 'directory'; path: string }; content: string
    }),
  })
}

describe('official Captain preset and skill inheritance', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('joins the Captain preset and official skill catalog on fresh member start and one explicit cold wakeup', { timeout: 30_000 }, async () => {
    // The composition resolves these published modules by package name. Keep
    // their official plugin identities explicit, rather than hiding runtime
    // test dependencies behind YAML strings.
    expect(SkillFileSystem.name).toBe('skill-filesystem')
    expect(ToolSkill.name).toBe('tool-skill')
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-skill-proof-'))
    roots.push(root)
    const { workspace, compositionPath } = await writeFixture(root)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      first = await mount(root)
      const initial = new ProofAdapter()
      first.ctx.llm.registerAdapter(['mock'], initial)
      const captainA = await first.ctx.agents.create({
        sessionId: CAPTAIN,
        meta: { cwd: workspace, agentPreset: PRESET_ID },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => { await first!.ctx.agentPresets.mount(agentCtx, PRESET_ID) },
      })
      const generationOne = standingMountFor(captainA.agent.ctx)
      if (generationOne === undefined) throw new Error('Captain did not join the first official preset generation')
      await writeFile(compositionPath, composition(join(root, 'captain-proof-plugin.mjs'), root, GENERATION_TWO_MARKER, 'two'))
      const later = await first.ctx.agents.create({
        sessionId: GENERATION_TWO_SESSION,
        meta: { cwd: workspace, agentPreset: PRESET_ID },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => { await first!.ctx.agentPresets.mount(agentCtx, PRESET_ID) },
      })
      const generationTwo = standingMountFor(later.agent.ctx)
      if (generationTwo === undefined) throw new Error('later session did not join a preset generation')
      expect(generationTwo).not.toBe(generationOne)
      const laterPrompt = await first.ctx.systemPrompt.assemble(assembleContextFor(later.agent))
      expect(laterPrompt.sections.map(section => section.text).join('\n')).toContain(GENERATION_TWO_MARKER)
      later.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Prove the second preset generation.' }],
        source: { kind: 'user' },
      }))
      await vi.waitFor(() => expect(initial.requestsFor(GENERATION_TWO_SESSION)).toHaveLength(1), { timeout: 15_000 })
      await later.agent.whenIdle()
      await assertGeneratedComposition(first.ctx, later.agent, initial.requestsFor(GENERATION_TWO_SESSION)[0]!, GENERATION_TWO_MARKER)
      await later.dispose()
      expect(standingMountFor(captainA.agent.ctx)).toBe(generationOne)
      const captainPrompt = await first.ctx.systemPrompt.assemble(assembleContextFor(captainA.agent))
      expect(captainPrompt.sections.map(section => section.text).join('\\n')).toContain(GENERATION_ONE_MARKER)
      const created = await call(first.ctx, captainA.agent, 'preset-team-create', 'agent_swarm_create', {
        name: 'Preset proof', description: 'Use only official preset and skill composition.',
      })
      expect(created.isError).toBe(false)
      let freshMember: Agent | undefined
      const stopCreatedObservation = first.ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== CAPTAIN && agent.id !== GENERATION_TWO_SESSION) {
          freshMember = agent
          initial.hold(agent.id)
        }
      })
      const adding = call(first.ctx, captainA.agent, 'preset-member-add', 'agent_swarm_add_member', {
        name: 'member', role: 'Prove inherited composition.',
      })
      try {
        await vi.waitFor(() => expect(freshMember).toBeDefined(), { timeout: 15_000 })
        const exactFreshMember = freshMember
        if (exactFreshMember === undefined) throw new Error('fresh Team member was not published at its held first request')
        await vi.waitFor(() => expect(initial.requestsFor(exactFreshMember.id)).toHaveLength(1), { timeout: 15_000 })
        expect(first.ctx.agentPresets.composedPreset(captainA.agent.ctx)).toBe(PRESET_ID)
        expect(first.ctx.agentPresets.composedPreset(exactFreshMember.ctx)).toBe(PRESET_ID)
        expect(standingMountFor(exactFreshMember.ctx)).toBe(generationOne)
        await assertGeneratedComposition(first.ctx, exactFreshMember, initial.requestsFor(exactFreshMember.id)[0]!, GENERATION_ONE_MARKER)
        await assertOfficialSkill(first.ctx, exactFreshMember, 'preset-skill-fresh')
      } finally {
        initial.release()
        stopCreatedObservation()
      }
      const added = await adding
      expect(added.isError).toBe(false)
      const memberId = SessionId((added.value as { session_id: string }).session_id)
      expect((await first.ctx.sessionPersistence.inspect(memberId, SIGNAL)).meta.agentPreset).toBe(PRESET_ID)

      first.ctx.subagents.interrupt(memberId, { kind: 'ancestor', agent: captainA.agent })
      await first.ctx.subagents.drainContinuableChildren(captainA.agent, [memberId])
      await vi.waitFor(() => expect(first!.ctx.agents.get(memberId)).toBeUndefined(), { timeout: 15_000 })
      await captainA.dispose()
      await dispose(first)
      first = undefined

      second = await mount(root)
      const recovered = new ProofAdapter()
      second.ctx.llm.registerAdapter(['mock'], recovered)
      const durableCaptain = await second.ctx.sessionPersistence.inspect(CAPTAIN, SIGNAL)
      // SQLite inspection separates creation `meta` from the Session header;
      // reconstruct only the official preset-bearing view that resolver owns.
      const durablePreset = resolveSessionPreset({
        header: durableCaptain.meta,
        events: durableCaptain.events,
      })
      expect(durablePreset).toBe(PRESET_ID)
      const captainB = await second.ctx.agents.resume({
        resumeSessionId: CAPTAIN,
        setup: async agentCtx => { await second!.ctx.agentPresets.mount(agentCtx, durablePreset) },
      })
      try {
        // No recovery pass or direct member resume is used: the member remains
        // cold until the Captain's public Team wakeup command is accepted.
        expect(second.ctx.agents.get(memberId)).toBeUndefined()
        expect(recovered.requestsFor(memberId)).toEqual([])
        recovered.hold(memberId)
        const wakeup = await call(second.ctx, captainB.agent, 'preset-member-wakeup', 'agent_swarm_send_message', {
          target: 'member', content: 'Wake the exact cold member once.', delivery: 'wakeup',
        })
        expect(wakeup.isError).toBe(false)
        await vi.waitFor(() => expect(recovered.requestsFor(memberId)).toHaveLength(1), { timeout: 15_000 })
        const resumedMember = second.ctx.agents.get(memberId)
        if (resumedMember === undefined) throw new Error('Captain wakeup did not cold-resume the exact Team member')
        await assertGeneratedComposition(second.ctx, resumedMember, recovered.requestsFor(memberId)[0]!, GENERATION_TWO_MARKER)
        expect(second.ctx.agentPresets.composedPreset(resumedMember.ctx)).toBe(PRESET_ID)
        expect(standingMountFor(resumedMember.ctx)).toBe(standingMountFor(captainB.agent.ctx))
        expect((await second.ctx.sessionPersistence.inspect(memberId, SIGNAL)).meta.agentPreset).toBe(PRESET_ID)
        await assertOfficialSkill(second.ctx, resumedMember, 'preset-skill-cold-resume')
        expect(recovered.requestsFor(memberId)).toHaveLength(1)
      } finally {
        recovered.release()
        await captainB.dispose()
      }
    } finally {
      if (first !== undefined) await dispose(first)
      if (second !== undefined) await dispose(second)
    }
  })
})
