# Tools, configuration and Bundles

## Tool checklist

- `defineTool()` from `@deepseek-ai/dsh-tools`.
- Parameters use supported value-schema DSL.
- Output has canonical schema and deterministic render.
- Authority derives from `exec.agent`.
- Cancellation uses `exec.signal`.
- Write operations use revision/idempotency/fencing.
- Full output limits include metadata/framing.
- Errors tell the model the next valid action.

## Configuration

Use `@deepseek-ai/schemastery`, not bare `schemastery` and not zod for plugin Config. Defaults belong in schema. Empty strings and invalid provider names fail explicitly where they become resolvable.

## Package manifest

Host-only Bundle needs:

```json
{
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Dual-face adds `./client` and `dsh.client`. Ensure `files` includes every published entry.

## Patch

```yaml
- insert:
    - id: example
      name: dsh-example
      config: {}
```

`config` replacement is whole-row. Verify actual composition with `--dump-config`.
