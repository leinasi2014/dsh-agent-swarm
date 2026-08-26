# 13. DSH RPC self-hosting and dogfood design

Status: accepted target design; no readiness level is implemented merely because this document exists. ADR-0008 is authoritative.

## 1. Objective

Use an isolated DSH Profile and RPC endpoint to let `dsh-agent-swarm` form a development Team that improves this repository, while preserving an external control path, independent verification and rollback. The loop is intended to reveal real coordination defects and convert verified failures into canonical repair tasks without allowing the candidate plugin to approve or deploy itself.

## 2. Composition

```text
project manager / user
  -> stable control Profile (last-known-good plugin + DSH RPC)
       -> Lead Session
            -> TeamDomainPort (one authoritative backend)
            -> adaptive Scheduler OR Workflow owner
            -> Jobs projection and cancellation
            -> Workspace Provider
                 -> Worker A: Worktree A, exact cwd/tool roots
                 -> Worker B: Worktree B, exact cwd/tool roots
            -> Review Providers
                 -> command/check
                 -> independent Reviewer Agent
                 -> optional human approval
       -> frozen candidate artifact
            -> isolated acceptance Profile + separate RPC/state
                 -> load/dump-config/reload/recovery/e2e/security checks
                      -> external promotion or rejection
```

The control Profile owns Team admission and promotion coordination. The selected Team backend owns roster, mailbox and task state. A Workspace Provider owns leases and cleanup. Review Providers own evidence evaluation. The acceptance Profile can report health but cannot promote itself.

## 3. Readiness gates

### D0 — Profile smoke after M1D

Required:

- all M1 security/protocol blockers closed and independently re-reviewed;
- real Profile composes Session persistence, Storage Domain, KV backend and this Bundle;
- clean load, `--dump-config`, RPC tool visibility, reload, recovery and bounded teardown pass;
- stable artifact and rollback command are recorded.

D0 does not perform autonomous source mutation.

### D1 — supervised single-writer dogfood after M1D

Allowed:

- one Lead, one coding writer at a time and any number of read-only research/review members;
- a dedicated project clone or Worktree that is not the stable control checkout;
- manual review, merge, acceptance Profile startup and promotion;
- low-frequency manager observation of committed Team/Job state and final reports.

Forbidden:

- two members writing the same checkout;
- automatic merge or stable Profile replacement;
- candidate writes to control storage, official/ref checkouts or credentials;
- describing prompt-only `writeScopes` as isolation.

### D2 — supervised parallel self-development after M2 and M3

Required:

- Workflow/Jobs integration with one transition owner, durable run ids, cancellation and completion disclosure;
- one immutable base revision and one unique branch/Worktree/lease per attempt;
- out-of-process DSH/ACP execution whose actual cwd, filesystem and shell roots equal the lease;
- command/check and independent Reviewer Providers; canonical completion cannot bypass them;
- frozen commit and package artifact digest before verification;
- separate acceptance Profile/port/state root, health checks and deterministic rollback;
- merge queue serializes promotion and rejects stale attempt/lease generations;
- structured diagnostics redact credentials and remain linked to Team/task/run ids.

Readiness is evaluated from the current accepted implementation, executable checks, immutable review evidence and deployment configuration; this stable design does not carry a dated delivery table. The selected project binding remains the authority for whether parallel repository writers are enabled. D2 stays closed whenever any required execution-root, reviewer, frozen-artifact, acceptance-Profile, promotion-fencing or OS-level demotion claim lacks current evidence.

### D3 and D4

D3 adds accepted-evidence memory and approval-separated Skill Evolution. D4 adds distributed CAS/leases/fencing, remote observability, packaged release, migration and unattended rollback. Neither level is implied by successful local parallel dogfood.

## 4. Candidate lifecycle

```text
planned
  -> leased
  -> running
  -> submitted
  -> frozen
  -> verified
  -> acceptance-booted
  -> accepted
  -> promoted
```

Any verification, boot, recovery or health failure moves the candidate to `rejected`. A rejected candidate remains immutable evidence. A repair uses a fresh attempt and lease; it never reopens the old accepted/rejected generation. Promotion records stable and candidate commit, artifact digest, Profile configuration identity, verification evidence and rollback target.

## 5. Observation and management loop

The manager reads structured facts rather than member reasoning:

- Team/task/run/revision/attempt identifiers and transitions;
- live Agent status, lineage and abandoned ownership;
- mailbox ids, pending/ack state and recovery outcome;
- Workspace lease, exact cwd, branch, base and cleanup result;
- execution-root lease state per attempt: acquired/released counts, the activation-scan residue report (orphan vs reattachable, `docs/04` §8l), the root-residue rate — orphaned roots over settled attempts — and the captain reclaim outcome for marked roots;
- Job phase, cancellation, timeout and safe diagnostic;
- test/review evidence, frozen commit/artifact digest and acceptance health;
- token/request/context projections used for efficiency analysis;
- final stage or blocker report.

Observed failures become Lead-owned tasks with reproduction evidence, expected invariant and acceptance check. The manager does not directly patch canonical state, rewrite reviewer conclusions or push a healthy Team toward early convergence.

## 6. Defects this dogfood must expose

- duplicate/lost messages across crash windows;
- orphan or double-provisioned members;
- Scheduler selecting busy/unavailable Agents;
- stale attempt, lease or bootstrap ACK acceptance;
- hung admission/disposal/cancellation;
- cross-Worktree or control-root writes;
- review bypass, reviewer/worker collusion and mutable evidence;
- merge races, dirty base, cleanup failure and rollback failure;
- Bundle/inject/Profile drift, port conflict and reload leakage;
- excessive tool/status context, repeated scans and accounting duplication.

Each confirmed defect requires a regression test in the owning layer. Update stable architecture, contract, security or recovery documents only when their decision-bearing semantics change; dynamic implementation status stays in the selected pipeline authority. Logs alone are not closure evidence.

## 7. Permission and resource policy

Model usage is not constrained for cost or forced convergence unless the user requests it. Fault containment remains mandatory:

- bounded concurrent writers and processes;
- cancellable commands with explicit timeout and captured result;
- retry/recursion detection and stale-generation fencing;
- disk, artifact, mailbox, attempt and diagnostic retention limits;
- deny write access to stable control artifacts, storage roots, secrets and evidence checkouts;
- recoverable cleanup and a tested rollback path.

These controls protect correctness and host availability; they are not billing policy.

## 8. Promotion rule

The first releases use manual external promotion. Automation may later perform the mechanical switch only after all configured gates accept and only from a controller that is not loaded from the candidate artifact. No Agent, reviewer, candidate Profile, UI or prompt message can alone mark a candidate promoted.

## 9. Control-plane hardening ops (issue #122, D2 precondition)

The D2 security review (`docs/reviews/2026-08-22-d2-security-review.md`, verdict CONDITIONAL) found the candidate-execution boundary held only at the interface layer: candidate code executing in the freeze worktree, the acceptance verification root and the booted acceptance plane ran with the promoter's authority and inherited the PM session environment. Iteration 1 (issue #122) closes the executable part in code and documents the OS-level part here as a deployment runbook.

### 9.1 Closed in code (verified by `tests/promotion-contract.spec.ts` and the P0–P7+H drill)

| Face | Closure |
|---|---|
| env credential boundary (F2) | every promotion-lane child (`runner.mjs` `run`/`bootPlane`) spawns under an env allowlist (PATH/PATHEXT/SYSTEMROOT/COMSPEC/SYSTEMDRIVE/OS/TEMP/TMP/DSH_HOME) plus explicit injections — model keys, tokens and arbitrary PM session state are invisible to candidate code; verified live (pnpm/git/tar/CLI boot + `host.describe` all green under the sealed base) |
| dependency lifecycle scripts (F1a) | repo-level installs in the freeze worktree and the acceptance verification root run `pnpm install --frozen-lockfile --ignore-scripts`; `pnpm pack` runs under `npm_config_ignore_scripts=true` (pack rejects the flag itself) so prepack/postpack cannot execute with PM authority — closing the asymmetry the review flagged (tarball-side installs already used the flag) |
| verdict strength (F4) | promote accepts a verdict only with the full eight-name gate vocabulary (seven evidence-carrying gates, each name + `pass` + digest — three-fold presence), re-digested evidence against the accepted ledger record's drill evidence tree, and a verdict-file digest cross-check against that record's `verdictRef` |
| chain-tail anchor (F5, OQ-11 reversal) | every successful promote writes a LOCAL annotated tag `d2-ledger-<gen>` (`.seq`-suffixed on gen-number reuse) whose message carries the promoting record's full `recordSha256`; `status --repo` verifies the latest promotion's tail against it, so a whole-chain recomputation is detectable without a key; tags are never pushed (credentials face stays out) |
| half-applied promote (F3) | establishGeneration failure after the stable install triggers compensation re-install of the previous generation's tarball; `status` reconciles the installed Profile bytes against the pointer generation's tarball (deterministic content digest); `repair.mjs` re-anchors a pointer/ledger divergence onto the hash-chained ledger tail after explicit `--yes` (dry-run by default) and refuses a broken chain as evidence tampering |
| quiesce fail-safe (F6) | a parseable authority unit with `tables.teams` pruned, or an empty unit file, counts as ACTIVE (blocks promotion); only an absent file (fresh root) reads quiet |
| residue-report integrity (F9) | an execution-root marker whose recorded path does not match its directory is treated as unreadable (orphan without identity) — a worker-copied marker cannot steer residue reports |

### 9.2 Residual candidate-script surface (honest statement)

`pnpm build` in freeze, and the acceptance lanes (`pnpm <lane>`), still execute candidate-defined scripts with PM authority — that execution IS the verification. The env seal removes their credential visibility, and the promotion state machine refuses self-promotion, but file-write authority during those lanes equals the promoter's until the OS-level demotion below is deployed. Until then the D2 posture remains "controlled opening" (PM supervision, single-writer, candidate source = this team's loop).

### 9.3 OS-level demotion runbook (deployment option — needs an environment decision)

Full demotion runs the freeze/acceptance lanes under a principal that CANNOT write the protected faces. Two deployment forms; both are PM-side operational steps, deliberately not automated into the lanes:

**Option A — low-privilege local account (recommended for the real dogfood root).**

1. Create a dedicated local account, e.g. `d2lane` (no admin group membership).
2. Grant it read/execute on the checkout and the dogfood root, deny write on the protected faces:

```powershell
# protected faces of the control plane (adjust <dogfood-root> to the real root)
$root   = 'D:\Source\DSH\dogfood\dsh-agent-swarm'   # lkg/ ledger/ control/ live here
$repo   = 'D:\Source\DSH\plugin\dsh-agent-swarm'    # stable checkout (promoter identity)
# read/execute everything under the roots ...
icacls $root /grant 'd2lane:(OI)(CI)RX'
icacls $repo /grant 'd2lane:(OI)(CI)RX'
# ... then deny write on the authoritative faces (test on a drill copy first)
icacls "$root\lkg"        /deny 'd2lane:(OI)(CI)W'   # LKG generations + pointer
icacls "$root\ledger"     /deny 'd2lane:(OI)(CI)W'   # promotion ledger (hash chain)
icacls "$root\control"    /deny 'd2lane:(OI)(CI)W'   # stable control home/storage/sessions
icacls "$root\candidates" /deny 'd2lane:(OI)(CI)W'   # frozen evidence (immutable once written)
# the host stable face: the account's own writes must never reach it
icacls "$env:USERPROFILE\.dsh" /deny 'd2lane:(OI)(CI)W'
```

3. Run the lanes as that account (`runas /user:d2lane` or a scheduled task carrying the lane command); the promoter itself stays on the PM identity.
4. Verify the fence before relying on it: as `d2lane`, `echo x > <dogfood-root>\ledger\probe` must FAIL; as the PM it must succeed. Remove the probe file afterwards.

**Option B — deny-write ACL on the drill domain (lighter, drill-applicable).** The same `icacls ... /deny` command set applied to a DRILL-ONLY dogfood root's `lkg`/`ledger`/`control`/`candidates` directories before the failure-injection phases; the drill then proves the injection cannot mutate the anchored faces even when the injected code holds the lane's authority. Applicable where creating accounts is not possible; it does not protect the host `~/.dsh` (that face needs Option A's separate principal).

**Windows reality (why this is a runbook, not code):** creating principals, scheduled-task delegation and per-process tokens are host-administration decisions outside this repository's authority. The code-level guarantees (env seal, script-free installs, digest/anchor verification) hold regardless; this runbook closes the write-authority gap when the deployment chooses to. Until a deployment decision is made, this section is the honest record that OS-level demotion is NOT yet active on the real dogfood root.
