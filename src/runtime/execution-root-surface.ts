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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { workspaceOf } from './authority.js'
import type { AttemptId, TaskId, TaskAttempt, TeamId, TeamState, TeamTask } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { ExecutionRoots, EXECUTION_ROOT_MARKER, type ExecutionRootResidue, type TeamExecutionRootProvider, gitWorktreeExecutionRoots } from './execution-roots.js'

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
      recoverMember: agent => this.recoverMember(agent),
    })
  }

  /** Restore only a current member's existing root, before its first cold IO. */
  private async recoverMember(agent: Agent): Promise<boolean> {
    if (this.deps.closing()) return true // deny IO during disposal
    const scope = resolve(workspaceOf(agent))
    const teams = await this.deps.teams(scope)
    // Retained attempts also identify removed/settled members, which must not
    // become unrelated unrestricted Agents just because the process restarted.
    const team = teams.find(candidate => candidate.members.some(member => member.sessionId === agent.id)
      || candidate.attempts.some(attempt => attempt.memberSessionId === agent.id))
    if (team === undefined) return false
    const member = team.members.find(candidate => candidate.sessionId === agent.id && candidate.phase === 'active')
    const task = team.tasks.find(candidate => candidate.ownerSessionId === agent.id && candidate.status === 'in_progress')
    const attempt = team.attempts.find(candidate => candidate.id === task?.currentAttemptId
      && candidate.memberSessionId === agent.id && candidate.phase === 'running')
    if (team.phase !== 'active' || member === undefined || task === undefined || attempt === undefined) return true
    const path = this.roots.declarationPathFor(scope, team.id, task.id, attempt.id)
    // A missing root may contain lost work: never silently create an empty
    // replacement. The Provider validates the durable marker when reattaching.
    if (!existsSync(join(path, EXECUTION_ROOT_MARKER))) return true
    await this.roots.acquire(scope, team.id, task.id, attempt.id, String(agent.id))
    return true
  }

  /** Register one replaceable Provider; returns its disposer. */
  registerProvider(name: string, provider: TeamExecutionRootProvider): () => void {
    return this.roots.registerProvider(name, provider)
  }

  /** A cold submit must recover its existing root before publishing evidence. */
  async captureSubmission(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId, agent: Agent): Promise<string | undefined> {
    if (this.deps.enabled() && this.roots.leaseOf(scope, teamId, taskId, attemptId) === undefined) {
      await this.recoverMember(agent)
      if (this.roots.leaseOf(scope, teamId, taskId, attemptId) === undefined) {
        throw new TeamDomainError('Current attempt execution root is unavailable; retain the attempt for recovery', 'TEAM_EXECUTION_ROOT_EVIDENCE_FAILED')
      }
    }
    return await this.roots.captureWorktreeDiff(scope, teamId, taskId, attemptId)
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
      const lease = await this.roots.acquire(scope, team.id, claim.task.id, claim.attempt.id, claim.attempt.memberSessionId)
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

  /** Revoke IO without destroying unfinished output during runtime shutdown. */
  suspendAll(): Promise<void> {
    return this.roots.suspendAll()
  }
}
