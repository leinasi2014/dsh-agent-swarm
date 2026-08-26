/** SWARM-P1-02 internal, process-local Host opaque context lifecycle. */
import { randomBytes } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamId } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'

export const DEFAULT_MAX_HOST_CONTEXTS = 64
export const DEFAULT_HOST_CONTEXT_TTL_MS = 5 * 60_000

export interface HostContextAuthority {
  /** Host-owned live object reference; never a caller-supplied Session id. */
  readonly captain: Agent
  readonly signal: AbortSignal
}

export interface HostContextGrant {
  /** Random bearer value with no embedded identity or authority fields. */
  readonly token: string
  readonly teamId: TeamId
  readonly captainSessionId: string
  readonly generation: number
  readonly issuedAt: number
  readonly expiresAt: number
}

interface HostContextRecord extends HostContextGrant {
  readonly captain: Agent
  readonly scope: TeamScope
}

interface HostContextServiceOptions {
  readonly maxActive: number
  readonly ttlMs: number
  readonly now?: () => number
}

/** Typed Host face; construction remains private to plugin activation. */
export interface HostContextPort {
  mint(authority: HostContextAuthority): Promise<HostContextGrant>
  resolve(token: string, authority: HostContextAuthority): Promise<HostContextGrant>
  refresh(token: string, authority: HostContextAuthority): Promise<HostContextGrant>
  rotate(token: string, authority: HostContextAuthority): Promise<HostContextGrant>
  revoke(token: string, authority: HostContextAuthority): Promise<void>
}

interface AuthorizedCaptain {
  readonly captain: Agent
  readonly scope: TeamScope
  readonly teamId: TeamId
}

function serviceName(options: HostContextServiceOptions): string {
  if (!Number.isSafeInteger(options.maxActive) || options.maxActive < 1) {
    throw new TeamDomainError('maxHostContexts must be a positive safe integer', 'TEAM_INVALID_CONFIG')
  }
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
    throw new TeamDomainError('hostContextTtlMs must be a positive safe integer', 'TEAM_INVALID_CONFIG')
  }
  return 'agentSwarmHostContext'
}

/**
 * Host-only capability issuer. Tokens are deliberately process-local: reload
 * creates an empty owner and therefore invalidates every prior token.
 */
class HostContextService extends Service implements HostContextPort {
  private readonly records = new Map<string, HostContextRecord>()
  private readonly now: () => number
  private closed = false

  constructor(
    ctx: Context,
    private readonly runtime: AgentSwarmRuntime,
    private readonly options: HostContextServiceOptions,
  ) {
    // Validate before Service registration, so invalid configuration leaves
    // no partially provided Host face behind.
    super(ctx, serviceName(options))
    this.now = options.now ?? (() => Date.now())
  }

  async mint(authority: HostContextAuthority): Promise<HostContextGrant> {
    const authorized = await this.authorize(authority)
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    this.pruneExpired()
    if (this.records.size >= this.options.maxActive) {
      throw new TeamDomainError('Host context capacity is exhausted', 'TEAM_HOST_CONTEXT_CAPACITY')
    }
    const now = this.now()
    const record: HostContextRecord = {
      token: this.nextToken(),
      teamId: authorized.teamId,
      captainSessionId: authorized.captain.id,
      generation: 1,
      issuedAt: now,
      expiresAt: this.deadline(now),
      captain: authorized.captain,
      scope: authorized.scope,
    }
    this.records.set(record.token, record)
    return this.grant(record)
  }

  async resolve(token: string, authority: HostContextAuthority): Promise<HostContextGrant> {
    const authorized = await this.authorize(authority)
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    return this.grant(this.requireRecord(token, authorized))
  }

  /** Replace the token and renew its full TTL; the predecessor is invalid. */
  async refresh(token: string, authority: HostContextAuthority): Promise<HostContextGrant> {
    const authorized = await this.authorize(authority)
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    const current = this.requireRecord(token, authorized)
    const now = this.now()
    return this.replace(current, now, this.deadline(now))
  }

  /** Replace the token while preserving its existing expiry deadline. */
  async rotate(token: string, authority: HostContextAuthority): Promise<HostContextGrant> {
    const authorized = await this.authorize(authority)
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    const current = this.requireRecord(token, authorized)
    return this.replace(current, this.now(), current.expiresAt)
  }

  async revoke(token: string, authority: HostContextAuthority): Promise<void> {
    const authorized = await this.authorize(authority)
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    const current = this.requireRecord(token, authorized)
    this.records.delete(current.token)
  }

  /** The sole lifecycle owner closes admission and forgets every capability. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.records.clear()
  }

  private async authorize(authority: HostContextAuthority): Promise<AuthorizedCaptain> {
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    this.assertLiveRoot(authority.captain)
    const scope = this.runtime.scopeOf(authority.captain)
    const membership = await this.runtime.domain.requireMembership(scope, authority.captain.id)
    this.assertOpen()
    this.assertNotAborted(authority.signal)
    this.assertLiveRoot(authority.captain)
    if (membership.role !== 'captain') {
      throw new TeamDomainError('Host context requires the exact live root captain', 'TEAM_HOST_CONTEXT_CAPTAIN_REQUIRED')
    }
    return { captain: authority.captain, scope, teamId: membership.team.id }
  }

  private assertLiveRoot(captain: Agent): void {
    if (this.ctx.agents.get(captain.id) !== captain || !this.ctx.agents.roots().includes(captain)) {
      throw new TeamDomainError('Host context requires the exact live root captain', 'TEAM_HOST_CONTEXT_CAPTAIN_REQUIRED')
    }
  }

  private requireRecord(token: string, authorized: AuthorizedCaptain): HostContextRecord {
    if (typeof token !== 'string' || token.length > 128) {
      throw new TeamDomainError('Host context token is invalid', 'TEAM_HOST_CONTEXT_INVALID')
    }
    const record = this.records.get(token)
    if (record === undefined) {
      throw new TeamDomainError('Host context token is invalid', 'TEAM_HOST_CONTEXT_INVALID')
    }
    if (record.captain !== authorized.captain || record.scope !== authorized.scope || record.teamId !== authorized.teamId) {
      throw new TeamDomainError('Host context belongs to another captain or Team', 'TEAM_HOST_CONTEXT_UNAUTHORIZED')
    }
    if (this.now() >= record.expiresAt) {
      this.records.delete(record.token)
      throw new TeamDomainError('Host context token has expired', 'TEAM_HOST_CONTEXT_EXPIRED')
    }
    return record
  }

  private replace(current: HostContextRecord, issuedAt: number, expiresAt: number): HostContextGrant {
    if (issuedAt >= current.expiresAt) {
      this.records.delete(current.token)
      throw new TeamDomainError('Host context token has expired', 'TEAM_HOST_CONTEXT_EXPIRED')
    }
    const successor: HostContextRecord = {
      ...current,
      token: this.nextToken(),
      generation: current.generation + 1,
      issuedAt,
      expiresAt,
    }
    this.records.delete(current.token)
    this.records.set(successor.token, successor)
    return this.grant(successor)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [token, record] of this.records) {
      if (now >= record.expiresAt) this.records.delete(token)
    }
  }

  private nextToken(): string {
    let token: string
    do token = randomBytes(32).toString('base64url')
    while (this.records.has(token))
    return token
  }

  private deadline(now: number): number {
    const deadline = now + this.options.ttlMs
    if (!Number.isSafeInteger(deadline)) {
      throw new TeamDomainError('hostContextTtlMs exceeds the safe clock range', 'TEAM_INVALID_CONFIG')
    }
    return deadline
  }

  private grant(record: HostContextRecord): HostContextGrant {
    return Object.freeze({
      token: record.token,
      teamId: record.teamId,
      captainSessionId: record.captainSessionId,
      generation: record.generation,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new TeamDomainError('Host context service is closed', 'TEAM_HOST_CONTEXT_CLOSED')
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new TeamDomainError('Host context operation was aborted', 'TEAM_HOST_CONTEXT_ABORTED')
  }
}

/** Mount one lifecycle owner and return its Cordis disposer. */
export function mountHostContext(
  ctx: Context,
  runtime: AgentSwarmRuntime,
  options: HostContextServiceOptions,
): () => void {
  const service = new HostContextService(ctx, runtime, options)
  return () => service.dispose()
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Internal Host face; never exposed as a model tool, RPC or Canvas API. */
    agentSwarmHostContext: HostContextPort
  }
}
