# Testing and debugging

## Test strategy

- official compatibility gate: remote SHA, package visibility/exports, Profile composition and superseded-claim search;
- pure behavior tests for transformations;
- Provider conformance suite;
- lifecycle/reload tests;
- crash/fault matrix;
- real Loader composition;
- model-visible snapshot;
- selective real-provider e2e;
- client mount/dispose tests.

## Debug order

### Plugin absent

1. build artifact exists;
2. main/exports/files agree;
3. function vs default export shape;
4. Bundle manifest and patch;
5. `--dump-config` row/layer;
6. required inject Provider exists;
7. host logs.

### Client absent

1. `./client` export exists;
2. `dsh.client` metadata correct;
3. client bundle registers full package id;
4. client `inject` services exist;
5. browser console/network;
6. slot kind/scope/key;
7. disposer/HMR.

### Team stuck

1. authoritative Team/task/run snapshot;
2. live Agent status and lineage;
3. current revision/attempt;
4. mailbox queued/delivered ids;
5. scheduler admission queue;
6. budget/workspace/review blockers;
7. disposal/recovery logs.

## Windows

Test EPERM/locked rename, UTF-8, drive/UNC normalization, PowerShell semantics and Worktree cleanup. Do not solve a locked atomic rename by ignoring write failure; use documented retry/fallback while preserving durability semantics.
