# R3 native Team Details UI

- Status: implementation candidate
- Base: `1d472a91718c7d07b9c65c110d2cbdce7784a982`
- Official DSH: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Lane: S2/MEDIUM UI consumer
- Scope: Swarm package only; official DSH remains a read-only validation host

## Outcome

R3 adds the first DSH-native browser surface for the accepted R2 read contract. It is an additive Session utility that temporarily occupies the official Details column, not a replacement conversation view. The panel reads only the packed public `/swarm/v1` client and shows the exact Host-projected Team, roster, tasks, attempts, budget, pending interactions and capability ceiling.

The action can be invoked from any displayed Session, but the browser Session id is only a target hint. The R2 Host must independently prove that it is the exact live root Agent/Session/roots/workspace/Captain binding before any Team data renders.

## Official seams

- `conversation.session.header.utilities` is the additive, Session-scoped entry point. It receives the framework-owned `sessionId`; it does not replace the official header or Chat.
- A priority-`-1` public `details` lease is the only Team body surface. `ctx.layout.openDetails()` and `closeDetails()` leave Chat geometry and narrow-screen Details concession to the official AppFrame. There is no `shell.overlay`, Modal, full-screen or fixed fallback.
- `ctx.locale.register()` owns bilingual copy and follows the official live locale.
- Cordis effects and slot registrations own unload. The read controller aborts every in-flight fetch and timer on close or disposal.

The official conversation package exposes no public `setView` operation. Its view selection is a package-private Chat store action. R3 therefore keeps Chat authoritative and projects Team in Details without importing package-private state.

## Read lifecycle

1. Opening captures one target root Session hint and creates one bounded refresh generation.
2. The controller checks the packed R2 capability response, then requests binding and snapshot.
3. Tasks, attempts and pending interactions are read through strict pages bounded by the R1 ceilings (100/200/100 rows). Every page must retain the same cursor, totals and truncation state, `nextOffset` must advance exactly, stable row ids cannot repeat, and the terminal aggregate must equal `visibleTotal`. A cursor change discards the partial aggregate and restarts once from a fresh snapshot.
4. A successful refresh schedules a bounded poll. A later failure preserves the last complete projection as stale, reports the bounded error and retries. Initial failure has no data and renders an error state.
5. Close, Session-target change, plugin unload and component unmount abort physical requests. No hidden closed panel performs reads.

## Verification

- packed server-to-client contract tests for every rendered field and capability ceiling;
- strict pagination, mixed cursor, target switch, retry/stale and abort/dispose tests;
- Details priority lease registration/restoration, Team toggle aria state, Session switch/unload cleanup, locale rerender and no overlay/fallback;
- official AppFrame wide reflow and narrow Details concession/recovery browser evidence;
- packed client bundle purity and exact Host/client contract identity;
- fresh isolated official Profile with a real live root/Captain Team, explicit browser locator/version, zero unclassified console/page errors, real render, screenshot, Team toggle and Details reflow, disable/unload and R0 proof. The fixture first adopts the path through official `workspace.create` and creates the root with that `workspaceId`; a test-only probe appends and flushes one empty closed turn only when the exact root has no existing turn, so the Session is nonblank without LLM/network or a fabricated human message and reload never duplicates it. Official list/accounting evidence must prove the attached Workspace, nonblank Session and exact root before UI acceptance. The fresh browser context then seeds only the pinned official SessionRuntime selection key before load; evidence binds its key/value and official source blob/digest, while R2 still independently reauthorizes the framework-emitted target hint. R0 follows the official loader rather than retaining a disabled UI: the disabled inventory row, absent Team action/dashboard and zero rendered Team data are required in the zero-console browser, while a runner-owned Node fetch must observe the exact rc.2 Host fallback triple (`405`, zero UTF-8 body bytes, null content-type) before owner/unregistered status is derived; remove proves package/inventory disappearance. The proof handles the optional official onboarding sequence only through its real accessible keyboard actions: Continue for the testing notice, then Configure later for API-key setup; it records both steps and never enters or fabricates a key;
- full project verification, clean official before/after evidence and non-author candidate review.

## Non-goals

No Team mutation, Captain navigation, human-principal claim, direct effect, Chat-text interpretation, Canvas component reuse, public package release or official DSH source/config/lock change is part of R3.
