import { Service, type Context } from '@deepseek-ai/cordis'

export interface ExampleProvider {
  readonly name: string
  run(input: string, signal: AbortSignal): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context { examples: ExampleService }
}

export default class ExampleService extends Service {
  readonly #providers = new Map<string, ExampleProvider>()

  constructor(ctx: Context) { super(ctx, 'examples') }

  register(provider: ExampleProvider): () => void {
    if (this.#providers.has(provider.name)) throw new Error(`duplicate provider: ${provider.name}`)
    this.#providers.set(provider.name, provider)
    return () => { if (this.#providers.get(provider.name) === provider) this.#providers.delete(provider.name) }
  }

  provider(name: string): ExampleProvider {
    const provider = this.#providers.get(name)
    if (provider === undefined) throw new Error(`unknown provider: ${name}`)
    return provider
  }
}
