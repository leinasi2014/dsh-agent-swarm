/**
 * Activation-time usage recovery net (issue #92).
 *
 * The M1C write-coalescing design treats the durable per-session usage cursor
 * plus a recovery refold as the correctness net for every dropped live flush.
 * That net existed only on delivery-driven paths (assignment dispatch, message
 * delivery, post-activation), so a usage event dropped through any other
 * window — a membership-window flush discard, the disposal entry gate —
 * survived as a PERMANENT billed-token gap whenever the member went cold
 * without receiving a wakeup. This module wires the net where the design
 * intended it: plugin activation refolds every active Team roster in every
 * root-reachable scope — live sessions from their in-process log, cold
 * sessions from persisted history — exactly once per event through the
 * unchanged M1B cursor semantics (≤ cursor is always a skip, never a count).
 * Best-effort per Team: one unreadable Team never blocks the rest.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamState } from '../domain/types.js'
import { UsageAccountant } from './usage-accounting.js'

/** Refold every active roster's usage in the given scopes (activation recovery path). */
export async function recoverActiveRosters(
  ctx: Context,
  deps: {
    domain: () => TeamDomainPort
    scopes: readonly TeamScope[]
    teams: (scope: TeamScope) => Promise<TeamState[]>
  },
): Promise<void> {
  // A recovery-scoped accountant: `recoverTeamUsage` touches no live chains,
  // and its live-agent/persisted-history lanes default to the ctx seams.
  const accountant = new UsageAccountant(ctx, { domain: deps.domain, isClosing: () => false })
  for (const scope of deps.scopes) {
    let teams: TeamState[]
    try {
      teams = await deps.teams(scope)
    } catch (error) {
      ctx.logger.warn(`agent-swarm: usage recovery cannot list ${scope}: ${String(error)}`)
      continue
    }
    for (const team of teams) {
      if (team.phase !== 'active') continue
      try {
        await accountant.recoverTeamUsage(scope, team)
      } catch (error) {
        ctx.logger.warn(`agent-swarm: usage recovery failed for ${team.id}: ${String(error)}`)
      }
    }
  }
}
