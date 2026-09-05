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
import type { TeamId } from '../domain/types.js'
import { MemberPrivateMemoryStore, type MemberPrivateMemoryRecord, type PrivateMemoryPage } from '../storage/member-private-memory.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'

export interface MemberPrivateMemoryServiceDeps {
  domain: () => TeamDomainPort
  scopeOf: (agent: Agent) => TeamScope
  store: () => MemberPrivateMemoryStore | undefined
  /** Exact live-Agent oracle: the registered Agent whose id equals the caller's id, or undefined. */
  liveAgent: (id: string) => Agent | undefined
}

/** Resolved owning-member tuple that is also the private-memory partition key. */
interface OwningMember {
  readonly scope: TeamScope
  readonly teamId: TeamId
  readonly memberSessionId: string
}

export class MemberPrivateMemoryService {
  constructor(private readonly deps: MemberPrivateMemoryServiceDeps) {}

  /** Resolve the caller as the single owning active member, or fail loud. */
  private async owningMember(exec: ToolExecutionAuthority): Promise<OwningMember> {
    const agent = requireAgent(exec)
    // The caller handle must be the EXACT live registered Agent bound to the
    // official Session: `requireMembership` alone keys on the id string, so a
    // forged or stale handle that carries a valid member id must not be honored.
    if (this.deps.liveAgent(agent.id) !== agent) {
      throw new TeamDomainError('private memory requires the live owning agent session', 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED')
    }
    const scope = this.deps.scopeOf(agent)
    const membership = await this.deps.domain().requireMembership(scope, agent.id)
    if (membership.role !== 'member') {
      throw new TeamDomainError('private memory is reserved for the owning active member', 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED')
    }
    return { scope, teamId: membership.team.id, memberSessionId: agent.id }
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
    return await this.requireStore().append(owner.scope, owner.teamId, owner.memberSessionId, content, evidenceRefs)
  }

  /** Explicitly read one bounded page of the caller's own partition. */
  async list(exec: ToolExecutionAuthority, input: { cursor: number; limit: number }): Promise<PrivateMemoryPage> {
    const owner = await this.owningMember(exec)
    return this.requireStore().listPage(owner.scope, owner.teamId, owner.memberSessionId, input.cursor, input.limit)
  }
}
