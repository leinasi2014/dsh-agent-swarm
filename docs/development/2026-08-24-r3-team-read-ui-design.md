# R3 Team read UI and Captain Chat handoff

- Status: implementation candidate
- Base: `768828ee21c16727bc0a7deae8c1a39e365d6481`
- Official DSH: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Lane: S2/MEDIUM UI consumer with one S3/HIGH identity-sensitive handoff
- Scope: Swarm package only; official DSH remains a read-only validation host

## Outcome

R3 adds the first DSH-native browser surface for the accepted R2 read contract. It is an additive Session-header action that opens an official overlay, not a replacement conversation view. The overlay reads only the packed public `/swarm/v1` client and shows the exact Host-projected Team, roster, tasks, attempts, budget, pending interactions and capability ceiling.

The action can be invoked from any displayed Session, but the browser Session id is only a target hint. The R2 Host must independently prove that it is the exact live root Agent/Session/roots/workspace/Captain binding before any Team data renders.

## Official seams

- `conversation.session.header.actions` is the additive, Session-scoped entry point. It receives the framework-owned `sessionId`; it does not replace the official header or Chat.
- `shell.overlay` is the additive root-level floating layer. The panel uses the official `Modal`, `Button`, `Pill` and state primitives and only `--dsw-*` theme tokens.
- `ctx.locale.register()` owns bilingual copy and follows the official live locale.
- `ctx.sessions.open(rootSessionId)` is the only navigation operation. The plugin does not manipulate URLs, click DOM-owned tabs or import package-private Chat stores.
- Cordis effects and slot registrations own unload. The read controller aborts every in-flight fetch and timer on close or disposal.

The official conversation package exposes no public `setView` operation. Its view selection is a package-private Chat store action. R3 therefore keeps Chat authoritative and displays Team in an overlay; “Open Captain Chat” closes the overlay after official Session navigation rather than reaching into private view state.

## Read lifecycle

1. Opening captures one target root Session hint and creates one bounded refresh generation.
2. The controller checks the packed R2 capability response, then requests binding and snapshot.
3. Tasks, attempts and pending interactions are read through strict pages bounded by the R1 ceilings (100/200/100 rows). Every page must retain the same cursor, totals and truncation state, `nextOffset` must advance exactly, stable row ids cannot repeat, and the terminal aggregate must equal `visibleTotal`. A cursor change discards the partial aggregate and restarts once from a fresh snapshot.
4. A successful refresh schedules a bounded poll. A later failure preserves the last complete projection as stale, reports the bounded error and retries. Initial failure has no data and renders an error state.
5. Close, Session-target change, plugin unload and component unmount abort physical requests. No hidden closed panel performs reads.

## Captain Chat handoff

The handoff never trusts the panel's cached identity. It performs a fresh packed R2 `binding` request for the exact root Session and Team, verifies that the response matches the panel identity, checks that the official client Session list still contains that root, then calls `ctx.sessions.open(rootSessionId)` and closes the panel. A deleted, archived, switched or mismatched target fails closed and leaves the panel open.

This is target-bound local-single-user navigation, not authentication or a human principal. It does not parse Chat text, manufacture typed Control, call a `/swarm` write method or execute a Team effect.

## Verification

- packed server-to-client contract tests for every rendered field and capability ceiling;
- strict pagination, mixed cursor, target switch, retry/stale and abort/dispose tests;
- slot registration/unregistration, locale, keyboard/Escape and accessible dialog/controls;
- Captain handoff success plus forged root, non-Captain, Session switch and missing Session negatives;
- packed client bundle purity and exact Host/client contract identity;
- fresh isolated official Profile with a real live root/Captain Team, explicit browser locator/version, zero unclassified console/page errors, real render, screenshot, keyboard path, exact official `dsh.sessions.current` root binding after Chat handoff and reload, disable/unload and R0 proof;
- full project verification, clean official before/after evidence and non-author candidate review.

## Non-goals

No Team/overlay mutation, human-principal claim, direct effect, Chat-text interpretation, Canvas component reuse, public package release or official DSH source/config/lock change is part of R3.
