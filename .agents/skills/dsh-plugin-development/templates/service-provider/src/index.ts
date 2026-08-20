import type { Context } from '@deepseek-ai/cordis'
import type ExampleService from 'dsh-example-service'
import type { ExampleProvider } from 'dsh-example-service'

declare module '@deepseek-ai/cordis' {
  interface Context { examples: ExampleService }
}

export const name = 'example-provider-local'
export const inject = ['examples'] as const

export function apply(ctx: Context): void {
  const provider: ExampleProvider = {
    name: 'local',
    async run(input, signal) {
      if (signal.aborted) throw signal.reason
      return input
    },
  }
  ctx.effect(() => ctx.examples.register(provider), 'example: local provider')
}
