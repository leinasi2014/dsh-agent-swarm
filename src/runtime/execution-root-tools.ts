/** Attempt-local adapters over the host's registered file and shell consumers. */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'

const FILE_TOOLS = ['read', 'read_image', 'write', 'edit'] as const
const ROOT_TOOLS = [...FILE_TOOLS, 'pwsh', 'bash'] as const

/** Canonical Agent identity stays intact; only the consumer resolves its IO arguments. */
export class ExecutionRootTools {
  private readonly roots = new Map<string, string>()
  private readonly members = new Set<string>()
  private readonly attached = new WeakMap<Agent, ReadonlySet<string>>()

  constructor(private readonly ctx: Context) {
    ctx.tools.guard(exec => {
      if (exec.agent === undefined || !this.members.has(String(exec.agent.id))) return undefined
      if (!ROOT_TOOLS.some(name => name === exec.name)) return undefined
      if (!this.roots.has(String(exec.agent.id)) || !this.attached.get(exec.agent)?.has(exec.name)) {
        return 'This member has no active execution-root tool scope; claim or resume its attempt first.'
      }
      return undefined
    })
    ctx.subagents.registerContinuableSetup(childCtx => {
      const agent = childCtx.agent
      if (agent !== undefined && this.members.has(String(agent.id))) this.attach(agent)
      return () => {}
    })
    ctx.effect(() => () => { this.roots.clear(); this.members.clear() })
  }

  bind(sessionId: string, path: string): () => void {
    this.members.add(sessionId)
    this.roots.set(sessionId, path)
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent !== undefined) this.attach(agent)
    return () => { if (this.roots.get(sessionId) === path) this.roots.delete(sessionId) }
  }

  private attach(agent: Agent): void {
    if (this.attached.has(agent)) return
    const names = new Set<string>()
    for (const name of ROOT_TOOLS) {
      const original = this.ctx.tools.get(name, agent)
      if (original !== undefined) {
        agent.ctx.tools.register(this.adapter(original))
        names.add(name)
      }
    }
    this.attached.set(agent, names)
    agent.ctx.effect(() => () => { this.attached.delete(agent) })
  }

  private adapter(original: ToolDefinition): ToolDefinition {
    return {
      ...original,
      execute: async (args, exec) => {
        const root = exec.agent === undefined ? undefined : this.roots.get(String(exec.agent.id))
        if (root === undefined) return await original.execute(args, exec)
        const input = args as Record<string, unknown>
        if (FILE_TOOLS.some(name => name === original.name)) {
          return await original.execute({ ...input, file_path: fencedPath(root, String(input.file_path)) }, exec)
        }
        if (input.run_in_background === true) throw new Error('Execution-root shell commands must settle before submitting the attempt')
        const workdir = fencedPath(root, typeof input.workdir === 'string' ? input.workdir : '.')
        // Persistent shells keep a process across attempts and ignore workdir.
        // Reset their command cwd as well; the official consumer still owns
        // process lifetime, cancellation, output, and the real Agent identity.
        const enter = original.name === 'pwsh'
          ? `Set-Location -LiteralPath '${workdir.replaceAll("'", "''")}' -ErrorAction Stop\n`
          : `cd -- '${workdir.replaceAll("'", "'\\''")}' || exit\n`
        return await original.execute({ ...input, workdir, command: enter + String(input.command) }, exec)
      },
    }
  }
}

/** Reject explicit escapes and existing symlink/junction escapes before IO. */
function fencedPath(root: string, input: string): string {
  const target = resolve(root, input)
  const offset = relative(root, target)
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('Path is outside this attempt execution root')
  }
  let ancestor = target
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
  const physicalOffset = relative(realpathSync(root), realpathSync(ancestor))
  if (physicalOffset === '..' || physicalOffset.startsWith(`..${sep}`) || isAbsolute(physicalOffset)) {
    throw new Error('Path resolves outside this attempt execution root')
  }
  return target
}
