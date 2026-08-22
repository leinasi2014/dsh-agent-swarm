# 2026-08-23 worktree cleanup ledger

Status: `ARCHIVED_WORKTREE_ONLY`. The worktree directories were retired after all writers stopped. These records preserve local candidate identity; they do **not** mean the candidates were reviewed, accepted, merged, or released.

| Archived branch | Exact candidate SHA |
|---|---|
| `codex/dual-plugin-architecture-realignment` | `6e9ea9141ab49fd365ec2d1aae843c0221775066` |
| `codex/single-host-ui-integration` | `4c6de300e6bdd85ff179933ab96866194539c7aa` |
| `feat/ui-panel-s0-s1` | `2cf4a4e0185eb7c922bc6a217fdcecf2ec7e8c68` |
| `codex/m5-h4-actionable-dual-surface` | `004a70df02ca9f7eabe66f646ab1035b9696f5a8` |
| `codex/m5-h4-visual-gate` | `496eb84e2b94db14f7a21b430c3228f7e1765c29` |
| `codex/m5-h4a-host-rpc` | `714e10ac676a986730a15fa4ca9f8631c46a34cc` |
| `codex/m5-h4a2-effect-correlation` | `0317e040664a353c971b152e76e1ef3297b86589` |
| `codex/m5-h4a3-context-registry` | `1303404ec0a94434a1eea79e760de9ba8fdb907a` |
| `codex/m5-h4a3-host-service` | `62defca141854886a59f7c7dcf8d2d3a8025db67` |
| `codex/m5-h4a3-integration` | `cafee9a6c467fd808d48f2b9856cbe151ccc4348` |
| `codex/m5-h4a3-panel-projection` | `19e578399ea9adeef0d63eb4957f65473e85483a` |
| `codex/m5-h4a3d-host-service` | `7b493879cc2d79e31dc7dfb1b9ecd348fc0a74a2` |
| `codex/m5-h4a3e-host-hardening` | `591e2667f9d09673389b3fe2d57a147406acbb49` |
| `codex/m5-h4a3f-bounded-overlay` | `99da4812bd6fa853b55abb9c52d40e3077785474` |
| `codex/m5-h4a4-gatea` | `12ad56c0ad0a3d3e33256249c72e2507139800be` |
| `codex/m5-h4a4-rpc` | `3e659d972751e19a3334796f8986b1b91c17a938` |
| `codex/m5-h4a4-typert-spike` | `fd8b0ad695442f53233934d82645a7c69d63a205` |

Two interrupted trees were made recoverable before retirement: the host-service contract baseline was preserved at `62defca141854886a59f7c7dcf8d2d3a8025db67`, and the H4a3 integration delta was preserved at `cafee9a6c467fd808d48f2b9856cbe151ccc4348`.

To resume one candidate, first pass `pnpm verify:worktrees`, then recreate only that branch under `.worktree/<task>`. After review, close it as `INTEGRATED` or keep the branch/SHA as `ARCHIVED`; either outcome removes the worktree in the same closeout action.
