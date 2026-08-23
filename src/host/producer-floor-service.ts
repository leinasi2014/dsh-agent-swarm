/**
 * Internal pre-I2/I3 Host producer floor.
 *
 * Reads are projections over the authoritative Team/HumanInteraction stores.
 * Effects are deliberately absent until the I1b authority blocker closes.
 */
import { isProxy } from 'node:util/types'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamId, type TeamStatusSnapshot } from '../domain/types.js'
import type { HumanInteractionOverlayStore } from '../human/human-interaction-store.js'
import { requireAgent, type ToolExecutionAuthority } from '../runtime/authority.js'
import {
  SWARM_PRODUCER_EFFECT_BLOCKER,
  SWARM_PRODUCER_FIXTURES_V1,
  unavailableFixture,
  type SwarmProducerDescriptionV1,
  type SwarmProducerReceiptPageV1,
  type SwarmProducerSnapshotV1,
  type SwarmProducerUnavailableErrorV1,
} from './producer-contract.js'
import { deepFreezeJson } from './frozen-json.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Internal read-only contract floor; not the accepted I2 Host. */
    agentSwarmProducerFloor: AgentSwarmProducerFloorService
  }
}

export interface SwarmProducerReadInput {
  readonly teamId: string
}

export interface SwarmProducerReceiptReadInput extends SwarmProducerReadInput {
  /** Newest bounded window; entries remain ordered oldest-to-newest. */
  readonly limit?: number
}

export interface AgentSwarmProducerFloorDeps {
  readonly domain: () => TeamDomainPort
  readonly overlay: Pick<HumanInteractionOverlayStore, 'list'>
  readonly scopeOf: (agent: Agent) => TeamScope
  readonly isExactLiveRoot: (agent: Agent) => boolean
  readonly now?: () => number
  readonly disposalTimeoutMs?: number
}

const DESCRIPTION: SwarmProducerDescriptionV1 = SWARM_PRODUCER_FIXTURES_V1.description

const DEFAULT_RECEIPT_LIMIT = 50
const MAX_RECEIPT_LIMIT = 100
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/** One lifecycle owner for the pre-I2/I3 read projection. */
export class AgentSwarmProducerFloorService {
  private closing = false
  private admittedReads = 0
  private readonly drainWaiters = new Set<() => void>()

  constructor(private readonly deps: AgentSwarmProducerFloorDeps) {}

  describe(): SwarmProducerDescriptionV1 {
    this.assertOpen()
    return DESCRIPTION
  }

  async readSnapshot(
    input: SwarmProducerReadInput,
    authority: ToolExecutionAuthority,
  ): Promise<SwarmProducerSnapshotV1> {
    const normalized = parseReadInput(input)
    return await this.runRead(authority, async agent => {
      const { scope, snapshot } = await this.readCaptainSnapshot(normalized.teamId, agent, authority.signal)
      const receipts = this.deps.overlay.list(scope, snapshot.team.id)
      const tasks = snapshot.team.tasks
      const terminalTasks = tasks.filter(task => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled').length
      return deepFreezeJson({
        schemaVersion: 1,
        team: {
          id: snapshot.team.id,
          name: snapshot.team.name,
          phase: snapshot.team.phase,
          revision: snapshot.team.revision,
          updatedAt: snapshot.team.updatedAt,
        },
        counts: {
          members: snapshot.team.members.length,
          activeMembers: snapshot.team.members.filter(member => member.phase === 'active').length,
          tasks: tasks.length,
          pendingTasks: tasks.filter(task => task.status === 'pending').length,
          inProgressTasks: tasks.filter(task => task.status === 'in_progress').length,
          submittedTasks: tasks.filter(task => task.status === 'submitted' || task.status === 'verifying').length,
          terminalTasks,
          pendingReceipts: receipts.filter(record => record.receipt.status === 'pending' || record.receipt.status === 'acknowledged').length,
        },
        budget: { ...snapshot.team.budget },
        observedAt: this.observedAt(),
      })
    })
  }

  async readReceipts(
    input: SwarmProducerReceiptReadInput,
    authority: ToolExecutionAuthority,
  ): Promise<SwarmProducerReceiptPageV1> {
    const normalized = parseReceiptReadInput(input)
    return await this.runRead(authority, async agent => {
      const { scope, snapshot } = await this.readCaptainSnapshot(normalized.teamId, agent, authority.signal)
      const records = this.deps.overlay.list(scope, snapshot.team.id)
      const start = Math.max(0, records.length - normalized.limit)
      return deepFreezeJson({
        schemaVersion: 1,
        teamId: snapshot.team.id,
        entries: records.slice(start).map(record => ({
          requestId: record.request.requestId,
          teamId: record.request.teamId,
          intent: record.request.intent,
          targetKind: record.request.target.kind,
          status: record.receipt.status,
          ...(record.receipt.code === undefined ? {} : { code: record.receipt.code }),
          updatedAt: record.receipt.updatedAt,
        })),
        total: records.length,
        truncated: start > 0,
        observedAt: this.observedAt(),
      })
    })
  }

  /** I1b is unresolved: payloads are deliberately neither inspected nor executed. */
  async submitMessage(_payload: unknown, _authority?: ToolExecutionAuthority): Promise<never> {
    this.assertOpen()
    throw capabilityUnavailable('message.write')
  }

  /** I1b is unresolved: payloads are deliberately neither inspected nor executed. */
  async submitControl(_payload: unknown, _authority?: ToolExecutionAuthority): Promise<never> {
    this.assertOpen()
    throw capabilityUnavailable('control.write')
  }

  /** I1b is unresolved: payloads are deliberately neither inspected nor executed. */
  async cancelEffect(_payload: unknown, _authority?: ToolExecutionAuthority): Promise<never> {
    this.assertOpen()
    throw capabilityUnavailable('effect.cancel')
  }

  /** Stop new reads and wait a bounded interval for admitted projections. */
  async dispose(): Promise<void> {
    if (this.closing && this.admittedReads === 0) return
    this.closing = true
    if (this.admittedReads === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let release!: () => void
    const drained = new Promise<void>(resolve => {
      release = resolve
      this.drainWaiters.add(resolve)
    })
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TeamDomainError(
            'producer floor reads did not drain before disposal timeout',
            'SWARM_HOST_DISPOSAL_TIMEOUT',
          )), this.deps.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.drainWaiters.delete(release)
    }
  }

  private async runRead<T>(
    authority: ToolExecutionAuthority,
    operation: (agent: Agent) => Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    authority.signal.throwIfAborted()
    const agent = requireAgent(authority)
    if (!this.deps.isExactLiveRoot(agent)) {
      throw new TeamDomainError('producer reads require the exact live root captain', 'SWARM_HOST_CAPTAIN_REQUIRED')
    }
    this.admittedReads += 1
    try {
      return await operation(agent)
    } finally {
      this.admittedReads -= 1
      if (this.admittedReads === 0) {
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      }
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new TeamDomainError('producer floor service is closed', 'SWARM_HOST_CLOSED')
  }

  private async readCaptainSnapshot(
    teamId: string,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<{ readonly scope: TeamScope; readonly snapshot: TeamStatusSnapshot }> {
    const scope = this.deps.scopeOf(agent)
    // The domain read authenticates membership before the overlay is touched;
    // the extra captain equality keeps this Host floor root-captain-only.
    const snapshot = await this.deps.domain().snapshot(scope, TeamId(teamId), agent.id)
    signal.throwIfAborted()
    if (snapshot.team.captainSessionId !== agent.id) {
      throw new TeamDomainError('producer reads require the exact live root captain', 'SWARM_HOST_CAPTAIN_REQUIRED')
    }
    return { scope, snapshot }
  }

  private observedAt(): number {
    const value = this.deps.now?.() ?? Date.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TeamDomainError('producer clock returned an invalid timestamp', 'SWARM_HOST_INVALID_CLOCK')
    }
    return value
  }
}

/** Official Cordis lifecycle wrapper. No route, Client or RPC is mounted. */
export function provideAgentSwarmProducerFloor(
  ctx: Context,
  service: AgentSwarmProducerFloorService,
): () => Promise<void> {
  const unprovide = ctx.provide('agentSwarmProducerFloor', service)
  return async () => {
    // Close admission synchronously before the first await so a consumer
    // cannot enter during the unprovide/drain hand-off.
    const drained = service.dispose()
    await unprovide?.()
    await drained
  }
}

function capabilityUnavailable(capability: 'message.write' | 'control.write' | 'effect.cancel'): TeamDomainError {
  return Object.assign(new TeamDomainError(
    `${capability} is unavailable while ${SWARM_PRODUCER_EFFECT_BLOCKER} remains unresolved`,
    'SWARM_CAPABILITY_UNAVAILABLE',
  ), {
    capability,
    blocker: SWARM_PRODUCER_EFFECT_BLOCKER,
    result: deepFreezeJson(unavailableFixture(capability)) as SwarmProducerUnavailableErrorV1,
  })
}

function parseReadInput(input: unknown): SwarmProducerReadInput {
  const fields = strictOwnFields(input, new Set(['teamId']))
  if (!Object.hasOwn(fields, 'teamId') || !validBoundedString(fields.teamId, 128)) {
    throw new TeamDomainError('producer read requires one bounded teamId', 'SWARM_HOST_INVALID_REQUEST')
  }
  return { teamId: fields.teamId }
}

function parseReceiptReadInput(input: unknown): Required<SwarmProducerReceiptReadInput> {
  const fields = strictOwnFields(input, new Set(['teamId', 'limit']))
  if (!Object.hasOwn(fields, 'teamId') || !validBoundedString(fields.teamId, 128)) {
    throw new TeamDomainError('receipt read requires one bounded teamId', 'SWARM_HOST_INVALID_REQUEST')
  }
  const limit = fields.limit ?? DEFAULT_RECEIPT_LIMIT
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RECEIPT_LIMIT) {
    throw new TeamDomainError('receipt limit must be an integer from 1 through 100', 'SWARM_HOST_INVALID_REQUEST')
  }
  return { teamId: fields.teamId, limit: limit as number }
}

function strictOwnFields(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TeamDomainError('producer input must be a strict plain data object', 'SWARM_HOST_INVALID_REQUEST')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TeamDomainError('producer input must be a strict plain data object', 'SWARM_HOST_INVALID_REQUEST')
  }
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TeamDomainError('producer input contains an unknown field', 'SWARM_HOST_INVALID_REQUEST')
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TeamDomainError('producer input fields must be plain values', 'SWARM_HOST_INVALID_REQUEST')
    }
    result[key] = descriptor.value
  }
  return result
}

function validBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && [...value].length <= maxLength
}
