/** Official standing preset with real file and shell Consumers. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'

export async function installRestartPreset(ctx: Context, fibers: Fiber[], sandbox: string): Promise<void> {
  const preset = join(sandbox, 'presets', 'code')
  await mkdir(preset, { recursive: true })
  await mkdir(join(sandbox, 'workspace'), { recursive: true })
  await writeFile(join(preset, 'agent.cordis.yml'), '- id: files\n  name: "@deepseek-ai/dsh-tool-fs"\n- id: shell\n  name: "@deepseek-ai/dsh-tool-pwsh"\n  config:\n    enableRunInBackground: false\n')
  ctx.baseUrl = pathToFileURL(sandbox).href + '/'
  fibers.push(await ctx.plugin(Loader))
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['@deepseek-ai/dsh-tool-fs'] = ToolFs
  ctx.loader.builtins['@deepseek-ai/dsh-tool-pwsh'] = ToolPwsh
  fibers.push(await ctx.plugin(LocalFileSystem, { cwd: join(sandbox, 'workspace') }))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  fibers.push(await ctx.plugin(ShellEnv))
  fibers.push(await ctx.plugin(PwshLocalExecutor))
  fibers.push(await ctx.plugin(AgentPresets, { default: 'code', roots: [{ path: join(sandbox, 'presets'), trust: 'user' }], includeUserRoot: false }))
}
