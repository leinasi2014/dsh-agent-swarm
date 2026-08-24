import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import { queryMemory, type MemoryQueryInput, type MemoryQuerySettings } from './memory-query.js'

type Category = 'decision' | 'lesson' | 'member' | 'context'

export class MemoryOperations {
  constructor(private readonly ctx: Context, private readonly deps: {
    readonly ready: () => Promise<void>
    readonly assertOpen: () => void
    readonly domain: () => TeamDomainPort
    readonly scopeOf: (agent: Agent) => TeamScope
    readonly settings: () => MemoryQuerySettings
  }) {}

  async add(
    exec: ToolExecutionAuthority,
    category: Category,
    content: string,
    evidenceRefs: readonly string[],
    options?: { readonly scope?: 'team' | 'member'; readonly ownerSessionId?: string },
  ) {
    await this.deps.ready()
    this.deps.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.deps.scopeOf(actor)
    const membership = await this.deps.domain().requireMembership(scope, actor.id)
    return await this.deps.domain().addMemory(scope, membership.team.id, actor.id, category, content, evidenceRefs, options)
  }

  async list(exec: ToolExecutionAuthority, input: MemoryQueryInput) {
    await this.deps.ready()
    this.deps.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.deps.scopeOf(actor)
    const membership = await this.deps.domain().requireReadMembership(scope, actor.id)
    return await queryMemory(
      this.ctx, this.deps.domain(), scope, membership.team.id, actor.id, this.deps.settings(), input, exec.signal,
    )
  }

  async addPersonal(
    exec: ToolExecutionAuthority,
    category: Category,
    content: string,
    evidenceRefs: readonly string[],
    ownerName?: string,
  ) {
    await this.deps.ready()
    this.deps.assertOpen()
    const actor = requireAgent(exec)
    const scope = this.deps.scopeOf(actor)
    const membership = await this.deps.domain().requireMembership(scope, actor.id)
    let ownerSessionId = actor.id as string
    if (ownerName !== undefined) {
      if (membership.role !== 'captain') throw new TeamDomainError('only the captain can write another member personal memory', 'TEAM_CAPTAIN_REQUIRED')
      const owner = membership.team.members.find(member => member.name === ownerName && member.phase === 'active')
      if (owner === undefined) throw new TeamDomainError(`active member "${ownerName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
      ownerSessionId = owner.sessionId
    } else if (membership.role === 'captain') {
      throw new TeamDomainError('the captain must name the personal-memory owner', 'TEAM_INPUT_INVALID')
    }
    return await this.deps.domain().addMemory(
      scope, membership.team.id, actor.id, category, content, evidenceRefs, { scope: 'member', ownerSessionId },
    )
  }
}
