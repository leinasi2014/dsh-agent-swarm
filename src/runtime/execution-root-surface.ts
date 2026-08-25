/**
 * Runtime-side execution-root integration (M3-1, issue #100): the thin
 * collaborator that binds the generic {@link ExecutionRoots} manager to the
 * authoritative domain, keeping `orchestrator-runtime.ts` at its size gate.
 *
 * It owns the three integration seams the runtime needs: the claim-time
 * acquire with its compensating rollback (a failed acquisition is a failed
 * dispatch — the reservation is cancelled under the team captain's authority,
 * exactly the discipline the scheduling pass applies to a failed followup),
 * the authority-derived settle sweep (one aggregate read releases every root
 * whose attempt no longer holds one), and the activation residue scan. The
 * domain stays the single attempt authority; the lease map and on-disk
 * markers stay plugin-side state (docs/04 §8l).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TaskAttempt, TeamId, TeamState, TeamTask } from '../domain/types.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { ExecutionRoots, type ExecutionRootResidue, type TeamExecutionRootProvider, gitWorktreeExecutionRoots } from './execution-roots.js'

/** One claimed attempt plus its acquired execution root, when enabled. */
export type ClaimWithRoot = { task: TeamTask; attempt: TaskAttempt; executionRoot?: { path: string; isolation: 'git-worktree' | 'temp-directory' } }

/** Bindings the surface needs from its owning runtime. */
export interface ExecutionRootSurfaceDeps {
  readonly ctx: Context
  readonly enabled: () => boolean
  readonly closing: () => boolean
  readonly providerName: () => string
  readonly base: string
  readonly domain: () => TeamDomainPort
  /** Authoritative aggregate enumeration of one scope (read-only). */
  readonly teams: (scope: TeamScope) => Promise<TeamState[]>
}

export class ExecutionRootSurface {
  /** The generic manager: registry, per-fence leases, residue scanning. */
  readonly roots: ExecutionRoots

  constructor(private readonly deps: ExecutionRootSurfaceDeps) {
    this.roots = new ExecutionRoots(deps.ctx, {
      enabled: deps.enabled,
      providerName: deps.providerName,
      base: deps.base,
      builtin: gitWorktreeExecutionRoots,
    })
  }

  /** Register one replaceable Provider; returns its disposer. */
  registerProvider(name: string, provider: TeamExecutionRootProvider): () => void {
    return this.roots.registerProvider(name, provider)
  }

  /**
   * Fence one freshly claimed attempt into its root (M3-1): acquire on the
   * attempt's fence key and return the claim enriched with the root. A failed
   * acquisition rolls the claim back under the team captain's compensating
   * authority and rethrows the structured error; if even the compensation
   * fails, the stuck attempt surfaces through the stranded evidence lanes.
   */
  async settleClaim(scope: TeamScope, team: TeamState, claim: { task: TeamTask; attempt: TaskAttempt }): Promise<ClaimWithRoot> {
    if (!this.deps.enabled()) return claim
    try {
      const lease = await this.roots.acquire(scope, team.id, claim.task.id, claim.attempt.id)
      this.roots.inheritLatestAttempt(scope, team, claim.task, claim.attempt)
      this.roots.inheritCompletedDependencies(scope, team, claim.task, claim.attempt)
      return { ...claim, executionRoot: { path: lease.path, isolation: lease.isolation } }
    } catch (error) {
      const diagnostic = `execution root acquisition failed: ${error instanceof Error ? error.message : String(error)}`
      await this.deps.domain().cancelAttempt(
        scope, team.id, team.captainSessionId, claim.task.id, claim.task.revision, diagnostic,
      ).catch(compensation => {
        this.deps.ctx.logger.warn(`agent-swarm: could not roll back a rootless claim for ${claim.task.id}: ${String(compensation)}`)
      })
      throw error
    }
  }

  /**
   * Release every execution root whose attempt no longer holds one, derived
   * from one authoritative aggregate read. Best-effort on every
   * terminal-adjacent surface: the domain transition already committed, so a
   * failure warns and the activation residue scan remains the net.
   */
  async sweep(scope: TeamScope, teamId: TeamId): Promise<void> {
    if (!this.deps.enabled() || this.deps.closing()) return
    try {
      const team = (await this.deps.teams(scope)).find(candidate => candidate.id === teamId)
      if (team !== undefined) await this.roots.sweepSettledAttempts(scope, teamId, team)
    } catch (error) {
      this.deps.ctx.logger.warn(`agent-swarm: execution-root sweep failed for ${teamId}: ${String(error)}`)
    }
  }

  /**
   * Activation-recovery residue scan: fold every on-disk execution root of
   * one scope against the authoritative aggregates (docs/04 §8l). Returns
   * the report for observation (the D1 root-residue metric, docs/13 §5).
   */
  async scan(scope: TeamScope): Promise<ExecutionRootResidue[]> {
    if (!this.deps.enabled()) return []
    return await this.roots.scanResidue(scope, await this.deps.teams(scope))
  }

  /** Reclaim every verified root after the captain commits Team archival. */
  reclaimTeam(scope: TeamScope, teamId: TeamId, reason: string): Promise<number> {
    return this.roots.reclaimTeam(scope, teamId, reason)
  }

  /** Release every live lease (runtime disposal path, F4-bounded). */
  releaseAll(reason: string): Promise<void> {
    return this.roots.releaseAll(reason)
  }

  /** Preserve physical roots across plugin restart; only live handles end. */
  detachAll(): Promise<void> {
    return this.roots.detachAll()
  }
}
