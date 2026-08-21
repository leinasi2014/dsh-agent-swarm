# M4-1 design note: official tokenMeter contract analysis and the Team budget measurement boundary (issue #127)

Status: decided (Option B — boundary declaration + parity cross-check). Date: 2026-08-22.

## 0. Gate A record

```text
Official remote SHA/date: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e (release dsh@0.1.1-rc.2, tag dsh-v0.1.1-rc.2 verified landing exactly on the pin; contract analysis originally at 141eb6f/rc.8 and re-verified fold-identical at the current pin — Section 0)
Relevant implemented Agent Notes/packages: packages/llm/token-meter (service, projections, tests), packages/session/session-projection (registry), packages/session/session-projection-cache (persisted cache, NOT consumed), packages/core/session (event face facts, already registered in 09 §1 for #92)
Installed/Profile capability evidence: @deepseek-ai/dsh-token-meter@0.1.1-rc.2 installed as devDependency in this change (parity test consumption only); still NOT a runtime dependency, NOT composed in any Profile the plugin ships (cordis.patch.yml unchanged)
Stable / experimental / absent / overlay classification: tokenMeter service + tokenUsage/contextPressure/contextBreakdown projections = official stable (public rc.8 packages); cumulative Team budget ledger with per-seq cursors, admission, carry = project-owned overlay
Reference behaviors and failure cases selected: Jiuwen shared budget spent/remaining + per-run reservations (docs/05 budget rows) — unchanged; dsh-agent-teams has no separate metering face (process-local accounting)
Canonical state owner: Team budget aggregate (agent_swarm Storage Domain record) — unchanged
Transition owner: UsageAccountant → TeamDomain.recordSessionUsageBatch (unchanged); official tokenMeter owns NO Team state
Plugin shape: no new service; test-only consumption of official packages; documentation boundary registration
Lifecycle/persistence/security limits: none added (no runtime dependency, no registration, no state)
Migration/rollback: none needed (nothing runtime changes)
Unit/conformance/fault/real-composition gates: tests/tokenmeter-parity.spec.ts (real official composition)
Docs/Skill files updated: docs/03, docs/09, docs/10, README, this note
```

Gate A execution facts (worktree `feat/m4-tokenmeter`, rebased onto main `4ac6ff7` — see the mid-task base movement below):

- Final state (after rebase onto the re-pinned main): `pnpm verify:gate-a` fully PASS — official half `release anchor PASS (release tag dsh-v0.1.1-rc.2 landed on the pinned commit b150a55)`, checkout evidence and package visibility PASS, and the references half `Reference remotes, pins, and clean local checkouts: PASS` (local checkouts materialized at the recorded pins via each `sync-reference.ps1`).
- The contract analysis below was performed against the rc.8 evidence checkout (141eb6f, `packages/llm/token-meter` + `packages/session/session-projection`), because the branch was commissioned from main @ e1712ad. Before this branch landed, main re-pinned to 0.1.1-rc.2 (`4ac6ff7`, the Gate C change) and the PR was rebased onto it; the token-meter family delta rc.8 → 0.1.1-rc.2 was then diff-reviewed (sparse evidence checkout holds both commits): `usage-projection.ts`/`breakdown-projection.ts` were refactored to the new `ProjectionDefinition` contract shape (`schema` split into `stateSchema` + `wire: { viewSchema, view }`, state types moved into `SessionProjectionStateMap`), while the fold semantics — chunk-early counting, same-`(turn, step)` message-final replacement, non-monotone corrections, `stateVersion` 1, and the registry's `snapshot().values.tokenUsage` wire read face — are unchanged, and `token-meter/src/index.ts` (`measure()`) and the estimate/surface folds are untouched. The parity suite was re-run green against the installed 0.1.1-rc.2 packages (devDependency bumped with the rebase), so every conclusion below holds verbatim at the current pin; the rc.8 file citations remain the original analysis anchor.

## 1. Official tokenMeter contract (rc.8, `@deepseek-ai/dsh-token-meter` @ 141eb6f)

All file references are against the pinned evidence checkout; the installed npm build was import-verified (`default export: TokenMeter service class`, exports `.`, `./invariant`, `./client`, `./src/*`).

### 1.1 Service face

- Package `@deepseek-ai/dsh-token-meter`, public rc.8. Default-exports `TokenMeter extends Service` registering itself as `ctx.tokenMeter` (`super(ctx, 'tokenMeter')`). Config is an empty object schema; `validateConfigKeys` rejects any key — the estimator deliberately has no settings (README "Configuration").
- Composition is a bundle patch row (`- name: '@deepseek-ai/dsh-token-meter'`). It is NOT in this plugin's dependency tree at runtime (docs/09 registers that fact); this change adds it as a devDependency only, for the parity test.

### 1.2 Measurement face — `measure()` measures CURRENT REQUEST PRESSURE, not cumulative usage

`measure(session, requestHeader?): TokenMeasurement` is a pull/read API (src/index.ts):

- Per-`Session` replay state in a `WeakMap`; `_sync` lazily folds `session.events` from the last consumed index. The `session/event` listener only catches up sessions already read once — no state is created for sessions no consumer has measured.
- The returned snapshot (`src/types.ts`): `logRevision` (consumed event count), `baseline` (`none | estimated | usage` — anchored at the LATEST successful call), signed `surfaceDeltaTokens`, `totalTokens` (current request+response pressure), `surfaceTokens`, `nodes` (per-event priced surface).
- Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope AND its total is no lower than that call's full heuristic anchor; otherwise the complete envelope+surface is heuristically repriced (conservative fallback). The fixed heuristic is ~4 chars/token plus structural overhead.
- **Granularity: per-request/per-call pressure for the NEXT request of ONE session.** It keeps no cumulative total across calls — each successful `assistant/message` REPLACES the anchor. The README is explicit that occupancy figures are "a user-facing reference, not a billing record or a gating input — nothing in the harness makes decisions from it".

### 1.3 Projection face — `tokenUsage` IS a per-session cumulative fold, with replacement semantics

When the composition provides `ctx.sessionProjections` (optional child `ctx.inject`), the meter registers three units (src/index.ts constructor; `src/usage-projection.ts`):

- **`tokenUsage`** (`ProjectionDefinition<'tokenUsage', TokenUsageState>`, stateVersion 1): cumulative provider usage over the COMPLETE durable log in four disjoint buckets (`uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`; reasoning is an output subdivision, not added again). Inputs (src/usage-projection.ts `apply`): an `assistant/chunk` with `chunk.type === 'usage'` counts as an EARLY sample — "counted even when a request later fails" (README); an `assistant/message` with `data.usage` is the FINAL sample for the same `(turn, step)` and REPLACES that step's earlier chunk sample instead of double-counting (`addReplacing`), relying on the registered session-log invariant that usage reports for one turn/step are adjacent. Consequences:
  - the bucket totals are **not monotone** — a corrective final sample below the chunk sample SHRINKS the total (src/invariant.ts documents this deliberately);
  - identical-sample dedup (`bucketsEqual` short-circuit) keeps `view` state-reference stable.
- **`contextPressure`**: independent last-wins slots — newest prompt-side pressure (`input + cacheRead + cacheWrite`), heuristic `projectedTokens` for the NEXT request, newest `contextWindow`. Explicitly not one atomic request observation.
- **`contextBreakdown`**: heuristic system/tools/message composition of the next request.
- The registry (`@deepseek-ai/dsh-session-projection`, `SessionProjectionRegistry`) owns the drive: subscribes `session/event` once, per-session per-unit watermark cells (`WeakMap<Session, UnitCell>`), lazy full-log fold on first touch, synchronous `snapshot(session)` consistent cut, `onChanged` change feed, and a cold-read recipe for logs without a live `Session`: `restore(checkpoint, events, baseSeq)` seeded from `(sessionId, key, ver, seq, val)` rows produced by `checkpoint()`/`viewCheckpoint()`/`restoreFloor()`. Persisting those rows is the SEPARATE optional `@deepseek-ai/dsh-session-projection-cache` package's concern — the meter and the registry alone persist nothing.

### 1.4 Relation to the session event stream

Both faces are pure functions of the durable per-session event log (replay-aware): the service folds in memory lazily; the projection registry folds eagerly per committed event and can refold cold logs from persisted events. Neither writes Team state; neither offers Team aggregation, admission, limits, carry, or any budget semantics. The token-sum formula equals ours (`usageTokens` = input + cacheRead + cacheWrite + output, src/index.ts; same as `billedTokens` in `src/runtime/usage-accounting.ts`).

## 2. The two accounting faces compared on one event stream

Plugin ledger (M1B/#92, unchanged): `session/event` observer folds ONLY committed `assistant/message.data.usage`; coalesced per scope+session batched writes; per-session durable cursor makes every fold exactly-once per event seq (replay, reorder, reload idempotent); #92 recovery refolds whole rosters (live log or `sessionPersistence.inspect` history); #79 carry and admission are Team-domain semantics.

Equivalence over the same log:

| Log shape | official `tokenUsage` bucket sum | plugin ledger | relation |
|---|---|---|---|
| standard step: usage chunk → `assistant/message` with the same usage | final value (chunk replaced) | final value (only message counted) | **equal** |
| corrective step: chunk sample N, final message M ≠ N | M (replace) | M | **equal** |
| aborted turn (zero-content interruption appends no usage; partial content appends `assistant/message` with `usage`, #92-registered fact 4) | message value where present | message value where present | **equal** |
| failed request: usage chunk landed, NO usage-bearing `assistant/message` followed | chunk sample counted | nothing counted | **official ≥ plugin** — the declared divergence |
| any log, read twice / after reload | same (pure fold) | same (per-seq cursor) | both replay-exact |

So the two faces agree exactly on every log where each usage-reporting step finalizes with a usage-bearing `assistant/message` — which is every log the official agent loop can produce except a request that fails after its provider usage chunk with zero assembled content. That single edge is the whole semantic delta between the faces (chunk-only usage).

## 3. Selection: Option A (consume official as measurement source) vs Option B (boundary declaration)

### Option A — official tokenMeter/tokenUsage as the Team measurement source, plugin ledger as consumer

Required re-derivation of the ledger's idempotency mechanism, and where it breaks:

1. The Team ledger still needs per-session crash/reload idempotency. The official `tokenUsage` face exposes whole-value totals at a watermark (`snapshot.asOfSeq`) and whole-value change events (`onChanged`), never per-event attribution. An adapter would have to store `(session → lastWatermark, lastTotals)` and fold `next − last` deltas.
2. **Non-monotone totals break delta folding**: a corrective final sample shrinks a bucket, so `delta` can be negative. `recordSessionUsageBatch` rejects negative tokens (a durable-ledger invariant), and clamping a negative delta to zero permanently drifts the ledger upward — a semantic regression of the M1B exactly-once fold (red line: M1B/#92 semantics zero regression).
3. **Weaker recovery**: the #92 net refolds precise event-seq suffixes against the durable cursor from `sessionPersistence.inspect`. Under watermark+delta accounting, a drop between two reads is only healable by re-deriving a delta whose attribution the official face never published; healing would need the plugin to keep its own seq-keyed fold anyway — i.e. the second measurement path Option A was supposed to remove.
4. **Counted-set change**: chunk-only usage (failed requests) would start billing Teams that the current ledger deliberately does not bill — changing the meaning of `usedTokens` for identical logs, interacting with admission (`TEAM_BUDGET_TOKENS`) and #79 carry.
5. **Composition coupling grows**: measurement would additionally require `sessionProjections` composed in every Profile plus token-meter installed, and cold-session reads would require either live `Session` objects or the `restore` recipe with checkpoint rows the plugin would have to own (the projection-cache package is a further optional composition).
6. **Double-counting closure (the issue's precondition)**: double counting arises iff both the plugin's own `session/event` fold and the official-derived deltas feed the ledger. Closing it means REPLACING the plugin fold with official deltas — which is exactly steps 2-5, i.e. a regression of red-lined semantics. Keeping both paths for cross-validation inside the runtime would double-bill every assistant message.

Conclusion: Option A cannot be closed within this task's red lines. It is not rejected forever — it becomes viable if the official face ever exposes per-event usage attribution (or a monotone per-step settled-usage projection), at which point the adapter can map official per-seq entries onto the existing cursor fold one-for-one. That precondition is registered in docs/03/09 as the re-evaluation trigger.

### Option B — plugin ledger stays the single Team measurement path; official tokenMeter is the host-side official metering face (boundary declared)

- The Team budget keeps exactly one measurement path: the plugin's own per-seq-cursor fold over committed `assistant/message` usage (M1B/#92 semantics untouched; #79 carry untouched).
- The official tokenMeter keeps its own host-side roles (request-pressure for compaction, occupancy UI) and is NOT consumed by the budget — so no double counting exists by construction; docs/11's forbidden design ("counting the same usage through Session folding and Token Meter twice") stays excluded.
- The boundary is proven, not just asserted: a real-composition parity test (Section 4) drives the SAME live session log through both accounting faces — the official `tokenUsage` projection (real `SessionStore` + `SessionProjectionRegistry` + `TokenMeter` plugins) and the plugin's `UsageAccountant` + `TeamDomain` ledger — and asserts numeric equality on every log shape where the faces are defined to agree, pinning the one declared divergence (chunk-only usage) as an explicit boundary case.

**Recommendation: Option B.** It satisfies the issue's acceptance (evaluation + selection argument + boundary registration in docs/03/09 + a cross-check test), preserves the red lines verbatim, and converts the docs/03 aspiration ("a future accounting adapter should consume the official projection where its semantics match") into a characterized contract: the faces' agreement condition, divergence condition, and the exact precondition under which Option A would become adoptable.

## 4. Implementation (this change)

- `tests/tokenmeter-parity.spec.ts` — real official composition (`Context` + `SessionStore` + `SessionProjectionRegistry` + `TokenMeter` from installed rc.8 packages), a real plugin Team stack (`openStorageStack`), and the plugin accountant wired to the same `session/event` firehose. Scenarios:
  1. multi-step happy path (two sessions — captain + member — several usage-bearing steps each): official bucket sum per session == plugin ledger total == sum of billed message usages; both faces stay equal after repeated reads (replay-exact);
  2. chunk-then-corrected-final (final ≠ chunk): replacement keeps the faces equal;
  3. aborted turn with usage (the #92-registered shape): equal;
  4. chunk-only failed request: official counts it, plugin does not — the declared divergence, asserted as the boundary (and the plugin number is proven exactly the sum of its counted events);
  5. the official `measure()` face is exercised once to pin the read-model difference (current pressure with heuristic baseline, no cumulative total) without feeding the ledger.
- `docs/03` TeamBudget section: replace the future-adapter aspiration with the decided boundary and the Option A re-evaluation precondition.
- `docs/09`: register the token-meter contract facts (service face, measure semantics, projection registration optionality, replace semantics, non-monotonicity, adjacency invariant, cold-read recipe, cache package separation) with file citations; update the "installed dependency tree" fact (devDependency now, runtime dependency still no).
- `docs/10`: update the budget row and the `ctx.tokenMeter` row (boundary decided in M4-1; adapter remains deliberately absent with precondition).
- `README`: same status sentence update.
- Roadmap note: docs/07 M4 keeps "define one token-measurement adapter and characterize ctx.tokenMeter projections" — M4-1 delivers the characterization half and the decision; the "remove or disable direct Session folding when the official adapter owns measurement" clause stays conditional on a future official per-event face (now explicitly recorded).

## 5. Known limitations / follow-ups

- Parity is pinned at stateVersion 1 fold semantics (identical at rc.8 and 0.1.1-rc.2; the rc.2 delta is contract-shape only — Section 0). A token-meter release that changes the counted set or adds per-event attribution re-opens the Option A evaluation (Gate C).
- The parity test consumes `@deepseek-ai/dsh-token-meter` as a devDependency only; the shipped `cordis.patch.yml` does not compose it, and the plugin has no runtime dependency on it (no fail-closed requirement is added — measurement stays in-tree).
