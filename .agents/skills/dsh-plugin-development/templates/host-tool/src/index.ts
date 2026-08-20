import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'example-tool'
export const inject = ['tools'] as const
export interface Config { enabled?: boolean }
export const Config: z<Config> = z.object({ enabled: z.boolean().default(true) })

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'example_echo',
    description: 'Return the supplied text unchanged. Read-only diagnostic example.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return args.text },
  })), 'example-tool: echo')
}
