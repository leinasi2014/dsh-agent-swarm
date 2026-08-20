# Services, effects and events

## Required and optional services

Required:

```ts
export const inject = ['tools', 'sessions'] as const
```

Optional:

```ts
const service = ctx.get('optionalService')
```

For a contribution that should exist only while an optional service exists, use lazy injection with its own child scope rather than repeated polling.

## Effect pattern

```ts
ctx.effect(() => {
  const dispose = registry.register(value)
  return () => dispose()
}, 'package: contribution')
```

For async resource setup, use the official Service lifecycle or a controller whose disposer waits for setup/teardown. Do not return a Promise where the framework expects a synchronous disposer unless the API documents it.

## Transaction pattern

```text
validate
reserve local identity
perform external setup
persist authoritative state
publish result/event
```

If persistence fails after external setup, retire/dispose the exact resource. If a concurrent generation changed the record, rollback must not overwrite it.

## Event rules

- declaration-merge typed event maps;
- document dispatch mode and payload;
- durable event payload validates at append/replay boundary;
- listeners after commit cannot veto the completed transaction;
- waterfall listeners delegate with `next()`;
- contain listener exceptions where the commit already passed.
