# 01. DSH plugin engineering principles

## 1. Everything is a plugin

DSH runs as an ordered Cordis plugin tree. LLM adapters, Session persistence, tools, subagents, workflow, Web host and Agent Loop are all replaceable composition rows. Therefore a new feature begins by locating the correct extension point, not by editing a central loop.

Practical rule:

```text
Need a stable capability?      Define a Service.
Need alternative implementations? Register Providers.
Need model access?             Add a Tool Consumer.
Need human access?             Add a Command/UI Consumer.
Need loose observation?        Listen to typed events.
Need durable facts?            Append supported Session events or use a storage domain.
Need a recommended install?    Publish a Bundle patch.
```

## 2. Capability seam is a complete design unit

A capability seam has three roles:

| Role | Responsibility | Must not own |
|---|---|---|
| Service Definition | Types, stable methods, errors, events, identity and lifecycle contract | Provider libraries, UI text, one consumer’s workflow |
| Provider | IO, medium, transport, implementation-specific resource lifecycle | Model tool schema, unrelated policy |
| Consumer | Tool, command, UI, workflow adapter or product behavior | Hidden provider-specific assumptions |

Only writing a tool is not a complete seam when alternative implementations are expected. Conversely, do not split packages merely for aesthetics; split when roles evolve independently or need replacement.

## 3. Dependency injection is capability declaration

Required services must be declared with `inject` or `static inject`. Cordis delays activation until they are ready and disposes the dependent plugin if a required service disappears. Optional services are read through `ctx.get(name)` or mounted through a lazy `ctx.inject()` contribution.

Do not:

- poll until a sibling plugin appears;
- access an undeclared `ctx.service` property;
- swallow a missing required service and silently degrade;
- import a concrete Provider when a Service Definition exists.

## 4. Registrations are effects

Every listener, registry entry, route, watcher, timer, socket, child runtime and UI root needs an owner and disposer. Use `ctx.effect()` or APIs whose registration is already scoped to the current fiber.

Correct teardown order normally is:

1. stop new admission;
2. unregister public routes/registry entries;
3. cancel or settle admitted operations;
4. flush durable state where required;
5. release children, workers, sockets and files;
6. emit no new public state after disposal.

Reload safety is a behavior to test, not an implementation detail.

## 5. Publish at the commit point

Do not emit events, update UI caches or report success before the authoritative mutation is durable. A typical operation is:

```text
validate authority and request
  → reserve operation-local identity
  → write durable state
  → update authoritative in-memory projection
  → emit notification
  → attempt best-effort live delivery
```

If a side effect happens before persistence, the rollback path must retire or dispose the created resource. `dsh-agent-teams` orphan-member fixes are an important reference for this failure class.

## 6. Model-visible means logged

Anything entering a model request must be reconstructable from the Session log. Injecting transient context without a durable/logged representation breaks resume, fork, replay and audit invariants.

For team features:

- peer messages delivered to a member need stable source identity;
- workflow/human answers entering history need normal message events;
- task board records may remain log-only if the tool result is the sole model-facing representation;
- UI must project authoritative Session/storage state rather than invent model context.

## 7. Use the correct event domain

- Session events: durable facts that survive reload.
- Agent events: in-flight status, inbox, step, request and turn lifecycle.
- Capability events: Provider/Consumer policy and adapter hooks.

Waterfall listeners must call `next()` unless they intentionally terminate the chain. A missing `next()` is control-flow interception, not a harmless omission.

## 8. Explicit configuration and fail-loud behavior

Deployment-varying choices belong in validated `Config`, including limits, provider names, timeouts, paths and feature toggles. Protocol constants and security invariants remain fixed.

Fail early for:

- unknown provider names;
- unsupported capabilities;
- invalid limits or paths;
- missing durable storage where durability is promised;
- conflicting service keys or route paths;
- stale task revisions and stale attempt tokens.

Do not silently fall back from distributed to local, from Worktree to shared checkout, or from verification to trust-the-model unless the user explicitly configured that policy.

## 9. Host, client and bundle are separate faces

- Host-only plugin: Node service/tool/event behavior; no `dsh.client` declaration.
- Dual-face plugin: host entry plus `exports['./client']` and `dsh.client` metadata.
- Bundle: package `dsh.bundle.patch` points to a top-level-array patch.
- Profile: user-owned ordered bundle composition; plugin authors should not hand-edit user profile manifests.

Client state must remain a projection. If a feature works only when the UI is open, its runtime design is wrong unless it is explicitly a UI-only feature.

## 10. Patch semantics

`cordis.patch.yml` is an ordered layer. `insert` adds rows. Later rows can target an id and replace its full config. Config is not deep-merged. A `name` mismatch can make a patch ineffective. Always inspect the actual tree:

```sh
dsh --profile web --dump-config
```

## 11. Official source beats secondary documentation

The community documentation currently identifies rc.7, while official repository `master` was verified on 2026-08-20 at the rc.8 release commit. During Developer Preview:

1. inspect installed package exports/types;
2. inspect the official repository at a recorded commit;
3. use deepseekdocs for learning path and examples;
4. treat community plugins as prior art, not framework contracts;
5. record every source pin in `docs/09-sources.md`.

At this verified rc.8 baseline, public services include workflow, jobs, token meter, storage domain and workspace registry. The Agent Team package remains private/experimental. Published capability existence and this plugin's actual integration status are separate facts.

For this project, authoritative Team state is non-Session application data and therefore belongs behind `ctx.storageDomain` until a published official Team Provider owns it. A shared coding checkout is not an authority boundary: any member allowed to write it can replace structurally valid state. M1 requires Storage Domain plus Session persistence and forbids a workspace-file fallback or dual write. The local Provider remains single-process until an atomic distributed Store exists.

## 12. Official-first is an implementation gate

Before design or code, run `pnpm verify:gate-a`, read the materially present implemented Agent Notes and package exports/tests, inspect the target Profile, and update the ownership/conflict map. If a stable official Service Definition owns the capability, this project may only supply a Provider, Consumer, policy overlay or Bundle row. A new project Service requires evidence that the target lacks an owner and an ADR explaining how it avoids current and experimental service keys. See `11-official-first-development.md`.
