import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type ExampleService from 'dsh-example-service'

declare module '@deepseek-ai/cordis' {
  interface Context { examples: ExampleService }
}

export const name = 'tool-example'
export const inject = ['tools', 'examples'] as const

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'example_run',
    description: 'Run the selected example provider.',
    parameters: {
      provider: { type: 'string', required: true },
      input: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return ctx.examples.provider(args.provider).run(args.input, exec.signal)
    },
  })), 'tool-example: run')
}
