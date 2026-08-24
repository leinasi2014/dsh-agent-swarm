# R3 Team read UI — official three-column contract

Status: accepted product direction; implemented candidate requires exact-artifact browser proof and one non-author review.

Last reviewed: 2026-08-24.

## 1. Decision

The Team dashboard has one presentation only: the official DSH `details`
column. Opening Team acquires that public Slot seat and calls the public Layout
face; the official AppFrame recomputes `sidebar | Chat | details`, so Chat
really narrows. Pressing the Team icon again closes Team directly.

The former anchored Peek, compact card, three-click cycle, viewport-owned
`1440px` gate and `shell.overlay` registration are removed. Swarm does not
render a floating Team surface at any width and does not keep a second visual
implementation as a fallback.

```text
inactive --Team--> docked Team --Team--> inactive
                    |
                    +--Tool details--> official Tool Details
```

There is no Team close button. The persistent Team icon remains the direct
toggle. Escape closes only when focus is inside Team or its adjacent action
pair and restores focus to the Team icon.

## 2. Official ownership boundaries

Swarm consumes these public rc.2 seams:

- `conversation.session.header.utilities`: persistent adjacent Team and Tool
  actions;
- `details`: temporary priority `-1` Team occupant;
- `ILayout.openDetails()` / `closeDetails()`: request official column state;
- official Sessions service: exact Session target and Captain navigation;
- official LocaleRuntime and DSH theme tokens.

The priority-0 official DetailsPanel remains registered. Team only shadows it
while its own entry is the public Slot winner. Releasing Team restores the
unchanged official occupant; Swarm never copies Tool Details or stores Tool
selection/state.

Swarm does not modify official DSH source, private stores, DOM structure,
inline grid styles, CSS breakpoints, or panel preferences. It does not inject a
runtime grid override. Gate A must be revisited if the public Slot, Layout,
Session, Locale, or token contracts change.

## 3. Responsive behavior belongs to DSH

The official AppFrame owns concession. At the pinned baseline it targets a
640px Chat center, a minimum 300px details track, and a 56px collapsed sidebar.
Consequently the host can derive the details track to zero below its supported
three-column width even when `openDetails()` retains the preference.

That host decision is not replaced by Peek. While the host has details
conceded:

- the Team entry and read generation remain attached to the selected Session;
- no floating Team UI appears;
- the Team icon remains active and can close the request;
- widening the host automatically restores the same official details column;
- Tool Details has the same official visibility limitation.

The browser proof covers both a width where the official details track is
visible and a narrow width where it is officially zero. A narrow screenshot is
evidence of host concession and absence of floating fallback, not evidence that
Team is visible there.

## 4. State and lifecycle ownership

`TeamDashboardController` owns only read lifecycle:

```text
closed | loading | ready | stale | reconnecting | error
```

It has no presentation enum and no UI cycle. Opening starts the exact
Session-bound read; closing aborts requests and timers. The surface coordinator
is the sole owner of the temporary details entry and the two-state UI contract:

```text
inactive | docked
```

The coordinator commits `docked` only after all of these succeed:

1. the official `details` declaration is live;
2. the current public Layout face exists;
3. the priority `-1` entry registers exactly once;
4. that entry is the public winner;
5. the controller accepts the exact target Session;
6. `openDetails()` succeeds.

Any failure rolls back the entry and reads. Entry render failure, priority
loss, Session replacement, Layout replacement, declaration replacement,
disable, HMR, or unload fails closed instead of switching presentation. Rebind
requires an explicit new Team click; there is no hidden Peek/read continuation.

## 5. Team and Tool handoff

On the adjacent Tool action:

```text
release Team entry
-> stop Team reads and publish inactive
-> call official openDetails()
-> official priority-0 DetailsPanel is visible when host geometry permits
```

The coordinator deliberately does not call `closeDetails()` during this
handoff. At a host width that already supports details, the track never reaches
zero and focus remains on the Tool action. If the Layout call fails, Team is
reacquired and its read is restarted; otherwise the failure is announced in
the action pair's live region.

This is not a claim that Swarm can keep official Tool Details visible below the
host's own concession threshold. The public Layout API exposes no rendered
width or close event, and this design does not add a private DOM bridge.

## 6. Content, language, theme, and trust

The details content is read-only and renders the complete bounded R2
projection: Team, roster, tasks, attempts, budget, pending interactions and
capabilities, including loading/reconnect/stale/error states.

- DSH language is the only i18n authority. Locale changes rerender the mounted
  Team panel in place; Swarm stores no locale preference.
- DSH theme tokens are the only theme authority. Swarm stores no theme state
  and defines no independent palette.
- R2 remains local-single-user, target-bound and read-only. The UI cannot
  mutate Team authority.
- Captain Chat revalidates the exact R2 binding immediately before calling the
  official Session navigation face.

## 7. Accessibility and interaction

- Team and Tool are named 32px toolbar actions in one persistent action pair.
- Team exposes `aria-controls` and two-state `aria-expanded`.
- The panel is `role="complementary"`, never a dialog and never modal.
- Chat remains interactive while the host renders all three columns.
- Team views are keyboard-operable; stale/error state is announced with the
  existing status/alert semantics.
- Escape is scoped to focus inside Team/actions; ordinary Chat interaction does
  not dismiss Team.
- There is no outside-pointer dismissal because the panel is not a floating
  surface.

## 8. Acceptance evidence

Author evidence must prove:

- controller has no presentation/compact cycle;
- coordinator has exactly `inactive | docked` and one details entry;
- first Team action opens the official track and second action closes it;
- Team to Tool handoff has no `closeDetails()` or zero-width transition at a
  supported wide viewport;
- source, rendered DOM and shipped styles contain no Team floating layer,
  fixed card, compact mode, shadow, Peek animation, or narrow overlay fallback;
- official Chat geometry narrows when wide Team opens and remains interactive;
- narrow host geometry derives details to zero with no floating Team surface,
  then widening restores the same official presentation;
- Session switch, entry loss, Layout/declaration replacement, HMR, disable,
  unload and removal leave no Team entry/read/style residue;
- locale `en -> zh -> en`, light/dark/system tokens, Captain Chat identity,
  reload, R0-disabled and removed-package paths remain clean;
- packed artifact and real official Profile carry the exact reviewed candidate.

The final claim is E4 only after the representative official Profile/browser
flow passes. Component tests alone establish no user-visible layout claim.

## 9. Rejected alternatives

- Anchored Peek or compact cards: rejected because they do not reflow Chat and
  created two user-visible products for one action.
- A third click state: rejected; Team is a direct open/close toggle.
- Plugin-owned safe-width gate: rejected; it duplicated and contradicted the
  official AppFrame concession policy.
- Runtime DOM/CSS grid patch: rejected for this slice because it would become a
  version-bound shadow layout authority and still could not observe official
  Tool Details closure through the public API.
- Modifying official DSH source: forbidden by the project boundary.

## 10. Documentation impact

```yaml
documentationImpact:
  affectedAuthorities:
    - r3-team-read-ui-design
    - implementation-roadmap
    - testing-verification
    - source-register
  disposition: updated
  rationale: replaces Peek/compact/width-gated presentation with one official details-column contract
```
