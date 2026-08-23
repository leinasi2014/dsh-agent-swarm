# R3 Team read UI and Captain Chat handoff

- Status: presentation revision candidate
- Base: `0a62e839670f5a0467bfa322c58f39b10aa8f894`
- Official DSH: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Lane: S2/MEDIUM UI consumer with one S3/HIGH identity-sensitive handoff
- Scope: Swarm package only; official DSH remains a read-only validation host

## Outcome

R3 adds the first DSH-native browser surface for the accepted R2 read contract. Its presentation is an icon-only Session-header utility immediately after Session log that controls a plugin-owned, non-modal anchored Peek Card, not a replacement conversation view. The control cycles closed → expanded → compact → closed: expanded is the complete 400–420px read surface, while compact is a smaller right-side card containing only the real Team name, phase and member/task/pending counts. There is no duplicate close button inside either card. On desktop both modes retain viewport clearance; at widths up to 720px the expanded card alone fills the horizontal viewport while the Session header and Team trigger remain visible. It reads only the packed public `/swarm/v1` client and shows the exact Host-projected Team, roster, tasks, attempts, budget, pending interactions and capability ceiling.

The action can be invoked from any displayed Session, but the browser Session id is only a target hint. The R2 Host must independently prove that it is the exact live root Agent/Session/roots/workspace/Captain binding before any Team data renders.

## Official seams

- `conversation.session.header.utilities` is the additive, Session-scoped right-header entry point. It receives the framework-owned `sessionId`; it does not replace the official header or Chat.
- `shell.overlay` is the additive root-level floating layer. The direct plugin wrapper remains pointer-transparent and only the card accepts pointer input, so the uncovered official Chat remains interactive. The card uses official `Button`, icons, `Pill`, state primitives, `useAnchoredPosition` and `--dsw-*` theme tokens; official DSH exposes no public non-modal Drawer primitive. A plugin-owned wrapper supplies the DOM anchor because the official function-component `Button` does not forward refs.
- The card has no backdrop, focus trap or `aria-modal` claim. The same Team button owns the three-state cycle; `aria-expanded` stays true in expanded and compact modes and becomes false only when closed. Escape closes directly and restores focus to the trigger. An outside pointerdown also closes directly without cancellation or focus restoration, so the original Chat interaction continues. Compacting does not restart or stop the read lifecycle. The 720px responsive rule changes only expanded-card horizontal geometry, not data ownership or interaction authority, and never covers the trigger.
- `ctx.locale.register()` owns bilingual copy and follows the official live locale.
- `ctx.sessions.open(rootSessionId)` is the only navigation operation. The plugin does not manipulate URLs, click DOM-owned tabs or import package-private Chat stores.
- Cordis effects and slot registrations own unload. The read controller aborts every in-flight fetch and timer on close or disposal.

The official conversation package exposes no public `setView` operation. Its view selection is a package-private Chat store action. R3 therefore keeps Chat authoritative and displays Team in the Peek Card; “Open Captain Chat” closes the card after official Session navigation rather than reaching into private view state. The plugin does not register the single-owner `details` seat because doing so would replace official Tool Details.

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
- slot registration/unregistration, locale, icon expanded/compact/closed cycle, non-modal semantics, keyboard/Escape focus return and accessible controls;
- Captain handoff success plus forged root, non-Captain, Session switch and missing Session negatives;
- packed client bundle purity and exact Host/client contract identity;
- fresh isolated official Profile with a real live root/Captain Team, explicit browser locator/version, zero unclassified console/page errors, expanded/compact/680px screenshots, anchor gap plus desktop/narrow viewport clearance, trigger visibility/selected state, exact expanded→compact→closed cycle, Escape and outside-pointer dismissal, proof that the original outside click focuses official Chat, exact official `dsh.sessions.current` root binding after Chat handoff and reload, disable/unload and R0 proof. The retained evidence verifier requires all three screenshots and validates the expanded, compact and narrow rectangles, non-modal facts and each close path; its negative fixtures reject forged narrow/compact geometry and missing interaction facts. The fixture first adopts the path through official `workspace.create` and creates the root with that `workspaceId`; a test-only probe appends and flushes one empty closed turn only when the exact root has no existing turn, so the Session is nonblank without LLM/network or a fabricated human message and reload never duplicates it. Official list/accounting evidence must prove the attached Workspace, nonblank Session and exact root before UI acceptance. The fresh browser context then seeds only the pinned official SessionRuntime selection key before load; evidence binds its key/value and official source blob/digest, while R2 still independently reauthorizes the framework-emitted target hint. R0 follows the official loader rather than retaining a disabled UI: the disabled inventory row, absent Team action/dashboard and zero rendered Team data are required in the zero-console browser, while a runner-owned Node fetch must observe the exact rc.2 Host fallback triple (`405`, zero UTF-8 body bytes, null content-type) before owner/unregistered status is derived; remove proves package/inventory disappearance. The proof handles the optional official onboarding sequence only through its real accessible keyboard actions: Continue for the testing notice, then Configure later for API-key setup; it records both steps and never enters or fabricates a key;
- full project verification, clean official before/after evidence and non-author candidate review.

## Non-goals

No Team/overlay mutation, human-principal claim, direct effect, Chat-text interpretation, Canvas component reuse, public package release or official DSH source/config/lock change is part of R3.
