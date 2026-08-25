/**
 * Per-attempt execution roots (M3-1, issue #100 / ADR-0008 D2): every task
 * attempt can be fenced into its own physical working root, so parallel
 * attempts never share a mutable checkout.
 *
 * The seam is a replaceable Provider registered exactly like the scheduler
 * and review Providers (`registerExecutionRootProvider` + a config name).
 * The builtin `git-worktree` implementation isolates through a detached git
 * worktree of the Team workspace's repository checkout and degrades — per
 * acquire, honestly declared on the root — to an independent temporary
 * directory when the scope holds no repository.
 *
 * Ownership: the root ledger is PLUGIN-SIDE state (ADR-0007 is not engaged —
 * the Team aggregate schema is untouched). `TeamDomainPort` stays the single
 * authority for attempt phases; this manager derives hold/release decisions
 * from authoritative snapshots and never writes Team state. The on-disk
 * marker inside each root is the crash-truth the activation-recovery scan
 * folds: a root whose attempt no longer holds it is alarmed and marked
 * reclaimable, never auto-deleted (the captain decides).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { TeamDomainError } from '../domain/error.js'
import type { AttemptId, TaskId, TeamId, TeamState } from '../domain/types.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import {
  copyDependencyScopes,
  copyPredecessorRoot,
  writeDependencyReceipt,
} from './execution-root-handoff.js'

export { EXECUTION_ROOT_DEPENDENCIES, EXECUTION_ROOT_HANDOFF } from './execution-root-handoff.js'

const execFileAsync = promisify(execFile)

/** Bound for every git invocation (fault containment, not cost control). */
const GIT_TIMEOUT_MS = 30_000

/** Durable identity marker written inside every root the builtin manages. */
export const EXECUTION_ROOT_MARKER = '.dsh-execution-root.json'

/** Reclaimable flag written beside the marker for scan-detected leftovers. */
const RECLAIMABLE_MARKER = '.dsh-execution-root.reclaimable.json'

/** How the root directory is physically isolated (capability declaration). */
export type ExecutionRootIsolation = 'git-worktree' | 'temp-directory'

/** One physical per-attempt working root supplied by a Provider. */
export interface ExecutionRoot {
  /** Absolute path of the isolated root directory. */
  readonly path: string
  /** Declared isolation capability actually materialized for this root. */
  readonly isolation: ExecutionRootIsolation
  /** Reclaim the physical root. Idempotent; resolves even when partly failed. */
  release(): Promise<void>
}

/**
 * Replaceable execution-root supply seam (issue #100). `acquire` must be
 * idempotent per fence tuple: a root already present for the exact
 * `(scope, teamId, taskId, attemptId)` is re-attached and returned; a path
 * occupied by anything else must fail loud. Providers keep roots under the
 * manager's deterministic layout (`declarationPathFor` folds frame identity
 * from it) or persist their own identity marker at that layout path.
 */
export interface TeamExecutionRootProvider {
  acquire(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): Promise<ExecutionRoot>
}

/** The manager's lease over one acquired root (plugin-side ledger entry). */
export interface ExecutionLease {
  readonly scope: TeamScope
  readonly teamId: TeamId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly path: string
  readonly isolation: ExecutionRootIsolation
  readonly acquiredAt: number
}

/** One scan verdict over an on-disk root at activation recovery. */
export interface ExecutionRootResidue {
  readonly path: string
  /** Identity from the root's marker, when readable. */
  readonly identity: { readonly teamId: string; readonly taskId: string; readonly attemptId: string } | undefined
  /** `orphan` — provably ownerless (alarmed + reclaimable marker, kept); `reattachable` — its attempt may still be redriven (report only). */
  readonly verdict: 'orphan' | 'reattachable'
  readonly reason: string
}

/** Marker document persisted inside each builtin-managed root. */
interface RootMarker {
  readonly version: 1
  readonly scope: TeamScope
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly path: string
  readonly isolation: ExecutionRootIsolation
  readonly acquiredAt: number
}

/** Path segment sanitizer: ids are system-generated, this is defense in depth. */
function segment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, '_')
  return clean === '' || clean === '.' || clean === '..' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : clean
}

/** Stable scope partition directory (survives process restarts). */
function scopeDirectory(base: string, scope: TeamScope): string {
  return join(base, createHash('sha256').update(scope).digest('hex').slice(0, 16))
}

/** The deterministic root layout path for one fence tuple. */
export function deterministicRootPath(base: string, scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): string {
  return join(scopeDirectory(base, scope), segment(teamId), segment(taskId), segment(attemptId))
}

/** Read one root's marker, or `undefined` when absent/unreadable/invalid. */
function readMarker(path: string): RootMarker | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(path, EXECUTION_ROOT_MARKER), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const marker = raw as Partial<RootMarker>
    if (marker.version !== 1) return undefined
    if (typeof marker.scope !== 'string' || typeof marker.teamId !== 'string' || typeof marker.taskId !== 'string') return undefined
    if (typeof marker.attemptId !== 'string' || typeof marker.path !== 'string') return undefined
    if (marker.isolation !== 'git-worktree' && marker.isolation !== 'temp-directory') return undefined
    // Issue #122 F9: a marker whose recorded path does not match the
    // directory it was read from cannot vouch for that directory — a worker
    // writing a copied/forged marker must not steer residue reports for a
    // path it never owned. Path comparison is case-insensitive on Windows.
    if (!markerPathMatches(marker.path, path)) return undefined
    return raw as RootMarker
  } catch {
    return undefined
  }
}

/** Whether a marker's recorded path is the directory the marker lives in. */
function markerPathMatches(recorded: string, actual: string): boolean {
  const left = resolve(recorded)
  const right = resolve(actual)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Whether an attempt still holds its execution root, derived ONLY from the
 * authoritative aggregate: `running` attempts hold; every settled phase
 * (submitted/verifying/accepted/rejected/cancelled) releases; a `stale`
 * attempt holds exactly while its same-owner successor is still reserved and
 * undelivered — the reinstate window of the atomic retry (issue #83) during
 * which the domain can revive it. A pruned/absent attempt releases (it
 * settled long before pruning).
 */
export function attemptHoldsExecutionRoot(team: TeamState, attemptId: AttemptId): boolean {
  const attempt = team.attempts.find(candidate => candidate.id === attemptId)
  if (attempt === undefined) return false
  if (team.phase === 'archived') return false
  // Submitted roots are the executable candidate, and accepted roots are the
  // durable dependency artifact. They stay until Team archival instead of
  // collapsing a real file tree into the member's short textual summary.
  if (['running', 'submitted', 'verifying', 'accepted'].includes(attempt.phase)) return true
  if (attempt.assignmentPhase !== 'delivered') return false
  const task = team.tasks.find(candidate => candidate.id === attempt.taskId)
  if (task === undefined || task.status === 'completed') return false
  // Keep exactly the newest delivered terminal generation as a recovery
  // source while the task is pending or its successor has not yet become
  // model-visible. Once the successor is delivered, the normal sweep may
  // reclaim the predecessor.
  const newestDelivered = team.attempts
    .filter(candidate => candidate.taskId === attempt.taskId && candidate.assignmentPhase === 'delivered')
    .toSorted((left, right) => right.generation - left.generation)[0]
  if (newestDelivered?.id !== attempt.id) return false
  if (task.currentAttemptId === undefined) return task.status === 'pending'
  const successor = team.attempts.find(candidate => candidate.id === task.currentAttemptId)
  return successor !== undefined
    && successor.generation > attempt.generation
    && successor.assignmentPhase === 'reserved'
}

/** One bounded git invocation; a non-zero exit rejects with stderr context. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true })
    return stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new TeamDomainError(`git ${args[0] ?? ''} failed in ${cwd}: ${detail}`, 'TEAM_EXECUTION_ROOT_ACQUIRE_FAILED', { cause: error })
  }
}

/**
 * Builtin `git-worktree` Provider: a detached worktree of the repository
 * containing the Team workspace (detached so parallel attempts never fight
 * over one branch), degrading to an independent temporary directory when the
 * scope is not inside a repository — the capability difference is declared
 * per root through `isolation`, never silently.
 */
export function gitWorktreeExecutionRoots(base: string): TeamExecutionRootProvider {
  const reclaim = async (path: string, isolation: ExecutionRootIsolation, cwd: string): Promise<void> => {
    if (!existsSync(path)) return
    if (isolation === 'git-worktree') {
      try {
        // Best effort through git first (keeps worktree metadata consistent);
        // --force because member output normally leaves the tree dirty — a
        // settled attempt's durable output lives in the submitted record.
        await git(cwd, ['worktree', 'remove', '--force', path])
      } catch {
        try {
          // Registration with a half-removed directory (external deletion):
          // prune clears exactly those, never a live worktree.
          await git(cwd, ['worktree', 'prune'])
        } catch {
          // fall through to direct removal
        }
      }
    }
    rmSync(path, { recursive: true, force: true })
  }
  return {
    async acquire(scope, teamId, taskId, attemptId) {
      const path = deterministicRootPath(base, scope, teamId, taskId, attemptId)
      let repoRoot: string | undefined
      try {
        repoRoot = (await git(scope, ['rev-parse', '--show-toplevel'])).trim()
      } catch {
        repoRoot = undefined // not a repository: declared degradation below
      }
      if (existsSync(path)) {
        const marker = readMarker(path)
        if (marker === undefined) {
          throw new TeamDomainError(`execution root path is occupied by a foreign or unreadable directory: ${path}`, 'TEAM_EXECUTION_ROOT_CONFLICT')
        }
        if (marker.scope !== scope || marker.teamId !== teamId || marker.taskId !== taskId || marker.attemptId !== attemptId) {
          throw new TeamDomainError(`execution root path holds a different attempt's root: ${path}`, 'TEAM_EXECUTION_ROOT_CONFLICT')
        }
        return { path, isolation: marker.isolation, release: () => reclaim(path, marker.isolation, scope) }
      }
      const isolation: ExecutionRootIsolation = repoRoot === undefined ? 'temp-directory' : 'git-worktree'
      if (isolation === 'git-worktree') {
        try {
          await git(scope, ['worktree', 'add', '--detach', path])
        } catch (error) {
          rmSync(path, { recursive: true, force: true })
          throw error
        }
      } else {
        mkdirSync(path, { recursive: true })
      }
      const marker: RootMarker = {
        version: 1, scope, teamId, taskId, attemptId, path, isolation, acquiredAt: Date.now(),
      }
      writeFileSync(join(path, EXECUTION_ROOT_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      return { path, isolation, release: () => reclaim(path, isolation, scope) }
    },
  }
}

/** Serialized per-fence root supply, sweep and crash-residue detection. */
export class ExecutionRoots {
  private readonly providers = new Map<string, TeamExecutionRootProvider>()
  /** Fence tuple → its live lease plus the supplying root's release handle. */
  private readonly leases = new Map<string, { readonly lease: ExecutionLease; readonly release: () => Promise<void> }>()
  private readonly inflight = new Map<string, Promise<ExecutionLease>>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      readonly enabled: () => boolean
      readonly providerName: () => string
      readonly base: string
      /** Builtin factory (isolated for fault tests). */
      readonly builtin: (base: string) => TeamExecutionRootProvider
    },
  ) {
    this.providers.set('git-worktree', deps.builtin(deps.base))
  }

  /** Register one replaceable Provider; returns its disposer. */
  registerProvider(name: string, provider: TeamExecutionRootProvider): () => void {
    const key = name.trim()
    if (key === '') throw new TeamDomainError('execution-root Provider name must not be empty', 'TEAM_INVALID_CONFIG')
    if (this.providers.has(key)) throw new TeamDomainError(`execution-root Provider "${key}" is already registered`, 'TEAM_PROVIDER_DUPLICATE')
    this.providers.set(key, provider)
    return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
  }

  private provider(): TeamExecutionRootProvider {
    const name = this.deps.providerName()
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new TeamDomainError(`execution-root Provider "${name}" is unavailable`, 'TEAM_EXECUTION_ROOT_PROVIDER_MISSING')
    }
    return provider
  }

  private static fence(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): string {
    return `${scope}\0${teamId}\0${taskId}\0${attemptId}`
  }

  /** The live lease of one fence tuple, if this process holds it. */
  leaseOf(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): ExecutionLease | undefined {
    return this.leases.get(ExecutionRoots.fence(scope, teamId, taskId, attemptId))?.lease
  }

  /**
   * Deterministic declaration path for one fence tuple: the live lease's
   * path, else the on-disk marker's path (crash truth), else the layout
   * default. Pure of network/model state, so the assignment frame built at
   * dispatch and recomputed by the visibility fold stay byte-identical.
   */
  declarationPathFor(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): string {
    const leased = this.leaseOf(scope, teamId, taskId, attemptId)
    if (leased !== undefined) return leased.path
    const fallback = deterministicRootPath(this.deps.base, scope, teamId, taskId, attemptId)
    const marker = existsSync(fallback) ? readMarker(fallback) : undefined
    return marker?.path ?? fallback
  }

  /** Acquire (or re-attach) the root of one fence tuple; exactly-once per tuple. */
  async acquire(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): Promise<ExecutionLease> {
    const fence = ExecutionRoots.fence(scope, teamId, taskId, attemptId)
    const leased = this.leases.get(fence)
    if (leased !== undefined) return leased.lease
    const pending = this.inflight.get(fence)
    if (pending !== undefined) return await pending
    const operation = (async () => {
      let root
      try {
        root = await this.provider().acquire(scope, teamId, taskId, attemptId)
      } catch (error) {
        // Structured containment for every supply failure (a missing git, a
        // full disk, an unwritable base): the callers roll their claims back
        // on this code, so raw filesystem errors must not leak through.
        if (error instanceof TeamDomainError) throw error
        throw new TeamDomainError(
          `execution root acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
          'TEAM_EXECUTION_ROOT_ACQUIRE_FAILED',
          { cause: error },
        )
      }
      const lease: ExecutionLease = {
        scope, teamId, taskId, attemptId, path: root.path, isolation: root.isolation, acquiredAt: Date.now(),
      }
      this.leases.set(fence, { lease, release: () => root.release() })
      return lease
    })()
    this.inflight.set(fence, operation)
    try {
      return await operation
    } finally {
      this.inflight.delete(fence)
    }
  }

  /**
   * Seed a fresh generation from the newest delivered predecessor of the same
   * task. This is an attempt handoff, not cross-task integration: the new
   * generation has the same write authority, while `.git`, dependency caches
   * and root-control markers are never copied.
   */
  inheritLatestAttempt(
    scope: TeamScope,
    team: TeamState,
    task: { readonly id: TaskId },
    attempt: { readonly id: AttemptId; readonly generation: number },
  ): { readonly sourceAttemptId: AttemptId; readonly copiedEntries: number } | undefined {
    const target = this.leaseOf(scope, team.id, task.id, attempt.id)
    if (target === undefined) return undefined
    const predecessor = team.attempts
      .filter(candidate => candidate.taskId === task.id
        && candidate.generation < attempt.generation
        && candidate.assignmentPhase === 'delivered')
      .toSorted((left, right) => right.generation - left.generation)
      .find(candidate => existsSync(this.declarationPathFor(scope, team.id, task.id, candidate.id)))
    if (predecessor === undefined) return undefined
    const sourcePath = this.declarationPathFor(scope, team.id, task.id, predecessor.id)
    const copiedEntries = copyPredecessorRoot(sourcePath, target.path, predecessor.id, attempt.id)
    return { sourceAttemptId: predecessor.id, copiedEntries }
  }

  /** Materialize accepted direct blockers by their declared write scopes. */
  inheritCompletedDependencies(
    scope: TeamScope,
    team: TeamState,
    task: { readonly id: TaskId; readonly blockedBy: readonly TaskId[] },
    attempt: { readonly id: AttemptId },
  ): readonly { readonly taskId: TaskId; readonly attemptId: AttemptId; readonly copiedScopes: readonly string[] }[] {
    const target = this.leaseOf(scope, team.id, task.id, attempt.id)
    if (target === undefined || task.blockedBy.length === 0) return []
    const inherited: { taskId: TaskId; attemptId: AttemptId; copiedScopes: string[] }[] = []
    for (const dependencyId of task.blockedBy) {
      const dependency = team.tasks.find(candidate => candidate.id === dependencyId)
      const dependencyAttempt = dependency?.currentAttemptId === undefined
        ? undefined
        : team.attempts.find(candidate => candidate.id === dependency.currentAttemptId)
      if (dependency?.status !== 'completed' || dependencyAttempt?.phase !== 'accepted') {
        throw new TeamDomainError(`dependency ${dependencyId} has no accepted execution artifact`, 'TEAM_EXECUTION_ROOT_DEPENDENCY_MISSING')
      }
      const sourceRoot = this.declarationPathFor(scope, team.id, dependency.id, dependencyAttempt.id)
      if (!existsSync(join(sourceRoot, EXECUTION_ROOT_MARKER))) {
        throw new TeamDomainError(`dependency ${dependencyId} execution artifact is unavailable`, 'TEAM_EXECUTION_ROOT_DEPENDENCY_MISSING')
      }
      const copiedScopes = copyDependencyScopes(sourceRoot, target.path, dependency.id, dependency.writeScopes)
      inherited.push({ taskId: dependency.id, attemptId: dependencyAttempt.id, copiedScopes })
    }
    writeDependencyReceipt(target.path, attempt.id, inherited)
    return inherited
  }

  /**
   * Reclaim one fence tuple's root through the handle of the root that
   * supplied it. The logical lease always ends; a failed physical reclaim
   * leaves disk residue the activation scan reports (the lease map is the
   * live set, never a leak-denial).
   */
  async release(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId, reason: string): Promise<void> {
    const fence = ExecutionRoots.fence(scope, teamId, taskId, attemptId)
    const entry = this.leases.get(fence)
    if (entry === undefined) return
    this.leases.delete(fence)
    try {
      await entry.release()
    } catch (error) {
      this.ctx.logger.warn(
        `agent-swarm: execution root reclaim failed for ${teamId}/${taskId}/${attemptId} (${reason}): ${String(error)} — residue stays for the activation scan`,
      )
    }
  }

  /** Sweep every lease whose attempt no longer holds a root (authority-derived). */
  async sweepSettledAttempts(scope: TeamScope, teamId: TeamId, team: TeamState): Promise<number> {
    if (!this.deps.enabled()) return 0
    let released = 0
    for (const { lease } of this.leases.values()) {
      if (lease.scope !== scope || lease.teamId !== teamId) continue
      if (attemptHoldsExecutionRoot(team, lease.attemptId)) continue
      await this.release(scope, teamId, lease.taskId, lease.attemptId, `attempt settled (${team.id} revision ${team.revision})`)
      released += 1
    }
    return released
  }

  /** Captain-authorized Team archival reclaims every verified Team root. */
  async reclaimTeam(scope: TeamScope, teamId: TeamId, reason: string): Promise<number> {
    if (!this.deps.enabled()) return 0
    const teamPath = join(scopeDirectory(this.deps.base, scope), segment(teamId))
    if (!existsSync(teamPath)) return 0
    const identities: RootMarker[] = []
    for (const taskEntry of readdirSync(teamPath, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue
      const taskPath = join(teamPath, taskEntry.name)
      for (const attemptEntry of readdirSync(taskPath, { withFileTypes: true })) {
        if (!attemptEntry.isDirectory()) continue
        const marker = readMarker(join(taskPath, attemptEntry.name))
        if (marker?.scope === scope && marker.teamId === teamId) identities.push(marker)
      }
    }
    let reclaimed = 0
    for (const marker of identities) {
      const taskId = marker.taskId as TaskId
      const attemptId = marker.attemptId as AttemptId
      const fence = ExecutionRoots.fence(scope, teamId, taskId, attemptId)
      const leased = this.leases.get(fence)
      try {
        if (leased !== undefined) {
          await this.release(scope, teamId, taskId, attemptId, reason)
        } else {
          const root = await this.provider().acquire(scope, teamId, taskId, attemptId)
          await root.release()
        }
        reclaimed += 1
      } catch (error) {
        this.ctx.logger.warn(`agent-swarm: archived Team root reclaim failed for ${marker.path} (${reason}): ${String(error)}`)
      }
    }
    return reclaimed
  }

  /** Release every live lease (runtime disposal path). */
  async releaseAll(reason: string): Promise<void> {
    for (const { lease } of this.leases.values()) {
      await this.release(lease.scope, lease.teamId, lease.taskId, lease.attemptId, reason)
    }
  }

  /** Drop process-local handles while preserving roots for restart recovery. */
  async detachAll(): Promise<void> {
    await Promise.allSettled(this.inflight.values())
    this.inflight.clear()
    this.leases.clear()
  }

  /**
   * Activation-recovery residue scan (issue #100 fault face): fold every
   * marker-bearing root of one scope against the authoritative aggregates.
   * A root whose attempt still holds it is `reattachable` (report only — the
   * reserved fold may redrive it); every provably ownerless root is an
   * `orphan`: alarmed and marked reclaimable, NEVER deleted (the captain
   * decides). Foreign/unreadable directories are orphans with no identity.
   */
  async scanResidue(scope: TeamScope, teams: readonly TeamState[]): Promise<ExecutionRootResidue[]> {
    if (!this.deps.enabled()) return []
    const directory = scopeDirectory(this.deps.base, scope)
    if (!existsSync(directory)) return []
    const residues: ExecutionRootResidue[] = []
    for (const teamId of readdirSync(directory, { withFileTypes: true })) {
      if (!teamId.isDirectory()) continue
      const teamPath = join(directory, teamId.name)
      for (const taskId of readdirSync(teamPath, { withFileTypes: true })) {
        if (!taskId.isDirectory()) continue
        const taskPath = join(teamPath, taskId.name)
        for (const attemptId of readdirSync(taskPath, { withFileTypes: true })) {
          if (!attemptId.isDirectory()) continue
          const path = join(taskPath, attemptId.name)
          const marker = readMarker(path)
          if (marker === undefined) {
            residues.push(this.reportOrphan(path, undefined, 'no readable execution-root marker'))
            continue
          }
          if (this.leaseOf(marker.scope, marker.teamId as TeamId, marker.taskId as TaskId, marker.attemptId as AttemptId) !== undefined) continue
          const team = teams.find(candidate => candidate.id === marker.teamId)
          if (team === undefined || team.phase === 'archived') {
            residues.push(this.reportOrphan(path, marker, team === undefined ? 'Team record absent' : 'Team archived'))
            continue
          }
          if (attemptHoldsExecutionRoot(team, marker.attemptId as AttemptId)) {
            residues.push({ path, identity: marker, verdict: 'reattachable', reason: 'attempt still holds its root (redrivable)' })
            continue
          }
          const attempt = team.attempts.find(candidate => candidate.id === marker.attemptId)
          residues.push(this.reportOrphan(path, marker, attempt === undefined ? 'attempt pruned from the retained history' : `attempt settled (${attempt.phase})`))
        }
      }
    }
    return residues
  }

  /** Alarm + reclaimable marker for one ownerless root; the directory stays. */
  private reportOrphan(path: string, marker: RootMarker | undefined, reason: string): ExecutionRootResidue {
    try {
      writeFileSync(join(path, RECLAIMABLE_MARKER), `${JSON.stringify({ version: 1, reason, markedAt: Date.now() }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: could not mark orphan execution root ${path}: ${String(error)}`)
    }
    this.ctx.logger.warn(`agent-swarm: orphan execution root detected (${reason}): ${path} — kept for captain decision`)
    return {
      path,
      identity: marker === undefined ? undefined : { teamId: marker.teamId, taskId: marker.taskId, attemptId: marker.attemptId },
      verdict: 'orphan',
      reason,
    }
  }
}

/** Default roots base: a dedicated partition under the platform temp dir. */
export function defaultExecutionRootsBase(): string {
  return join(tmpdir(), 'dsh-agent-swarm-roots')
}

/** Config validation for an operator-supplied roots base. */
export function expectExecutionRootsBase(base: string | undefined): string | undefined {
  if (base === undefined) return undefined
  if (base.trim() === '') throw new TeamDomainError('executionRootsBase must not be empty — omit the key for the default', 'TEAM_INVALID_CONFIG')
  if (!isAbsolute(base)) throw new TeamDomainError(`executionRootsBase must be absolute: ${base}`, 'TEAM_INVALID_CONFIG')
  return base
}
