/**
 * Cross-run budget carry for the Team bridge (M2-5, issue #79): the budget
 * lifecycle is decoupled from the workflow run's lifecycle.
 *
 * Each bridge run still creates and archives exactly one Team (the #75
 * lifecycle mapping is unchanged), but a captain's sequential runs consume
 * ONE ledger: when a new run's Team is established, the captain's most
 * recent prior run Team's FINAL budget face — limits and used counters
 * together, read from the durable aggregate through the authoritative port —
 * is adopted onto the fresh ledger (domain `adoptBudget`). `set_budget` once,
 * every later run of the same captain consumes it; the carry source is
 * durable state only (the `agent_swarm_workflow` overlay plus the archived
 * aggregates), so a reload between runs changes nothing.
 *
 * The wake-budget audit conclusion (planning-note trap 2) is encoded here as
 * the single-ledger rule: run-driven and adaptive-driven wake deliveries are
 * assignment dispatches of the SAME scheduling pass and charge through the
 * same `claimTask` seat — the bridge keeps no second counter.
 * @module dsh-agent-swarm/runtime/workflow/budget-carry
 */

import { TeamDomainError } from '../../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../../domain/team-domain-port.js'
import { TeamId, type TeamBudget } from '../../domain/types.js'
import type { WorkflowRunOverlayStore } from '../../storage/workflow-run-overlay.js'

/** Whether one budget face is the untouched fresh-Team default. */
function isFreshBudget(budget: TeamBudget): boolean {
  return budget.usedTokens === 0 && budget.usedRequests === 0 && budget.usedRetries === 0
    && budget.tokenLimit === undefined && budget.requestLimit === undefined
    && budget.retryLimit === undefined && budget.deadlineAt === undefined
}

/**
 * Resolve the budget face the captain's next run must continue from: the
 * final budget of their most recent prior run Team, or `undefined` when there
 * is nothing to carry (no prior run, or a prior ledger identical to the fresh
 * default — adopting it would be a no-op write).
 *
 * Sources are the overlay's non-`running` records of this scope whose linked
 * aggregate is archived and captained by this parent; `createUniqueForCaptain`
 * guarantees every prior Team of this captain is archived by the time a new
 * run can create its own. A record whose aggregate the parent cannot read
 * (`TEAM_UNAUTHORIZED` — a run Team of a different captain) is not this
 * captain's ledger and is skipped; any other read failure propagates (fail
 * closed rather than silently forking the ledger).
 */
export async function resolveCarriedBudget(
  domain: TeamDomainPort,
  overlay: WorkflowRunOverlayStore,
  scope: TeamScope,
  captainSessionId: string,
): Promise<TeamBudget | undefined> {
  let latest: { at: number; budget: TeamBudget } | undefined
  for (const record of overlay.list()) {
    if (record.scope !== scope || record.state === 'running') continue
    let budget: TeamBudget | undefined
    try {
      const snapshot = await domain.snapshot(scope, TeamId(record.teamId), captainSessionId)
      if (snapshot.team.phase === 'archived' && snapshot.team.captainSessionId === captainSessionId) {
        budget = snapshot.team.budget
      }
    } catch (error: unknown) {
      // A different captain's run Team is not this ledger; anything else is a
      // genuine read failure and must fail the establishment.
      if (!(error instanceof TeamDomainError && error.code === 'TEAM_UNAUTHORIZED')) throw error
      continue
    }
    if (budget === undefined) continue
    const at = record.settledAt ?? record.updatedAt
    if (latest === undefined || at > latest.at) latest = { at, budget }
  }
  if (latest === undefined || isFreshBudget(latest.budget)) return undefined
  return latest.budget
}
