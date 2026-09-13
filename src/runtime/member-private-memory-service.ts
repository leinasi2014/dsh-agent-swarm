/**
 * Owning-member private-memory service (2026-08-26): resolves the single active
 * owning member behind `agent_swarm_add_private_memory` /
 * `agent_swarm_list_private_memory` and delegates to `MemberPrivateMemoryStore`.
 *
 * Authority is the existing membership/owning-agent gate narrowed to an active roster
 * row (`requireMembership` with `role === 'member'`, Phase `active`); the
 * caller's own durable Session id is the record partition key, so there is no
 * target-member parameter and no way to address anyone else's private memory. The
 * captain, non-members, external sessions, and failed/removed/archived members are
 * all rejected. See `docs/04-core-protocol.md`.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState, TeamTask } from '../domain/types.js'
import { MemberPrivateMemoryStore, type MemberPrivateMemoryRecord, type PrivateMemoryNote, type PrivateMemoryPage } from '../storage/member-private-memory.js'
import {
  canonicalizeMaintenanceInput,
  type PrivateMemoryMaintenanceInput,
  type PrivateMemoryProvenance,
  type PrivateMemoryReceipt,
} from '../storage/member-private-memory-operations.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'

export interface MemberPrivateMemoryServiceDeps {
  domain: () => TeamDomainPort
  scopeOf: (agent: Agent) => TeamScope
  store: () => MemberPrivateMemoryStore | undefined
  /** Exact live-Agent oracle: the registered Agent whose id equals the caller's id, or undefined. */
  liveAgent: (id: string) => Agent | undefined
  /** Host clock for maintenance provenance observation (defaults to `Date.now`). */
  now?: () => number
}

/** Resolved owning-member tuple that is also the private-memory partition key. */
interface OwningMember {
  readonly scope: TeamScope
  readonly teamId: TeamId
  readonly memberSessionId: string
  /** Host Team snapshot captured BEFORE any fence entry (provenance observation only). */
  readonly team: TeamState
}

/**
 * The ONE shared eligibility filter (task-6): the member's EXACTLY ONE
 * in-progress task whose `currentAttemptId` matches a RUNNING attempt of the
 * SAME task and member. Anything else (none, several, replaced/mismatched)
 * is undefined — id plus running phase alone never attributes. Used by the
 * M1 maintenance provenance (Host WHERE) and the M2 recall installer
 * (auto-read eligibility); behavior of both call sites is unchanged.
 */
export function uniqueRunningAttemptTask(team: TeamState, memberSessionId: string): TeamTask | undefined {
  const attributed = team.tasks.filter(task => task.status === 'in_progress' && task.ownerSessionId === memberSessionId
    && task.currentAttemptId !== undefined
    && team.attempts.some(attempt => attempt.id === task.currentAttemptId
      && attempt.taskId === task.id
      && attempt.memberSessionId === memberSessionId
      && attempt.phase === 'running'))
  return attributed.length === 1 ? attributed[0] : undefined
}

export class MemberPrivateMemoryService {
  private readonly now: () => number

  constructor(private readonly deps: MemberPrivateMemoryServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Resolve the caller as the single owning active member, or fail loud. */
  private async owningMember(exec: ToolExecutionAuthority): Promise<OwningMember> {
    const agent = this.assertCaller(exec)
    const scope = this.deps.scopeOf(agent)
    const membership = await this.deps.domain().requireMembership(scope, agent.id)
    const owner = { scope, teamId: membership.team.id, memberSessionId: agent.id, team: membership.team }
    this.assertCaller(exec, owner)
    if (membership.role !== 'member') {
      throw new TeamDomainError('private memory is reserved for the owning active member', 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED')
    }
    return owner
  }

  private assertCaller(exec: ToolExecutionAuthority, owner?: OwningMember): Agent {
    exec.signal.throwIfAborted()
    const agent = requireAgent(exec)
    // The caller handle must be the EXACT live registered Agent bound to the
    // official Session: `requireMembership` alone keys on the id string, so a
    // forged or stale handle that carries a valid member id must not be honored.
    if (this.deps.liveAgent(agent.id) !== agent || (owner !== undefined
      && (agent.id !== owner.memberSessionId || this.deps.scopeOf(agent) !== owner.scope))) {
      throw new TeamDomainError('private memory requires the live owning agent session', 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED')
    }
    return agent
  }

  private requireStore(): MemberPrivateMemoryStore {
    const store = this.deps.store()
    if (store === undefined) {
      throw new TeamDomainError('member private memory store is not mounted', 'TEAM_PRIVATE_MEMORY_UNAVAILABLE')
    }
    return store
  }

  /** Durably append one record to the caller's own partition (never a Team write). */
  async add(exec: ToolExecutionAuthority, content: string, evidenceRefs: readonly string[]): Promise<MemberPrivateMemoryRecord> {
    const owner = await this.owningMember(exec)
    return await this.requireStore().append(owner.scope, owner.teamId, owner.memberSessionId, content, evidenceRefs, write =>
      this.deps.domain().withActiveMember(owner.scope, owner.teamId, owner.memberSessionId, () => {
        // No await between the final caller check and invoking the store write.
        // The Team lock remains held until put settles; later abort cannot undo it.
        this.assertCaller(exec, owner)
        return write()
      }))
  }

  /**
   * Host observation of WHERE this member is working, derived ONLY from the
   * Team snapshot the membership resolution already returned (captured before
   * any fence entry — never re-read inside the fence). Attribution requires
   * EXACTLY ONE task that is `in_progress`, owned by this member, with a
   * current attempt whose durable `taskId` is that task, whose
   * `memberSessionId` is this member, and whose phase is `running` — id plus
   * running phase alone can never attribute. Anything else (no candidate,
   * several candidates, a replaced/attempt-mismatched candidate) is an
   * explicit `{ kind: 'unattributed' }`. The model can never supply this:
   * provenance is absent from the maintenance input.
   */
  private hostProvenance(team: TeamState, memberSessionId: string): PrivateMemoryProvenance {
    const task = uniqueRunningAttemptTask(team, memberSessionId)
    if (task?.currentAttemptId === undefined) return { kind: 'unattributed' }
    return {
      kind: 'task', taskId: task.id,
      ...(task.currentAttemptId === undefined ? {} : { attemptId: task.currentAttemptId }),
      teamRevision: team.revision, observedAt: this.now(),
    }
  }

  /**
   * Append (or idempotently RETRY) ONE durable v2 maintenance operation on the
   * caller's own partition: add/revise/invalidate/replace under record-level
   * `expectedHeadSeq` CAS. Identity, membership, permissions and cancellation
   * are re-checked before the durable side effect (and the live-agent/signal
   * check runs again inside the Team fence immediately before the write); a
   * committed maintenance write is never claimable as abort-rolled-back. A
   * legal retry of the same stable operationId returns the ORIGINAL prefix
   * receipt and appends nothing — the retry comparison covers only the
   * canonicalized normalized input, never Host provenance, Host time or the
   * assigned seq. Invalid or over-threshold input never reaches the medium.
   */
  async maintain(exec: ToolExecutionAuthority, input: PrivateMemoryMaintenanceInput): Promise<{ receipt: PrivateMemoryReceipt; replayed: boolean }> {
    // Caller eligibility is resolved FIRST — before input canonicalization, so
    // a non-owner can never probe partition content through input errors.
    const owner = await this.owningMember(exec)
    const operation = canonicalizeMaintenanceInput(input)
    const provenance = this.hostProvenance(owner.team, owner.memberSessionId)
    return await this.requireStore().appendMaintenance(owner.scope, owner.teamId, owner.memberSessionId, operation, provenance, write =>
      this.deps.domain().withActiveMember(owner.scope, owner.teamId, owner.memberSessionId, () => {
        // No await between the final caller/signal check and the durable write.
        // The Team lock is held until put settles; later abort cannot undo it.
        this.assertCaller(exec, owner)
        return write()
      }))
  }

  /** Explicitly read one bounded page of the caller's own partition. */
  async list(exec: ToolExecutionAuthority, input: { cursor: number; limit: number }): Promise<PrivateMemoryPage> {
    const owner = await this.owningMember(exec)
    return this.requireStore().listPage(owner.scope, owner.teamId, owner.memberSessionId, input.cursor, input.limit)
  }

  /**
   * M2 recall (task-6): read-only same-fold recent-active CANDIDATE projection
   * over the ELIGIBLE member's own partition, resolved by the recall installer
   * (never a tool surface and never another member's partition). Thin delegator
   * — all authority, eligibility and boundary re-verification live in the
   * installer; semantics of the store/domain/maintenance writes are unchanged.
   */
  recallCandidates(scope: TeamScope, teamId: TeamId, memberSessionId: string, cap: number): readonly PrivateMemoryNote[] {
    return this.requireStore().recentActiveNotes(scope, teamId, memberSessionId, cap)
  }

  /** Same-fold (memoryId → headSeq/status) identity map for boundary re-verification. */
  recallNoteVersions(scope: TeamScope, teamId: TeamId, memberSessionId: string): Map<string, { headSeq: number; status: PrivateMemoryNote['status'] }> {
    return this.requireStore().noteVersions(scope, teamId, memberSessionId)
  }
}
