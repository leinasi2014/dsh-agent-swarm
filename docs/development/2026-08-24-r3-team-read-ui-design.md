# R3 Team read UI, Tool Details handoff and Captain Chat

- Status: architecture revision candidate
- Supersedes presentation details in the earlier Peek-only revision of this document
- Official DSH baseline: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Lane: S3/HIGH for the reversible runtime replacement; S2/MEDIUM for the read-only UI
- Scope: Swarm package only; official DSH remains an unchanged validation host

## Outcome

R3 adds a DSH-native browser consumer for the accepted R2 read contract. The
Session-header Team button remains immediately after Session log and keeps the
three-step product interaction:

```text
closed -> expanded -> compact -> closed
```

`expanded` is responsive. At a proven safe wide-screen threshold it is a real
DSH details-column surface, so the official center Chat is recomputed rather
than covered. Below that threshold it is the existing non-modal anchored Peek
Card. `compact` is always the small right-side Peek Card containing only the
real Team name, phase and member/task/pending counts. Neither Team surface has
a duplicate close button.

The Session header also contains a persistent “Show tool details” action
immediately beside the Team button. It is the other side of the visible surface
switch at the safe width, but the plugin does not infer or store an official
Tool-active state.
Activating it releases any Team occupant, stops the Team read lifecycle, returns
the Team controller to inactive and calls `openDetails()` without ever calling
`closeDetails()`. The unchanged official Tool Details occupant then renders in
the same column. Pressing it while Team is already inactive simply opens the
official details column. The user returns to Team by pressing the adjacent Team
button. Below the safe threshold, the action remains visible and focusable for
layout stability but is `aria-disabled`; activation leaves Team unchanged and
the persistent live region explains that Tool Details requires a wider window.

## Official seams and ownership

- `conversation.session.header.utilities` remains the additive, Session-scoped
  action seat. One plugin registration renders the adjacent Team and Tool
  Details actions as a stable pair and receives the framework-owned `sessionId`.
- `details` is the official `single/session` column seat. Official
  `ui-conversation` occupies priority `0`. DSH's public Slot contract permits
  different-priority entries in one cell and renders the lowest live priority.
  Swarm may register a temporary priority `-1` occupant only while
  `expanded` is docked. It declares no child slot and never registers
  `conversation.details.tool`.
- `ctx.layout.openDetails()` and `closeDetails()` are the only layout writes.
  Swarm does not read private layout stores, set widths, query official DOM or
  CSS-module classes, modify `grid-template-columns`, or import private Chat
  selection state.
- `shell.overlay` remains the additive surface for expanded Peek fallback and
  compact summary.
- Slot priority shadowing here is a bounded, reversible UI composition
  operation. It does not shadow an official Service, canonical state,
  authorization owner or Agent Runtime. Official Tool Details remains
  registered and automatically becomes the winner when Team releases its
  temporary entry.
- `ctx.sessions.open(rootSessionId)` remains the only Captain Chat navigation
  operation.

The plugin can prove restoration of the official Tool Details occupant and its
functionality. The public layout face does not expose the prior details
open/closed state, rendered width or a restore token, so R3 does not claim to
restore arbitrary historic layout geometry. Tool handoff deliberately keeps the
current column open; an ordinary Team close deliberately closes it.

## Surface coordinator

One non-React coordinator owns the temporary details entry, responsive mode,
target Session and shutdown order. React components never register or dispose
slots themselves.

The controller continues to own Team data and the product presentation
`expanded | compact`; the coordinator derives the concrete surface:

```text
expanded + safe wide frame -> TEAM_DOCKED
expanded + smaller frame   -> TEAM_PEEK
compact                    -> TEAM_COMPACT_PEEK
closed                     -> INACTIVE
```

The initial safe threshold is 1440 CSS px. It is intentionally above the
official rc.2 maximum-sidebar + minimum-center + default-details sum
(`420 + 640 + 360 = 1420`). The real Profile proof must verify that the DSH
AppFrame occupies the tested viewport and that the details column remains
non-zero. If a future host embeds a narrower AppFrame or official geometry
changes, Gate A revises the threshold or falls back to Peek; the plugin does not
inspect private frame geometry to force docking.

### Transitions

| Current | Event | Ordered behavior | Next |
|---|---|---|---|
| inactive | Team at safe width | register `details/-1`, verify Team is the public slot winner, start/open Team reads, call `openDetails()` | docked expanded |
| inactive | Team below threshold | start/open reads without a details registration | expanded Peek |
| docked expanded | Team | call `closeDetails()`, release Team entry, retain the read generation and render compact Peek | compact Peek |
| expanded Peek | Team | retain the read generation and render compact Peek | compact Peek |
| compact Peek | Team | stop reads and close | inactive |
| docked expanded | adjacent Tool Details | release Team entry, stop reads and become inactive; do **not** call `closeDetails()`, then call `openDetails()` | official Tool Details |
| inactive/Peek/compact at safe width | adjacent Tool Details | close any Team Peek/read state, release any Team entry without `closeDetails()`, then call `openDetails()` | official Tool Details |
| any state below safe width | adjacent Tool Details | keep the current Team state; announce that Tool Details requires a wider window | unchanged |
| expanded Team | Captain Chat | complete the fresh R2 binding proof, close/release Team through the coordinator, then navigate through official Sessions | inactive |
| any Team surface | Session changes/disappears | if docked, call `closeDetails()` before releasing Team; abort old-root reads, move focus and clear presentation | inactive |
| docked expanded | Team entry render error | fail inactive, stop reads and keep details open so the official occupant is the fallback | official Tool Details |
| docked expanded | crosses below safe threshold | call `closeDetails()`, release Team entry, then commit Peek; retain the read generation | expanded Peek |
| expanded Peek | crosses into safe threshold | register and verify Team winner, call `openDetails()`, then hide Peek; on any acquisition failure keep Peek unchanged | docked expanded or expanded Peek |
| Swarm fiber | unload/HMR | close admission, advance coordinator epoch and clear desired state; stop reads; release entry/listeners/styles without changing layout; forbid late registration | from docked: official Tool Details in the still-open column; from Peek/inactive: prior layout unchanged |
| official details declaration | collapse/redeclare | clear the old lease and entry identity; if the same live coordinator still desires docked Team for the same Session at safe width, run the epoch-fenced two-phase rebind below | docked Team or visible Peek/inactive with zero Team entries |

Opening is fail-closed. `slots.inject('details', ...)` does not unconditionally
register Team. Its callback lends the coordinator one declaration-lifetime
registration seat/factory. Only `desired === TEAM_DOCKED` may use that seat.
Callback cleanup releases its exact entry, clears the identity and invalidates
the old disposer. After registration, the coordinator checks the public
slot-ledger winner. Priority collision, declaration mismatch or a third-party
lower numeric rank rolls back acquisition. A fresh opening that cannot acquire
or call `openDetails()` returns inactive; migration from an existing Peek keeps
that Peek visible and its reads alive. Rapid inputs are serialized and there is
at most one Team details entry.

Official declaration HMR and Swarm HMR are different lifecycles. An official
collapse/redeclare may reacquire one lease only when the still-live coordinator
has the same target, remains at safe width and still desires docked Team. Swarm
unload first closes admission and clears desired state, so declaration changes
cannot resurrect it; it then releases Team without closing the official column.

Official redeclaration rebind is two-phase because the new layout store starts
closed and its public actions are not wired until the new root first renders.
Phase 1 registers Team under the new declaration, verifies the exact winner and
keeps the prior Peek visible (or remains inactive). Phase 2 waits for the
current public layout face to become callable, invokes exactly one
`openDetails()` under the same coordinator/declaration epoch, and commits docked
only after the real column is non-zero in Profile evidence. A stale epoch,
timeout or call failure releases the tentative entry and keeps Peek visible (or
inactive); it never leaves an invisible winning Team entry.

The coordinator subscribes to the official Session list/current snapshot. A
Session-scoped component returning `null` is not cleanup: the global slot
contribution is disposed when the target changes. It handles only its exact
entry identity on `slots.onEntryError`; official or third-party errors are not
swallowed.

## Interaction and accessibility

- The persistent Team button alone reports Team visibility through
  `aria-expanded`; it is false after Tool handoff even while official Tool
  Details remains open.
- The adjacent “Show tool details” action is persistent and named. It has no
  `aria-pressed` or `aria-expanded`, remains usable without a selected tool and
  lets the official panel render its own empty state at safe width. Below the
  threshold it exposes `aria-disabled="true"`; keyboard or pointer activation
  does not change the surface and announces the width requirement.
- Tool handoff returns focus to the still-mounted Tool action. Its announcement
  is rendered in a persistent polite live region owned by the header action
  pair, never inside the disappearing Team occupant.
- Tool rows may update the official hidden selection while Team is docked, but
  public DSH exposes no event for automatic takeover. The user explicitly
  presses “Show tool details” to reveal the current official selection.
- Docked Team does not close on an outside Chat click. Escape from the Team
  surface is one serialized transaction: `closeDetails()`, release Team, stop
  reads, become inactive and restore Team-button focus; it never passes through
  compact. Peek modes retain their accepted outside-pointer and direct-close
  Escape behavior.
- Every Team surface is the one `role="complementary"` region with a resolvable
  title and stable controls id. If Session switching removes the focused Team
  region, focus is moved to a stable action in the newly current Session before
  teardown instead of falling to `body`.
- The plugin does not claim keyboard resizing; the official rc.2 drag handle is
  pointer-owned.

## Locale and theme

Swarm registers complete `zh` and `en` dictionaries through official
`ctx.locale` and binds every Team slot entry to that namespace. Mounted Team
controls and surfaces update on the same page when DSH locale changes; the
plugin stores no independent language preference. The persistent coordinator
also subscribes to the public `ctx.locale` snapshot for the active locale id
used by formatters; the injected `t` seat remains the text refresh mechanism.

Finite protocol enums are translated through exhaustive locale-key maps.
Business data and diagnostic identifiers (Team/member names, roles, subjects,
intent, IDs, error codes and capability IDs) remain verbatim. Dates and
localized numbers use an explicit `zh-CN | en-US` mapping derived from the
active DSH locale, never parameterless browser/OS formatting.

Swarm uses official primitives and tokens only. It stores no theme preference,
writes no global theme class and follows the live DSH token cascade. Every
color, border, shadow, font and status treatment must resolve to a token present
in the pinned official baseline; CSS color literals, self-owned
`prefers-color-scheme` branches and unknown `--dsw-*` names fail verification.
Docked and Peek surfaces share one token set.

## Read lifecycle

1. Opening captures one target root Session hint and creates one bounded
   refresh generation.
2. The controller checks packed R2 capabilities, binding and snapshot.
3. Tasks, attempts and pending interactions use the unchanged strict bounded
   pagination and cursor invariants.
4. Successful refresh schedules a bounded poll. Later failure preserves the
   last complete stale projection; initial failure renders an explicit error.
5. Close, Tool handoff, Session change, unload and disposal abort physical
   requests. No hidden or handed-off Team panel reads.

## Captain Chat handoff

Captain handoff re-reads packed R2 binding for the exact root Session and Team,
verifies panel identity and the official Session list, then calls
`ctx.sessions.open(rootSessionId)`. Deleted, archived, switched or mismatched
targets fail closed and leave the Team surface visible.

This remains target-bound local-single-user navigation, not authentication or a
human principal. It does not parse Chat, manufacture Control, call a `/swarm`
write method or execute a Team effect.

## Verification

Author and non-author acceptance bind the exact package candidate and include:

- slot/coordinator tests for official priority `0` while inactive, one Team
  priority `-1` winner while docked, rollback, close ordering, adjacent Tool
  handoff with zero `closeDetails()` delta, rapid-toggle uniqueness,
  declaration collapse/rebind, entry-error fallback and idempotent disposal;
- declaration lifecycle negatives proving inactive collapse/redeclare keeps
  zero Team entries, docked redeclaration reacquires exactly one, and Swarm
  unload during a declaration gap can never register later. Rebind also proves
  exactly one current-face `openDetails()`, non-zero details width and Chat
  reflow only after the layout face is wired; stale/failed rebind retains Peek
  or inactive with zero Team entries;
- Session switch and target disappearance proving entry release and physical
  read abort;
- responsive tests proving atomic docked/Peek migration, real compact summary,
  and below-threshold zero Team details entries, zero details-column width,
  restored Chat width and one Peek. The persistent Tool action is focusable but
  aria-disabled and announces its width requirement. Failed dock acquisition
  keeps Peek intact;
- locale tests switching DSH `zh -> en -> zh` while docked and Peek remain
  mounted; exhaustive enum and locale-aware time formatting; official theme
  `light -> dark -> system` token-resolution evidence with no plugin preference;
- existing R2 strict read, Captain handoff, bundle-purity and lifecycle tests;
- a fresh official Profile proving real third-column Chat reflow; Team/Tool
  handoff at unchanged non-zero column width; official DetailsPanel, empty or
  selected-tool content and official close behavior; Team reopen; three-click
  expanded -> compact -> closed; 680px Peek; Session switch; HMR/reload/disable/
  unload/R0; zero stale reads, duplicate entries, unclassified errors or
  non-read RPC;
- negative evidence rejects residual Team DOM/entries after Tool handoff,
  `closeDetails()` during Tool handoff, narrow details registration, duplicate
  trigger/entry, stale target reads, missing official fallback, locale/theme
  drift, private layout/DOM access and official checkout changes. Tool handoff,
  Team render error and Swarm unload separately prove the official priority-0
  winner; unload additionally proves no read/listener and no later resurrection.

## Non-goals

No official DSH source/config/lock change, permanent replacement of Tool
Details, automatic tool-row takeover, Tool-state mirror, historic layout-width
restoration, Team mutation, human-principal claim, direct effect, Chat parsing,
Canvas component reuse, Canvas theme integration, public package release or
private official import is part of this slice.
