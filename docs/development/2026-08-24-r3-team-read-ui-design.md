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

The wide-screen Team column includes a header action named “Show tool details”.
It is a one-way handoff, not a second Tool Details implementation and not a
two-way toggle. Activating it immediately releases the Team occupant, stops the
Team read lifecycle and returns the Team controller to inactive, while leaving
the official details column open. The unchanged official Tool Details occupant
then renders in the same column. The user returns to Team by pressing the
persistent Team button again.

## Official seams and ownership

- `conversation.session.header.utilities` remains the additive,
  Session-scoped Team action seat. It receives the framework-owned `sessionId`.
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
| docked expanded | Show tool details | release Team entry, stop reads and become inactive; do **not** call `closeDetails()` | official Tool Details |
| expanded Team | Captain Chat | complete the fresh R2 binding proof, close/release Team through the coordinator, then navigate through official Sessions | inactive |
| any Team surface | Session changes/disappears | release entry, close Team-opened details, abort old-root reads and clear presentation | inactive |
| docked expanded | Team entry render error | fail inactive, stop reads and keep details open so the official occupant is the fallback | official Tool Details |
| expanded | crosses responsive threshold | atomically migrate docked <-> Peek without restarting reads or rendering both | expanded |
| active plugin | unload/HMR | stop admission/reads, release entries/listeners/styles and prevent later re-registration | official-only |

Opening is fail-closed. Registration occurs through
`slots.inject('details', ...)` so it follows declaration
collapse/redeclaration during official HMR. After registration, the coordinator
checks the public slot-ledger winner. Priority collision, declaration mismatch,
third-party lower-priority winner or `openDetails()` failure rolls back the Team
entry and controller. Rapid inputs are serialized and there is at most one Team
details entry.

The coordinator subscribes to the official Session list/current snapshot. A
Session-scoped component returning `null` is not cleanup: the global slot
contribution is disposed when the target changes. It handles only its exact
entry identity on `slots.onEntryError`; official or third-party errors are not
swallowed.

## Interaction and accessibility

- The persistent Team button alone reports Team visibility through
  `aria-expanded`; it is false after Tool handoff even while official Tool
  Details remains open.
- “Show tool details” is a named one-way action. It has no `aria-pressed` or
  `aria-expanded`, remains usable without a selected tool and lets the official
  panel render its own empty state.
- Because the Tool action unmounts itself, handoff queues focus back to the
  persistent Team button and announces “Tool details shown” through a polite
  live region.
- Tool rows may update the official hidden selection while Team is docked, but
  public DSH exposes no event for automatic takeover. The user explicitly
  presses “Show tool details” to reveal the current official selection.
- Docked Team does not close on an outside Chat click. Escape closes only when
  focus is in the Team column or its header controls and restores Team-button
  focus. Peek modes retain their accepted outside-pointer and Escape behavior.
- The plugin does not claim keyboard resizing; the official rc.2 drag handle is
  pointer-owned.

## Locale and theme

Swarm registers complete `zh` and `en` dictionaries through official
`ctx.locale` and binds every Team slot entry to that namespace. Mounted Team
controls and surfaces update on the same page when DSH locale changes; the
plugin stores no independent language preference.

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
  priority `-1` winner while docked, rollback, close ordering, one-way Tool
  handoff without `closeDetails()`, rapid-toggle uniqueness,
  declaration collapse/rebind, entry-error fallback and idempotent disposal;
- Session switch and target disappearance proving entry release and physical
  read abort;
- responsive tests proving atomic docked/Peek migration, real compact summary,
  and no details entry or Tool action below the threshold;
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
  drift, private layout/DOM access and official checkout changes.

## Non-goals

No official DSH source/config/lock change, permanent replacement of Tool
Details, automatic tool-row takeover, Tool-state mirror, historic layout-width
restoration, Team mutation, human-principal claim, direct effect, Chat parsing,
Canvas component reuse, Canvas theme integration, public package release or
private official import is part of this slice.
