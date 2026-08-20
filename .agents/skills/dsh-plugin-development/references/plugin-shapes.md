# Plugin shapes

Before choosing a shape, classify the capability from current official source and installed exports. If DSH already owns the Service Definition, this project implements only a Provider, Consumer, policy overlay or Bundle row. A new Service requires recorded evidence that no official stable seam owns the contract and must not shadow an experimental service key.

## Function plugin

Use for stateless contributions and Consumers.

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'example'
export const inject = ['tools'] as const
export interface Config { enabled?: boolean }
export const Config: z<Config> = z.object({ enabled: z.boolean().default(true) })
export function apply(ctx: Context, config: Config): void {}
```

No default export.

## Service plugin

Use for a stable capability.

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { example: ExampleService }
}

export default class ExampleService extends Service {
  static inject = ['sessions']
  constructor(ctx: Context) { super(ctx, 'example') }
}
```

Default export the Service class. Public methods document authority, timing, failure and ownership.

## Provider plugin

A Provider registers on a Service Definition and returns a disposer. Provider config contains transport/medium choices. It does not register model tools unless the package intentionally combines roles.

## Tool Consumer

Inject the Service Definition and register tools. Convert model JSON into typed service calls and stable model-facing results. Do not expose private Provider handles.

## Client face

A dual-face package requires a real `./client` export plus `dsh.client` metadata. Host and Client have separate compiler/runtime assumptions. Browser effects must dispose.
