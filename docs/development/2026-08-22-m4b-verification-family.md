# M4B verification family: multiple roots and command templates

Status: implementation design for issue #128. Date: 2026-08-22.

## 1. Evidence gate and capability classification

`pnpm verify:gate-a` passed before this note was written. The release anchor is official DSH `0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`; the reference checkouts are `dsh-agent-teams@0c21e5d2f45ec1ea7c9ee89ffc4ee77d1cb9262e` and `jiuwenswarm@1d45d2b4a08423365eae7c37b2afdae6614a97ad`, both clean and equal to their remote branch tips. The required reference checkouts were materialized only through their supplied sync scripts.

The relevant official evidence was checked in the permitted rc.8 full source tree at `141eb6fef83422698aef7a981029e843e8161534` and against the installed `@deepseek-ai/dsh-invariants@0.1.1-rc.2` package. The installed export remains `InvariantRegistry.register(packageName, installer): () => void`; its `InvariantInstaller` owns listeners or startup checks over authoritative runtime relationships. The rc.8 source, package README, subsystem documentation, tests, `docs/architecture.md`, `docs/module-graph.md`, and the implemented Agent Notes `2026-06-11-dev-invariants-over-deep-readonly.md` and `2026-07-19-package-owned-invariant-service.md` agree on the following boundary:

| Needed capability | Classification and owner |
|---|---|
| Runtime invariant registry and package companions | Official stable/public support service. It selects and lifecycle-owns package-attributed relational assertions; it is not a command runner or verification-result registry. |
| Task verification declarations and review execution | Project-owned Review Provider overlay over `TeamDomainPort`; #101 already owns the deterministic executable-review transaction. |
| Review-root supply | Project-owned replaceable Provider registry because official Workspace is identity, not a per-review execution-root allocator. #101's `ReviewRootProvider` is the compatibility contract. |
| Verification command templates | Absent officially; project-owned stateless compiler/registry consumed before the authoritative task commit. |
| Verification evidence summary | Project-owned operation result derived only from root-produced `ReviewCommandEvidence`; the persisted attempt diagnostic remains the bounded projection. |

The shipped Bundle/Profile row composes `dsh-agent-swarm` only. `@deepseek-ai/dsh-invariants` is installed for tests but is not a required runtime injection and is not mounted by `cordis.patch.yml`; this issue does not change that Profile fact.

Reference mapping is deliberately behavioral. `dsh-agent-teams` supplies no verification-command service; its `pnpm verify` material is repository verification practice only. JiuwenSwarm demonstrates Python/`uv run pytest` toolchain specificity, multi-language review analyzers, isolated Worktree verification, and explicit failures when required analyzers are missing. This design adopts the need for toolchain-specific roots and missing-tool refusal, not its runtime or types.

## 2. Compatibility and ownership table

| State or transition | Single owner | Conflict prevention |
|---|---|---|
| Authored verification declaration | Captain through `create_task` | The worker and review call receive no mutation path. |
| Template registry | `AgentSwarmRuntime` process-local registry | Unique canonical names; each external registration returns an identity-checked disposer. Templates own no durable state. |
| Compilation to concrete commands | Runtime pre-commit compiler | Expansion and root availability finish before `TeamDomainPort.createTask`; only the compiled list crosses the authority boundary. |
| Frozen verification list | Existing schema-v1 `TeamTask.verification` in the authoritative Team aggregate | The stored field remains exactly `{ command, timeoutMs? }[]`; rework attempts reuse it byte-for-byte. |
| Root-family selection | Executable Review Provider over the registered root-family metadata | A canonical command envelope selects a family and required capability; unknown or unavailable families fail loudly and never fall back to `temp`. |
| Command evidence | The selected `ReviewRootSession.run` | Worker output is checked in only as candidate data; it cannot supply exit code, output, timing, root label, or summary. |
| Review settlement | Existing captain-only review transaction and `TeamDomainPort.reviewTask` | Verification is a floor, not a ceiling; a root or capability failure leaves the task submitted, while command failure forces reject. |
| Structured summary | Pure aggregation inside `executableReview` | Derived from the complete in-memory root evidence only; no second store and no reverse write into Team state. |

No Agent Loop, official service, Session event, Storage Domain table, or Profile service registration is added.

## 3. Multiple verification-root Providers

### 3.1 Backward-compatible registration extension

`ReviewRootProvider.open(input)` and `ReviewRootSession` remain unchanged. Existing #101 providers and `registerReviewRootProvider(name, provider)` calls therefore retain their source and runtime meaning. Registration gains one optional capability declaration:

```ts
interface ReviewRootCapabilities {
  readonly provides: readonly string[]
  readonly checkAvailability: (input: {
    readonly signal: AbortSignal
  }) => Promise<ReviewRootAvailability>
}

interface ReviewRootAvailability {
  readonly available: boolean
  readonly diagnostic?: string
}

registerReviewRootProvider(
  family: string,
  provider: ReviewRootProvider,
  capabilities?: ReviewRootCapabilities,
): () => void
```

The registration name is now explicitly the root-family name. Omitting `capabilities` is the legacy #101 form: it may serve raw commands selected by `reviewRootProvider`, but a template cannot claim a toolchain through it. Capability names and family names use a bounded lowercase identifier vocabulary; declarations are copied, nonempty, unique, and disposer-owned.

Builtins are:

| Family | Provides | Availability check | Root implementation |
|---|---|---|---|
| `temp` | none (legacy raw-command face) | none | Existing fresh temporary review root; #101 semantics unchanged. |
| `node` | `node` | bounded `node --version` probe | Fresh temporary review root. |
| `python` | `python` | bounded `python --version` probe | Fresh temporary review root. |

The builtin roots prove the family and failure contracts; they do not claim that an empty temporary directory contains a project's dependencies. A Worktree/container Provider may register another family with the same toolchain capability and pair it with templates that target that family. Registration never silently replaces a builtin or another plugin's family.

Availability is checked twice: before the task commit for every family required by an expanded declaration, and again immediately before the first root session opens during review. The first check prevents a known-impossible task from entering the board; the second catches environment drift. Missing registration, missing declared capability, probe failure, or `available: false` produces `TEAM_REVIEW_ROOT_UNAVAILABLE` with the family/capability named. There is no Python-to-Node or Python-to-`temp` degradation. If `python` is absent, Python-template task creation is refused before persistence; if it disappears later, review refuses to settle and the task stays `submitted` with no retry charge.

### 3.2 Mixed-root execution

Each compiled command carries its root family and required capability. The executable Provider preserves declaration order, opens at most one session per used family, checks the candidate artifact into every opened root, and reuses that session if the same family occurs again. A failed command remains fail-fast across the whole ordered list. All opened roots close in `finally`; cleanup failures remain warning-only after the evidence-producing operation, matching #101.

A family-open or capability failure is not command evidence and aborts the review transaction. A spawned command that exits nonzero, times out, or cannot spawn is root-produced command evidence and forces the ordinary reject path.

## 4. Verification command library

### 4.1 Selection: named template registration, not an author-facing inline DSL

Two authoring designs were considered:

1. Inline DSL such as `python:test(args=...)` inside `command`. It keeps one field but makes validation, escaping, discovery, Provider ownership, and typo handling depend on string parsing; it also lets each Consumer invent a dialect.
2. Named template registration with a typed invocation `{ template, parameters?, timeoutMs? }`. The registry owns names, allowed parameter names, expansion, lifecycle, and family/capability selection. Consumers share one compiler, while raw `{ command, timeoutMs? }` remains available.

The second design is selected. The task tool accepts either a raw command or a template invocation. Exactly one of `command` and `template` is required; parameters are explicit name/value pairs at the JSON tool boundary and become a copied record for the compiler. Unknown templates, duplicate/unknown parameters, invalid expansion, or an expansion above the domain command/count bounds fail before the Team commit.

```ts
interface VerificationTemplateInvocation {
  readonly template: string
  readonly parameters?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

interface VerificationCommandTemplate {
  readonly rootFamily: string
  readonly capability: string
  readonly parameters?: readonly string[]
  expand(parameters: Readonly<Record<string, string>>):
    string | readonly string[]
}
```

`registerVerificationCommandTemplate(name, template)` returns an identity-checked disposer. Templates are stateless; their expansion is joined synchronously before persistence. Builtin names use `<toolchain>.<operation>`:

| Template | Concrete default | Optional parameter |
|---|---|---|
| `node.typecheck` | `pnpm typecheck` | `args` replaces no default suffix |
| `node.test` | `pnpm test` | `args` |
| `node.build` | `pnpm build` | `args` |
| `node.lint` | `pnpm lint` | `args` |
| `python.typecheck` | `python -m mypy .` | `args` replaces `.` |
| `python.test` | `python -m pytest` | `args` |
| `python.build` | `python -m build` | `args` |
| `python.lint` | `python -m ruff check .` | `args` replaces `.` |

`args` is deliberately a shell fragment because the captain already has the stronger raw-shell declaration authority. It is bounded, single-line, and cannot alter the template/root envelope.

### 4.2 Compilation and stored-format compatibility

Template invocations never enter `TeamDomainPort`. The runtime expands them before calling `createTask`, then stores only the existing `ReviewVerificationCommand` list. Root routing is encoded in the command string with a canonical internal envelope:

```text
dsh-verification-root:<family>/<capability> -- <concrete shell command>
```

The envelope is compiler output, not an authoring DSL. The executable Provider parses it and passes only the concrete shell command to `ReviewRootSession.run`. Raw commands have no envelope and continue to use configured `reviewRootProvider` exactly as in #101.

This choice changes neither `ReviewVerificationCommand`, `TeamTask.verification`, the schema-v1 aggregate validator, nor ADR-0007's storage authority/version. Old code encountering a new envelope attempts to run the nonexistent `dsh-verification-root:<family>/<capability>` command and fails loudly; it cannot silently execute a Python command in the legacy root. A stored-format revision is therefore not required. If future requirements need structured root metadata outside the command string, that is a new durable field and must receive an ADR-0007 migration/version decision before implementation.

## 5. Structured evidence aggregation

`executableReview` produces a versioned operation summary before rendering the existing bounded diagnostic:

```ts
interface VerificationEvidenceSummary {
  readonly version: 1
  readonly status: 'passed' | 'failed'
  readonly requestedDecision: 'accept' | 'reject'
  readonly finalDecision: 'accept' | 'reject'
  readonly plannedCommands: number
  readonly executedCommands: number
  readonly skippedCommands: number
  readonly totalDurationMs: number
  readonly roots: readonly {
    readonly family: string
    readonly capability: string
    readonly label: string
    readonly commandIndexes: readonly number[]
  }[]
  readonly commands: readonly {
    readonly index: number
    readonly family: string
    readonly capability: string
    readonly rootLabel: string
    readonly evidence: ReviewCommandEvidence
  }[]
  readonly failedCommandIndex?: number
  readonly provenance: 'review-root'
}
```

The summary contains every executed command exactly once, preserves declaration order, records all used roots, and accounts for fail-fast skipped commands. `planned = executed + skipped`; `totalDurationMs` is the sum of root-recorded command durations; `failedCommandIndex` points into the declared list. `ExecutableReviewResult` exposes the summary to programmatic Consumers while remaining structurally assignable to `ReviewProviderResult`. The authoritative attempt continues to store the bounded text diagnostic, so this issue adds no projection store or durable state. The diagnostic header gains root count and the per-command rows name family/root label; the final provenance line remains exactly #101's root-only claim.

## 6. Official invariants integration decision

No invariant companion is registered in this issue. Official rules explicitly reject service/method presence checks and fixed pure-function examples as runtime invariants. Template expansion is a pure compiler concern; executable verification is an intentional operation whose failures are ordinary review evidence, not violations of a Harness-owned runtime relationship. Turning command exit status into `InvariantError` would both misuse the official support service and bypass the review transaction's reject semantics.

A future companion becomes appropriate only if this package publishes an authoritative verification event stream or mutable summary registry with a cross-record relationship such as command start/end pairing, monotonic indexes, or equality between a durable summary and its source events. At that point the project may consume `ctx.invariants` through an explicit package companion. The official service and every official companion remain read-only dependencies; no official source is modified.

## 7. Failure, lifecycle, and security semantics

- Missing template, root family, declared capability, or unavailable executable: fail before task commit; no silent raw-command fallback.
- Availability lost after commission: review throws `TEAM_REVIEW_ROOT_UNAVAILABLE`; task stays `submitted`, attempt diagnostic stays absent, retry budget is unchanged.
- Command spawn/nonzero/timeout: root-produced evidence, structured summary status `failed`, captain accept is overridden to reject, remaining commands are counted as skipped.
- Passing commands: captain request remains authoritative; verification is still a floor, not a ceiling.
- Candidate data is checked into every opened root but is never copied into evidence unless a root command itself emits it. Worker text still cannot forge the diagnostic or summary.
- Registry contributions have identity-checked disposers. Root sessions close in reverse-open order even on failure. No timer, listener, subprocess, or root survives its operation owner.
- Command count, command text, parameter values, availability probe time, command time, captured output, diagnostic size, and summary item count are bounded.

## 8. Implementation and verification plan

1. Add the root capability declaration/probe and optional third registration argument without changing `ReviewRootProvider.open`.
2. Add the template registry/compiler, canonical routing envelope, and the eight builtin templates.
3. Compile declarations and preflight required root capabilities before `TeamDomainPort.createTask`.
4. Route the executable review across per-family sessions and build the versioned summary before rendering its diagnostic.
5. Add focused tests for builtin/custom template expansion, duplicate/unknown parameters, mixed Node/Python-family order and candidate check-in, summary completeness, unavailable Python capability refusal before commit, review-time loss, and unchanged raw-command #101 behavior.
6. Run the focused suite, structure/type checks, `node scripts/verify-project.mjs`, and the full `pnpm verify` chain. Test waits introduced across asynchronous boundaries use at least 15 seconds and each affected test file keeps at least a 60-second budget, per `CONTRIBUTING.md`.

## 9. Judgment calls for PM review

1. The canonical routing envelope is stored inside the existing command string to preserve schema version 1. This is intentionally visible in task snapshots; it is compiled data, not a user-facing DSL.
2. Builtin Node/Python roots are availability-aware temporary roots, not dependency installers or Worktree replicas. A missing project dependency is honest command failure, distinct from root capability unavailability.
3. The structured summary is operation evidence and is not persisted separately. Persisting it would add a second durable record or alter `TaskAttempt`; neither is required by issue #128 and both need a separate authority/version decision.
4. Official invariants are not integrated because the official ownership rules make command execution and pure expansion the wrong subject for an invariant companion.
