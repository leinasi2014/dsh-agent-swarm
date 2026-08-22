/**
 * SwarmPanelSnapshot: the frozen S0 read-only data contract
 * (docs/development/2026-08-22-m9-ui-architecture-spec.md §5.2).
 *
 * The panel layer never imports host state. Host adapters project the
 * authoritative Team state onto this shape:
 *
 * - the DSH side derives it from `AgentSwarmRuntime.status()` /
   `agent_swarm_status` + `agent_swarm_list_tasks` frames
 *   (src/tools/read-surface.ts: counters map 1:1 — tasks→total,
 *   completed_tasks→completed, ready_tasks→ready, queued_messages,
 *   memory_entries, used_tokens/used_requests/used_retries);
 * - the Canvas side derives the degraded form (counters + budget only) from
 *   `GET /agent/dsh/status` swarm status projection.
 *
 * Degraded snapshots (spec §5.2: "Canvas MVP 允许降级快照") omit `members`
 * and `tasks`; components render the absent segments as empty states or
 * honest "unknown" markers, never as zeros. `review` is the S5 segment and is
 * already frozen here so later slices widen no published type.
 */

/** Team identity block. Maps `team_id` / `name` / `revision` from the read surface. */
export interface SwarmTeamRef {
  readonly id: string
  readonly name: string
  readonly revision: number
}

/**
 * Member phase. `'active'` is the canonical live marker (the read surface
 * counts `phase === 'active'`); hosts may emit their own wider vocabulary, so
 * the union stays open to `string`.
 */
export type SwarmMemberPhase = 'active' | (string & {})

/** One roster row. `id` is the member id; `role` is the display role. */
export interface SwarmMemberView {
  readonly id: string
  readonly role: string
  readonly phase: SwarmMemberPhase
}

/**
 * Task status vocabulary. The closed set mirrors the authoritative
 * `agent_swarm_list_tasks` rows (`src/tools/read-surface.ts` TASK_ROW_SCHEMA);
 * `ready` is kept because spec §5.2 froze it into the open union (readiness
 * is otherwise a derived flag, not a status). Unknown host statuses fall back
 * to default badge styling and a raw-text label.
 */
export type SwarmTaskStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'submitted'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | (string & {})

/** One task row. `title` is the read-surface `subject`; `attempts` counts started attempts. */
export interface SwarmTaskView {
  readonly id: string
  readonly title: string
  readonly status: SwarmTaskStatus
  readonly ownerId?: string
  readonly attempts: number
  readonly blockedBy?: readonly string[]
}

/** Fixed-size counters. Maps 1:1 onto the `agent_swarm_status` output. */
export interface SwarmCounters {
  readonly total: number
  readonly completed: number
  readonly ready: number
  readonly queuedMessages: number
  readonly memoryEntries: number
}

/** Budget usage (used only — the contract carries no caps, so meters show plain usage). */
export interface SwarmBudgetUsage {
  readonly usedTokens: number
  readonly usedRequests: number
  readonly usedRetries: number
  readonly observedAt?: string
}

/** One pending review/approval entry (S5 segment, frozen early). */
export interface SwarmReviewEntry {
  readonly requestId: string
  readonly state: string
  readonly summary?: string
}

/** The whole panel projection. Read-only at every layer; UI never writes back. */
export interface SwarmPanelSnapshot {
  readonly team: SwarmTeamRef
  /** Absent in degraded snapshots; the summary card then shows "unknown" instead of a count. */
  readonly members?: ReadonlyArray<SwarmMemberView>
  /** Absent in degraded snapshots; the panel then renders the summary-only degraded form. */
  readonly tasks?: ReadonlyArray<SwarmTaskView>
  readonly counters: SwarmCounters
  /** Absent when the budget face is not projected; BudgetMeter hides entirely. */
  readonly budget?: SwarmBudgetUsage
  /** Absent when no review bridge is mounted. */
  readonly review?: ReadonlyArray<SwarmReviewEntry>
}
