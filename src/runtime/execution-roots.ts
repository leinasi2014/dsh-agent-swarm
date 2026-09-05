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
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { AttemptId, TaskId, TeamId, TeamState } from '../domain/types.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import { ExecutionRootTools } from './execution-root-tools.js'

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
  /**
   * The member Session working this attempt, when the lease was acquired
   * through the dispatch/self-claim path. Used only to bind the member's
   * effective tool workspace to the root (issue #191) and to release that
   * binding when the root is reclaimed. Absent for leases acquired by the
   * standalone fault tests, which never resolve a member tool workspace.
   */
  readonly memberSessionId?: string
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
  /** Immutable checkout baseline, retained even when the member commits. */
  readonly baseCommit?: string
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
  if (attempt.phase === 'running') return true
  if (attempt.phase !== 'stale') return false
  const task = team.tasks.find(candidate => candidate.id === attempt.taskId)
  if (task?.currentAttemptId === undefined) return false
  const successor = team.attempts.find(candidate => candidate.id === task.currentAttemptId)
  return successor?.assignmentPhase === 'reserved' && successor.replacesAttemptId === attempt.id
}

/** One bounded git invocation; a non-zero exit rejects with stderr context. */
async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, ...(env === undefined ? {} : { env }) })
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
        ...(isolation === 'git-worktree' ? { baseCommit: (await git(path, ['rev-parse', 'HEAD'])).trim() } : {}),
      }
      writeFileSync(join(path, EXECUTION_ROOT_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      return { path, isolation, release: () => reclaim(path, isolation, scope) }
    },
  }
}

/** Serialized per-fence root supply, sweep and crash-residue detection. */
export class ExecutionRoots {
  private readonly providers = new Map<string, TeamExecutionRootProvider>()
  /** Fence tuple → its live lease plus the supplying root's release handle and
   * the member tool-workspace binding disposer (issue #191), when bound. */
  private readonly leases = new Map<string, { readonly lease: ExecutionLease; readonly release: () => Promise<void>; unbind?: () => void }>()
  private readonly inflight = new Map<string, Promise<ExecutionLease>>()
  private readonly tools: ExecutionRootTools | undefined

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      readonly enabled: () => boolean
      readonly providerName: () => string
      readonly base: string
      /** Builtin factory (isolated for fault tests). */
      readonly builtin: (base: string) => TeamExecutionRootProvider
      readonly recoverMember?: (agent: Agent) => Promise<boolean>
    },
  ) {
    this.providers.set('git-worktree', deps.builtin(deps.base))
    this.tools = deps.enabled() && ctx.tools !== undefined && ctx.subagents !== undefined ? new ExecutionRootTools(ctx, deps.recoverMember) : undefined
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

  /** Acquire (or re-attach) the root of one fence tuple; exactly-once per tuple.
   * When `memberSessionId` is supplied, bind that member's effective tool
   * workspace to the root for as long as this lease lives (issue #191). */
  async acquire(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId, memberSessionId?: string): Promise<ExecutionLease> {
    const fence = ExecutionRoots.fence(scope, teamId, taskId, attemptId)
    const leased = this.leases.get(fence)
    if (leased !== undefined) {
      // The same canonical fence reuses its original lease and member binding.
      return leased.lease
    }
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
        ...(memberSessionId === undefined ? {} : { memberSessionId }),
      }
      const unbind = memberSessionId === undefined ? undefined : this.tools?.bind(memberSessionId, root.path)
      this.leases.set(fence, { lease, release: () => root.release(), ...(unbind === undefined ? {} : { unbind }) })
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
    // Revoke member IO before reclaiming the root; stale calls fail closed.
    entry.unbind?.()
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

  /** Release every live lease (runtime disposal path). */
  async releaseAll(reason: string): Promise<void> {
    for (const { lease } of this.leases.values()) {
      await this.release(lease.scope, lease.teamId, lease.taskId, lease.attemptId, reason)
    }
  }

  /** Revoke process-local IO on shutdown; unfinished roots remain recoverable. */
  async suspendAll(): Promise<void> {
    await Promise.allSettled(this.inflight.values())
    for (const entry of this.leases.values()) entry.unbind?.()
    this.leases.clear()
  }

  /**
   * Capture a durable git diff/patch of a git-worktree execution root's
   * isolated worktree (issue #191). When the live lease for the fence tuple
   * is a `git-worktree`, run `git diff --binary` inside the root and persist
   * the output to a durable `.patch` file BESIDE the root — the root itself
   * is reclaimed on settle, so this file is review's only window into the
   * code the root once isolated. Returns the patch file's absolute path, or
   * `undefined` when the attempt holds no git-worktree root (a `temp-directory`
   * root is not a git checkout, and an absent lease means nothing to capture).
   * An isolated temporary index includes staged, unstaged, untracked and
   * committed work without altering the member's index. Capture/publication
   * failures reject submit, keeping its running attempt and root intact.
   */
  async captureWorktreeDiff(scope: TeamScope, teamId: TeamId, taskId: TaskId, attemptId: AttemptId): Promise<string | undefined> {
    const leased = this.leaseOf(scope, teamId, taskId, attemptId)
    if (leased === undefined || leased.isolation !== 'git-worktree') return undefined
    const patchPath = `${leased.path}.patch`
    const temporary = `${patchPath}.${randomUUID()}`
    const indexPath = `${temporary}.index`
    try {
      const baseline = readMarker(leased.path)?.baseCommit
      if (baseline === undefined || !/^[a-f0-9]{40,64}$/.test(baseline)) {
        throw new Error('execution root has no recorded checkout baseline; retain it for recovery')
      }
      const env = { ...process.env, GIT_INDEX_FILE: indexPath }
      await git(leased.path, ['read-tree', 'HEAD'], env)
      await git(leased.path, ['add', '-A', '--', '.', `:(exclude)${EXECUTION_ROOT_MARKER}`, `:(exclude)${RECLAIMABLE_MARKER}`], env)
      const diff = await git(leased.path, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', baseline], env)
      writeFileSync(temporary, diff, { encoding: 'utf8', flush: true })
      renameSync(temporary, patchPath)
    } catch (error) {
      throw new TeamDomainError(`execution-root evidence capture failed: ${String(error)}`, 'TEAM_EXECUTION_ROOT_EVIDENCE_FAILED', { cause: error })
    } finally {
      rmSync(temporary, { force: true })
      rmSync(indexPath, { force: true })
    }
    return patchPath
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
