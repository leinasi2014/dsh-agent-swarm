import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as AgentSwarm from '../../src/index.js'

export const RESTART_SIGNAL = new AbortController().signal

export interface RestartMounted {
  readonly ctx: Context
  readonly fibers: Fiber[]
}

/**
 * A restart proof owns every official fiber in each Context: a later Context
 * opens only the same durable SQLite and Storage roots, never a live handle.
 */
export async function mountRestartComposition(sandbox: string, strandedAfterMs: number): Promise<RestartMounted> {
  const ctx = new Context()
  const fibers: Fiber[] = []
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
  fibers.push(await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs }))
  return { ctx, fibers }
}

export async function disposeRestartComposition(mounted: RestartMounted): Promise<void> {
  for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
}

export async function restartTool(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: RESTART_SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

export async function restartSnapshot(ctx: Context, lead: Agent, teamId: string) {
  return await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
}
