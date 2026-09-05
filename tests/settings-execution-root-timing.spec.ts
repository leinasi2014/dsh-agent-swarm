import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import { GatedAdapter } from './helpers/gated-composition.js'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

const sandboxes: string[] = []
afterEach(async () => { for (const s of sandboxes.splice(0)) await rm(s, { recursive: true, force: true }) })
async function sd(p: string): Promise<string> { const s = await mkdtemp(join(tmpdir(), 'dsh-191-'+p+'-')); sandboxes.push(s); return s }

class DeferredSettings extends SettingsProvider {
  constructor(ctx: Context, private readonly options: { store: { doc: Record<string, unknown> }; gate: Promise<void> }) { super(ctx) }
  get writable(): boolean { return true }
  protected async load(): Promise<Record<string, unknown>> { await this.options.gate; return structuredClone(this.options.store.doc) }
  protected async persist(_ns: SettingsNamespace, _s: Record<string, unknown>): Promise<void> {}
}

async function readPatchInject(): Promise<boolean> { const t = await (await import('node:fs/promises')).readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'); return /id: agent-swarm-runtime[\s\S]*?inject:\s*\[settings\]/.test(t) }

async function boot(injectSettings: boolean, withSettings: boolean) {
  const sandbox = await sd('boot')
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(Loader))
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['agent-swarm'] = AgentSwarm
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  let release: (() => void) | undefined
  let settingsFiber: Fiber | undefined
  if (withSettings) {
    let g!: () => void
    const gate = new Promise<void>(r => { g = r })
    release = g
    const store = { doc: { 'agent-swarm': { enabled: true, executionRoots: true, executionRootProvider: 'git-worktree', executionRootsBase: join(sandbox, 'roots') } } }
    settingsFiber = ctx.plugin(DeferredSettings, { store, gate })
  }
  const entry = await ctx.loader.create({ name: 'cordis:agent-swarm', inject: (injectSettings ? ['settings'] : undefined) as never, config: { enabled: true, memberProvider: 'spawn', memberMaxDepth: 1, schedulerProvider: 'priority-ready', reviewProvider: 'manual' }, disabled: false })
  return { ctx, fibers, release, entry, settingsFiber, sandbox }
}

describe('issue #191 real Loader enable timing', () => {
  it('patch-with-inject GREEN: apply deferred until Settings.load resolves -> effective executionRoots true', async () => {
    const patchInject = await readPatchInject()
    const b = await boot(patchInject, true)
    const applied = b.ctx.loader.await()
    b.release!()
    await applied
    await vi.waitFor(() => expect(b.ctx.agentSwarm).toBeDefined(), { timeout: 5000 })
    await vi.waitFor(() => expect(b.ctx.tools.get('agent_swarm_create')).toBeDefined())
    expect((b.ctx.agentSwarm as { config: { executionRootsEnabled: boolean } }).config.executionRootsEnabled).toBe(true)
    try {
      const adapter = new GatedAdapter(); b.ctx.llm.registerAdapter(['mock'], adapter)
      const lead = b.ctx.agentLoop.create(SessionId('captain-'+Date.now()), { provider: 'mock', model: 'mock' }, { cwd: join(b.sandbox, 'workspace') })
      const exec = async (name: string, args: unknown) => await b.ctx.tools.execute({ agent: lead, signal: new AbortController().signal, callId: CallId('c-'+Math.random().toString(36).slice(2,8)), name, arguments: args })
      const te = await exec('agent_swarm_create', { name: 'Claim team', description: 'd' }) as { isError: boolean, value?: { team_id: string } }
      expect(te, JSON.stringify(te)).toMatchObject({ isError: false }); const teamId = AgentSwarm.TeamId(te.value!.team_id)
      const ad = await exec('agent_swarm_add_member', { name: 'claimer', role: 'self-claim' }) as { isError: boolean, value?: { session_id: string } }
      expect(ad, JSON.stringify(ad)).toMatchObject({ isError: false }); const memberId = ad.value!.session_id
      const member = await vi.waitFor(() => { const live = b.ctx.agents.get(SessionId(memberId)); expect(live).toBeDefined(); return live! }, { timeout: 10000 })
      const tk = await exec('agent_swarm_create_task', { subject: 'self-claim', description: 'd' }) as { isError: boolean, value?: { task_id: string } }
      expect(tk.isError).toBe(false); const taskId = tk.value!.task_id
      const pending = (await b.ctx.agentSwarm.domain.snapshot(b.ctx.agentSwarm.scopeOf(lead), teamId, lead.id)).team.tasks.find((x: { id: string }) => x.id === taskId)!
      expect(pending.status).toBe('pending')
      const claim = await b.ctx.agentSwarm.claimTask({ agent: member, signal: new AbortController().signal }, AgentSwarm.TaskId(taskId), pending.revision)
      expect(claim.executionRoot?.isolation).toBe('temp-directory')
      const { existsSync } = await import('node:fs')
      expect(existsSync(claim.executionRoot!.path)).toBe(true)
      expect(b.ctx.agentSwarm.executionRoots.roots.leaseOf(b.ctx.agentSwarm.scopeOf(lead), teamId, AgentSwarm.TaskId(taskId), claim.attempt.id)?.path).toBe(claim.executionRoot!.path)
    } finally {
      await b.settingsFiber?.dispose?.()
      for (const f of b.fibers.toReversed()) await f.dispose().catch(() => {})
      await b.ctx.fiber.dispose().catch(() => {})
    }
  })
  it('patch-no-inject RED: apply runs before Settings.load resolves -> runtime built default false', async () => {
    const b = await boot(false, true)
    const applied = b.ctx.loader.await()
    // settings is held; apply (no inject) runs already with default-false config.
    b.release!()
    await applied
    expect((b.ctx.agentSwarm as { config: { executionRootsEnabled: boolean } }).config.executionRootsEnabled).toBe(false)
    for (const f of b.fibers.toReversed()) await f.dispose()
    await b.ctx.fiber.dispose()
  })
  it('headless no Settings (no inject): applies immediately, no hang, default executionRoots false', async () => {
    const b = await boot(false, false)
    await b.ctx.loader.await()  // must not hang (no settings service, no inject required)
    expect(b.ctx.agentSwarm).toBeDefined()
    expect((b.ctx.agentSwarm as { config: { executionRootsEnabled: boolean } }).config.executionRootsEnabled).toBe(false)
    for (const f of b.fibers.toReversed()) await f.dispose()
    await b.ctx.fiber.dispose()
  })
})
