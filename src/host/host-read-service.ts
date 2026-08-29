/** R1/I2-R internal Host-owned read projection. No route, Client or write seam. */
import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamId, type TeamState, type TeamStatusSnapshot } from '../domain/types.js'
import type { HumanInteractionOverlayStore } from '../human/human-interaction-store.js'
import { deepFreezeJson } from './frozen-json.js'
import type { SwarmHostReadInput, SwarmHostReadProjectionV1 } from './host-read-types.js'
import { canonicalJson, SWARM_PRODUCER_CAPABILITIES_V1 } from './producer-contract.js'

export type { SwarmHostReadInput, SwarmHostReadProjectionV1 } from './host-read-types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Internal R1 read producer; transport and browser publication begin at R2. */
    agentSwarmHostRead: AgentSwarmHostReadService
  }
}

export interface AgentSwarmHostReadDeps {
  readonly currentInitiator: () => Agent | undefined
  readonly isExactLiveRoot: (agent: Agent) => boolean
  readonly scopeOf: (agent: Agent) => TeamScope
  readonly teams: (scope: TeamScope) => Promise<TeamState[]>
  readonly domain: () => Pick<TeamDomainPort, 'snapshot'>
  readonly overlay: Pick<HumanInteractionOverlayStore, 'list'>
  /** Managed dedicated Captain child Session ids of a Main Brain root, so a non-Captain
   *  root can resolve its unique Captain-rooted Team (architecture: main brain → Captain → Team). */
  readonly managedCaptainSessionsOf?: (rootSessionId: string) => readonly string[]
  /** Official Session-store parent lookup: durable descriptor-chain re-proof for
   *  Captain-rooted Teams whose Captain Session is not a live agent in this process. */
  readonly parentOfSession?: (sessionId: string) => string | undefined
  readonly now?: () => number
  readonly disposalTimeoutMs?: number
}

const MAX_ROSTER = 100
const MAX_TASKS = 100
const MAX_ATTEMPTS = 200
const MAX_PENDING_INTERACTIONS = 100
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000
const CURSOR_PATTERN = /^r1:[a-f0-9]{64}$/u

export class AgentSwarmHostReadService {
  private readonly lifecycle: ReadAdmissionLifecycle

  constructor(private readonly deps: AgentSwarmHostReadDeps) {
    this.lifecycle = new ReadAdmissionLifecycle(() => deps.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS)
  }

  async read(input: SwarmHostReadInput = {}): Promise<SwarmHostReadProjectionV1> {
    const normalized = parseInput(input)
    return await this.runRead(async root => {
      const initialScope = this.deps.scopeOf(root)
      const teamId = normalized.teamId ?? await this.resolveImplicitTeam(initialScope, root.id)
      const snapshot = await this.readBoundSnapshot(initialScope, teamId, root.id, normalized.captainSessionId)
      // binding.rootSessionId is the resolved dedicated Captain Session id (root of this read),
      // never the system Main Brain / owner main Chat; the captain owns the Team the UI reflects.
      const bindingRoot = snapshot.team.captainSessionId
      if (bindingRoot !== root.id) this.assertParentBinding(root, bindingRoot)
      const interactions = this.deps.overlay.list(initialScope, snapshot.team.id)
      this.assertBindingStillLive(root, initialScope)
      return project(snapshot, interactions, bindingRoot, normalized.afterCursor, this.observedAt())
    })
  }

  /** Stop admission and wait a bounded interval for all admitted projections. */
  async dispose(): Promise<void> {
    await this.lifecycle.dispose()
  }

  private async runRead<T>(operation: (root: Agent) => Promise<T>): Promise<T> {
    const release = this.lifecycle.admit()
    try {
      const root = this.deps.currentInitiator()
      if (root === undefined) {
        throw new TeamDomainError('Host read requires an official current initiator', 'SWARM_HOST_INITIATOR_REQUIRED')
      }
      if (!this.deps.isExactLiveRoot(root)) {
        throw new TeamDomainError('Host read requires the exact live root Session', 'SWARM_HOST_ROOT_REQUIRED')
      }
      if (root.session.header.cwd === undefined) {
        throw new TeamDomainError('Host root Session has no workspace cwd', 'SWARM_HOST_WORKSPACE_REQUIRED')
      }
      return await operation(root)
    } finally {
      release()
    }
  }

  private async resolveImplicitTeam(scope: TeamScope, rootSessionId: string): Promise<string> {
    const owned = (await this.deps.teams(scope)).filter(team => team.captainSessionId === rootSessionId)
    const active = owned.filter(team => team.phase === 'active')
    if (active.length === 1) return active[0]!.id
    if (active.length > 1 || owned.length > 1) {
      throw new TeamDomainError('Host root maps to multiple Teams; a lookup hint is required', 'SWARM_HOST_BINDING_AMBIGUOUS')
    }
    // A Main Brain root is not itself a Captain; resolve through its managed dedicated Captain
    // Session(s) to the single Captain-rooted Team (architecture: main brain → Captain → Team).
    const children = this.deps.managedCaptainSessionsOf?.(rootSessionId) ?? []
    if (children.length > 0) {
      const viaChild = (await this.deps.teams(scope))
        .filter(team => team.phase === 'active' && children.includes(team.captainSessionId))
      if (viaChild.length === 1) return viaChild[0]!.id
      if (viaChild.length > 1) {
        throw new TeamDomainError('Host root maps to multiple Teams; a lookup hint is required', 'SWARM_HOST_BINDING_AMBIGUOUS')
      }
    }
    if (owned.length === 1) return owned[0]!.id
    throw new TeamDomainError('Host root has no authoritative Team binding', 'SWARM_HOST_BINDING_NOT_FOUND')
  }

  private async readBoundSnapshot(
    scope: TeamScope,
    teamId: string,
    rootSessionId: string,
    captainSessionId?: string,
  ): Promise<TeamStatusSnapshot> {
    let actorSessionId = captainSessionId ?? rootSessionId
    let snapshot: TeamStatusSnapshot
    let recoveredViaDescriptor = false
    try {
      snapshot = await this.deps.domain().snapshot(scope, TeamId(teamId), actorSessionId)
    } catch (error) {
      // Implicit parent-root reads do not know the captain before the first snapshot:
      // retry once with the descriptor captain before rebind failure is declared.
      const retryable = error instanceof TeamDomainError && error.code === 'TEAM_UNAUTHORIZED'
      const descriptor = retryable
        ? (await this.deps.teams(scope)).find(team => team.id === TeamId(teamId))
        : undefined
      if (descriptor === undefined || descriptor.captainSessionId === actorSessionId) {
        if (error instanceof TeamDomainError && (error.code === 'TEAM_UNAUTHORIZED' || error.code === 'TEAM_ARCHIVED')) {
          throw new TeamDomainError('Team lookup hint does not match the Host root binding', 'SWARM_HOST_BINDING_MISMATCH', { cause: error })
        }
        throw error
      }
      actorSessionId = descriptor.captainSessionId
      recoveredViaDescriptor = true
      try {
        snapshot = await this.deps.domain().snapshot(scope, TeamId(teamId), actorSessionId)
      } catch (retryError) {
        if (retryError instanceof TeamDomainError && (retryError.code === 'TEAM_UNAUTHORIZED' || retryError.code === 'TEAM_ARCHIVED')) {
          throw new TeamDomainError('Team lookup hint does not match the Host root binding', 'SWARM_HOST_BINDING_MISMATCH', { cause: retryError })
        }
        throw retryError
      }
    }
    if (captainSessionId === undefined && !recoveredViaDescriptor
      && snapshot.team.captainSessionId !== rootSessionId) {
      throw new TeamDomainError('Team lookup hint does not identify the Host root captain', 'SWARM_HOST_BINDING_MISMATCH')
    }
    return snapshot
  }

  /** Re-prove the descriptor chain for a parent-root read: the team captain must be a
   *  managed dedicated Captain child of this exact live root (in-process tracking or the
   *  official Session-store parent link). No aggregate copy, no second state source. */
  private assertParentBinding(root: Agent, captainSessionId: string): void {
    const managed = this.deps.managedCaptainSessionsOf?.(root.id)?.includes(captainSessionId) ?? false
    const parented = this.deps.parentOfSession?.(captainSessionId) === root.id
    if (!managed && !parented) {
      throw new TeamDomainError('Team binding does not belong to this root\'s managed Captain Sessions', 'SWARM_HOST_BINDING_MISMATCH')
    }
  }

  private assertBindingStillLive(root: Agent, scope: TeamScope): void {
    if (this.deps.currentInitiator() !== root || !this.deps.isExactLiveRoot(root) || this.deps.scopeOf(root) !== scope) {
      throw new TeamDomainError('Host Session binding changed during the read', 'SWARM_HOST_BINDING_MISMATCH')
    }
  }

  private observedAt(): number {
    const value = this.deps.now?.() ?? Date.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TeamDomainError('Host read clock returned an invalid timestamp', 'SWARM_HOST_INVALID_CLOCK')
    }
    return value
  }
}

/** Promise-tail admission barrier kept local to R1; it owns no domain state. */
class ReadAdmissionLifecycle {
  private closing = false
  private tail = Promise.resolve()

  constructor(private readonly timeoutMs: () => number) {}

  admit(): () => void {
    if (this.closing) throw new TeamDomainError('Host read service is closed', 'SWARM_HOST_READ_CLOSED')
    let settle!: () => void
    let settled = false
    const admitted = new Promise<void>(resolve => { settle = resolve })
    this.tail = Promise.all([this.tail, admitted]).then(() => undefined)
    return () => {
      if (settled) return
      settled = true
      settle()
    }
  }

  async dispose(): Promise<void> {
    this.closing = true
    const barrier = this.tail
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        barrier,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TeamDomainError(
            'Host reads did not drain before disposal timeout',
            'SWARM_HOST_READ_DISPOSAL_TIMEOUT',
          )), this.timeoutMs())
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** Official Cordis lifecycle wrapper. Close admission precedes unprovide and drain. */
export function provideAgentSwarmHostRead(ctx: Context, service: AgentSwarmHostReadService): () => Promise<void> {
  const unprovide = ctx.provide('agentSwarmHostRead', service)
  return async () => {
    const drained = service.dispose()
    await unprovide?.()
    await drained
  }
}

function parseInput(input: unknown): SwarmHostReadInput {
  const fields = strictOwnFields(input, new Set(['teamId', 'afterCursor', 'captainSessionId']))
  if (fields.teamId !== undefined && !validBoundedString(fields.teamId, 128)) {
    throw new TeamDomainError('teamId lookup hint must be one bounded string', 'SWARM_HOST_INVALID_REQUEST')
  }
  if (fields.captainSessionId !== undefined && !validBoundedString(fields.captainSessionId, 256)) {
    throw new TeamDomainError('captainSessionId binding hint must be one bounded string', 'SWARM_HOST_INVALID_REQUEST')
  }
  if (fields.captainSessionId !== undefined && fields.teamId === undefined) {
    throw new TeamDomainError('captainSessionId binding requires an explicit teamId lookup hint', 'SWARM_HOST_INVALID_REQUEST')
  }
  if (fields.afterCursor !== undefined && (typeof fields.afterCursor !== 'string' || !CURSOR_PATTERN.test(fields.afterCursor))) {
    throw new TeamDomainError('afterCursor is not an R1 projection cursor', 'SWARM_HOST_INVALID_REQUEST')
  }
  return {
    ...(fields.teamId === undefined ? {} : { teamId: fields.teamId }),
    ...(fields.afterCursor === undefined ? {} : { afterCursor: fields.afterCursor }),
    ...(fields.captainSessionId === undefined ? {} : { captainSessionId: fields.captainSessionId }),
  }
}

function strictOwnFields(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TeamDomainError('Host read input must be a strict plain data object', 'SWARM_HOST_INVALID_REQUEST')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TeamDomainError('Host read input must be a strict plain data object', 'SWARM_HOST_INVALID_REQUEST')
  }
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TeamDomainError('Host read input contains an unknown field', 'SWARM_HOST_INVALID_REQUEST')
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TeamDomainError('Host read input fields must be plain values', 'SWARM_HOST_INVALID_REQUEST')
    }
    result[key] = descriptor.value
  }
  return result
}

function validBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && [...value].length <= maxLength
}

function project(
  snapshot: TeamStatusSnapshot,
  interactions: ReturnType<HumanInteractionOverlayStore['list']>,
  rootSessionId: string,
  afterCursor: string | undefined,
  observedAt: number,
): SwarmHostReadProjectionV1 {
  const team = snapshot.team
  const memberNames = new Map(team.members.map(member => [member.sessionId, member.name]))
  const roster = team.members.slice(0, MAX_ROSTER).map(member => ({
    name: member.name,
    role: member.role,
    phase: member.phase,
    createdAt: member.createdAt,
  }))
  const tasks = team.tasks.toSorted(newestFirst).slice(0, MAX_TASKS).map(task => ({
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    status: task.status,
    blockedBy: [...task.blockedBy],
    priority: task.priority,
    ...optionalName('ownerName', displayName(task.ownerSessionId, rootSessionId, memberNames)),
    ...optionalName('targetMemberName', displayName(task.targetMemberSessionId, rootSessionId, memberNames)),
    ...(task.currentAttemptId === undefined ? {} : { currentAttemptId: task.currentAttemptId }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }))
  const attempts = team.attempts.toSorted(newestFirst).slice(0, MAX_ATTEMPTS).map(attempt => ({
    id: attempt.id,
    taskId: attempt.taskId,
    generation: attempt.generation,
    ...optionalName('memberName', displayName(attempt.memberSessionId, rootSessionId, memberNames)),
    phase: attempt.phase,
    assignmentPhase: attempt.assignmentPhase,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  }))
  const pending = interactions
    .filter(record => record.receipt.status === 'pending' || record.receipt.status === 'acknowledged')
    .toSorted((left, right) => newestFirst(left.receipt, right.receipt))
  const pendingInteractions = pending.slice(0, MAX_PENDING_INTERACTIONS).map(record => ({
    requestId: record.request.requestId,
    intent: record.request.intent,
    targetKind: record.request.target.kind,
    ...targetRef(record.request.target),
    status: record.receipt.status as 'pending' | 'acknowledged',
    createdAt: record.request.createdAt,
    updatedAt: record.receipt.updatedAt,
  }))
  const stableProjection = {
    schemaVersion: 1 as const,
    binding: {
      rootSessionId,
      teamId: team.id,
    },
    team: {
      id: team.id, name: team.name, phase: team.phase, revision: team.revision,
      createdAt: team.createdAt, updatedAt: team.updatedAt,
    },
    roster,
    tasks,
    attempts,
    budget: { ...team.budget },
    pendingInteractions,
    totals: {
      roster: team.members.length,
      tasks: team.tasks.length,
      attempts: team.attempts.length,
      pendingInteractions: pending.length,
    },
    truncated: {
      roster: team.members.length > MAX_ROSTER,
      tasks: team.tasks.length > MAX_TASKS,
      attempts: team.attempts.length > MAX_ATTEMPTS,
      pendingInteractions: pending.length > MAX_PENDING_INTERACTIONS,
    },
    capabilities: SWARM_PRODUCER_CAPABILITIES_V1,
  }
  const cursor = `r1:${createHash('sha256').update(canonicalJson(stableProjection)).digest('hex')}`
  return deepFreezeJson({
    ...stableProjection,
    cursor,
    changed: afterCursor !== cursor,
    resyncRequired: afterCursor !== undefined && afterCursor !== cursor,
    observedAt,
  })
}

function newestFirst(left: { readonly updatedAt: number }, right: { readonly updatedAt: number }): number {
  return right.updatedAt - left.updatedAt
}

function targetRef(target: { readonly kind: string; readonly memberName?: string; readonly taskId?: string }): { readonly targetRef?: string } {
  if (target.kind === 'member' && target.memberName !== undefined) return { targetRef: target.memberName }
  if (target.kind === 'task' && target.taskId !== undefined) return { targetRef: target.taskId }
  return {}
}

function displayName(
  sessionId: string | undefined,
  rootSessionId: string,
  memberNames: ReadonlyMap<string, string>,
): string | undefined {
  if (sessionId === undefined) return undefined
  if (sessionId === rootSessionId) return 'captain'
  return memberNames.get(sessionId)
}

function optionalName<K extends 'ownerName' | 'targetMemberName' | 'memberName'>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>
}
