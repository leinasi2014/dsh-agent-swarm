/**
 * Per-Team orchestration ownership (M2-3, issue #77): the single-owner
 * discipline's registry and gates.
 *
 * Two faces can advance one Team aggregate — the adaptive event-scheduling
 * face (idle edges, stranded self-healing, re-kick timers) and a live
 * workflow run. This collaborator records which run owns which Team
 * (process-local: the `agent_swarm_workflow` overlay's `running` record is
 * the durable run truth, so ownership never persists) and answers the one
 * policy question both faces ask: may the AUTONOMOUS event face drive this
 * Team now? Explicit operations stay admitted on every Team — they are the
 * caller's own acts, fenced by the domain's revision CAS. The current
 * ownership contract is defined in docs/04-core-protocol.md.
 * @module dsh-agent-swarm/runtime/orchestration-ownership
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import { BUDGET_EXHAUSTION_CODES } from '../domain/team-domain-budget.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamId } from '../domain/types.js'

/** The plugin's explicit orchestration mode (config `orchestrationMode`). */
export type OrchestrationMode = 'adaptive' | 'workflow'

/**
 * The single-owner registry: `${scope}\0${teamId}` → the runId of the live
 * workflow run owning that Team's orchestration.
 */
export class OrchestrationOwnership {
  private readonly owners = new Map<string, string>()
  /**
   * Budget-exhaustion watchers by runId (M2-5, issue #79): a run-owned Team
   * whose scheduling pass was rejected by the budget admission gate gets the
   * structured error routed to its owning run, so the run converges to a
   * terminal state instead of parking on a claim that can never be seated.
   */
  private readonly budgetWatchers = new Map<string, (error: TeamDomainError) => void>()

  constructor(
    private readonly deps: {
      readonly mode: OrchestrationMode
      /** The runtime's serialized scheduling-pass entry (the drive path). */
      readonly requestSchedule: (scope: TeamScope, teamId: TeamId, captain: Agent) => void
    },
  ) {}

  /**
   * Whether the autonomous event face may drive this Team: `adaptive` mode
   * only, and never a Team whose orchestration a live workflow run owns.
   * Gates the idle-edge scheduling entry, the stranded self-healing and the
   * re-kick timers.
   */
  eventFaceActive(scope: TeamScope, teamId: TeamId): boolean {
    return this.deps.mode === 'adaptive' && !this.owners.has(`${scope}\0${teamId}`)
  }

  /**
   * Take the orchestration ownership of one Team for a workflow run. Called
   * by the bridge run after its Team aggregate and `running` overlay record
   * are durable and before `workflow/start` publishes; idempotent per run.
   * @throws {@link TeamDomainError} `TEAM_ORCHESTRATION_OWNER_CONFLICT` when
   *   a different live run already owns this Team. Structurally unreachable
   *   through the public flow today (`createUniqueForCaptain` rejects a
   *   captain's second active Team first) — the registry makes the
   *   single-owner contract explicit for future seams and tests.
   */
  acquire(scope: TeamScope, teamId: TeamId, runId: string): void {
    const key = `${scope}\0${teamId}`
    const owner = this.owners.get(key)
    if (owner === runId) return
    if (owner !== undefined) {
      throw new TeamDomainError(
        `Team ${teamId} orchestration is owned by live workflow run ${owner}; run ${runId} cannot take it`,
        'TEAM_ORCHESTRATION_OWNER_CONFLICT',
      )
    }
    this.owners.set(key, runId)
  }

  /**
   * Release the ownership one run took. Guarded by the runId, so a late
   * release after a successor acquired never steals; a no-op when the entry
   * is already gone.
   */
  release(scope: TeamScope, teamId: TeamId, runId: string): void {
    const key = `${scope}\0${teamId}`
    if (this.owners.get(key) === runId) this.owners.delete(key)
  }

  /** The live run owning this Team's orchestration, if any (evidence). */
  ownerOf(scope: TeamScope, teamId: TeamId): string | undefined {
    return this.owners.get(`${scope}\0${teamId}`)
  }

  /**
   * Drive one scheduling pass for a run-owned Team: the run's own clock.
   * Only the owning run may drive; anything else is a structured ownership
   * conflict rather than a silent second driver.
   */
  drive(scope: TeamScope, teamId: TeamId, runId: string, captain: Agent): void {
    if (this.owners.get(`${scope}\0${teamId}`) !== runId) {
      throw new TeamDomainError(
        `run ${runId} does not own Team ${teamId} orchestration`,
        'TEAM_ORCHESTRATION_OWNER_CONFLICT',
      )
    }
    this.deps.requestSchedule(scope, teamId, captain)
  }

  /**
   * Register one run's budget-exhaustion watcher; the disposer detaches it
   * (the run settles → `releaseDriving` → watcher gone, so a late pass
   * failure after settlement is a silent no-op). The watcher is keyed by the
   * runId, not the Team: only the owning run converges on it.
   */
  watchBudget(runId: string, onExhausted: (error: TeamDomainError) => void): () => void {
    this.budgetWatchers.set(runId, onExhausted)
    return () => {
      if (this.budgetWatchers.get(runId) === onExhausted) this.budgetWatchers.delete(runId)
    }
  }

  /**
   * Observe one scheduling-pass failure (M2-5, issue #79): a pass rejected by
   * the budget admission gate (`BUDGET_EXHAUSTION_CODES`) can never seat the
   * pending claim it failed on, so the structured error is routed to the
   * Team's owning run, which converges instead of parking on that claim.
   * Every other failure — and every Team without a live run owner (all
   * adaptive Teams) — is a no-op here: the pass's logged diagnostic remains
   * the only effect, byte-identical to the pre-M2-5 behavior.
   */
  notePassFailure(scope: TeamScope, teamId: TeamId, error: unknown): void {
    if (!(error instanceof TeamDomainError) || !BUDGET_EXHAUSTION_CODES.has(error.code)) return
    const owner = this.owners.get(`${scope}\0${teamId}`)
    if (owner === undefined) return
    const watcher = this.budgetWatchers.get(owner)
    if (watcher !== undefined) watcher(error)
  }

  /** Drop every entry (runtime disposal path). */
  clear(): void {
    this.owners.clear()
    this.budgetWatchers.clear()
  }
}
